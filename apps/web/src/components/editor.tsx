"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import {
  useCreateBlockNote,
  SuggestionMenuController,
  FormattingToolbarController,
  FormattingToolbar,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { createComment } from "@/app/w/[slug]/comment-actions";
import { filterSuggestionItems } from "@blocknote/core";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { saveContent } from "@/app/w/[slug]/actions";
import { editorSchema } from "./blocks/schema";

type Peer = { clientId: number; name: string; color: string };

const COLLAB_URL = process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234";

export function Editor({
  pageId,
  slug,
  initialContent,
  user,
  readOnly,
}: {
  pageId: string;
  slug: string;
  initialContent: string;
  user: { id: string; name: string; color: string };
  readOnly: boolean;
}) {
  // doc + provider are created once per page mount and bound synchronously.
  const { doc, provider } = useMemo(() => {
    const d = new Y.Doc();
    const p = new WebsocketProvider(COLLAB_URL, pageId, d, {
      // Start disconnected; we'll fetch a signed token then reconnect.
      connect: false,
    });
    p.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
    });
    return { doc: d, provider: p };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // Fetch signed token from server, then connect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/collab-token?pageId=${encodeURIComponent(pageId)}`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { token: string };
        if (cancelled) return;
        provider.params.token = data.token;
        provider.connect();
      } catch {
        // ignore — provider stays disconnected
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId, provider]);

  const [peers, setPeers] = useState<Peer[]>([]);
  const [syncStatus, setSyncStatus] = useState<"offline" | "connecting" | "syncing" | "synced">(
    "offline",
  );
  useEffect(() => {
    const onStatus = (ev: { status: "connected" | "disconnected" | "connecting" }) => {
      if (ev.status === "connected") setSyncStatus("syncing");
      else if (ev.status === "disconnected") setSyncStatus("offline");
      else if (ev.status === "connecting") setSyncStatus("connecting");
    };
    const onSync = (synced: boolean) => {
      setSyncStatus(synced ? "synced" : "syncing");
    };
    provider.on("status", onStatus);
    provider.on("sync", onSync);
    return () => {
      provider.off("status", onStatus);
      provider.off("sync", onSync);
    };
  }, [provider]);

  useEffect(() => {
    const update = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.clientID) return;
        if (state?.user) {
          list.push({ clientId, name: state.user.name, color: state.user.color });
        }
      });
      setPeers(list);
    };
    provider.awareness.on("change", update);
    update();
    return () => {
      provider.awareness.off("change", update);
      provider.destroy();
      doc.destroy();
    };
  }, [provider, doc]);

  const editor = useCreateBlockNote({
    schema: editorSchema,
    collaboration: {
      provider,
      fragment: doc.getXmlFragment("document-store"),
      user: { name: user.name, color: user.color },
    },
    uploadFile: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const data = (await res.json()) as { url: string };
      return data.url;
    },
  });

  // Seed initial DB content into Yjs the first time, if doc is empty after sync.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const onSynced = () => {
      if (seededRef.current) return;
      seededRef.current = true;
      try {
        const fragment = doc.getXmlFragment("document-store");
        if (fragment.length > 0) return; // already has content
        if (!initialContent) return;
        const blocks = JSON.parse(initialContent);
        if (Array.isArray(blocks) && blocks.length > 0) {
          editor.replaceBlocks(editor.document, blocks);
        }
      } catch (e) {
        console.warn("seed error", e);
      }
    };
    if (provider.synced) onSynced();
    else provider.once("sync", onSynced);
  }, [provider, doc, editor, initialContent]);

  // Debounced save of JSON snapshot to DB.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const json = JSON.stringify(editor.document);
          saveContent(slug, pageId, json);
        } catch (e) {
          console.error(e);
        }
      }, 1500);
    };
    const unsubscribe = editor.onChange(onChange);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [editor, slug, pageId]);

  const commentOnCurrentBlock = async () => {
    const cur = editor.getTextCursorPosition().block;
    if (!cur) return;
    const body = window.prompt(`Add a comment on this block:`);
    if (!body || !body.trim()) return;
    await createComment(slug, pageId, body, { blockId: cur.id });
  };

  return (
    <div>
      <PresenceBar self={user} peers={peers} syncStatus={syncStatus} />
      <div className="flex gap-2 mb-2">
        {!readOnly && (
          <button
            onClick={commentOnCurrentBlock}
            className="text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
            title="Add a comment anchored to the block your cursor is on"
          >
            💬 Comment on this block
          </button>
        )}
        <button
          onClick={() => {
            const cur = editor.getTextCursorPosition().block;
            if (!cur) return;
            const u = new URL(window.location.href);
            u.searchParams.set("b", cur.id);
            void navigator.clipboard?.writeText(u.toString());
          }}
          className="text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
          title="Copy a link that jumps directly to the block your cursor is on"
        >
          🔗 Copy block link
        </button>
      </div>
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme="light"
        slashMenu={false}
        formattingToolbar={false}
      >
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar>
              {getFormattingToolbarItems()}
              <CommentToolbarButton
                onComment={(selectedText) => {
                  const cur = editor.getTextCursorPosition().block;
                  if (!cur) return;
                  const body = window.prompt(
                    selectedText ? `Comment on "${selectedText.slice(0, 60)}…":` : "Comment:",
                  );
                  if (!body || !body.trim()) return;
                  void createComment(slug, pageId, body, { blockId: cur.id });
                }}
              />
            </FormattingToolbar>
          )}
        />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) => {
            const defaults = getDefaultReactSlashMenuItems(editor);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const insert = (type: string, props?: Record<string, any>) => () => {
              editor.insertBlocks(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                [{ type: type as any, props: (props ?? {}) as any }],
                editor.getTextCursorPosition().block,
                "after",
              );
            };
            const extras: DefaultReactSuggestionItem[] = [
              {
                title: "Math equation",
                subtext: "LaTeX formula (KaTeX)",
                aliases: ["math", "latex", "tex", "equation", "수식"],
                group: "Advanced",
                icon: <span style={{ fontFamily: "serif", fontStyle: "italic" }}>fx</span>,
                onItemClick: insert("math", { formula: "", display: true }),
              },
              {
                title: "Callout",
                subtext: "Highlighted note with emoji",
                aliases: ["callout", "note", "info", "tip", "콜아웃"],
                group: "Basic blocks",
                icon: <span>💡</span>,
                onItemClick: insert("callout", { emoji: "💡", color: "yellow" }),
              },
              {
                title: "Quote",
                subtext: "Bordered italic quote",
                aliases: ["quote", "blockquote", "인용"],
                group: "Basic blocks",
                icon: <span>”</span>,
                onItemClick: insert("quote"),
              },
              {
                title: "Embed",
                subtext: "YouTube / Vimeo / Figma / Loom",
                aliases: ["embed", "iframe", "video", "임베드"],
                group: "Media",
                icon: <span>▶</span>,
                onItemClick: insert("embed", { url: "" }),
              },
              {
                title: "Toggle",
                subtext: "Collapsible block",
                aliases: ["toggle", "collapse", "fold", "토글"],
                group: "Basic blocks",
                icon: <span>▾</span>,
                onItemClick: insert("toggle", { open: true }),
              },
              {
                title: "2 columns",
                subtext: "Two side-by-side columns",
                aliases: ["columns", "2col", "two columns", "컬럼"],
                group: "Basic blocks",
                icon: <span>▥</span>,
                onItemClick: insert("columns", { count: "2" }),
              },
              {
                title: "3 columns",
                subtext: "Three side-by-side columns",
                aliases: ["columns", "3col", "three columns"],
                group: "Basic blocks",
                icon: <span>▦</span>,
                onItemClick: insert("columns", { count: "3" }),
              },
              ...(["summarize", "translate", "improve"] as const).map(
                (action): DefaultReactSuggestionItem => {
                  const meta = {
                    summarize: { title: "AI · Summarize", emoji: "✨", color: "blue", aliases: ["ai", "summarize", "summary", "요약"] },
                    translate: { title: "AI · Translate", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "번역"] },
                    improve: { title: "AI · Improve writing", emoji: "📝", color: "green", aliases: ["ai", "improve", "rewrite", "교정"] },
                  }[action];
                  return {
                    title: meta.title,
                    subtext: "Sends the surrounding text to /api/ai",
                    aliases: meta.aliases,
                    group: "AI",
                    icon: <span>{meta.emoji}</span>,
                    onItemClick: async () => {
                      // collect text from the current and nearby blocks (up to ~600 chars)
                      const cur = editor.getTextCursorPosition().block;
                      const blocks = editor.document;
                      const idx = blocks.findIndex((b) => b.id === cur?.id);
                      const slice = idx >= 0 ? blocks.slice(Math.max(0, idx - 5), idx + 1) : blocks.slice(-6);
                      const text = slice
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        .map((b: any) => (Array.isArray(b.content) ? b.content.map((c: any) => (typeof c === "object" && c && "text" in c ? c.text : "")).join("") : ""))
                        .join("\n")
                        .slice(0, 1500);

                      const placeholder = {
                        type: "callout" as const,
                        props: { emoji: meta.emoji, color: meta.color } as Record<string, unknown>,
                        content: [{ type: "text", text: `${meta.title}: thinking…`, styles: {} }] as unknown,
                      };
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const [inserted] = editor.insertBlocks([placeholder as any], cur ?? blocks[blocks.length - 1], "after");
                      try {
                        const res = await fetch("/api/ai", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action, text }),
                        });
                        const data = (await res.json()) as { output?: string; error?: string };
                        const out = data.output || data.error || "(no response)";
                        editor.updateBlock(inserted, {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          content: [{ type: "text", text: out, styles: {} }] as any,
                        });
                      } catch (e) {
                        editor.updateBlock(inserted, {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          content: [{ type: "text", text: `AI request failed: ${(e as Error).message}`, styles: {} }] as any,
                        });
                      }
                    },
                  };
                },
              ),
              {
                title: "Linked database",
                subtext: "Embed an existing database view",
                aliases: ["db", "database", "linked database", "데이터베이스"],
                group: "Advanced",
                icon: <span>📊</span>,
                onItemClick: insert("dbView"),
              },
              {
                title: "Table of contents",
                subtext: "Auto-generated list of headings",
                aliases: ["toc", "table of contents", "contents", "목차"],
                group: "Advanced",
                icon: <span>≡</span>,
                onItemClick: insert("toc"),
              },
              {
                title: "Code (TypeScript)",
                subtext: "Code block with TS syntax",
                aliases: ["ts", "typescript", "code"],
                group: "Advanced",
                icon: <span className="font-mono">{"</>"}</span>,
                onItemClick: insert("codeBlock", { language: "typescript" }),
              },
              {
                title: "Code (Python)",
                subtext: "Code block with Python syntax",
                aliases: ["py", "python", "code"],
                group: "Advanced",
                icon: <span className="font-mono">{"</>"}</span>,
                onItemClick: insert("codeBlock", { language: "python" }),
              },
              {
                title: "Code (SQL)",
                subtext: "Code block with SQL syntax",
                aliases: ["sql", "code"],
                group: "Advanced",
                icon: <span className="font-mono">{"</>"}</span>,
                onItemClick: insert("codeBlock", { language: "sql" }),
              },
              {
                title: "Code (JSON)",
                subtext: "Code block for JSON data",
                aliases: ["json", "code"],
                group: "Advanced",
                icon: <span className="font-mono">{"</>"}</span>,
                onItemClick: insert("codeBlock", { language: "json" }),
              },
              {
                title: "Table",
                subtext: "Simple table with rows and columns",
                aliases: ["table", "grid", "spreadsheet", "표"],
                group: "Basic blocks",
                icon: <span>▦</span>,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onItemClick: () => {
                  editor.insertBlocks(
                    [
                      {
                        type: "table" as any,
                        content: {
                          type: "tableContent",
                          rows: [
                            {
                              cells: ["", "", ""],
                            },
                            { cells: ["", "", ""] },
                            { cells: ["", "", ""] },
                          ],
                        } as any,
                      },
                    ],
                    editor.getTextCursorPosition().block,
                    "after",
                  );
                },
              },
            ];
            return filterSuggestionItems([...defaults, ...extras], query);
          }}
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) => {
            try {
              const res = await fetch(
                `/api/mentions?ws=${encodeURIComponent(slug)}&q=${encodeURIComponent(query)}`,
              );
              if (!res.ok) return [];
              const data = (await res.json()) as {
                users: { id: string; name: string; color: string }[];
                pages: { id: string; title: string; icon: string | null }[];
              };
              const items: DefaultReactSuggestionItem[] = [];
              for (const u of data.users) {
                items.push({
                  title: u.name,
                  subtext: "Mention person",
                  group: "People",
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  icon: (
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium"
                      style={{ background: u.color }}
                    >
                      {u.name.slice(0, 1).toUpperCase()}
                    </span>
                  ),
                  onItemClick: () => {
                    editor.insertInlineContent([
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      {
                        type: "mention",
                        props: { kind: "user", id: u.id, label: u.name },
                      } as any,
                      " ",
                    ]);
                  },
                });
              }
              for (const p of data.pages) {
                items.push({
                  title: p.title || "Untitled",
                  subtext: "Link page",
                  group: "Pages",
                  icon: <span>{p.icon ?? "📄"}</span>,
                  onItemClick: () => {
                    editor.insertInlineContent([
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      {
                        type: "mention",
                        props: {
                          kind: "page",
                          id: p.id,
                          label: p.title || "Untitled",
                        },
                      } as any,
                      " ",
                    ]);
                  },
                });
              }
              // Date shortcuts
              const today = new Date();
              const tmr = new Date(today);
              tmr.setDate(today.getDate() + 1);
              const fmt = (d: Date) => {
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, "0");
                const day = String(d.getDate()).padStart(2, "0");
                return `${y}-${m}-${day}`;
              };
              const dateCandidates = [
                { label: "Today", iso: fmt(today) },
                { label: "Tomorrow", iso: fmt(tmr) },
              ];
              for (const d of dateCandidates) {
                items.push({
                  title: d.label,
                  subtext: d.iso,
                  group: "Dates",
                  icon: <span>📅</span>,
                  onItemClick: () => {
                    editor.insertInlineContent([
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      {
                        type: "mention",
                        props: { kind: "date", id: d.iso, label: d.label },
                      } as any,
                      " ",
                    ]);
                  },
                });
              }
              return items;
            } catch {
              return [];
            }
          }}
        />
      </BlockNoteView>
    </div>
  );
}

