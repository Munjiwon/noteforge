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
      <PresenceBar self={user} peers={peers} />
      {!readOnly && (
        <button
          onClick={commentOnCurrentBlock}
          className="text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5 mb-2"
          title="Add a comment anchored to the block your cursor is on"
        >
          💬 Comment on this block
        </button>
      )}
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
              {
                title: "AI · Summarize page",
                subtext: "Insert a summary placeholder (manual fill for now)",
                aliases: ["ai", "summarize", "summary", "요약"],
                group: "AI",
                icon: <span>✨</span>,
                onItemClick: () => {
                  editor.insertBlocks(
                    [
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      {
                        type: "callout" as any,
                        props: { emoji: "✨", color: "blue" } as any,
                        content: [
                          { type: "text", text: "AI summary placeholder — fill in once an AI provider is connected.", styles: {} },
                        ] as any,
                      },
                    ],
                    editor.getTextCursorPosition().block,
                    "after",
                  );
                },
              },
              {
                title: "AI · Translate selection",
                subtext: "Insert a translation placeholder",
                aliases: ["ai", "translate", "번역"],
                group: "AI",
                icon: <span>🌐</span>,
                onItemClick: () => {
                  editor.insertBlocks(
                    [
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      {
                        type: "callout" as any,
                        props: { emoji: "🌐", color: "purple" } as any,
                        content: [
                          { type: "text", text: "AI translation placeholder.", styles: {} },
                        ] as any,
                      },
                    ],
                    editor.getTextCursorPosition().block,
                    "after",
                  );
                },
              },
              {
                title: "AI · Improve writing",
                subtext: "Insert a writing-improvement placeholder",
                aliases: ["ai", "improve", "rewrite", "교정"],
                group: "AI",
                icon: <span>📝</span>,
                onItemClick: () => {
                  editor.insertBlocks(
                    [
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      {
                        type: "callout" as any,
                        props: { emoji: "📝", color: "green" } as any,
                        content: [
                          { type: "text", text: "AI suggestion placeholder.", styles: {} },
                        ] as any,
                      },
                    ],
                    editor.getTextCursorPosition().block,
                    "after",
                  );
                },
              },
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
}: {
  self: { name: string; color: string };
  peers: Peer[];
}) {
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
