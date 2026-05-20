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
import { PAGE_TEMPLATES } from "@/lib/page-templates";

type Peer = { clientId: number; name: string; color: string };

const COLLAB_URL = process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234";

export function Editor({
  pageId,
  slug,
  initialContent,
  user,
  readOnly,
  aiEnabled = true,
}: {
  pageId: string;
  slug: string;
  initialContent: string;
  user: { id: string; name: string; color: string };
  readOnly: boolean;
  aiEnabled?: boolean;
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

  // Listen for restore-snapshot events from the History dialog and overwrite
  // the live editor (and therefore the Yjs doc) with the restored content.
  useEffect(() => {
    if (!editor) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ pageId: string; content: string }>).detail;
      if (!detail || detail.pageId !== pageId || !detail.content) return;
      try {
        const blocks = JSON.parse(detail.content);
        if (Array.isArray(blocks) && blocks.length > 0) {
          editor.replaceBlocks(editor.document, blocks);
        }
      } catch (err) {
        console.warn("restore replace error", err);
      }
    };
    window.addEventListener("noteforge:restore-snapshot", handler);
    return () => window.removeEventListener("noteforge:restore-snapshot", handler);
  }, [editor, pageId]);

  // Debounced save of JSON snapshot to DB, with a Saving / Saved indicator.
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved">(
    "idle",
  );
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let savedTimer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      setSaveState("dirty");
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const json = JSON.stringify(editor.document);
          setSaveState("saving");
          await saveContent(slug, pageId, json);
          setSaveState("saved");
          if (savedTimer) clearTimeout(savedTimer);
          savedTimer = setTimeout(() => setSaveState("idle"), 1200);
        } catch (e) {
          console.error(e);
          setSaveState("dirty");
        }
      }, 1500);
    };
    const unsubscribe = editor.onChange(onChange);
    return () => {
      if (timer) clearTimeout(timer);
      if (savedTimer) clearTimeout(savedTimer);
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

  // Image lightbox: clicking any rendered <img> inside the editor opens a
  // full-screen viewer. ESC closes.
  const [lightbox, setLightbox] = useState<string | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const img = t.closest("img") as HTMLImageElement | null;
      if (!img) return;
      if (!img.closest('[data-content-type="image"]')) return;
      if (img.src.startsWith("data:")) return;
      e.preventDefault();
      setLightbox(img.src);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // ⌘⇧T — insert a table block at the cursor.
  useEffect(() => {
    if (!editor || readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "t") return;
      e.preventDefault();
      const cur = editor.getTextCursorPosition().block;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.insertBlocks([{ type: "table" } as any], cur, "after");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, readOnly]);

  // ⌘; — insert today's date as inline text at the cursor.
  useEffect(() => {
    if (!editor || readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if (e.key !== ";") return;
      e.preventDefault();
      const today = new Date().toISOString().slice(0, 10);
      try {
        document.execCommand("insertText", false, today);
      } catch {
        const cur = editor.getTextCursorPosition().block;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor.insertBlocks(
          [
            {
              type: "paragraph",
              content: [{ type: "text", text: today, styles: {} }],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          ],
          cur,
          "after",
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, readOnly]);

  // File drag overlay — visual cue when the user drags a file onto the page.
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let counter = 0;
    const onEnter = (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) return;
      counter++;
      setDragOver(true);
    };
    const onLeave = () => {
      counter = Math.max(0, counter - 1);
      if (counter === 0) setDragOver(false);
    };
    const onDrop = () => {
      counter = 0;
      setDragOver(false);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // ⌘S — intercept the browser save and show a transient toast since we
  // auto-save continuously. ⌘⇧S explicitly takes a manual snapshot.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (e.shiftKey) {
        if (readOnly) return;
        import("@/app/w/[slug]/actions")
          .then((m) => m.takeSnapshot(slug, pageId))
          .then(() => {
            const tip = document.createElement("div");
            tip.textContent = "📸 Snapshot saved";
            tip.className =
              "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-blue-600 text-white rounded-full px-3 py-1 shadow";
            document.body.appendChild(tip);
            setTimeout(() => tip.remove(), 1400);
          })
          .catch(() => {});
        return;
      }
      const tip = document.createElement("div");
      tip.textContent = "✓ Auto-saved";
      tip.className =
        "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-emerald-600 text-white rounded-full px-3 py-1 shadow";
      document.body.appendChild(tip);
      setTimeout(() => tip.remove(), 1200);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, slug, pageId]);

  // Double-click on a heading → copy a direct link (?b=<blockId>) to the
  // heading. Discoverable without changing the BlockNote DOM.
  useEffect(() => {
    const onDbl = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const block = t.closest(
        '[data-content-type="heading"]',
      ) as HTMLElement | null;
      if (!block) return;
      const idEl = block.closest("[data-id]") as HTMLElement | null;
      const blockId = idEl?.getAttribute("data-id");
      if (!blockId) return;
      const url = `${window.location.origin}${window.location.pathname}?b=${blockId}`;
      navigator.clipboard?.writeText(url).then(() => {
        // Tiny toast — borrow notifications-style transient hint
        const tip = document.createElement("div");
        tip.textContent = "Link to heading copied";
        tip.className =
          "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
        document.body.appendChild(tip);
        setTimeout(() => tip.remove(), 1400);
      });
    };
    window.addEventListener("dblclick", onDbl);
    return () => window.removeEventListener("dblclick", onDbl);
  }, []);

  // Clipboard image paste: when the user pastes a PNG/JPEG/etc, upload it
  // and insert a real image block instead of letting BlockNote fall back to
  // a noisy data URL.
  useEffect(() => {
    if (!editor || readOnly) return;
    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      // URL paste → suggest bookmark when the clipboard is exactly a URL.
      const urlMatch = /^https?:\/\/\S+$/i.exec(text.trim());
      if (urlMatch && !items?.length) {
        // Let the default text paste happen first; then offer a one-line
        // upgrade so it doesn't surprise the user.
        setTimeout(() => {
          const yes = window.confirm(
            `Paste as bookmark card instead?\n\n${urlMatch[0]}`,
          );
          if (!yes) return;
          const cur = editor.getTextCursorPosition().block;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          editor.insertBlocks(
            [
              {
                type: "bookmark",
                props: { url: urlMatch[0] } as Record<string, unknown>,
              } as any,
            ],
            cur,
            "after",
          );
        }, 0);
      }
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (!file) continue;
          e.preventDefault();
          const fd = new FormData();
          fd.append("file", file, file.name || "paste.png");
          try {
            const res = await fetch("/api/upload", { method: "POST", body: fd });
            if (!res.ok) return;
            const data = (await res.json()) as { url: string };
            const cur = editor.getTextCursorPosition().block;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            editor.insertBlocks(
              [
                {
                  type: "image",
                  props: { url: data.url } as Record<string, unknown>,
                } as any,
              ],
              cur,
              "after",
            );
          } catch {
            /* swallow */
          }
          return;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [editor, readOnly]);

  // ⌘J — AI Edit on current selection (or surrounding paragraph if no selection)
  useEffect(() => {
    if (!editor || readOnly) return;
    const onKey = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "j") return;
      const sel = window.getSelection()?.toString() ?? "";
      const instruction = window.prompt(
        sel
          ? `AI · transform selection ('${sel.slice(0, 40)}…'). What should AI do?`
          : "AI · transform surrounding text. What should AI do?",
        "Improve clarity",
      );
      if (!instruction || !instruction.trim()) return;
      e.preventDefault();
      // Use selection if non-empty, else surrounding blocks.
      let text = sel;
      if (!text) {
        const cur = editor.getTextCursorPosition().block;
        const blocks = editor.document;
        const idx = blocks.findIndex((b: { id: string }) => b.id === cur?.id);
        const slice =
          idx >= 0
            ? blocks.slice(Math.max(0, idx - 3), idx + 1)
            : blocks.slice(-3);
        text = slice
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((b: any) =>
            Array.isArray(b.content)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? b.content
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((c: any) =>
                    typeof c === "object" && c && "text" in c ? c.text : "",
                  )
                  .join("")
              : "",
          )
          .join("\n")
          .slice(0, 1500);
      }
      // Remember whether to replace the live selection with the result.
      const replaceSelection = sel.length > 0;
      const placeholder = {
        type: "callout" as const,
        props: { emoji: "🪄", color: "red" } as Record<string, unknown>,
        content: [
          { type: "text", text: "AI · Edit: thinking…", styles: {} },
        ] as unknown,
      };
      const cur = editor.getTextCursorPosition().block;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [inserted] = editor.insertBlocks([placeholder as any], cur, "after");
      try {
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "edit", text, instruction }),
        });
        const data = (await res.json()) as { output?: string; error?: string };
        const out = data.output || data.error || "(no response)";
        if (replaceSelection && data.output) {
          // Replace the visible selection in-place with the result, then drop
          // the placeholder callout.
          try {
            // restore focus into the editor
            const root = document.querySelector(".bn-editor") as HTMLElement | null;
            root?.focus();
            // execCommand is deprecated but still the simplest way to replace a
            // contentEditable selection without re-implementing it.
            const ok = document.execCommand("insertText", false, out);
            if (ok) {
              editor.removeBlocks([inserted]);
              return;
            }
          } catch {
            /* fall through to keep the callout */
          }
        }
        editor.updateBlock(inserted, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: [{ type: "text", text: out, styles: {} }] as any,
        });
      } catch (err) {
        editor.updateBlock(inserted, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: [{ type: "text", text: `AI failed: ${(err as Error).message}`, styles: {} }] as any,
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, readOnly]);

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
        {saveState !== "idle" && !readOnly && (
          <span
            className={
              "ml-auto text-[10px] uppercase tracking-wide self-center " +
              (saveState === "saved"
                ? "text-emerald-600"
                : "text-gray-400")
            }
            title={saveState === "saving" ? "Saving to server…" : saveState === "saved" ? "All changes saved" : "Pending save"}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "✓ Saved"
                : "·"}
          </span>
        )}
      </div>
      {!readOnly && <EmptyHint editor={editor} />}
      {!readOnly && dragOver && (
        <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-none flex justify-center pb-12">
          <div className="bg-gray-900 text-white text-xs px-4 py-2 rounded-full shadow-lg">
            📥 Drop to upload — it'll become an image / file block
          </div>
        </div>
      )}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt=""
            className="max-w-full max-h-full object-contain shadow-2xl"
          />
          <button
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
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
                aliases: ["embed", "iframe", "video", "youtube", "vimeo", "twitter", "임베드"],
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
                title: "Table",
                subtext: "Spreadsheet-style table block",
                aliases: ["table", "spreadsheet", "grid", "표"],
                group: "Basic blocks",
                icon: <span>▤</span>,
                onItemClick: () => {
                  const cur = editor.getTextCursorPosition().block;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.insertBlocks([{ type: "table" } as any], cur, "after");
                },
              },
              {
                title: "File / attachment",
                subtext: "Upload a non-image file",
                aliases: ["file", "attachment", "upload", "첨부"],
                group: "Media",
                icon: <span>📎</span>,
                onItemClick: () => {
                  const cur = editor.getTextCursorPosition().block;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.insertBlocks(
                    [{ type: "file" } as any],
                    cur,
                    "after",
                  );
                },
              },
              {
                title: "Bookmark",
                subtext: "Link preview card",
                aliases: ["bookmark", "link", "preview", "북마크"],
                group: "Media",
                icon: <span>🔖</span>,
                onItemClick: insert("bookmark", { url: "" }),
              },
              {
                title: "Audio",
                subtext: "Record or upload a voice memo",
                aliases: ["audio", "voice", "record", "음성"],
                group: "Media",
                icon: <span>🎤</span>,
                onItemClick: insert("audio", { url: "" }),
              },
              {
                title: "Embed page",
                subtext: "Pull another page's content read-only",
                aliases: ["page", "embed", "reference", "transclude", "임베드", "참조"],
                group: "Media",
                icon: <span>📑</span>,
                onItemClick: insert("pageEmbed", { pageId: "" }),
              },
              {
                title: "Highlight selection",
                subtext: "Yellow background on the selected text",
                aliases: ["highlight", "mark", "yellow", "형광펜"],
                group: "Basic blocks",
                icon: <span>🖍</span>,
                onItemClick: () => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (editor as any).toggleStyles?.({ backgroundColor: "yellow" });
                },
              },
              {
                title: "Checkbox",
                subtext: "Single to-do checkbox",
                aliases: ["check", "checkbox", "todo", "task", "할일", "체크박스"],
                group: "Basic blocks",
                icon: <span>☑</span>,
                onItemClick: () => {
                  const cur = editor.getTextCursorPosition().block;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.insertBlocks(
                    [
                      {
                        type: "checkListItem",
                        props: { checked: false },
                        content: [{ type: "text", text: "", styles: {} }],
                      } as any,
                    ],
                    cur,
                    "after",
                  );
                },
              },
              {
                title: "Divider",
                subtext: "Horizontal rule (---)",
                aliases: ["divider", "hr", "horizontal rule", "구분선", "---"],
                group: "Basic blocks",
                icon: <span>―</span>,
                onItemClick: () => {
                  const cur = editor.getTextCursorPosition().block;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.insertBlocks(
                    [{ type: "horizontalRule" } as any],
                    cur,
                    "after",
                  );
                },
              },
              ...(["today", "tomorrow", "now"] as const).map(
                (kind): DefaultReactSuggestionItem => {
                  const fmt = () => {
                    const d = new Date();
                    if (kind === "tomorrow") d.setDate(d.getDate() + 1);
                    if (kind === "now") {
                      return d.toLocaleString();
                    }
                    return d.toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    });
                  };
                  return {
                    title: `Date · ${kind}`,
                    subtext: `Insert ${kind === "now" ? "current date + time" : kind === "today" ? "today's date" : "tomorrow's date"}`,
                    aliases: [kind, "date", "오늘", "내일", "지금"],
                    group: "Basic blocks",
                    icon: <span>📅</span>,
                    onItemClick: () => {
                      const text = fmt();
                      const cur = editor.getTextCursorPosition().block;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      editor.insertBlocks([
                        {
                          type: "paragraph",
                          content: [{ type: "text", text, styles: {} }],
                        } as any,
                      ], cur, "after");
                    },
                  };
                },
              ),
              ...PAGE_TEMPLATES.map((tpl): DefaultReactSuggestionItem => ({
                title: `Template · ${tpl.name}`,
                subtext: tpl.description ?? "Insert this template here",
                aliases: ["template", "snippet", tpl.id, tpl.name.toLowerCase()],
                group: "Templates",
                icon: <span>{tpl.icon}</span>,
                onItemClick: () => {
                  const cur = editor.getTextCursorPosition().block;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.insertBlocks(tpl.content as any[], cur, "after");
                },
              })),
              {
                title: "Snippet · Meeting agenda",
                subtext: "Quick agenda + action items checklist",
                aliases: ["meeting", "agenda", "snippet"],
                group: "Basic blocks",
                icon: <span>📝</span>,
                onItemClick: () => {
                  const cur = editor.getTextCursorPosition().block;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.insertBlocks(
                    [
                      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Agenda", styles: {} }] } as any,
                      { type: "bulletListItem", content: [{ type: "text", text: "", styles: {} }] } as any,
                      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Discussion", styles: {} }] } as any,
                      { type: "paragraph", content: [{ type: "text", text: "", styles: {} }] } as any,
                      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Action items", styles: {} }] } as any,
                      { type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "", styles: {} }] } as any,
                    ],
                    cur,
                    "after",
                  );
                },
              },
              {
                title: "Snippet · Pros / Cons",
                subtext: "Two-column-style decision matrix",
                aliases: ["pros", "cons", "decision", "snippet"],
                group: "Basic blocks",
                icon: <span>⚖️</span>,
                onItemClick: () => {
                  const cur = editor.getTextCursorPosition().block;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.insertBlocks(
                    [
                      { type: "heading", props: { level: 3 }, content: [{ type: "text", text: "Pros", styles: {} }] } as any,
                      { type: "bulletListItem", content: [{ type: "text", text: "", styles: {} }] } as any,
                      { type: "heading", props: { level: 3 }, content: [{ type: "text", text: "Cons", styles: {} }] } as any,
                      { type: "bulletListItem", content: [{ type: "text", text: "", styles: {} }] } as any,
                    ],
                    cur,
                    "after",
                  );
                },
              },
              {
                title: "Synced block",
                subtext: "Shared text mirrored across pages",
                aliases: ["synced", "sync", "shared", "동기화"],
                group: "Basic blocks",
                icon: <span>🔗</span>,
                onItemClick: insert("synced", { syncedBlockId: "" }),
              },
              {
                title: "Synced block (existing)",
                subtext: "Reuse a synced block by its reference ID",
                aliases: ["synced", "existing", "reference", "참조"],
                group: "Basic blocks",
                icon: <span>🔁</span>,
                onItemClick: () => {
                  const ref = window.prompt(
                    "Paste the synced block reference ID:",
                  )?.trim();
                  if (!ref) return;
                  insert("synced", { syncedBlockId: ref })();
                },
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
                title: "AI · Suggest title",
                subtext: "Read the page and propose a short title",
                aliases: ["ai", "title", "rename", "제목"],
                group: "AI",
                icon: <span>🏷</span>,
                onItemClick: async () => {
                  const blocks = editor.document;
                  const text = blocks
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    .map((b: any) =>
                      Array.isArray(b.content)
                        ? b.content
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            .map((c: any) =>
                              typeof c === "object" && c && "text" in c
                                ? c.text
                                : "",
                            )
                            .join("")
                        : "",
                    )
                    .join("\n")
                    .slice(0, 3000);
                  if (!text.trim()) {
                    alert("No content to summarize yet.");
                    return;
                  }
                  const res = await fetch("/api/ai", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "title", text }),
                  });
                  const data = (await res.json()) as { output?: string; error?: string };
                  const out = (data.output ?? "").trim().replace(/^[\"'`]|[\"'`]$/g, "");
                  if (!out) {
                    alert(data.error ?? "(no response)");
                    return;
                  }
                  const titleEl = document.querySelector(
                    'input[placeholder="Untitled"]',
                  ) as HTMLInputElement | null;
                  if (titleEl) {
                    if (confirm(`Use this title?\n\n${out}`)) {
                      titleEl.focus();
                      titleEl.select();
                      document.execCommand("insertText", false, out);
                      titleEl.blur();
                    }
                  } else {
                    navigator.clipboard.writeText(out);
                    alert(`Title copied:\n\n${out}`);
                  }
                },
              },
              ...(aiEnabled
                ? (["summarize", "one_liner", "translate", "improve", "proofread", "continue", "explain", "outline", "keywords", "ideas", "checklist", "poll", "email", "action_items", "quote", "tone", "longer", "shorter", "glossary", "sentiment", "next_steps", "critique", "agenda", "eli5", "pros_cons", "risks", "timeline", "faq", "counter", "hashtags", "headlines", "slug", "tweet_thread", "citations", "edit"] as const)
                : ([] as const)).map(
                (action): DefaultReactSuggestionItem => {
                  const meta = {
                    summarize: { title: "AI · Summarize", emoji: "✨", color: "blue", aliases: ["ai", "summarize", "summary", "요약"] },
                    one_liner: { title: "AI · One-liner", emoji: "💡", color: "blue", aliases: ["ai", "concise", "tldr", "한줄"] },
                    translate: { title: "AI · Translate", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "번역"] },
                    improve: { title: "AI · Improve writing", emoji: "📝", color: "green", aliases: ["ai", "improve", "rewrite", "교정"] },
                    proofread: { title: "AI · Proofread", emoji: "✅", color: "green", aliases: ["ai", "proofread", "spellcheck", "맞춤법"] },
                    continue: { title: "AI · Continue writing", emoji: "➡️", color: "yellow", aliases: ["ai", "continue", "write more", "이어쓰기"] },
                    explain: { title: "AI · Explain", emoji: "🔎", color: "blue", aliases: ["ai", "explain", "expand", "설명"] },
                    outline: { title: "AI · Outline", emoji: "🧱", color: "blue", aliases: ["ai", "outline", "toc", "목차"] },
                    keywords: { title: "AI · Keywords", emoji: "🏷", color: "yellow", aliases: ["ai", "keywords", "tags", "키워드"] },
                    ideas: { title: "AI · Brainstorm 5 ideas", emoji: "💭", color: "yellow", aliases: ["ai", "ideas", "brainstorm", "아이디어"] },
                    checklist: { title: "AI · Checklist", emoji: "✔️", color: "green", aliases: ["ai", "checklist", "todo", "체크리스트"] },
                    poll: { title: "AI · Poll", emoji: "📊", color: "blue", aliases: ["ai", "poll", "survey", "설문"] },
                    email: { title: "AI · Draft email", emoji: "✉️", color: "purple", aliases: ["ai", "email", "draft", "이메일"] },
                    action_items: { title: "AI · Action items", emoji: "📌", color: "green", aliases: ["ai", "action", "actions", "할일 추출"] },
                    quote: { title: "AI · Pick quotes", emoji: "❝", color: "blue", aliases: ["ai", "quote", "quotes", "인용"] },
                    tone: { title: "AI · Change tone", emoji: "🎚", color: "purple", aliases: ["ai", "tone", "formal", "casual"] },
                    longer: { title: "AI · Make longer", emoji: "📏", color: "blue", aliases: ["ai", "longer", "expand", "더 길게"] },
                    shorter: { title: "AI · Make shorter", emoji: "✂️", color: "blue", aliases: ["ai", "shorter", "compress", "더 짧게"] },
                    glossary: { title: "AI · Glossary", emoji: "📖", color: "yellow", aliases: ["ai", "glossary", "terms", "용어"] },
                    sentiment: { title: "AI · Sentiment", emoji: "😊", color: "blue", aliases: ["ai", "sentiment", "tone", "감정"] },
                    next_steps: { title: "AI · Next steps", emoji: "🚶", color: "green", aliases: ["ai", "next", "steps", "다음 단계"] },
                    critique: { title: "AI · Critique", emoji: "🧐", color: "purple", aliases: ["ai", "critique", "review", "피드백"] },
                    agenda: { title: "AI · Meeting agenda", emoji: "📋", color: "blue", aliases: ["ai", "agenda", "meeting", "안건"] },
                    eli5: { title: "AI · Explain like I'm 5", emoji: "🧒", color: "yellow", aliases: ["ai", "eli5", "simple", "쉽게"] },
                    pros_cons: { title: "AI · Pros & cons", emoji: "⚖️", color: "purple", aliases: ["ai", "pros", "cons", "찬반"] },
                    risks: { title: "AI · Identify risks", emoji: "⚠️", color: "red", aliases: ["ai", "risks", "risk", "위험"] },
                    timeline: { title: "AI · Build timeline", emoji: "🕒", color: "blue", aliases: ["ai", "timeline", "chronology", "연대표"] },
                    faq: { title: "AI · Generate FAQ", emoji: "❓", color: "green", aliases: ["ai", "faq", "questions", "질문"] },
                    counter: { title: "AI · Counter-argument", emoji: "🛡️", color: "red", aliases: ["ai", "counter", "rebuttal", "반박"] },
                    hashtags: { title: "AI · Hashtags", emoji: "#️⃣", color: "blue", aliases: ["ai", "hashtags", "tags", "해시태그"] },
                    headlines: { title: "AI · 5 alt headlines", emoji: "📰", color: "yellow", aliases: ["ai", "headlines", "headline", "헤드라인"] },
                    slug: { title: "AI · Suggest URL slug", emoji: "🔗", color: "blue", aliases: ["ai", "slug", "url", "주소"] },
                    tweet_thread: { title: "AI · Tweet thread", emoji: "🐦", color: "blue", aliases: ["ai", "tweet", "twitter", "thread", "트윗"] },
                    citations: { title: "AI · Citation check", emoji: "📚", color: "purple", aliases: ["ai", "citations", "sources", "출처"] },
                    edit: { title: "AI · Edit (custom)", emoji: "🪄", color: "red", aliases: ["ai", "edit", "custom", "transform"] },
                  }[action];
                  return {
                    title: meta.title,
                    subtext: "Sends the surrounding text to /api/ai",
                    aliases: meta.aliases,
                    group: "AI",
                    icon: <span>{meta.emoji}</span>,
                    onItemClick: async () => {
                      let instruction: string | null = null;
                      if (action === "edit") {
                        instruction = window.prompt(
                          "What should AI do with the surrounding text?",
                          "Make it more concise",
                        );
                        if (!instruction || !instruction.trim()) return;
                      } else if (action === "translate") {
                        instruction = window.prompt(
                          "Target language?",
                          "English",
                        );
                        if (!instruction || !instruction.trim()) return;
                      } else if (action === "tone") {
                        instruction = window.prompt(
                          "Tone? (e.g. formal, casual, friendly, assertive)",
                          "more formal",
                        );
                        if (!instruction || !instruction.trim()) return;
                      }
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
                          body: JSON.stringify({ action, text, instruction }),
                        });
                        const data = (await res.json()) as { output?: string; error?: string };
                        const out = data.output || data.error || "(no response)";
                        // Replace placeholder with a labeled callout (kept brief) +
                        // the actual paragraph below, which is freely editable. The
                        // user can delete the callout to "apply" the result.
                        editor.updateBlock(inserted, {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          content: [
                            { type: "text", text: `${meta.title} ✓`, styles: { bold: true } },
                            { type: "text", text: " — delete this callout to keep just the result below.", styles: {} },
                          ] as any,
                        });
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        editor.insertBlocks(
                          [
                            {
                              type: "paragraph",
                              content: out
                                .split(/\n\n+/)
                                .map((p, i, arr) => ({
                                  type: "text",
                                  text: p + (i < arr.length - 1 ? "\n" : ""),
                                  styles: {},
                                })),
                            } as any,
                          ],
                          inserted,
                          "after",
                        );
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function EmptyHint({ editor }: { editor: any }) {
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    if (!editor) return;
    const check = () => {
      const doc = editor.document;
      if (!doc || doc.length === 0) {
        setEmpty(true);
        return;
      }
      if (doc.length > 1) {
        setEmpty(false);
        return;
      }
      const only = doc[0];
      const hasText =
        Array.isArray(only?.content) &&
        only.content.some(
          (c: { text?: unknown }) =>
            c && typeof c === "object" && typeof c.text === "string" && c.text.length > 0,
        );
      setEmpty(!hasText);
    };
    check();
    const un = editor.onChange?.(check);
    return () => un?.();
  }, [editor]);
  if (!empty) return null;
  return (
    <div className="text-[11px] text-gray-400 mt-2 mb-1 select-none pointer-events-none">
      Type <kbd className="px-1 py-0.5 border border-gray-200 rounded text-[10px]">/</kbd>{" "}
      for commands · <kbd className="px-1 py-0.5 border border-gray-200 rounded text-[10px]">@</kbd>{" "}
      to mention · drag a file here to upload
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