function PresenceBar({
  self,
  peers,
  syncStatus,
}: {
  self: { name: string; color: string };
  peers: Peer[];
  syncStatus?: "offline" | "connecting" | "syncing" | "synced";
}) {
  const statusDot: Record<NonNullable<typeof syncStatus>, { color: string; label: string }> = {
    offline: { color: "bg-gray-400", label: "Offline" },
    connecting: { color: "bg-yellow-400", label: "Connecting…" },
    syncing: { color: "bg-yellow-400 animate-pulse", label: "Syncing…" },
    synced: { color: "bg-emerald-500", label: "Synced" },
  };
  const dot = syncStatus ? statusDot[syncStatus] : null;
  return (
    <div className="flex items-center gap-1 mb-3 -ml-2">
      <Avatar name={self.name} color={self.color} title={`${self.name} (you)`} />
      {peers.map((p) => (
        <Avatar key={p.clientId} name={p.name} color={p.color} title={p.name} />
      ))}
      {peers.length > 0 && (
        <span className="ml-2 text-xs text-gray-500">
          {peers.length + 1} editing
        </span>
      )}
      {dot && (
        <span
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-500"
          title={dot.label}
        >
          <span className={`w-2 h-2 rounded-full ${dot.color}`} />
          {dot.label}
        </span>
      )}
    </div>
  );
}

function CommentToolbarButton({
  onComment,
}: {
  onComment: (selectedText: string) => void;
}) {
  return (
    <button
      type="button"
      className="bn-mt-button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const sel = typeof window !== "undefined" ? window.getSelection()?.toString() ?? "" : "";
        onComment(sel);
      }}
      title="Add a comment on selection"
      style={{
        padding: "4px 8px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      💬
    </button>
  );
}

function Avatar({ name, color, title }: { name: string; color: string; title: string }) {
  return (
    <div
      title={title}
      className="w-7 h-7 rounded-full grid place-items-center text-white text-xs font-medium ring-2 ring-white -ml-2"
      style={{ backgroundColor: color }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
