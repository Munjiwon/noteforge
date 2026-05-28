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

  // `:shortcode:` → emoji autoreplace. Fires when the user types the closing
  // colon. Small built-in dictionary; covers the most-used shortcodes.
  useEffect(() => {
    if (readOnly) return;
    const map: Record<string, string> = {
      smile: "😄", laugh: "😂", joy: "😂", grin: "😁", wink: "😉",
      heart: "❤️", love: "❤️", "+1": "👍", thumbsup: "👍", "-1": "👎",
      thumbsdown: "👎", clap: "👏", fire: "🔥", rocket: "🚀", tada: "🎉",
      party: "🥳", check: "✅", cross: "❌", warning: "⚠️", star: "⭐",
      sparkles: "✨", eyes: "👀", thinking: "🤔", shrug: "🤷", cry: "😢",
      sad: "😢", angry: "😠", sweat: "😅", pray: "🙏", muscle: "💪",
      brain: "🧠", bug: "🐛", wrench: "🔧", lock: "🔒", unlock: "🔓",
      calendar: "📅", clock: "⏰", phone: "📱", bulb: "💡", memo: "📝",
      mag: "🔍", chart: "📊", pin: "📌", link: "🔗", zap: "⚡",
      coffee: "☕", pizza: "🍕", cake: "🎂", tea: "🍵",
    };
    const onInput = (e: KeyboardEvent) => {
      if (e.key !== ":") return;
      const sel = window.getSelection?.();
      if (!sel || !sel.focusNode || sel.focusNode.nodeType !== Node.TEXT_NODE)
        return;
      const node = sel.focusNode as Text;
      const offset = sel.focusOffset;
      const text = node.textContent ?? "";
      // We see the keydown BEFORE the colon is inserted; look for an opening
      // ":word" right behind the caret.
      const m = /:([a-z+_-]{2,16})$/i.exec(text.slice(0, offset));
      if (!m) return;
      const code = m[1].toLowerCase();
      const emoji = map[code];
      if (!emoji) return;
      e.preventDefault();
      // remove the ":word" then insert the emoji using execCommand so undo
      // works naturally.
      const range = document.createRange();
      range.setStart(node, offset - m[0].length);
      range.setEnd(node, offset);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        document.execCommand("insertText", false, emoji);
      } catch {}
    };
    window.addEventListener("keydown", onInput, true);
    return () => window.removeEventListener("keydown", onInput, true);
  }, [readOnly]);

  // '@today' / '@tomorrow' / '@now' / '@yesterday' autoreplace.
  // Triggers when the user types whitespace right after the keyword.
  useEffect(() => {
    if (readOnly) return;
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Enter" && e.key !== "Tab") return;
      const sel = window.getSelection?.();
      if (!sel || !sel.focusNode || sel.focusNode.nodeType !== Node.TEXT_NODE)
        return;
      const node = sel.focusNode as Text;
      const offset = sel.focusOffset;
      const text = node.textContent ?? "";
      const m = /@(today|tomorrow|yesterday|now|noon)$/i.exec(
        text.slice(0, offset),
      );
      if (!m) return;
      const keyword = m[1].toLowerCase();
      let replacement = "";
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 86_400_000);
      const yesterday = new Date(today.getTime() - 86_400_000);
      if (keyword === "today") replacement = fmtDate(today);
      else if (keyword === "tomorrow") replacement = fmtDate(tomorrow);
      else if (keyword === "yesterday") replacement = fmtDate(yesterday);
      else if (keyword === "now") replacement = today.toISOString().slice(0, 16).replace("T", " ");
      else if (keyword === "noon") replacement = `${fmtDate(today)} 12:00`;
      if (!replacement) return;
      // Replace the @keyword with the date, then let the original keystroke
      // proceed (space/enter naturally follows).
      const range = document.createRange();
      range.setStart(node, offset - m[0].length);
      range.setEnd(node, offset);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        document.execCommand("insertText", false, replacement);
      } catch {}
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [readOnly]);

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
      <EmojiPickerOverlay />
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
                title: "Emoji picker",
                subtext: "Search and insert an emoji (or type :name: inline)",
                aliases: ["emoji", "icon", "이모지"],
                group: "Basic blocks",
                icon: <span>😀</span>,
                onItemClick: () => {
                  window.dispatchEvent(new CustomEvent("noteforge:emoji-picker"));
                },
              },
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
                ? (["summarize", "one_liner", "translate", "improve", "proofread", "continue", "explain", "outline", "keywords", "ideas", "checklist", "poll", "email", "action_items", "quote", "tone", "longer", "shorter", "glossary", "sentiment", "next_steps", "critique", "agenda", "eli5", "pros_cons", "risks", "timeline", "faq", "counter", "hashtags", "headlines", "slug", "tweet_thread", "citations", "study_notes", "flashcards", "quiz", "persona", "swot", "release_notes", "objections", "decision_log", "user_stories", "test_cases", "rhyme", "lyrics", "regex", "sql", "commit_msg", "standup", "retro", "jargon", "mind_map", "elevator_pitch", "job_desc", "follow_up", "sub_headings", "anti_pattern", "dictionary", "expand_acronyms", "star_method", "key_takeaways", "email_reply", "cover_letter", "pre_publish", "tagline", "metaphor", "press_release", "interview_questions", "linkedin_post", "blog_outline", "testimonials", "contrarian", "dialog", "seo_keywords", "news_headline", "recommendation_letter", "scenario", "risk_matrix", "api_spec", "raci", "value_prop", "cta", "landing_hero", "onboarding_email", "insight_3", "dictation_clean", "clean_formatting", "inverse_pyramid", "contrast_vs", "buyer_persona", "feature_benefit", "learn_vocab", "business_canvas", "competitive_analysis", "postmortem", "case_study", "customer_interview", "release_tweet", "job_offer_email", "spec_template", "okrs", "onboarding_checklist", "prd", "sales_pitch", "cold_email", "q_and_a", "agenda_action", "escalation_email", "proposal", "roadmap", "sprint_plan", "standup_async", "release_detailed", "code_review", "devil_advocate", "objection_handler", "changelog_emoji", "inverse_faq", "style_guide", "email_friendly", "persona_quote", "voice_script", "short_bio", "long_bio", "job_rejection", "recruiting_msg", "exec_summary", "lessons_learned", "decision_memo", "release_faq", "launch_checklist", "feedback_questions", "user_research_plan", "discovery_questions", "product_tour", "day_in_life", "founder_story", "positioning", "ad_copy", "headline_test", "before_after", "social_proof", "error_msg", "migration_guide", "legal_disclaimer", "privacy_summary", "api_changelog", "whitepaper_outline", "press_quote", "customer_quote", "content_calendar", "seo_meta", "alt_text", "thumbnail_text", "survey_design", "system_prompt", "talking_points", "brief_from_bullets", "haiku", "quotes_on_topic", "tldr_emoji", "icebreaker", "one_on_one", "customer_pain", "pivot_options", "risk_register", "team_charter", "values_statement", "swot_personal", "career_pitch", "resignation_letter", "welcome_message", "exit_interview", "checkin_questions", "lunch_and_learn", "coffee_chat", "personal_mission", "book_summary_3", "weekly_review", "monthly_review", "goal_tree", "habits_list", "reading_list", "mantra", "vision_statement", "quarterly_okrs", "negotiation_script", "performance_review", "perf_feedback", "skip_level", "feedback_360", "career_ladder", "comp_band", "pip_plan", "reorg_memo", "hiring_rubric", "reference_check", "promotion_case", "short_story", "character_bio", "worldbuilding", "dialogue_scene", "lesson_plan", "study_plan", "architecture_review", "docstring", "sample_data", "json_schema", "sql_optimize", "code_comment", "investor_update", "board_update", "pitch_deck", "gtm_plan", "pricing_strategy", "financial_narrative", "branding_attributes", "tone_voice", "editorial_calendar", "cs_playbook", "discovery_deck", "github_issue", "github_pr", "apology_letter", "thank_you_note", "reddit_post", "hn_post", "screenplay_scene", "story_arc", "sonnet", "free_verse", "idiom_translate", "comedian_bit", "yelp_review", "recipe", "handover_doc", "runbook", "troubleshooting", "partnership_pitch", "demo_day_pitch", "angel_update", "buying_guide", "comparison_vs", "one_pager", "meeting_recap", "knowledge_transfer", "eli_expert", "press_statement", "investor_faq", "linkedin_newsletter", "thought_leader", "podcast_notes", "video_script", "infographic_labels", "toast_speech", "wedding_toast", "birthday_message", "condolence", "referral_request", "linkedin_profile", "substack_post", "elevator_no_jargon", "data_table_narrative", "chart_caption", "dashboard_summary", "sql_explain", "cli_help", "error_explain", "refactor_suggest", "test_edge_cases", "name_suggest", "explain_diagram", "sequence_diagram", "state_machine", "ad_headlines", "og_tags", "commit_template", "branch_name", "unit_test_skeleton", "readme_skeleton", "contributing_md", "license_pick", "cron_explain", "regex_explain", "env_var_doc", "elevator_perspectives", "twitter_bio", "instagram_caption", "tiktok_hook", "youtube_title", "youtube_description", "app_store_desc", "notification_copy", "email_subject_ab", "empty_state_copy", "message_404", "maintenance_notice", "system_status_blurb", "holiday_greeting", "jira_ticket", "linear_ticket", "weekly_status", "exec_1pager", "risk_rag", "budget_narrative", "faq_localize", "security_runbook", "incident_customer_comms", "tweet_rewrite", "linkedin_comment", "yc_application", "cv_bullet", "lightning_talk", "conference_cfp", "talk_abstract", "intro_bio_speaker", "workshop_plan", "curriculum_outline", "test_plan", "bug_priority", "eli5_medical", "eli5_legal", "eli5_financial", "family_update", "old_friend_msg", "ad_mock_banner", "google_ad", "facebook_ad", "email_sequence_5", "welcome_flow", "upsell_msg", "cancel_recovery", "winback", "nps_followup", "csat_script", "handoff_summary", "ooo_message", "calendar_invite_note", "job_listing", "job_rejection_no_fit", "internship_jd", "relocation_package", "sabbatical_pitch", "raise_request", "promotion_self_pitch", "transfer_request", "remote_policy", "handbook_page", "code_of_conduct", "community_rules", "diversity_statement", "social_bio", "influencer_pitch", "affiliate_pitch", "landing_tour", "security_policy", "incident_tweet", "onboarding_tour", "ff_rollout", "experiment_plan", "experiment_readout", "metric_tree", "cohort_analysis", "proposal_cover", "sow", "msa_summary", "nda_summary", "dpia", "soc2_readiness", "gdpr_data_map", "dpa_clause", "rate_limit_msg", "billing_failure_msg", "refund_policy", "data_retention_policy", "cookie_banner_copy", "elevator_tldr", "changelog_html", "sql_seed", "dockerfile", "compose_yml", "gh_actions", "k8s_deploy", "nginx_conf", "oauth_flow", "jwt_claims", "webhook_payload", "data_model", "api_versioning", "prd_section", "ux_copy_review", "accessibility_review", "perf_budget", "observability_plan", "error_budget_slo", "disaster_recovery", "threat_model", "api_deprecation", "feature_sunset", "beta_invite", "waitlist_email", "early_access_email", "emails_7day", "lead_magnet_idea", "landing_faq", "landing_feature_grid", "pricing_faq", "comparison_grid", "vp_canvas", "jtbd", "north_star_narrative", "customer_journey", "pain_relief_list", "aha_moment", "activation_events", "funding_roadmap", "saas_pricing_page", "usage_pricing", "trial_conversion_email", "feat_deprecation_roadmap", "launch_day_checklist", "product_hunt_launch", "changelog_blog_post", "release_tweet_thread", "dev_blog_post", "api_doc_endpoint", "cli_tutorial", "sdk_getting_started", "ux_microcopy", "dialog_confirm", "form_error", "tooltip_copy", "onboarding_tooltip_seq", "empty_state_variations", "loading_skeleton_text", "cta_variants", "banner_promo", "sale_headline", "seasonal_campaign", "referral_program_copy", "discount_code_email", "affiliate_terms", "terms_of_service", "privacy_policy", "eula", "sla_template", "acceptable_use", "return_policy", "shipping_policy", "warranty_terms", "agency_pitch_deck", "freelance_quote", "client_onboarding", "invoice_narrative", "copywriter_feedback", "editor_rewrite", "translate_batch", "transliterate", "native_rewrite", "honorific_ko", "casual_ko", "business_ko", "email_ko_polite", "kakao_msg", "announcement_ko", "biz_card_bio", "elevator_mom_test", "yo_style_ko", "grandma_explain", "movie_pitch", "changelog_from_bullets", "contract_summary", "explain_acronym", "dramatize", "karaoke_lyrics", "legal_plain_ko", "yc_pitch", "meeting_minutes", "sprint_retro_detailed", "user_story_acceptance", "bug_repro", "api_mock_response", "changelog_merge", "customer_followup_ko", "release_blog_ko", "sql_from_schema", "excel_formula", "onboarding_survey_ko", "refund_letter_ko", "news_summary_ko", "recipe_shopping_list", "podcast_guest_questions", "email_subject_5", "research_summary", "tough_questions", "legalese_detect", "translate_natural_en", "safety_review", "style_mirror", "biz_eng_email", "intro_ko_formal", "ui_spec_from_desc", "dad_jokes", "jp_business_polite", "git_conflict_resolve", "copy_3_tones", "sql_explain_ko", "jira_from_bug", "slack_rephrase_ko", "pitch_slide_titles", "customer_quote_ko", "release_go_no_go", "icp_profile", "competitive_moat", "postmortem_ko", "headline_rewrite_ko", "email_decline_ko", "api_docs_from_code", "db_schema_naming", "translate_formal_en", "translate_formal_ko", "customer_segments", "email_thread_summary", "pr_review_checklist", "onboarding_30_60_90", "sales_call_script_ko", "contract_redline", "spec_to_test_cases", "log_pattern_detect", "regression_risk", "db_migration_plan", "marketing_positioning", "welcome_pack_ko", "incident_report_customer", "team_okr_quarterly", "translate_academic_en", "sales_objection_handle_ko", "competitor_feature_matrix", "jira_from_spec", "translate_poetic_ko", "sales_email_cold_ko", "event_mc_script", "incident_rca_5whys", "feature_naming", "release_note_internal", "cv_bullet_impact", "journal_prompt_ko", "translate_natural_ko", "release_tweet_thread_ko", "feedback_rewrite_constructive", "bullets_to_paragraph", "paragraph_to_bullets", "code_comment_jsdoc", "k8s_yaml_from_app", "dockerfile_multistage", "git_rebase_strategy", "cors_config", "changelog_ko", "scam_detect_ko", "contract_clause_explain_ko", "study_cheatsheet", "saas_onboarding_checklist", "email_thank_customer_ko", "community_rules_ko", "translate_formal_jp", "dashboard_widgets_spec", "error_message_friendly", "translate_academic_ko", "code_explain_line_by_line", "sql_optimize_ko", "customer_call_script_ko", "marketing_email_segments", "youtube_script_3min", "twitter_bio_3_ko", "sql_window_function", "release_rollback_plan", "api_pagination_design", "diff_intent_explain", "feature_flag_rollout", "release_notes_detailed_ko", "translate_marketing_en", "devops_runbook", "comment_intent_rewrite", "sales_discovery_questions_ko", "db_er_diagram_mermaid", "incident_comms_internal", "copy_rewrite_3_angles", "translate_casual_en", "code_security_review", "changelog_monthly_rollup", "product_tour_script_ko", "email_intro_warm_ko", "log_redact_pii", "career_narrative_ko", "api_error_codes", "standup_summary_team_ko", "regex_test_cases", "error_msg_multilingual", "team_intro_ko", "strategy_1pager", "translate_poetic_en", "api_deprecation_ko", "postmortem_detailed", "customer_meeting_prep", "changelog_twitter_thread", "translate_poetic_jp", "bio_3_lengths", "landing_hero_3_variant", "release_blog_en", "translate_cs_formal_ko", "api_readme_from_spec", "sprint_goal_statement", "incident_tweet_public_ko", "podcast_intro_host_ko", "code_rename_suggest", "error_msg_empathic_ko", "recruiter_reply_ko", "translate_business_jp", "landing_faq_ko", "pricing_objection_ko", "competitor_positioning", "sql_explain_en", "contract_redline_ko", "sql_from_csv", "release_1_liner", "customer_story_narrative", "api_error_codes_ko", "translate_marketing_ko", "refactor_suggest_ko", "test_strategy_doc", "incident_summary_exec_ko", "feedback_1_1_ko", "jira_epic_breakdown", "sales_discovery_summary_ko", "landing_cta_5_variant", "legal_clause_en", "customer_research_synthesis", "sales_email_warm_ko", "changelog_html_ko", "discovery_call_prep_ko", "feature_request_response_ko", "translate_legal_en", "bug_repro_steps_ko", "weekly_status_summary_ko", "ux_review_checklist", "api_error_friendly_ko", "investor_followup_email_ko", "competitor_teardown_ko", "user_persona_short_ko", "sprint_demo_script_ko", "blog_seo_outline_ko", "translate_marketing_jp", "press_release_short_ko", "incident_status_page_ko", "qbr_deck_outline", "cs_followup_email_ko", "release_email_customer_ko", "okr_personal_quarterly_ko", "stakeholder_update_email_ko", "youtube_chapter_titles_ko", "translate_business_ko", "team_charter_ko", "negotiation_email_ko", "perf_review_self_ko", "saas_trial_email_d3_ko", "open_source_readme_ko", "code_review_feedback_ko", "intro_email_to_team_ko", "reorg_announcement_ko", "thank_you_customer_review_ko", "raise_request_email_ko", "monthly_growth_recap_ko", "feature_kill_announcement_ko", "outage_post_mortem_ko", "investor_pitch_one_liner", "trade_show_booth_copy_ko", "linkedin_post_thought_leader_ko", "translate_casual_ko", "haiku_ko", "sql_join_explain", "yaml_to_table", "investor_metrics_one_pager_ko", "tldr_3_layers", "ad_copy_3_languages", "decision_doc_one_pager_ko", "founder_update_email_ko", "brand_voice_audit_ko", "scrum_standup_summary_ko", "kickoff_meeting_agenda_ko", "podcast_show_notes_ko", "translate_korean_dialect_seoul", "user_onboarding_video_script_ko", "social_media_calendar_week_ko", "pricing_change_announcement_ko", "investor_anti_pitch_ko", "weekly_1_1_agenda_ko", "marketing_tagline_ab_test_ko", "user_journey_map_ko", "translate_ko_to_chinese", "fundraising_pipeline_update_ko", "tech_debt_priority_ko", "saas_renewal_email_ko", "interview_invite_email_ko", "press_pitch_email_en", "release_video_script_ko", "user_research_plan_ko", "stakeholder_meeting_summary_ko", "support_ticket_response_ko", "github_issue_template_ko", "data_dashboard_narrative_ko", "onboarding_checklist_30day_ko", "advisor_outreach_ko", "product_hunt_launch_post_ko", "customer_quote_card_ko", "release_email_internal_ko", "ux_microcopy_5_states", "translate_jp_to_ko", "weekly_okr_check_in_ko", "executive_decision_brief_ko", "translate_de_to_ko", "user_interview_invite_email_ko", "ad_landing_copy_ko", "marketing_campaign_brief_ko", "team_value_workshop_ko", "incident_runbook_ko", "product_market_fit_survey_ko", "investor_thank_you_pass_ko", "engineering_onboarding_repo_ko", "press_release_long_ko", "founder_intro_email_warm_ko", "customer_invoice_followup_ko", "developer_advocate_post_ko", "stretch_goal_okr_ko", "translate_french_to_ko", "support_macro_collection_ko", "linkedin_referral_request_ko", "dashboards_alert_thresholds_ko", "podcast_intro_30sec_ko", "saas_winback_email_ko", "freelance_proposal_ko", "translate_es_to_ko", "weekly_email_newsletter_ko", "competitor_landing_breakdown_ko", "engineering_blog_post_ko", "intern_project_brief_ko", "investor_referral_intro_ko", "customer_advisory_invite_ko", "translate_pt_to_ko", "ml_experiment_writeup_ko", "ai_prompt_template_ko", "exit_interview_questions_ko", "marketing_email_segments_3_ko", "client_kickoff_email_ko", "team_retro_facilitation_ko", "design_critique_template_ko", "translate_it_to_ko", "open_letter_to_community_ko", "tweetstorm_8_ko", "translate_ko_to_vietnamese", "data_request_email_ko", "all_hands_speech_ko", "investor_data_room_index_ko", "patent_disclosure_summary_ko", "translate_ko_to_thai", "youtube_metadata_ko", "office_hours_email_ko", "annual_planning_one_pager_ko", "video_thumbnail_text_3_ko", "translate_ko_to_russian", "incident_war_room_intro_ko", "marketing_one_pager_partner_ko", "translate_ru_to_ko", "feature_specification_short_ko", "talent_referral_email_ko", "translate_zh_to_ko", "press_followup_email_en", "investor_intro_round_close_ko", "translate_ar_to_ko", "user_test_report_ko", "release_notes_html_ko", "ai_safety_eval_plan_ko", "translate_ko_to_arabic", "demo_day_script_ko", "discord_announcement_ko", "compliance_questionnaire_ko", "translate_id_to_ko", "growth_experiment_log_ko", "translate_ko_to_indonesian", "user_journey_map_storyboard_ko", "translate_ko_to_german", "support_escalation_template_ko", "team_offsite_agenda_2day_ko", "translate_ko_to_french", "internal_changelog_dev_ko", "translate_ko_to_italian", "linkedin_company_post_ko", "translate_ko_to_spanish", "translate_ko_to_japanese_business", "product_naming_brainstorm_ko", "translate_ko_to_portuguese", "cross_team_async_update_ko", "customer_health_score_definition_ko", "translate_ko_to_polish", "marketing_email_ab_subject_5_ko", "translate_ko_to_dutch", "pre_launch_checklist_ko", "founder_well_being_check_ko", "translate_ko_to_swedish", "all_hands_qna_doc_ko", "ux_writing_button_5_ko", "partner_intro_call_followup_ko", "translate_ko_to_turkish", "security_advisory_user_ko", "translate_ko_to_hebrew", "retention_cohort_writeup_ko", "talent_offer_letter_ko", "translate_ko_to_norwegian", "investor_followup_silence_ko", "translate_ko_to_finnish", "brand_color_palette_ko", "customer_pain_interview_qs_ko", "translate_ko_to_danish", "sales_email_winback_d60_ko", "sprint_review_demo_outline_ko", "translate_ko_to_czech", "ad_copy_3_variations_ko", "ai_eval_rubric_ko", "translate_ko_to_greek", "contract_negotiation_email_ko", "podcast_pitch_to_show_ko", "translate_ko_to_hungarian", "customer_referral_request_ko", "translate_ko_to_romanian", "weekly_ic_writeup_ko", "faq_from_support_tickets_ko", "translate_ko_to_swahili", "growth_loop_design_ko", "translate_ko_to_ukrainian", "decision_log_entry_ko", "customer_video_testimonial_brief_ko", "translate_ko_to_bulgarian", "recruiter_inmail_ko", "translate_ko_to_serbian", "npm_package_readme_ko", "translate_ko_to_filipino", "sales_qbr_internal_ko", "dei_statement_ko", "translate_ko_to_malay", "customer_call_prep_qbr_ko", "translate_ko_to_hindi", "slack_channel_charter_ko", "translate_ko_to_bengali", "perf_calibration_doc_ko", "translate_ko_to_tamil", "employer_brand_post_ko", "translate_ko_to_urdu", "ux_research_recruitment_screener_ko", "translate_ko_to_persian", "internal_tools_doc_ko", "translate_ko_to_burmese", "beta_feedback_request_ko", "translate_ko_to_khmer", "design_review_doc_ko", "translate_ko_to_lao", "customer_renewal_call_prep_ko", "translate_ko_to_mongolian", "public_roadmap_intro_ko", "translate_ko_to_uzbek", "board_meeting_prep_doc_ko", "translate_ko_to_kazakh", "employee_handbook_intro_ko", "translate_ko_to_georgian", "sales_demo_followup_email_ko", "translate_ko_to_armenian", "contractor_offer_email_ko", "translate_ko_to_amharic", "gdpr_dsr_response_ko", "final_milestone_celebration_email_ko", "milestone_complete_announcement_ko", "translate_ko_to_albanian", "competitor_battle_card_ko", "translate_ko_to_macedonian", "incident_postmortem_blameless_ko", "translate_ko_to_estonian", "meeting_decision_log_ko", "translate_ko_to_latvian", "okr_q3_alignment_doc_ko", "translate_ko_to_lithuanian", "customer_kickoff_email_ko", "translate_ko_to_slovenian", "engineering_design_doc_short_ko", "translate_ko_to_slovak", "partnership_proposal_email_ko", "translate_ko_to_croatian", "engineering_hiring_loop_doc_ko", "translate_ko_to_serbian_latin", "customer_advocacy_program_intro_ko", "translate_ko_to_bosnian", "product_principles_doc_ko", "translate_ko_to_montenegrin", "growth_marketing_funnel_audit_ko", "translate_ko_to_maltese", "internal_comms_layoff_announcement_ko", "translate_ko_to_icelandic", "customer_referral_program_intro_ko", "translate_ko_to_welsh", "sales_negotiation_concession_ladder_ko", "translate_ko_to_irish", "quarterly_growth_review_email_ko", "translate_ko_to_scottish_gaelic", "pm_weekly_writeup_to_eng_ko", "translate_ko_to_catalan", "incident_communications_press_ko", "translate_ko_to_basque", "customer_health_review_call_ko", "translate_ko_to_galician", "marketing_brief_template_ko", "translate_ko_to_yoruba", "engineering_team_charter_ko", "translate_ko_to_igbo", "customer_first_30day_review_ko", "translate_ko_to_hausa", "executive_offsite_agenda_ko", "translate_ko_to_zulu", "quarterly_engineering_planning_ko", "translate_ko_to_xhosa", "customer_pmf_survey_ko", "translate_ko_to_pashto", "pricing_proposal_internal_ko", "translate_ko_to_sinhala", "customer_voice_synthesis_ko", "translate_ko_to_punjabi", "engineering_oncall_handoff_doc_ko", "translate_ko_to_marathi", "marketing_campaign_postmortem_ko", "translate_ko_to_telugu", "sales_pipeline_review_internal_ko", "translate_ko_to_kannada", "team_meeting_async_format_ko", "translate_ko_to_malayalam", "customer_quarterly_strategic_review_ko", "translate_ko_to_gujarati", "engineering_runbook_template_ko", "translate_ko_to_odia", "marketing_pr_pitch_email_ko", "translate_ko_to_assamese", "customer_offboarding_email_ko", "translate_ko_to_nepali", "team_retro_continue_stop_start_ko", "translate_ko_to_kashmiri", "engineering_arch_review_doc_ko", "translate_ko_to_dari", "customer_renewal_negotiation_email_ko", "translate_ko_to_swiss_german", "sales_cold_call_script_ko", "translate_ko_to_pidgin_english", "culture_doc_principles_ko", "translate_ko_to_papiamento", "customer_check_in_30_day_email_ko", "translate_ko_to_swiss_french", "customer_executive_qbr_pre_brief_ko", "translate_ko_to_quebec_french", "brand_naming_brainstorm_ko", "translate_ko_to_brazilian_portuguese", "internal_announcement_promotion_ko", "translate_ko_to_mexican_spanish", "customer_complaint_response_ko", "translate_ko_to_argentinian_spanish", "team_okr_check_in_doc_ko", "translate_ko_to_castilian_spanish", "customer_renewal_at_risk_email_ko", "translate_ko_to_european_portuguese", "legal_template_nda_short_ko", "translate_ko_to_european_french", "partnerships_intro_summary_ko", "translate_ko_to_european_german", "customer_invoice_overdue_email_ko", "translate_ko_to_austrian_german", "weekly_team_health_pulse_ko", "translate_ko_to_andean_spanish", "customer_qr_code_handout_ko", "translate_ko_to_caribbean_spanish", "exec_team_huddle_agenda_ko", "translate_ko_to_chilean_spanish", "customer_loyalty_offer_email_ko", "translate_ko_to_peruvian_spanish", "internal_skip_level_invite_ko", "translate_ko_to_colombian_spanish", "customer_quarterly_winback_email_ko", "translate_ko_to_uruguayan_spanish", "customer_executive_intro_email_ko", "translate_ko_to_paraguayan_spanish", "competitive_displacement_playbook_ko", "translate_ko_to_venezuelan_spanish", "internal_offsite_planning_doc_ko", "translate_ko_to_dominican_spanish", "customer_seat_expansion_email_ko", "translate_ko_to_panamanian_spanish", "engineering_postmortem_template_ko", "translate_ko_to_canadian_english", "customer_segment_definition_doc_ko", "translate_ko_to_australian_english", "internal_all_hands_qna_doc_ko", "translate_ko_to_british_english", "customer_journey_email_series_ko", "translate_ko_to_indian_english", "saas_metrics_glossary_ko", "translate_ko_to_singapore_english", "team_growth_plan_individual_ko", "translate_ko_to_irish_english", "customer_renewal_30day_email_ko", "translate_ko_to_south_african_english", "employee_referral_program_ko", "translate_ko_to_new_zealand_english", "customer_advisory_board_invite_ko", "translate_ko_to_hong_kong_english", "internal_eng_hiring_kickoff_ko", "translate_ko_to_philippine_english", "customer_renewal_signed_thank_you_ko", "translate_ko_to_jamaican_english", "customer_csm_intro_email_ko", "translate_ko_to_kenyan_english", "eng_team_summit_outline_ko", "translate_ko_to_nigerian_english", "customer_referral_thanks_email_ko", "translate_ko_to_ghanaian_english", "internal_security_training_outline_ko", "translate_ko_to_tanzanian_english", "customer_quarterly_open_house_ko", "translate_ko_to_caribbean_english", "customer_pmf_interview_questions_ko", "translate_ko_to_west_african_french", "internal_compensation_change_announcement_ko", "translate_ko_to_belgian_french", "customer_health_dashboard_design_ko", "translate_ko_to_belgian_dutch", "internal_team_health_survey_quarterly_ko", "translate_ko_to_netherlands_dutch", "customer_handoff_email_csm_to_sales_ko", "translate_ko_to_swiss_italian", "customer_pricing_objection_response_ko", "translate_ko_to_italian_dialect_neapolitan", "internal_strategy_change_memo_ko", "translate_ko_to_italian_dialect_sicilian", "customer_q_and_a_template_blog_ko", "translate_ko_to_italian_dialect_milanese", "internal_eng_blameless_culture_doc_ko", "translate_ko_to_swiss_romansh", "customer_satisfaction_followup_email_ko", "translate_ko_to_swahili_dialect", "customer_co_marketing_brief_ko", "translate_ko_to_amharic_dialect", "internal_eng_quality_doc_ko", "translate_ko_to_thai_business", "customer_first_renewal_letter_ko", "translate_ko_to_vietnamese_business", "competitive_intelligence_brief_ko", "translate_ko_to_indonesian_business", "customer_invoice_received_thanks_ko", "translate_ko_to_burmese_business", "customer_internal_champion_doc_ko", "translate_ko_to_khmer_business", "internal_eng_postmortem_action_followup_ko", "translate_ko_to_lao_business", "customer_data_export_request_response_ko", "translate_ko_to_mongolian_business", "internal_eng_dx_survey_ko", "translate_ko_to_uzbek_business", "customer_lessons_learned_brief_ko", "translate_ko_to_kazakh_business", "customer_user_research_invite_ko", "translate_ko_to_kazakh_cyrillic", "internal_eng_review_template_ko", "translate_ko_to_kyrgyz", "customer_renewal_signed_announcement_internal_ko", "translate_ko_to_turkmen", "internal_eng_capacity_planning_ko", "translate_ko_to_tajik", "customer_survey_results_share_ko", "translate_ko_to_baluchi", "customer_health_review_template_ko", "translate_ko_to_sindhi", "internal_pm_org_strategy_doc_ko", "translate_ko_to_sorbian", "customer_lifecycle_email_d100_ko", "translate_ko_to_frisian", "internal_exec_decision_brief_template_ko", "translate_ko_to_walloon", "customer_quarterly_innovation_share_ko", "translate_ko_to_chechen", "customer_renewal_decision_tree_ko", "translate_ko_to_chuvash", "internal_eng_rfc_template_ko", "translate_ko_to_yakut", "customer_email_intro_to_advisory_ko", "translate_ko_to_bashkir", "internal_pm_okr_template_ko", "translate_ko_to_tatar", "customer_pricing_grandfather_email_ko", "translate_ko_to_buryat", "customer_strategic_review_pre_brief_ko", "translate_ko_to_kalmyk", "internal_pm_eng_alignment_doc_ko", "translate_ko_to_avar", "customer_quarterly_listening_session_ko", "translate_ko_to_ossetian", "internal_eng_promotion_calibration_ko", "translate_ko_to_ingush", "customer_implementation_kickoff_call_agenda_ko", "translate_ko_to_lezgian", "customer_renewal_negotiation_phone_script_ko", "translate_ko_to_kumyk", "internal_eng_oncall_rotation_doc_ko", "translate_ko_to_karachay", "customer_implementation_health_check_ko", "translate_ko_to_balkar", "internal_pm_user_research_intake_ko", "translate_ko_to_nogai", "customer_renewal_lost_postmortem_ko", "translate_ko_to_komi", "customer_quarterly_qbr_action_items_ko", "translate_ko_to_udmurt", "internal_pm_planning_doc_template_ko", "translate_ko_to_mari_meadow", "customer_first_workflow_setup_email_ko", "translate_ko_to_mari_hill", "internal_pm_strategy_offsite_outline_ko", "translate_ko_to_erzya", "customer_proof_of_concept_summary_ko", "translate_ko_to_moksha", "customer_strategic_account_summary_ko", "translate_ko_to_karelian", "internal_pm_research_synthesis_template_ko", "translate_ko_to_veps", "customer_upsell_proposal_doc_ko", "translate_ko_to_livonian", "internal_eng_team_capacity_calendar_ko", "translate_ko_to_ingrian", "customer_renewal_pre_negotiation_doc_ko", "translate_ko_to_yiddish", "customer_implementation_30day_review_ko", "translate_ko_to_ladino", "internal_pm_research_intake_form_quick_ko", "translate_ko_to_judeo_arabic", "customer_health_save_play_ko", "translate_ko_to_aramaic", "internal_eng_arch_governance_doc_ko", "translate_ko_to_coptic", "customer_implementation_60day_review_ko", "translate_ko_to_circassian", "customer_quarterly_summary_email_ko", "translate_ko_to_abkhaz", "internal_pm_decision_template_ko", "translate_ko_to_lak", "customer_implementation_90day_review_ko", "translate_ko_to_dargin", "internal_eng_oncall_postmortem_doc_ko", "translate_ko_to_tabasaran", "customer_success_metrics_dashboard_ko", "translate_ko_to_breton", "customer_renewal_quote_email_ko", "translate_ko_to_cornish", "internal_eng_alerting_strategy_doc_ko", "translate_ko_to_manx", "customer_advisory_quarterly_recap_ko", "translate_ko_to_occitan", "internal_design_review_protocol_ko", "translate_ko_to_aromanian", "customer_data_retention_change_email_ko", "translate_ko_to_galician_variant", "customer_implementation_lessons_doc_ko", "translate_ko_to_asturian", "internal_pm_eng_sprint_planning_ko", "translate_ko_to_aragonese", "customer_renewal_handoff_email_ko", "translate_ko_to_leonese", "internal_eng_release_train_doc_ko", "translate_ko_to_extremaduran", "customer_implementation_lessons_external_blog_ko", "translate_ko_to_sardinian", "customer_renewal_thank_you_call_script_ko", "translate_ko_to_corsican", "internal_eng_tech_debt_register_ko", "translate_ko_to_friulian", "customer_renewal_lost_winback_plan_ko", "translate_ko_to_ladin", "internal_pm_feature_prioritization_ko", "translate_ko_to_romansh_sursilvan", "customer_qbr_deck_outline_detailed_ko", "translate_ko_to_romansh_vallader", "customer_renewal_save_email_ko", "translate_ko_to_romansh_puter", "internal_eng_incident_severity_doc_ko", "translate_ko_to_romansh_surmiran", "customer_quarterly_value_report_ko", "translate_ko_to_romansh_sutsilvan", "internal_pm_user_feedback_triage_ko", "translate_ko_to_griko", "customer_expansion_business_case_ko", "translate_ko_to_griko_calabrian", "customer_health_qbr_combined_doc_ko", "translate_ko_to_arberesh", "internal_eng_slo_definition_doc_ko", "translate_ko_to_cimbrian", "customer_renewal_multi_year_proposal_ko", "translate_ko_to_mocheno", "internal_pm_metric_definition_doc_ko", "translate_ko_to_walser", "customer_executive_business_review_agenda_ko", "translate_ko_to_gagauz", "customer_renewal_executive_email_ko", "translate_ko_to_crimean_tatar", "internal_eng_capacity_quarterly_review_ko", "translate_ko_to_karaim", "customer_account_plan_doc_ko", "translate_ko_to_krymchak", "internal_pm_launch_readiness_doc_ko", "translate_ko_to_urum", "customer_value_realization_plan_ko", "translate_ko_to_chuukese", "customer_renewal_internal_brief_ko", "translate_ko_to_marshallese", "internal_eng_deploy_checklist_ko", "translate_ko_to_palauan", "customer_onboarding_plan_30_60_90_ko", "translate_ko_to_chamorro", "internal_pm_beta_program_doc_ko", "translate_ko_to_fijian", "customer_win_story_internal_ko", "translate_ko_to_tongan", "customer_renewal_qbr_combined_email_ko", "translate_ko_to_samoan", "internal_eng_code_review_guide_ko", "translate_ko_to_tahitian", "customer_business_case_template_ko", "translate_ko_to_maori", "internal_pm_competitive_teardown_ko", "translate_ko_to_hawaiian", "customer_quarterly_check_in_call_ko", "translate_ko_to_tetum", "customer_renewal_at_risk_internal_alert_ko", "translate_ko_to_bislama", "internal_eng_branching_strategy_doc_ko", "translate_ko_to_tok_pisin", "customer_quarterly_data_share_ko", "translate_ko_to_hiri_motu", "internal_pm_roadmap_communication_ko", "translate_ko_to_nauruan", "customer_advocacy_case_study_outline_ko", "translate_ko_to_greenlandic", "customer_renewal_won_internal_ko", "translate_ko_to_inuktitut", "internal_eng_testing_strategy_doc_ko", "translate_ko_to_cree", "customer_quarterly_recap_internal_ko", "translate_ko_to_ojibwe", "internal_pm_experiment_design_doc_ko", "translate_ko_to_navajo", "customer_renewal_summary_finance_ko", "translate_ko_to_quechua", "customer_renewal_recap_exec_ko", "translate_ko_to_aymara", "internal_eng_observability_doc_ko", "translate_ko_to_guarani", "customer_health_weekly_digest_ko", "translate_ko_to_nahuatl", "internal_pm_quarterly_review_doc_ko", "translate_ko_to_mapudungun", "customer_kickoff_recap_email_ko", "translate_ko_to_haitian_creole", "customer_renewal_close_plan_ko", "translate_ko_to_jamaican_patois", "internal_eng_dependency_management_doc_ko", "translate_ko_to_seychellois_creole", "customer_quarterly_exec_email_ko", "translate_ko_to_mauritian_creole", "internal_pm_north_star_doc_ko", "translate_ko_to_cape_verdean_creole", "customer_success_plan_annual_ko", "translate_ko_to_papuan_malay", "customer_renewal_negotiation_summary_ko", "translate_ko_to_ambonese_malay", "internal_eng_secrets_management_doc_ko", "translate_ko_to_betawi", "customer_qbr_followup_email_ko", "translate_ko_to_minangkabau", "internal_pm_discovery_doc_ko", "translate_ko_to_sundanese", "customer_success_review_internal_ko", "translate_ko_to_javanese", "customer_executive_sponsor_intro_ko", "translate_ko_to_balinese", "internal_eng_feature_flag_doc_ko", "translate_ko_to_madurese", "customer_renewal_lost_exec_summary_ko", "translate_ko_to_acehnese", "internal_pm_user_persona_doc_ko", "translate_ko_to_buginese", "customer_quarterly_nps_followup_ko", "translate_ko_to_cebuano", "customer_renewal_pipeline_report_ko", "translate_ko_to_hiligaynon", "internal_eng_database_migration_doc_ko", "translate_ko_to_waray", "customer_quarterly_qbr_prep_internal_ko", "translate_ko_to_kapampangan", "internal_pm_okr_retro_doc_ko", "translate_ko_to_bikol", "customer_value_story_one_pager_ko", "translate_ko_to_pangasinan", "customer_renewal_executive_summary_won_ko", "translate_ko_to_ilocano", "internal_eng_api_design_guide_ko", "translate_ko_to_maranao", "customer_health_escalation_doc_ko", "translate_ko_to_tausug", "internal_pm_competitive_positioning_doc_ko", "translate_ko_to_maguindanao", "customer_renewal_celebration_internal_ko", "translate_ko_to_chavacano", "customer_renewal_forecast_doc_ko", "translate_ko_to_kankanaey", "internal_eng_performance_optimization_doc_ko", "translate_ko_to_ibanag", "customer_qbr_executive_summary_ko", "translate_ko_to_ivatan", "internal_pm_release_planning_doc_ko", "translate_ko_to_sambal", "customer_annual_review_letter_ko", "c_series_completion_announcement_ko", "full_milestone_celebration_ko", "translate_ko_to_shona", "translate_ko_to_sotho", "translate_ko_to_tswana", "translate_ko_to_tsonga", "translate_ko_to_venda", "customer_health_score_review_ko", "internal_incident_retro_ko", "sales_discovery_call_notes_ko", "product_beta_feedback_summary_ko", "internal_hiring_scorecard_ko", "translate_ko_to_ndebele", "translate_ko_to_swati", "translate_ko_to_chichewa", "translate_ko_to_bemba", "translate_ko_to_kinyarwanda", "gtm_campaign_brief_ko", "internal_okr_checkin_ko", "customer_churn_analysis_ko", "eng_design_doc_ko", "internal_team_offsite_agenda_ko", "translate_ko_to_kirundi", "translate_ko_to_luganda", "translate_ko_to_kikuyu", "translate_ko_to_luo", "translate_ko_to_wolof", "sales_qbr_deck_outline_ko", "internal_postmortem_action_tracker_ko", "customer_adoption_plan_ko", "pm_feature_spec_ko", "internal_perf_review_self_ko", "translate_ko_to_twi", "translate_ko_to_ewe", "translate_ko_to_ga", "translate_ko_to_fon", "translate_ko_to_bambara", "exec_business_case_ko", "internal_sprint_retro_ko", "customer_escalation_summary_ko", "pm_competitive_teardown_ko", "internal_runbook_ko", "translate_ko_to_dyula", "translate_ko_to_mossi", "translate_ko_to_susu", "translate_ko_to_krio", "translate_ko_to_temne", "internal_decision_record_adr_ko", "sales_mutual_action_plan_ko", "customer_value_realization_ko", "pm_user_journey_map_ko", "internal_capacity_planning_ko", "translate_ko_to_tigre", "translate_ko_to_afar", "translate_ko_to_saho", "translate_ko_to_beja", "translate_ko_to_nuer", "internal_weekly_status_ko", "sales_proposal_exec_summary_ko", "customer_success_plan_ko", "pm_release_notes_external_ko", "internal_meeting_notes_ko", "translate_ko_to_dinka", "translate_ko_to_kanuri", "translate_ko_to_zarma", "translate_ko_to_maasai", "translate_ko_to_turkana", "internal_tech_spike_summary_ko", "sales_cold_outreach_sequence_ko", "customer_renewal_followup_email_ko", "pm_prioritization_rice_ko", "internal_onboarding_buddy_guide_ko", "translate_ko_to_lingala", "translate_ko_to_kongo", "translate_ko_to_tshiluba", "translate_ko_to_sango", "translate_ko_to_mongo", "internal_kickoff_doc_ko", "sales_battlecard_ko", "customer_exec_business_review_ebr_ko", "pm_experiment_design_ko", "internal_oncall_handoff_ko", "translate_ko_to_herero", "translate_ko_to_nama", "translate_ko_to_oshiwambo", "translate_ko_to_lozi", "translate_ko_to_tonga_zambia", "internal_change_management_plan_ko", "sales_renewal_risk_assessment_ko", "customer_training_plan_ko", "pm_north_star_metric_ko", "internal_quarterly_planning_ko", "translate_ko_to_kalanga", "translate_ko_to_ndau", "translate_ko_to_manyika", "translate_ko_to_sena", "translate_ko_to_chopi", "internal_design_critique_notes_ko", "sales_account_plan_ko", "customer_voice_of_customer_ko", "pm_gtm_launch_plan_ko", "internal_skip_level_prep_ko", "translate_ko_to_enga", "translate_ko_to_huli", "translate_ko_to_tolai", "translate_ko_to_kuman", "translate_ko_to_melpa", "internal_brainstorm_summary_ko", "sales_win_loss_analysis_ko", "customer_qbr_prep_internal_ko", "pm_feature_flag_rollout_ko", "internal_doc_style_guide_ko", "translate_ko_to_kosraean", "translate_ko_to_pohnpeian", "translate_ko_to_yapese", "translate_ko_to_gilbertese", "translate_ko_to_mortlockese", "internal_team_charter_ko", "sales_demo_script_ko", "customer_success_story_ko", "pm_okr_draft_ko", "internal_incident_comms_external_ko", "translate_ko_to_rotuman", "translate_ko_to_wallisian", "translate_ko_to_futunan", "translate_ko_to_niuean", "translate_ko_to_tokelauan", "internal_slo_definition_ko", "sales_pricing_proposal_ko", "customer_business_review_recap_ko", "pm_roadmap_narrative_ko", "internal_interview_loop_design_ko", "translate_ko_to_hmong", "translate_ko_to_mien", "translate_ko_to_shan", "translate_ko_to_karen", "translate_ko_to_mon", "internal_data_request_spec_ko", "sales_negotiation_prep_ko", "customer_kickoff_agenda_ko", "pm_jobs_to_be_done_ko", "internal_retro_action_review_ko", "translate_ko_to_chin", "translate_ko_to_rakhine", "translate_ko_to_jingpho", "translate_ko_to_palaung", "translate_ko_to_wa", "internal_architecture_overview_ko", "sales_proof_of_concept_plan_ko", "customer_renewal_proposal_ko", "pm_release_readiness_checklist_ko", "internal_team_health_survey_ko", "translate_ko_to_bhojpuri", "translate_ko_to_maithili", "translate_ko_to_konkani", "translate_ko_to_tulu", "translate_ko_to_santali", "internal_tech_debt_proposal_ko", "sales_executive_briefing_ko", "customer_usage_review_ko", "pm_metrics_dashboard_spec_ko", "internal_promotion_case_ko", "translate_ko_to_dogri", "translate_ko_to_bodo", "translate_ko_to_manipuri", "translate_ko_to_khasi", "translate_ko_to_mizo", "internal_dev_env_setup_guide_ko", "sales_close_plan_ko", "customer_executive_alignment_ko", "pm_feature_deprecation_plan_ko", "internal_proposal_one_pager_ko", "translate_ko_to_zhuang", "translate_ko_to_uyghur", "translate_ko_to_tibetan", "translate_ko_to_dungan", "translate_ko_to_salar", "internal_security_review_ko", "sales_reference_request_ko", "customer_health_check_call_notes_ko", "pm_competitive_positioning_ko", "internal_quarterly_retro_ko", "translate_ko_to_tuvan", "translate_ko_to_khakas", "translate_ko_to_altai", "translate_ko_to_shor", "translate_ko_to_dolgan", "internal_backlog_grooming_notes_ko", "sales_territory_plan_ko", "customer_onboarding_status_ko", "pm_ab_test_results_ko", "internal_eng_weekly_digest_ko", "translate_ko_to_andi", "translate_ko_to_tsez", "translate_ko_to_rutul", "translate_ko_to_tsakhur", "translate_ko_to_aghul", "internal_meeting_facilitation_guide_ko", "sales_deal_review_ko", "customer_feedback_loop_ko", "pm_discovery_summary_ko", "internal_engineering_standards_ko", "translate_ko_to_cherokee", "translate_ko_to_lakota", "translate_ko_to_choctaw", "translate_ko_to_apache", "translate_ko_to_hopi", "internal_pr_faq_ko", "sales_pipeline_review_ko", "customer_renewal_forecast_ko", "pm_product_principles_ko", "internal_incident_exec_summary_ko", "translate_ko_to_mixtec", "translate_ko_to_zapotec", "translate_ko_to_otomi", "translate_ko_to_purepecha", "translate_ko_to_yucatec", "internal_design_doc_review_checklist_ko", "sales_renewal_playbook_ko", "customer_quarterly_value_recap_ko", "pm_feature_acceptance_criteria_ko", "internal_oncall_rotation_policy_ko", "translate_ko_to_wayuu", "translate_ko_to_shipibo", "translate_ko_to_kichwa", "translate_ko_to_tupi", "translate_ko_to_yanomami", "internal_postmortem_5whys_ko", "sales_loss_recovery_plan_ko", "customer_advocacy_program_ko", "pm_release_retro_ko", "internal_team_ramp_plan_ko", "translate_ko_to_iban", "translate_ko_to_kadazan", "translate_ko_to_dusun", "translate_ko_to_murut", "translate_ko_to_bidayuh", "internal_eng_metrics_review_ko", "sales_champion_enablement_ko", "customer_onboarding_retrospective_ko", "pm_beta_program_plan_ko", "internal_alert_triage_guide_ko", "translate_ko_to_toba_batak", "translate_ko_to_nias", "translate_ko_to_mentawai", "translate_ko_to_rejang", "translate_ko_to_lampung", "internal_dependency_map_ko", "sales_enablement_one_pager_ko", "customer_renewal_checklist_ko", "pm_market_sizing_ko", "internal_escalation_policy_ko", "translate_ko_to_sasak", "translate_ko_to_bima", "translate_ko_to_manggarai", "translate_ko_to_sumbawa", "translate_ko_to_ngada", "internal_release_comms_internal_ko", "sales_account_handoff_ko", "customer_expansion_proposal_ko", "pm_concept_validation_ko", "internal_decision_framework_ko", "translate_ko_to_hokkien", "translate_ko_to_hakka", "translate_ko_to_cantonese", "translate_ko_to_teochew", "translate_ko_to_okinawan", "internal_war_room_notes_ko", "sales_qualification_notes_ko", "customer_renewal_business_case_ko", "pm_feature_kpi_definition_ko", "internal_sprint_demo_notes_ko", "translate_ko_to_kashubian", "translate_ko_to_silesian", "translate_ko_to_rusyn", "translate_ko_to_sami_northern", "translate_ko_to_voro", "internal_status_report_exec_ko", "sales_renewal_email_sequence_ko", "customer_business_outcomes_review_ko", "pm_assumption_log_ko", "internal_meeting_action_tracker_ko", "translate_ko_to_low_german", "translate_ko_to_limburgish", "translate_ko_to_picard", "translate_ko_to_norman", "translate_ko_to_gascon", "internal_okr_grading_ko", "sales_post_demo_email_ko", "customer_risk_mitigation_plan_ko", "pm_feature_rollout_comms_ko", "internal_eng_oncall_review_ko", "translate_ko_to_sorani", "translate_ko_to_kurmanji", "translate_ko_to_zazaki", "translate_ko_to_gilaki", "translate_ko_to_mazandarani", "internal_deploy_checklist_ko", "sales_proposal_followup_ko", "customer_nps_response_plan_ko", "pm_survey_design_ko", "internal_eng_capacity_review_ko", "translate_ko_to_carolinian", "translate_ko_to_satawalese", "translate_ko_to_ulithian", "translate_ko_to_woleaian", "translate_ko_to_puluwat", "internal_tech_lead_weekly_ko", "sales_account_research_brief_ko", "customer_quarterly_planning_ko", "pm_product_strategy_brief_ko", "internal_architecture_review_notes_ko", "translate_ko_to_acholi", "translate_ko_to_lango", "translate_ko_to_ateso", "translate_ko_to_karamojong", "translate_ko_to_madi", "internal_release_go_nogo_ko", "sales_handoff_checklist_ko", "customer_journey_milestone_review_ko", "pm_feature_tradeoff_analysis_ko", "internal_postmortem_learnings_digest_ko", "translate_ko_to_warlpiri", "translate_ko_to_pitjantjatjara", "translate_ko_to_yolngu", "translate_ko_to_arrernte", "translate_ko_to_tiwi", "internal_oncall_summary_weekly_ko", "sales_upsell_pitch_ko", "customer_qbr_action_plan_ko", "pm_impact_effort_matrix_ko", "internal_team_skills_matrix_ko", "translate_ko_to_kodava", "translate_ko_to_badaga", "translate_ko_to_gondi", "translate_ko_to_kui", "translate_ko_to_brahui", "internal_data_pipeline_design_ko", "sales_renewal_kickoff_ko", "customer_onboarding_kickoff_email_ko", "pm_quarterly_roadmap_review_ko", "internal_incident_severity_guide_ko", "translate_ko_to_makonde", "translate_ko_to_chiyao", "translate_ko_to_makhuwa", "translate_ko_to_tumbuka", "translate_ko_to_nyakyusa", "internal_api_design_review_ko", "sales_weekly_forecast_ko", "customer_success_metrics_review_ko", "pm_feature_request_triage_ko", "internal_allhands_notes_ko", "translate_ko_to_kituba", "translate_ko_to_fang", "translate_ko_to_teke", "translate_ko_to_punu", "translate_ko_to_duala", "internal_load_testing_plan_ko", "sales_intro_email_ko", "customer_qbr_invite_email_ko", "pm_opportunity_solution_tree_ko", "internal_retro_facilitation_guide_ko", "translate_ko_to_lue", "translate_ko_to_tai_dam", "translate_ko_to_nung", "translate_ko_to_tay", "translate_ko_to_bouyei", "internal_eng_quarterly_goals_ko", "sales_deal_desk_review_ko", "customer_executive_email_ko", "pm_changelog_entry_ko", "internal_code_review_guidelines_ko", "translate_ko_to_dagur", "translate_ko_to_evenki", "translate_ko_to_even", "translate_ko_to_nanai", "translate_ko_to_manchu", "internal_release_train_plan_ko", "sales_competitive_displacement_ko", "customer_quarterly_check_in_email_ko", "pm_release_scope_decision_ko", "internal_engineering_glossary_ko", "translate_ko_to_kiche", "translate_ko_to_qeqchi", "translate_ko_to_mam", "translate_ko_to_kaqchikel", "translate_ko_to_tzotzil", "internal_eng_roadmap_ko", "sales_quarterly_review_internal_ko", "customer_stakeholder_map_ko", "pm_feature_sunset_comms_ko", "internal_engineering_principles_ko", "translate_ko_to_kpelle", "translate_ko_to_loma", "translate_ko_to_vai", "translate_ko_to_gola", "translate_ko_to_kissi", "internal_service_catalog_entry_ko", "sales_pipeline_generation_plan_ko", "customer_health_improvement_plan_ko", "pm_definition_of_ready_ko", "internal_async_update_template_ko", "translate_ko_to_shilluk", "translate_ko_to_anuak", "translate_ko_to_bari", "translate_ko_to_lotuko", "translate_ko_to_zande", "internal_tech_radar_entry_ko", "sales_deal_loss_notification_ko", "customer_relationship_review_ko", "pm_problem_statement_ko", "internal_handover_doc_ko", "translate_ko_to_ainu", "translate_ko_to_nivkh", "translate_ko_to_chukchi", "translate_ko_to_koryak", "translate_ko_to_itelmen", "internal_observability_plan_ko", "sales_pipeline_hygiene_review_ko", "customer_kickoff_summary_email_ko", "pm_metrics_review_monthly_ko", "internal_onboarding_plan_eng_ko", "translate_ko_to_aleut", "translate_ko_to_yupik", "translate_ko_to_inupiaq", "translate_ko_to_alutiiq", "translate_ko_to_tlingit", "internal_eng_health_review_ko", "sales_competitive_intel_update_ko", "customer_executive_sponsor_update_ko", "pm_product_health_review_ko", "internal_eng_hiring_plan_ko", "translate_ko_to_haida", "translate_ko_to_tsimshian", "translate_ko_to_kwakwala", "translate_ko_to_salish", "translate_ko_to_nuuchahnulth", "internal_runbook_audit_ko", "sales_account_tiering_ko", "customer_executive_review_prep_ko", "pm_user_segmentation_ko", "internal_team_ritual_design_ko", "translate_ko_to_garifuna", "translate_ko_to_miskito", "translate_ko_to_kuna", "translate_ko_to_embera", "translate_ko_to_ngabere", "internal_incident_trends_review_ko", "sales_quota_planning_ko", "customer_onboarding_completion_review_ko", "pm_feature_postlaunch_review_ko", "internal_decision_postmortem_ko", "d_series_completion_announcement_ko", "full_program_celebration_ko", "translate_ko_to_classical_chinese", "translate_ko_to_old_norse", "translate_ko_to_egyptian_arabic", "translate_ko_to_gulf_arabic", "translate_ko_to_bavarian", "incident_postmortem_detailed_ko", "vendor_evaluation_memo_ko", "sprint_review_script_ko", "hiring_scorecard_ko", "customer_success_qbr_ko", "translate_eap_l1", "translate_eap_l2", "translate_eap_l3", "translate_eap_l4", "translate_eap_l5", "doc_eap_d1", "doc_eap_d2", "doc_eap_d3", "doc_eap_d4", "doc_eap_d5", "translate_ebe_l1", "translate_ebe_l2", "translate_ebe_l3", "translate_ebe_l4", "translate_ebe_l5", "doc_ebe_d1", "doc_ebe_d2", "doc_ebe_d3", "doc_ebe_d4", "doc_ebe_d5", "translate_ebt_l1", "translate_ebt_l2", "translate_ebt_l3", "translate_ebt_l4", "translate_ebt_l5", "doc_ebt_d1", "doc_ebt_d2", "doc_ebt_d3", "doc_ebt_d4", "doc_ebt_d5", "translate_eci_l1", "translate_eci_l2", "translate_eci_l3", "translate_eci_l4", "translate_eci_l5", "doc_eci_d1", "doc_eci_d2", "doc_eci_d3", "doc_eci_d4", "doc_eci_d5", "translate_ecx_l1", "translate_ecx_l2", "translate_ecx_l3", "translate_ecx_l4", "translate_ecx_l5", "doc_ecx_d1", "doc_ecx_d2", "doc_ecx_d3", "doc_ecx_d4", "doc_ecx_d5", "translate_edm_l1", "translate_edm_l2", "translate_edm_l3", "translate_edm_l4", "translate_edm_l5", "doc_edm_d1", "doc_edm_d2", "doc_edm_d3", "doc_edm_d4", "doc_edm_d5", "translate_eeb_l1", "translate_eeb_l2", "translate_eeb_l3", "translate_eeb_l4", "translate_eeb_l5", "doc_eeb_d1", "doc_eeb_d2", "doc_eeb_d3", "doc_eeb_d4", "doc_eeb_d5", "translate_eer_l1", "translate_eer_l2", "translate_eer_l3", "translate_eer_l4", "translate_eer_l5", "doc_eer_d1", "doc_eer_d2", "doc_eer_d3", "doc_eer_d4", "doc_eer_d5", "translate_efg_l1", "translate_efg_l2", "translate_efg_l3", "translate_efg_l4", "translate_efg_l5", "doc_efg_d1", "doc_efg_d2", "doc_efg_d3", "doc_efg_d4", "doc_efg_d5", "translate_efv_l1", "translate_efv_l2", "translate_efv_l3", "translate_efv_l4", "translate_efv_l5", "doc_efv_d1", "doc_efv_d2", "doc_efv_d3", "doc_efv_d4", "doc_efv_d5", "translate_egk_l1", "translate_egk_l2", "translate_egk_l3", "translate_egk_l4", "translate_egk_l5", "doc_egk_d1", "doc_egk_d2", "doc_egk_d3", "doc_egk_d4", "doc_egk_d5", "translate_egz_l1", "translate_egz_l2", "translate_egz_l3", "translate_egz_l4", "translate_egz_l5", "doc_egz_d1", "doc_egz_d2", "doc_egz_d3", "doc_egz_d4", "doc_egz_d5", "translate_eho_l1", "translate_eho_l2", "translate_eho_l3", "translate_eho_l4", "translate_eho_l5", "doc_eho_d1", "doc_eho_d2", "doc_eho_d3", "doc_eho_d4", "doc_eho_d5", "translate_eid_l1", "translate_eid_l2", "translate_eid_l3", "translate_eid_l4", "translate_eid_l5", "doc_eid_d1", "doc_eid_d2", "doc_eid_d3", "doc_eid_d4", "doc_eid_d5", "translate_eis_l1", "translate_eis_l2", "translate_eis_l3", "translate_eis_l4", "translate_eis_l5", "doc_eis_d1", "doc_eis_d2", "doc_eis_d3", "doc_eis_d4", "doc_eis_d5", "translate_ejh_l1", "translate_ejh_l2", "translate_ejh_l3", "translate_ejh_l4", "translate_ejh_l5", "doc_ejh_d1", "doc_ejh_d2", "doc_ejh_d3", "doc_ejh_d4", "doc_ejh_d5", "translate_ejw_l1", "translate_ejw_l2", "translate_ejw_l3", "translate_ejw_l4", "translate_ejw_l5", "doc_ejw_d1", "doc_ejw_d2", "doc_ejw_d3", "doc_ejw_d4", "doc_ejw_d5", "translate_ekl_l1", "translate_ekl_l2", "translate_ekl_l3", "translate_ekl_l4", "translate_ekl_l5", "doc_ekl_d1", "doc_ekl_d2", "doc_ekl_d3", "doc_ekl_d4", "doc_ekl_d5", "translate_ela_l1", "translate_ela_l2", "translate_ela_l3", "translate_ela_l4", "translate_ela_l5", "doc_ela_d1", "doc_ela_d2", "doc_ela_d3", "doc_ela_d4", "doc_ela_d5", "translate_elp_l1", "translate_elp_l2", "translate_elp_l3", "translate_elp_l4", "translate_elp_l5", "doc_elp_d1", "doc_elp_d2", "doc_elp_d3", "doc_elp_d4", "doc_elp_d5", "translate_eme_l1", "translate_eme_l2", "translate_eme_l3", "translate_eme_l4", "translate_eme_l5", "doc_eme_d1", "doc_eme_d2", "doc_eme_d3", "doc_eme_d4", "doc_eme_d5", "translate_emt_l1", "translate_emt_l2", "translate_emt_l3", "translate_emt_l4", "translate_emt_l5", "doc_emt_d1", "doc_emt_d2", "doc_emt_d3", "doc_emt_d4", "doc_emt_d5", "translate_eni_l1", "translate_eni_l2", "translate_eni_l3", "translate_eni_l4", "translate_eni_l5", "doc_eni_d1", "doc_eni_d2", "doc_eni_d3", "doc_eni_d4", "doc_eni_d5", "translate_enx_l1", "translate_enx_l2", "translate_enx_l3", "translate_enx_l4", "translate_enx_l5", "doc_enx_d1", "doc_enx_d2", "doc_enx_d3", "doc_enx_d4", "doc_enx_d5", "translate_eom_l1", "translate_eom_l2", "translate_eom_l3", "translate_eom_l4", "translate_eom_l5", "doc_eom_d1", "doc_eom_d2", "doc_eom_d3", "doc_eom_d4", "doc_eom_d5", "translate_epb_l1", "translate_epb_l2", "translate_epb_l3", "translate_epb_l4", "translate_epb_l5", "doc_epb_d1", "doc_epb_d2", "doc_epb_d3", "doc_epb_d4", "doc_epb_d5", "translate_epq_l1", "translate_epq_l2", "translate_epq_l3", "translate_epq_l4", "translate_epq_l5", "doc_epq_d1", "doc_epq_d2", "doc_epq_d3", "doc_epq_d4", "doc_epq_d5", "translate_eqf_l1", "translate_eqf_l2", "translate_eqf_l3", "translate_eqf_l4", "translate_eqf_l5", "doc_eqf_d1", "doc_eqf_d2", "doc_eqf_d3", "doc_eqf_d4", "doc_eqf_d5", "translate_equ_l1", "translate_equ_l2", "translate_equ_l3", "translate_equ_l4", "translate_equ_l5", "doc_equ_d1", "doc_equ_d2", "doc_equ_d3", "doc_equ_d4", "doc_equ_d5", "translate_erj_l1", "translate_erj_l2", "translate_erj_l3", "translate_erj_l4", "translate_erj_l5", "doc_erj_d1", "doc_erj_d2", "doc_erj_d3", "doc_erj_d4", "doc_erj_d5", "translate_ery_l1", "translate_ery_l2", "translate_ery_l3", "translate_ery_l4", "translate_ery_l5", "doc_ery_d1", "doc_ery_d2", "doc_ery_d3", "doc_ery_d4", "doc_ery_d5", "translate_esn_l1", "translate_esn_l2", "translate_esn_l3", "translate_esn_l4", "translate_esn_l5", "doc_esn_d1", "doc_esn_d2", "doc_esn_d3", "doc_esn_d4", "doc_esn_d5", "translate_etc_l1", "translate_etc_l2", "translate_etc_l3", "translate_etc_l4", "translate_etc_l5", "doc_etc_d1", "doc_etc_d2", "doc_etc_d3", "doc_etc_d4", "doc_etc_d5", "translate_etr_l1", "translate_etr_l2", "translate_etr_l3", "translate_etr_l4", "translate_etr_l5", "doc_etr_d1", "doc_etr_d2", "doc_etr_d3", "doc_etr_d4", "doc_etr_d5", "translate_eug_l1", "translate_eug_l2", "translate_eug_l3", "translate_eug_l4", "translate_eug_l5", "doc_eug_d1", "doc_eug_d2", "doc_eug_d3", "doc_eug_d4", "doc_eug_d5", "translate_euv_l1", "translate_euv_l2", "translate_euv_l3", "translate_euv_l4", "translate_euv_l5", "doc_euv_d1", "doc_euv_d2", "doc_euv_d3", "doc_euv_d4", "doc_euv_d5", "translate_evk_l1", "translate_evk_l2", "translate_evk_l3", "translate_evk_l4", "translate_evk_l5", "doc_evk_d1", "doc_evk_d2", "doc_evk_d3", "doc_evk_d4", "doc_evk_d5", "translate_evz_l1", "translate_evz_l2", "translate_evz_l3", "translate_evz_l4", "translate_evz_l5", "doc_evz_d1", "doc_evz_d2", "doc_evz_d3", "doc_evz_d4", "doc_evz_d5", "translate_ewo_l1", "translate_ewo_l2", "translate_ewo_l3", "translate_ewo_l4", "translate_ewo_l5", "doc_ewo_d1", "doc_ewo_d2", "doc_ewo_d3", "doc_ewo_d4", "doc_ewo_d5", "translate_exd_l1", "translate_exd_l2", "translate_exd_l3", "translate_exd_l4", "translate_exd_l5", "doc_exd_d1", "doc_exd_d2", "doc_exd_d3", "doc_exd_d4", "doc_exd_d5", "translate_exs_l1", "translate_exs_l2", "translate_exs_l3", "translate_exs_l4", "translate_exs_l5", "doc_exs_d1", "doc_exs_d2", "doc_exs_d3", "doc_exs_d4", "doc_exs_d5", "translate_eyh_l1", "translate_eyh_l2", "translate_eyh_l3", "translate_eyh_l4", "translate_eyh_l5", "doc_eyh_d1", "doc_eyh_d2", "doc_eyh_d3", "doc_eyh_d4", "doc_eyh_d5", "translate_eyw_l1", "translate_eyw_l2", "translate_eyw_l3", "translate_eyw_l4", "translate_eyw_l5", "doc_eyw_d1", "doc_eyw_d2", "doc_eyw_d3", "doc_eyw_d4", "doc_eyw_d5", "translate_ezl_l1", "translate_ezl_l2", "translate_ezl_l3", "translate_ezl_l4", "translate_ezl_l5", "doc_ezl_d1", "doc_ezl_d2", "doc_ezl_d3", "doc_ezl_d4", "doc_ezl_d5", "translate_faa_l1", "translate_faa_l2", "translate_faa_l3", "translate_faa_l4", "translate_faa_l5", "doc_faa_d1", "doc_faa_d2", "doc_faa_d3", "doc_faa_d4", "doc_faa_d5", "translate_faq_l1", "translate_faq_l2", "translate_faq_l3", "translate_faq_l4", "translate_faq_l5", "doc_faq_d1", "doc_faq_d2", "doc_faq_d3", "doc_faq_d4", "doc_faq_d5", "translate_fbf_l1", "translate_fbf_l2", "translate_fbf_l3", "translate_fbf_l4", "translate_fbf_l5", "doc_fbf_d1", "doc_fbf_d2", "doc_fbf_d3", "doc_fbf_d4", "doc_fbf_d5", "translate_fbu_l1", "translate_fbu_l2", "translate_fbu_l3", "translate_fbu_l4", "translate_fbu_l5", "doc_fbu_d1", "doc_fbu_d2", "doc_fbu_d3", "doc_fbu_d4", "doc_fbu_d5", "translate_fcj_l1", "translate_fcj_l2", "translate_fcj_l3", "translate_fcj_l4", "translate_fcj_l5", "doc_fcj_d1", "doc_fcj_d2", "doc_fcj_d3", "doc_fcj_d4", "doc_fcj_d5", "translate_fcy_l1", "translate_fcy_l2", "translate_fcy_l3", "translate_fcy_l4", "translate_fcy_l5", "doc_fcy_d1", "doc_fcy_d2", "doc_fcy_d3", "doc_fcy_d4", "doc_fcy_d5", "translate_fdn_l1", "translate_fdn_l2", "translate_fdn_l3", "translate_fdn_l4", "translate_fdn_l5", "doc_fdn_d1", "doc_fdn_d2", "doc_fdn_d3", "doc_fdn_d4", "doc_fdn_d5", "translate_fec_l1", "translate_fec_l2", "translate_fec_l3", "translate_fec_l4", "translate_fec_l5", "doc_fec_d1", "doc_fec_d2", "doc_fec_d3", "doc_fec_d4", "doc_fec_d5", "translate_fer_l1", "translate_fer_l2", "translate_fer_l3", "translate_fer_l4", "translate_fer_l5", "doc_fer_d1", "doc_fer_d2", "doc_fer_d3", "doc_fer_d4", "doc_fer_d5", "translate_ffh_l1", "translate_ffh_l2", "translate_ffh_l3", "translate_ffh_l4", "translate_ffh_l5", "doc_ffh_d1", "doc_ffh_d2", "doc_ffh_d3", "doc_ffh_d4", "doc_ffh_d5", "translate_ffw_l1", "translate_ffw_l2", "translate_ffw_l3", "translate_ffw_l4", "translate_ffw_l5", "doc_ffw_d1", "doc_ffw_d2", "doc_ffw_d3", "doc_ffw_d4", "doc_ffw_d5", "translate_fgl_l1", "translate_fgl_l2", "translate_fgl_l3", "translate_fgl_l4", "translate_fgl_l5", "doc_fgl_d1", "doc_fgl_d2", "doc_fgl_d3", "doc_fgl_d4", "doc_fgl_d5", "translate_fha_l1", "translate_fha_l2", "translate_fha_l3", "translate_fha_l4", "translate_fha_l5", "doc_fha_d1", "doc_fha_d2", "doc_fha_d3", "doc_fha_d4", "doc_fha_d5", "translate_fhp_l1", "translate_fhp_l2", "translate_fhp_l3", "translate_fhp_l4", "translate_fhp_l5", "doc_fhp_d1", "doc_fhp_d2", "doc_fhp_d3", "doc_fhp_d4", "doc_fhp_d5", "translate_fie_l1", "translate_fie_l2", "translate_fie_l3", "translate_fie_l4", "translate_fie_l5", "doc_fie_d1", "doc_fie_d2", "doc_fie_d3", "doc_fie_d4", "doc_fie_d5", "translate_fit_l1", "translate_fit_l2", "translate_fit_l3", "translate_fit_l4", "translate_fit_l5", "doc_fit_d1", "doc_fit_d2", "doc_fit_d3", "doc_fit_d4", "doc_fit_d5", "translate_fji_l1", "translate_fji_l2", "translate_fji_l3", "translate_fji_l4", "translate_fji_l5", "doc_fji_d1", "doc_fji_d2", "doc_fji_d3", "doc_fji_d4", "doc_fji_d5", "translate_fjx_l1", "translate_fjx_l2", "translate_fjx_l3", "translate_fjx_l4", "translate_fjx_l5", "doc_fjx_d1", "doc_fjx_d2", "doc_fjx_d3", "doc_fjx_d4", "doc_fjx_d5", "translate_fkm_l1", "translate_fkm_l2", "translate_fkm_l3", "translate_fkm_l4", "translate_fkm_l5", "doc_fkm_d1", "doc_fkm_d2", "doc_fkm_d3", "doc_fkm_d4", "doc_fkm_d5", "translate_flb_l1", "translate_flb_l2", "translate_flb_l3", "translate_flb_l4", "translate_flb_l5", "doc_flb_d1", "doc_flb_d2", "doc_flb_d3", "doc_flb_d4", "doc_flb_d5", "translate_flq_l1", "translate_flq_l2", "translate_flq_l3", "translate_flq_l4", "translate_flq_l5", "doc_flq_d1", "doc_flq_d2", "doc_flq_d3", "doc_flq_d4", "doc_flq_d5", "translate_fmf_l1", "translate_fmf_l2", "translate_fmf_l3", "translate_fmf_l4", "translate_fmf_l5", "doc_fmf_d1", "doc_fmf_d2", "doc_fmf_d3", "doc_fmf_d4", "doc_fmf_d5", "translate_fmu_l1", "translate_fmu_l2", "translate_fmu_l3", "translate_fmu_l4", "translate_fmu_l5", "doc_fmu_d1", "doc_fmu_d2", "doc_fmu_d3", "doc_fmu_d4", "doc_fmu_d5", "translate_fnj_l1", "translate_fnj_l2", "translate_fnj_l3", "translate_fnj_l4", "translate_fnj_l5", "doc_fnj_d1", "doc_fnj_d2", "doc_fnj_d3", "doc_fnj_d4", "doc_fnj_d5", "translate_fny_l1", "translate_fny_l2", "translate_fny_l3", "translate_fny_l4", "translate_fny_l5", "doc_fny_d1", "doc_fny_d2", "doc_fny_d3", "doc_fny_d4", "doc_fny_d5", "translate_fon_l1", "translate_fon_l2", "translate_fon_l3", "translate_fon_l4", "translate_fon_l5", "doc_fon_d1", "doc_fon_d2", "doc_fon_d3", "doc_fon_d4", "doc_fon_d5", "translate_fpc_l1", "translate_fpc_l2", "translate_fpc_l3", "translate_fpc_l4", "translate_fpc_l5", "doc_fpc_d1", "doc_fpc_d2", "doc_fpc_d3", "doc_fpc_d4", "doc_fpc_d5", "translate_fpr_l1", "translate_fpr_l2", "translate_fpr_l3", "translate_fpr_l4", "translate_fpr_l5", "doc_fpr_d1", "doc_fpr_d2", "doc_fpr_d3", "doc_fpr_d4", "doc_fpr_d5", "translate_fqg_l1", "translate_fqg_l2", "translate_fqg_l3", "translate_fqg_l4", "translate_fqg_l5", "doc_fqg_d1", "doc_fqg_d2", "doc_fqg_d3", "doc_fqg_d4", "doc_fqg_d5", "translate_fqv_l1", "translate_fqv_l2", "translate_fqv_l3", "translate_fqv_l4", "translate_fqv_l5", "doc_fqv_d1", "doc_fqv_d2", "doc_fqv_d3", "doc_fqv_d4", "doc_fqv_d5", "translate_frk_l1", "translate_frk_l2", "translate_frk_l3", "translate_frk_l4", "translate_frk_l5", "doc_frk_d1", "doc_frk_d2", "doc_frk_d3", "doc_frk_d4", "doc_frk_d5", "translate_frz_l1", "translate_frz_l2", "translate_frz_l3", "translate_frz_l4", "translate_frz_l5", "doc_frz_d1", "doc_frz_d2", "doc_frz_d3", "doc_frz_d4", "doc_frz_d5", "translate_fso_l1", "translate_fso_l2", "translate_fso_l3", "translate_fso_l4", "translate_fso_l5", "doc_fso_d1", "doc_fso_d2", "doc_fso_d3", "doc_fso_d4", "doc_fso_d5", "translate_ftd_l1", "translate_ftd_l2", "translate_ftd_l3", "translate_ftd_l4", "translate_ftd_l5", "doc_ftd_d1", "doc_ftd_d2", "doc_ftd_d3", "doc_ftd_d4", "doc_ftd_d5", "translate_fts_l1", "translate_fts_l2", "translate_fts_l3", "translate_fts_l4", "translate_fts_l5", "doc_fts_d1", "doc_fts_d2", "doc_fts_d3", "doc_fts_d4", "doc_fts_d5", "translate_fuh_l1", "translate_fuh_l2", "translate_fuh_l3", "translate_fuh_l4", "translate_fuh_l5", "doc_fuh_d1", "doc_fuh_d2", "doc_fuh_d3", "doc_fuh_d4", "doc_fuh_d5", "translate_fuw_l1", "translate_fuw_l2", "translate_fuw_l3", "translate_fuw_l4", "translate_fuw_l5", "doc_fuw_d1", "doc_fuw_d2", "doc_fuw_d3", "doc_fuw_d4", "doc_fuw_d5", "translate_fvl_l1", "translate_fvl_l2", "translate_fvl_l3", "translate_fvl_l4", "translate_fvl_l5", "doc_fvl_d1", "doc_fvl_d2", "doc_fvl_d3", "doc_fvl_d4", "doc_fvl_d5", "translate_fwa_l1", "translate_fwa_l2", "translate_fwa_l3", "translate_fwa_l4", "translate_fwa_l5", "doc_fwa_d1", "doc_fwa_d2", "doc_fwa_d3", "doc_fwa_d4", "doc_fwa_d5", "translate_fwp_l1", "translate_fwp_l2", "translate_fwp_l3", "translate_fwp_l4", "translate_fwp_l5", "doc_fwp_d1", "doc_fwp_d2", "doc_fwp_d3", "doc_fwp_d4", "doc_fwp_d5", "translate_fxe_l1", "translate_fxe_l2", "translate_fxe_l3", "translate_fxe_l4", "translate_fxe_l5", "doc_fxe_d1", "doc_fxe_d2", "doc_fxe_d3", "doc_fxe_d4", "doc_fxe_d5", "translate_fxt_l1", "translate_fxt_l2", "translate_fxt_l3", "translate_fxt_l4", "translate_fxt_l5", "doc_fxt_d1", "doc_fxt_d2", "doc_fxt_d3", "doc_fxt_d4", "doc_fxt_d5", "translate_fyi_l1", "translate_fyi_l2", "translate_fyi_l3", "translate_fyi_l4", "translate_fyi_l5", "doc_fyi_d1", "doc_fyi_d2", "doc_fyi_d3", "doc_fyi_d4", "doc_fyi_d5", "translate_fyx_l1", "translate_fyx_l2", "translate_fyx_l3", "translate_fyx_l4", "translate_fyx_l5", "doc_fyx_d1", "doc_fyx_d2", "doc_fyx_d3", "doc_fyx_d4", "doc_fyx_d5", "translate_fzm_l1", "translate_fzm_l2", "translate_fzm_l3", "translate_fzm_l4", "translate_fzm_l5", "doc_fzm_d1", "doc_fzm_d2", "doc_fzm_d3", "doc_fzm_d4", "doc_fzm_d5", "translate_gaa_l1", "translate_gaa_l2", "translate_gaa_l3", "translate_gaa_l4", "translate_gaa_l5", "doc_gaa_d1", "doc_gaa_d2", "doc_gaa_d3", "doc_gaa_d4", "doc_gaa_d5", "translate_gap_l1", "translate_gap_l2", "translate_gap_l3", "translate_gap_l4", "translate_gap_l5", "doc_gap_d1", "doc_gap_d2", "doc_gap_d3", "doc_gap_d4", "doc_gap_d5", "edit"] as const)
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
                    study_notes: { title: "AI · Study notes", emoji: "📒", color: "blue", aliases: ["ai", "study", "notes", "공부"] },
                    flashcards: { title: "AI · Flashcards (5)", emoji: "🃏", color: "yellow", aliases: ["ai", "flashcards", "cards", "암기"] },
                    quiz: { title: "AI · Quick quiz (3 Q)", emoji: "🧠", color: "green", aliases: ["ai", "quiz", "test", "퀴즈"] },
                    persona: { title: "AI · Build persona", emoji: "🧑‍💼", color: "purple", aliases: ["ai", "persona", "user", "페르소나"] },
                    swot: { title: "AI · SWOT analysis", emoji: "🧭", color: "blue", aliases: ["ai", "swot", "analysis", "분석"] },
                    release_notes: { title: "AI · Release notes", emoji: "🚀", color: "green", aliases: ["ai", "release", "changelog", "릴리스"] },
                    objections: { title: "AI · Objections & responses", emoji: "🙅", color: "red", aliases: ["ai", "objections", "rebuttal", "이의"] },
                    decision_log: { title: "AI · Decision log table", emoji: "📓", color: "purple", aliases: ["ai", "decision", "log", "결정"] },
                    user_stories: { title: "AI · User stories", emoji: "👤", color: "blue", aliases: ["ai", "stories", "user story", "유저스토리"] },
                    test_cases: { title: "AI · BDD test cases", emoji: "🧪", color: "green", aliases: ["ai", "tests", "bdd", "테스트"] },
                    rhyme: { title: "AI · Rhyme it", emoji: "🎵", color: "yellow", aliases: ["ai", "rhyme", "poem", "운율"] },
                    lyrics: { title: "AI · Song lyrics (4 lines)", emoji: "🎤", color: "yellow", aliases: ["ai", "lyrics", "song", "가사"] },
                    regex: { title: "AI · Regex from description", emoji: "🔣", color: "purple", aliases: ["ai", "regex", "pattern", "정규식"] },
                    sql: { title: "AI · SQL from question", emoji: "🗃️", color: "purple", aliases: ["ai", "sql", "query", "쿼리"] },
                    commit_msg: { title: "AI · Commit message", emoji: "📦", color: "green", aliases: ["ai", "commit", "git", "커밋"] },
                    standup: { title: "AI · Daily standup", emoji: "🕖", color: "blue", aliases: ["ai", "standup", "daily", "스탠드업"] },
                    retro: { title: "AI · Retrospective (4L)", emoji: "🔄", color: "purple", aliases: ["ai", "retro", "retrospective", "회고"] },
                    jargon: { title: "AI · Jargon explainer", emoji: "🗣️", color: "yellow", aliases: ["ai", "jargon", "terms", "용어"] },
                    mind_map: { title: "AI · Mind map", emoji: "🧠", color: "blue", aliases: ["ai", "mind", "map", "마인드맵"] },
                    elevator_pitch: { title: "AI · Elevator pitch", emoji: "🚀", color: "green", aliases: ["ai", "pitch", "elevator", "피치"] },
                    job_desc: { title: "AI · Job description", emoji: "💼", color: "purple", aliases: ["ai", "job", "jd", "직무"] },
                    follow_up: { title: "AI · Follow-up Qs", emoji: "↩️", color: "blue", aliases: ["ai", "follow", "up", "후속"] },
                    sub_headings: { title: "AI · Suggest sub-headings", emoji: "🏷", color: "blue", aliases: ["ai", "subheadings", "sections", "소제목"] },
                    anti_pattern: { title: "AI · Anti-pattern check", emoji: "🚧", color: "red", aliases: ["ai", "antipattern", "pitfalls", "안티패턴"] },
                    dictionary: { title: "AI · Mini dictionary", emoji: "📚", color: "yellow", aliases: ["ai", "dictionary", "definitions", "사전"] },
                    expand_acronyms: { title: "AI · Expand acronyms", emoji: "🔤", color: "purple", aliases: ["ai", "acronyms", "abbrev", "약어"] },
                    star_method: { title: "AI · STAR method", emoji: "⭐", color: "green", aliases: ["ai", "star", "situation", "결과"] },
                    key_takeaways: { title: "AI · Key takeaways", emoji: "🔑", color: "blue", aliases: ["ai", "takeaways", "key", "핵심"] },
                    email_reply: { title: "AI · Email reply", emoji: "📨", color: "purple", aliases: ["ai", "email", "reply", "답장"] },
                    cover_letter: { title: "AI · Cover letter", emoji: "📃", color: "yellow", aliases: ["ai", "cover", "letter", "자소서"] },
                    pre_publish: { title: "AI · Pre-publish checklist", emoji: "📋", color: "green", aliases: ["ai", "publish", "checklist", "출판"] },
                    tagline: { title: "AI · Taglines", emoji: "🎯", color: "yellow", aliases: ["ai", "tagline", "slogan", "슬로건"] },
                    metaphor: { title: "AI · Metaphors", emoji: "🪞", color: "purple", aliases: ["ai", "metaphor", "analogy", "비유"] },
                    press_release: { title: "AI · Press release", emoji: "📰", color: "blue", aliases: ["ai", "press", "release", "보도자료"] },
                    interview_questions: { title: "AI · Interview Qs", emoji: "💬", color: "blue", aliases: ["ai", "interview", "questions", "면접"] },
                    linkedin_post: { title: "AI · LinkedIn post", emoji: "💼", color: "blue", aliases: ["ai", "linkedin", "post", "링크드인"] },
                    blog_outline: { title: "AI · Blog outline", emoji: "✍️", color: "green", aliases: ["ai", "blog", "outline", "블로그"] },
                    testimonials: { title: "AI · Testimonials (3)", emoji: "🗨️", color: "yellow", aliases: ["ai", "testimonial", "추천사"] },
                    contrarian: { title: "AI · Contrarian view", emoji: "🙃", color: "red", aliases: ["ai", "contrarian", "opposite", "반대"] },
                    dialog: { title: "AI · Make dialog (A/B)", emoji: "🎭", color: "purple", aliases: ["ai", "dialog", "conversation", "대화"] },
                    seo_keywords: { title: "AI · SEO keywords", emoji: "🔎", color: "blue", aliases: ["ai", "seo", "keywords", "검색어"] },
                    news_headline: { title: "AI · News headline", emoji: "🗞️", color: "yellow", aliases: ["ai", "news", "headline", "뉴스"] },
                    recommendation_letter: { title: "AI · Recommendation letter", emoji: "🤝", color: "green", aliases: ["ai", "recommendation", "letter", "추천서"] },
                    scenario: { title: "AI · Scenarios (3)", emoji: "🎲", color: "purple", aliases: ["ai", "scenario", "cases", "시나리오"] },
                    risk_matrix: { title: "AI · Risk matrix", emoji: "📐", color: "red", aliases: ["ai", "risk", "matrix", "위험"] },
                    api_spec: { title: "AI · API spec", emoji: "🛰", color: "blue", aliases: ["ai", "api", "spec", "명세"] },
                    raci: { title: "AI · RACI table", emoji: "🧮", color: "blue", aliases: ["ai", "raci", "table", "책임"] },
                    value_prop: { title: "AI · Value proposition", emoji: "💎", color: "green", aliases: ["ai", "value", "vp", "가치"] },
                    cta: { title: "AI · CTA button copy", emoji: "👆", color: "yellow", aliases: ["ai", "cta", "button", "버튼"] },
                    landing_hero: { title: "AI · Landing hero", emoji: "🦸", color: "purple", aliases: ["ai", "hero", "landing", "랜딩"] },
                    onboarding_email: { title: "AI · Onboarding email", emoji: "📬", color: "blue", aliases: ["ai", "onboarding", "welcome", "환영"] },
                    insight_3: { title: "AI · 3 insights", emoji: "💡", color: "yellow", aliases: ["ai", "insight", "insights", "통찰"] },
                    dictation_clean: { title: "AI · Clean dictation", emoji: "🎙", color: "purple", aliases: ["ai", "dictation", "transcript", "받아쓰기"] },
                    clean_formatting: { title: "AI · Clean formatting", emoji: "🧹", color: "green", aliases: ["ai", "clean", "format", "정리"] },
                    inverse_pyramid: { title: "AI · Inverse pyramid", emoji: "🔻", color: "blue", aliases: ["ai", "pyramid", "inverse", "역피라미드"] },
                    contrast_vs: { title: "AI · Contrast A vs B", emoji: "🆚", color: "purple", aliases: ["ai", "contrast", "compare", "비교"] },
                    buyer_persona: { title: "AI · Buyer persona", emoji: "🛒", color: "blue", aliases: ["ai", "buyer", "persona", "구매자"] },
                    feature_benefit: { title: "AI · Feature → Benefit", emoji: "🎁", color: "green", aliases: ["ai", "feature", "benefit", "이익"] },
                    learn_vocab: { title: "AI · Vocab study list", emoji: "🅰", color: "yellow", aliases: ["ai", "vocab", "vocabulary", "단어"] },
                    business_canvas: { title: "AI · Lean canvas", emoji: "🧩", color: "blue", aliases: ["ai", "canvas", "business", "사업"] },
                    competitive_analysis: { title: "AI · Competitive analysis", emoji: "🥊", color: "red", aliases: ["ai", "competitor", "compare", "경쟁사"] },
                    postmortem: { title: "AI · Incident postmortem", emoji: "🚨", color: "red", aliases: ["ai", "postmortem", "incident", "장애회고"] },
                    case_study: { title: "AI · Case study", emoji: "📖", color: "blue", aliases: ["ai", "case", "study", "사례"] },
                    customer_interview: { title: "AI · Customer interview Qs", emoji: "🎤", color: "purple", aliases: ["ai", "customer", "interview", "고객인터뷰"] },
                    release_tweet: { title: "AI · Release tweet", emoji: "🐤", color: "blue", aliases: ["ai", "release", "tweet", "릴리스트윗"] },
                    job_offer_email: { title: "AI · Job offer email", emoji: "📨", color: "green", aliases: ["ai", "offer", "email", "오퍼"] },
                    spec_template: { title: "AI · Feature spec", emoji: "📐", color: "blue", aliases: ["ai", "spec", "feature", "명세"] },
                    okrs: { title: "AI · Quarterly OKRs", emoji: "🎯", color: "green", aliases: ["ai", "okrs", "objective", "분기"] },
                    onboarding_checklist: { title: "AI · Onboarding checklist", emoji: "📋", color: "blue", aliases: ["ai", "onboarding", "newhire", "온보딩"] },
                    prd: { title: "AI · PRD skeleton", emoji: "📑", color: "purple", aliases: ["ai", "prd", "spec", "기획서"] },
                    sales_pitch: { title: "AI · Sales pitch", emoji: "💰", color: "green", aliases: ["ai", "sales", "pitch", "세일즈"] },
                    cold_email: { title: "AI · Cold email", emoji: "❄️", color: "blue", aliases: ["ai", "cold", "outreach", "콜드메일"] },
                    q_and_a: { title: "AI · Q&A doc", emoji: "❓", color: "purple", aliases: ["ai", "qa", "q&a", "질문답변"] },
                    agenda_action: { title: "AI · Agenda → actions", emoji: "🧭", color: "blue", aliases: ["ai", "agenda", "actions", "안건"] },
                    escalation_email: { title: "AI · Escalation email", emoji: "🆘", color: "red", aliases: ["ai", "escalation", "issue", "에스컬"] },
                    proposal: { title: "AI · 1-page proposal", emoji: "📜", color: "yellow", aliases: ["ai", "proposal", "1pager", "제안서"] },
                    roadmap: { title: "AI · Now/Next/Later", emoji: "🛣", color: "green", aliases: ["ai", "roadmap", "now", "로드맵"] },
                    sprint_plan: { title: "AI · Sprint plan", emoji: "🏃", color: "blue", aliases: ["ai", "sprint", "plan", "스프린트"] },
                    standup_async: { title: "AI · Async standup (3 lines)", emoji: "📞", color: "blue", aliases: ["ai", "async", "standup", "비동기"] },
                    release_detailed: { title: "AI · Detailed release notes", emoji: "📃", color: "green", aliases: ["ai", "release", "detailed", "상세릴리스"] },
                    code_review: { title: "AI · Code review comments", emoji: "🧑‍💻", color: "purple", aliases: ["ai", "code", "review", "코드리뷰"] },
                    devil_advocate: { title: "AI · Devil's advocate", emoji: "😈", color: "red", aliases: ["ai", "devil", "advocate", "악마변호인"] },
                    objection_handler: { title: "AI · Objection handler", emoji: "🛡", color: "purple", aliases: ["ai", "objection", "handle", "대응"] },
                    changelog_emoji: { title: "AI · Emoji changelog", emoji: "🪄", color: "green", aliases: ["ai", "changelog", "emoji", "변경이력"] },
                    inverse_faq: { title: "AI · Inverse FAQ (A→Q)", emoji: "🔄", color: "blue", aliases: ["ai", "inverse", "faq", "역질문"] },
                    style_guide: { title: "AI · Style guide", emoji: "🎨", color: "purple", aliases: ["ai", "style", "guide", "스타일"] },
                    email_friendly: { title: "AI · Email — warm tone", emoji: "💌", color: "green", aliases: ["ai", "warm", "friendly", "따뜻"] },
                    persona_quote: { title: "AI · Persona pull-quotes", emoji: "💬", color: "yellow", aliases: ["ai", "quote", "persona", "인용"] },
                    voice_script: { title: "AI · Voice-over script", emoji: "🎙", color: "purple", aliases: ["ai", "voice", "script", "보이스오버"] },
                    short_bio: { title: "AI · Short bio (60w)", emoji: "👤", color: "blue", aliases: ["ai", "bio", "short", "약력"] },
                    long_bio: { title: "AI · Long bio (200w)", emoji: "👥", color: "blue", aliases: ["ai", "bio", "long", "긴약력"] },
                    job_rejection: { title: "AI · Job rejection email", emoji: "📭", color: "red", aliases: ["ai", "rejection", "decline", "탈락"] },
                    recruiting_msg: { title: "AI · Recruiting DM", emoji: "🔎", color: "blue", aliases: ["ai", "recruit", "message", "채용연락"] },
                    exec_summary: { title: "AI · Executive summary", emoji: "📔", color: "blue", aliases: ["ai", "exec", "summary", "경영요약"] },
                    lessons_learned: { title: "AI · Lessons learned", emoji: "🎓", color: "yellow", aliases: ["ai", "lessons", "learned", "교훈"] },
                    decision_memo: { title: "AI · Decision memo", emoji: "🧭", color: "purple", aliases: ["ai", "decision", "memo", "결정메모"] },
                    release_faq: { title: "AI · Release FAQ", emoji: "❓", color: "green", aliases: ["ai", "release", "faq", "출시FAQ"] },
                    launch_checklist: { title: "AI · Launch checklist", emoji: "🚀", color: "green", aliases: ["ai", "launch", "checklist", "출시체크"] },
                    feedback_questions: { title: "AI · Feedback questions", emoji: "🗳", color: "blue", aliases: ["ai", "feedback", "questions", "피드백질문"] },
                    user_research_plan: { title: "AI · UX research plan", emoji: "🔬", color: "purple", aliases: ["ai", "research", "plan", "유저리서치"] },
                    discovery_questions: { title: "AI · Discovery Qs", emoji: "🧪", color: "blue", aliases: ["ai", "discovery", "interview", "디스커버리"] },
                    product_tour: { title: "AI · Product tour copy", emoji: "🧭", color: "blue", aliases: ["ai", "tour", "tooltip", "투어"] },
                    day_in_life: { title: "AI · Day in life", emoji: "🌅", color: "yellow", aliases: ["ai", "day", "life", "하루"] },
                    founder_story: { title: "AI · Founder story", emoji: "🏁", color: "purple", aliases: ["ai", "founder", "story", "창업스토리"] },
                    positioning: { title: "AI · Positioning statement", emoji: "🎯", color: "green", aliases: ["ai", "positioning", "statement", "포지셔닝"] },
                    ad_copy: { title: "AI · Ad copy (S/M/L)", emoji: "📣", color: "yellow", aliases: ["ai", "ad", "copy", "광고"] },
                    headline_test: { title: "AI · Headline A/B tests", emoji: "🆎", color: "blue", aliases: ["ai", "headline", "ab", "test"] },
                    before_after: { title: "AI · Before / After", emoji: "↔", color: "purple", aliases: ["ai", "before", "after", "전후"] },
                    social_proof: { title: "AI · Social proof copy", emoji: "👥", color: "green", aliases: ["ai", "social", "proof", "후기"] },
                    error_msg: { title: "AI · Friendly error", emoji: "🤖", color: "red", aliases: ["ai", "error", "message", "에러메시지"] },
                    migration_guide: { title: "AI · Migration guide", emoji: "🚚", color: "blue", aliases: ["ai", "migration", "upgrade", "마이그레이션"] },
                    legal_disclaimer: { title: "AI · Legal disclaimer", emoji: "⚖️", color: "yellow", aliases: ["ai", "legal", "disclaimer", "면책"] },
                    privacy_summary: { title: "AI · Privacy summary", emoji: "🔐", color: "purple", aliases: ["ai", "privacy", "summary", "개인정보"] },
                    api_changelog: { title: "AI · API changelog", emoji: "🔌", color: "blue", aliases: ["ai", "api", "changelog", "API변경"] },
                    whitepaper_outline: { title: "AI · Whitepaper outline", emoji: "📄", color: "purple", aliases: ["ai", "whitepaper", "outline", "백서"] },
                    press_quote: { title: "AI · Press quotes (3)", emoji: "🗞", color: "blue", aliases: ["ai", "press", "quote", "보도인용"] },
                    customer_quote: { title: "AI · Customer pull-quote", emoji: "💬", color: "green", aliases: ["ai", "customer", "quote", "고객인용"] },
                    content_calendar: { title: "AI · 4-week content calendar", emoji: "🗓", color: "blue", aliases: ["ai", "calendar", "content", "콘텐츠일정"] },
                    seo_meta: { title: "AI · SEO meta tags", emoji: "🔖", color: "blue", aliases: ["ai", "seo", "meta", "메타태그"] },
                    alt_text: { title: "AI · Image alt text", emoji: "🖼", color: "purple", aliases: ["ai", "alt", "image", "alt텍스트"] },
                    thumbnail_text: { title: "AI · Thumbnail overlay", emoji: "🎬", color: "yellow", aliases: ["ai", "thumbnail", "overlay", "썸네일"] },
                    survey_design: { title: "AI · Survey (5 Q mix)", emoji: "📋", color: "blue", aliases: ["ai", "survey", "questions", "설문설계"] },
                    system_prompt: { title: "AI · System prompt", emoji: "🤖", color: "purple", aliases: ["ai", "system", "prompt", "시스템프롬프트"] },
                    talking_points: { title: "AI · Talking points (5)", emoji: "📌", color: "yellow", aliases: ["ai", "talking", "points", "발표포인트"] },
                    brief_from_bullets: { title: "AI · Bullets → brief prose", emoji: "📜", color: "green", aliases: ["ai", "brief", "expand", "확장"] },
                    haiku: { title: "AI · Haiku (5/7/5)", emoji: "🎋", color: "yellow", aliases: ["ai", "haiku", "poem", "하이쿠"] },
                    quotes_on_topic: { title: "AI · Famous quotes (5)", emoji: "📚", color: "purple", aliases: ["ai", "quotes", "famous", "명언"] },
                    tldr_emoji: { title: "AI · 1-line TL;DR + emoji", emoji: "💨", color: "blue", aliases: ["ai", "tldr", "emoji", "한줄요약"] },
                    icebreaker: { title: "AI · Icebreakers (3)", emoji: "🧊", color: "blue", aliases: ["ai", "icebreaker", "meeting", "아이스브레이커"] },
                    one_on_one: { title: "AI · 1:1 agenda", emoji: "🧑‍🤝‍🧑", color: "purple", aliases: ["ai", "1on1", "agenda", "원온원"] },
                    customer_pain: { title: "AI · Customer pain points", emoji: "🩹", color: "red", aliases: ["ai", "pain", "customer", "고통점"] },
                    pivot_options: { title: "AI · Pivot options (3)", emoji: "🔄", color: "purple", aliases: ["ai", "pivot", "options", "피벗"] },
                    risk_register: { title: "AI · Risk register", emoji: "🧯", color: "red", aliases: ["ai", "risk", "register", "위험등록부"] },
                    team_charter: { title: "AI · Team charter", emoji: "🛡", color: "blue", aliases: ["ai", "team", "charter", "팀헌장"] },
                    values_statement: { title: "AI · Values (5)", emoji: "💠", color: "purple", aliases: ["ai", "values", "core", "가치"] },
                    swot_personal: { title: "AI · Personal SWOT", emoji: "👤", color: "blue", aliases: ["ai", "swot", "personal", "개인swot"] },
                    career_pitch: { title: "AI · Career pitch (90s)", emoji: "🎤", color: "green", aliases: ["ai", "career", "pitch", "커리어피치"] },
                    resignation_letter: { title: "AI · Resignation letter", emoji: "✉", color: "yellow", aliases: ["ai", "resignation", "quit", "사직서"] },
                    welcome_message: { title: "AI · Welcome (Slack)", emoji: "👋", color: "blue", aliases: ["ai", "welcome", "newhire", "환영메시지"] },
                    exit_interview: { title: "AI · Exit interview Qs", emoji: "🚪", color: "red", aliases: ["ai", "exit", "interview", "퇴사인터뷰"] },
                    checkin_questions: { title: "AI · Team check-in Qs", emoji: "👂", color: "blue", aliases: ["ai", "checkin", "team", "체크인"] },
                    lunch_and_learn: { title: "AI · Lunch & learn plan", emoji: "🥗", color: "yellow", aliases: ["ai", "lunch", "learn", "런치앤런"] },
                    coffee_chat: { title: "AI · Coffee chat starters", emoji: "☕", color: "purple", aliases: ["ai", "coffee", "chat", "커피챗"] },
                    personal_mission: { title: "AI · Personal mission", emoji: "🧭", color: "green", aliases: ["ai", "personal", "mission", "개인미션"] },
                    book_summary_3: { title: "AI · 3-part book summary", emoji: "📚", color: "purple", aliases: ["ai", "book", "summary", "책요약"] },
                    weekly_review: { title: "AI · Weekly review prompts", emoji: "📆", color: "blue", aliases: ["ai", "weekly", "review", "주간회고"] },
                    monthly_review: { title: "AI · Monthly review", emoji: "🗓", color: "blue", aliases: ["ai", "monthly", "review", "월간회고"] },
                    goal_tree: { title: "AI · Goal tree", emoji: "🌳", color: "green", aliases: ["ai", "goal", "tree", "목표트리"] },
                    habits_list: { title: "AI · Habits to start", emoji: "🪴", color: "green", aliases: ["ai", "habits", "habit", "습관"] },
                    reading_list: { title: "AI · Reading list (5)", emoji: "📖", color: "yellow", aliases: ["ai", "reading", "books", "독서목록"] },
                    mantra: { title: "AI · Mantras (3)", emoji: "🪷", color: "purple", aliases: ["ai", "mantra", "affirmation", "만트라"] },
                    vision_statement: { title: "AI · Vision statement", emoji: "🔭", color: "blue", aliases: ["ai", "vision", "statement", "비전"] },
                    quarterly_okrs: { title: "AI · Quarterly OKRs (deep)", emoji: "🎯", color: "green", aliases: ["ai", "okrs", "quarterly", "분기OKR"] },
                    negotiation_script: { title: "AI · Negotiation script", emoji: "🤝", color: "purple", aliases: ["ai", "negotiation", "script", "협상"] },
                    performance_review: { title: "AI · Performance review", emoji: "📈", color: "blue", aliases: ["ai", "performance", "review", "성과리뷰"] },
                    perf_feedback: { title: "AI · SBI feedback", emoji: "🧮", color: "green", aliases: ["ai", "feedback", "sbi", "성과피드백"] },
                    skip_level: { title: "AI · Skip-level Qs", emoji: "📡", color: "blue", aliases: ["ai", "skip", "level", "스킵레벨"] },
                    feedback_360: { title: "AI · 360 feedback survey", emoji: "🔄", color: "purple", aliases: ["ai", "360", "feedback", "다면평가"] },
                    career_ladder: { title: "AI · Career ladder", emoji: "🪜", color: "blue", aliases: ["ai", "career", "ladder", "직무사다리"] },
                    comp_band: { title: "AI · Comp band explainer", emoji: "💵", color: "yellow", aliases: ["ai", "comp", "band", "보상밴드"] },
                    pip_plan: { title: "AI · PIP plan (30/60/90)", emoji: "🩺", color: "red", aliases: ["ai", "pip", "plan", "성과개선"] },
                    reorg_memo: { title: "AI · Reorg announcement", emoji: "🏢", color: "blue", aliases: ["ai", "reorg", "memo", "조직개편"] },
                    hiring_rubric: { title: "AI · Hiring rubric", emoji: "📊", color: "green", aliases: ["ai", "hiring", "rubric", "채용평가표"] },
                    reference_check: { title: "AI · Reference check Qs", emoji: "📞", color: "blue", aliases: ["ai", "reference", "check", "레퍼런스체크"] },
                    promotion_case: { title: "AI · Promotion case", emoji: "🏅", color: "green", aliases: ["ai", "promotion", "case", "승진"] },
                    short_story: { title: "AI · Short story (200w)", emoji: "📖", color: "yellow", aliases: ["ai", "story", "short", "단편소설"] },
                    character_bio: { title: "AI · Character bio", emoji: "🦸", color: "purple", aliases: ["ai", "character", "bio", "캐릭터"] },
                    worldbuilding: { title: "AI · Worldbuilding sketch", emoji: "🌌", color: "blue", aliases: ["ai", "world", "building", "세계관"] },
                    dialogue_scene: { title: "AI · Dialogue scene", emoji: "🎬", color: "purple", aliases: ["ai", "dialogue", "scene", "대화장면"] },
                    lesson_plan: { title: "AI · Lesson plan (45m)", emoji: "🏫", color: "green", aliases: ["ai", "lesson", "plan", "수업계획"] },
                    study_plan: { title: "AI · 1-week study plan", emoji: "🗒", color: "blue", aliases: ["ai", "study", "plan", "학습계획"] },
                    architecture_review: { title: "AI · Architecture review", emoji: "🏗", color: "purple", aliases: ["ai", "architecture", "review", "아키리뷰"] },
                    docstring: { title: "AI · Function docstring", emoji: "📝", color: "blue", aliases: ["ai", "docstring", "jsdoc", "함수문서"] },
                    sample_data: { title: "AI · Sample data (5 JSON)", emoji: "🧪", color: "yellow", aliases: ["ai", "sample", "data", "샘플데이터"] },
                    json_schema: { title: "AI · JSON Schema from example", emoji: "🧬", color: "blue", aliases: ["ai", "json", "schema", "JSON스키마"] },
                    sql_optimize: { title: "AI · SQL optimize", emoji: "🗃", color: "green", aliases: ["ai", "sql", "optimize", "쿼리최적화"] },
                    code_comment: { title: "AI · Comment this code", emoji: "💭", color: "blue", aliases: ["ai", "code", "comment", "코드주석"] },
                    investor_update: { title: "AI · Investor update email", emoji: "💼", color: "blue", aliases: ["ai", "investor", "update", "투자자업데이트"] },
                    board_update: { title: "AI · Board update memo", emoji: "🏛", color: "purple", aliases: ["ai", "board", "update", "보드업데이트"] },
                    pitch_deck: { title: "AI · 10-slide pitch deck", emoji: "🎞", color: "green", aliases: ["ai", "pitch", "deck", "피치덱"] },
                    gtm_plan: { title: "AI · GTM plan", emoji: "🛫", color: "blue", aliases: ["ai", "gtm", "go-to-market", "GTM"] },
                    pricing_strategy: { title: "AI · Pricing strategy (3 tier)", emoji: "💲", color: "green", aliases: ["ai", "pricing", "strategy", "가격전략"] },
                    financial_narrative: { title: "AI · Financial narrative", emoji: "🧾", color: "yellow", aliases: ["ai", "financial", "narrative", "재무내러티브"] },
                    branding_attributes: { title: "AI · Brand attributes", emoji: "🪄", color: "purple", aliases: ["ai", "brand", "attributes", "브랜드속성"] },
                    tone_voice: { title: "AI · Tone of voice guide", emoji: "📢", color: "blue", aliases: ["ai", "tone", "voice", "톤보이스"] },
                    editorial_calendar: { title: "AI · Editorial calendar (12w)", emoji: "📰", color: "blue", aliases: ["ai", "editorial", "calendar", "편집캘린더"] },
                    cs_playbook: { title: "AI · CS playbook", emoji: "🎯", color: "green", aliases: ["ai", "cs", "playbook", "고객성공"] },
                    discovery_deck: { title: "AI · Discovery readout deck", emoji: "🔍", color: "purple", aliases: ["ai", "discovery", "deck", "디스커버리덱"] },
                    github_issue: { title: "AI · GitHub bug issue", emoji: "🐞", color: "red", aliases: ["ai", "github", "issue", "이슈"] },
                    github_pr: { title: "AI · GitHub PR description", emoji: "🔀", color: "purple", aliases: ["ai", "github", "pr", "풀리퀘"] },
                    apology_letter: { title: "AI · Apology email", emoji: "🙇", color: "red", aliases: ["ai", "apology", "sorry", "사과"] },
                    thank_you_note: { title: "AI · Thank-you note", emoji: "🫶", color: "green", aliases: ["ai", "thanks", "thank", "감사"] },
                    reddit_post: { title: "AI · Reddit post", emoji: "🅁", color: "yellow", aliases: ["ai", "reddit", "post", "레딧"] },
                    hn_post: { title: "AI · Show HN post", emoji: "🟧", color: "yellow", aliases: ["ai", "hn", "showhn", "해커뉴스"] },
                    screenplay_scene: { title: "AI · Screenplay scene", emoji: "🎬", color: "purple", aliases: ["ai", "screenplay", "scene", "시나리오"] },
                    story_arc: { title: "AI · 3-act story arc", emoji: "🎭", color: "blue", aliases: ["ai", "story", "arc", "스토리아크"] },
                    sonnet: { title: "AI · Shakespearean sonnet", emoji: "✒", color: "yellow", aliases: ["ai", "sonnet", "poem", "소네트"] },
                    free_verse: { title: "AI · Free-verse poem", emoji: "🪶", color: "yellow", aliases: ["ai", "free", "verse", "자유시"] },
                    idiom_translate: { title: "AI · Idiom translation", emoji: "🌐", color: "blue", aliases: ["ai", "idiom", "translate", "관용어"] },
                    comedian_bit: { title: "AI · Stand-up bit (60s)", emoji: "🎤", color: "yellow", aliases: ["ai", "comedy", "bit", "스탠드업"] },
                    yelp_review: { title: "AI · Yelp-style review", emoji: "⭐", color: "yellow", aliases: ["ai", "yelp", "review", "리뷰"] },
                    recipe: { title: "AI · Simple recipe", emoji: "🍳", color: "green", aliases: ["ai", "recipe", "cook", "레시피"] },
                    handover_doc: { title: "AI · Handover doc", emoji: "🤲", color: "blue", aliases: ["ai", "handover", "transition", "인수인계"] },
                    runbook: { title: "AI · Ops runbook", emoji: "📕", color: "red", aliases: ["ai", "runbook", "ops", "런북"] },
                    troubleshooting: { title: "AI · Troubleshooting flow", emoji: "🩻", color: "purple", aliases: ["ai", "troubleshoot", "debug", "트러블슈팅"] },
                    partnership_pitch: { title: "AI · Partnership pitch", emoji: "🤝", color: "green", aliases: ["ai", "partnership", "pitch", "파트너십"] },
                    demo_day_pitch: { title: "AI · Demo day pitch (60s)", emoji: "🎙", color: "yellow", aliases: ["ai", "demoday", "pitch", "데모데이"] },
                    angel_update: { title: "AI · Angel investor update", emoji: "👼", color: "blue", aliases: ["ai", "angel", "update", "엔젤업데이트"] },
                    buying_guide: { title: "AI · Buying guide", emoji: "🛍", color: "yellow", aliases: ["ai", "buying", "guide", "구매가이드"] },
                    comparison_vs: { title: "AI · Comparison vs alternative", emoji: "⚔", color: "red", aliases: ["ai", "vs", "comparison", "대안비교"] },
                    one_pager: { title: "AI · Product one-pager", emoji: "📄", color: "blue", aliases: ["ai", "one", "pager", "원페이저"] },
                    meeting_recap: { title: "AI · Meeting recap email", emoji: "🗒", color: "green", aliases: ["ai", "recap", "meeting", "미팅요약"] },
                    knowledge_transfer: { title: "AI · KT session outline", emoji: "🧑‍🏫", color: "blue", aliases: ["ai", "kt", "transfer", "지식이전"] },
                    eli_expert: { title: "AI · Explain to expert", emoji: "🎓", color: "purple", aliases: ["ai", "expert", "explain", "전문가설명"] },
                    press_statement: { title: "AI · Public statement", emoji: "📰", color: "blue", aliases: ["ai", "press", "statement", "공식입장"] },
                    investor_faq: { title: "AI · Investor FAQ (6)", emoji: "💼", color: "blue", aliases: ["ai", "investor", "faq", "투자자FAQ"] },
                    linkedin_newsletter: { title: "AI · LinkedIn newsletter", emoji: "📨", color: "blue", aliases: ["ai", "linkedin", "newsletter", "링크드인뉴스레터"] },
                    thought_leader: { title: "AI · Thought leader post", emoji: "💡", color: "purple", aliases: ["ai", "thought", "leader", "TL"] },
                    podcast_notes: { title: "AI · Podcast show notes", emoji: "🎧", color: "yellow", aliases: ["ai", "podcast", "notes", "팟캐스트노트"] },
                    video_script: { title: "AI · 3-min video script", emoji: "📹", color: "purple", aliases: ["ai", "video", "script", "영상대본"] },
                    infographic_labels: { title: "AI · Infographic labels", emoji: "📊", color: "yellow", aliases: ["ai", "infographic", "labels", "라벨"] },
                    toast_speech: { title: "AI · Work toast (회식)", emoji: "🥂", color: "yellow", aliases: ["ai", "toast", "speech", "건배사"] },
                    wedding_toast: { title: "AI · Wedding toast", emoji: "💍", color: "pink", aliases: ["ai", "wedding", "toast", "결혼축사"] },
                    birthday_message: { title: "AI · Birthday message", emoji: "🎂", color: "yellow", aliases: ["ai", "birthday", "message", "생일메시지"] },
                    condolence: { title: "AI · Condolence note", emoji: "🤍", color: "purple", aliases: ["ai", "condolence", "sympathy", "조의"] },
                    referral_request: { title: "AI · Referral request", emoji: "🪢", color: "blue", aliases: ["ai", "referral", "request", "레퍼럴요청"] },
                    linkedin_profile: { title: "AI · LinkedIn About", emoji: "👔", color: "blue", aliases: ["ai", "linkedin", "profile", "프로필"] },
                    substack_post: { title: "AI · Substack post", emoji: "✉", color: "green", aliases: ["ai", "substack", "newsletter", "서브스택"] },
                    elevator_no_jargon: { title: "AI · 30s pitch (no jargon)", emoji: "🗣", color: "green", aliases: ["ai", "elevator", "jargon", "쉬운피치"] },
                    data_table_narrative: { title: "AI · Data table → narrative", emoji: "📊", color: "blue", aliases: ["ai", "data", "narrative", "표내러티브"] },
                    chart_caption: { title: "AI · Chart caption", emoji: "📈", color: "blue", aliases: ["ai", "chart", "caption", "차트설명"] },
                    dashboard_summary: { title: "AI · Dashboard 1-liner", emoji: "📟", color: "blue", aliases: ["ai", "dashboard", "summary", "대시보드요약"] },
                    sql_explain: { title: "AI · Explain SQL", emoji: "🗒", color: "blue", aliases: ["ai", "sql", "explain", "쿼리설명"] },
                    cli_help: { title: "AI · CLI help text", emoji: "💻", color: "yellow", aliases: ["ai", "cli", "help", "CLI도움말"] },
                    error_explain: { title: "AI · Explain error log", emoji: "🚨", color: "red", aliases: ["ai", "error", "log", "에러설명"] },
                    refactor_suggest: { title: "AI · Refactor suggestions", emoji: "🧰", color: "purple", aliases: ["ai", "refactor", "suggest", "리팩터"] },
                    test_edge_cases: { title: "AI · Edge cases (7)", emoji: "🧩", color: "blue", aliases: ["ai", "edge", "cases", "엣지케이스"] },
                    name_suggest: { title: "AI · Name suggestions (5)", emoji: "🏷", color: "yellow", aliases: ["ai", "name", "suggest", "이름후보"] },
                    explain_diagram: { title: "AI · Explain diagram", emoji: "🗺", color: "blue", aliases: ["ai", "diagram", "explain", "다이어그램설명"] },
                    sequence_diagram: { title: "AI · Mermaid sequence", emoji: "🔁", color: "purple", aliases: ["ai", "sequence", "mermaid", "시퀀스다이어그램"] },
                    state_machine: { title: "AI · Mermaid state machine", emoji: "🧠", color: "purple", aliases: ["ai", "state", "machine", "상태기계"] },
                    ad_headlines: { title: "AI · Ad headlines (7)", emoji: "📣", color: "yellow", aliases: ["ai", "ad", "headlines", "광고헤드라인"] },
                    og_tags: { title: "AI · OG / social meta", emoji: "🌐", color: "blue", aliases: ["ai", "og", "meta", "OG태그"] },
                    commit_template: { title: "AI · Commit template", emoji: "📦", color: "green", aliases: ["ai", "commit", "template", "커밋템플릿"] },
                    branch_name: { title: "AI · Branch names (5)", emoji: "🌿", color: "green", aliases: ["ai", "branch", "git", "브랜치이름"] },
                    unit_test_skeleton: { title: "AI · Unit test skeleton", emoji: "🧪", color: "blue", aliases: ["ai", "unit", "test", "단위테스트"] },
                    readme_skeleton: { title: "AI · README skeleton", emoji: "📖", color: "blue", aliases: ["ai", "readme", "skeleton", "리드미"] },
                    contributing_md: { title: "AI · CONTRIBUTING.md", emoji: "🤝", color: "green", aliases: ["ai", "contributing", "md", "기여가이드"] },
                    license_pick: { title: "AI · License pick", emoji: "⚖", color: "yellow", aliases: ["ai", "license", "oss", "라이선스"] },
                    cron_explain: { title: "AI · Explain cron", emoji: "⏲", color: "blue", aliases: ["ai", "cron", "explain", "cron설명"] },
                    regex_explain: { title: "AI · Explain regex", emoji: "🔣", color: "blue", aliases: ["ai", "regex", "explain", "정규식설명"] },
                    env_var_doc: { title: "AI · .env var doc table", emoji: "🔐", color: "purple", aliases: ["ai", "env", "vars", "환경변수"] },
                    elevator_perspectives: { title: "AI · Pitch — 3 perspectives", emoji: "🎯", color: "purple", aliases: ["ai", "pitch", "perspectives", "관점별피치"] },
                    twitter_bio: { title: "AI · Twitter/X bios (3)", emoji: "🐦", color: "blue", aliases: ["ai", "twitter", "bio", "트위터바이오"] },
                    instagram_caption: { title: "AI · Instagram caption", emoji: "📷", color: "pink", aliases: ["ai", "instagram", "caption", "인스타캡션"] },
                    tiktok_hook: { title: "AI · TikTok hooks (5)", emoji: "🎵", color: "purple", aliases: ["ai", "tiktok", "hook", "틱톡훅"] },
                    youtube_title: { title: "AI · YouTube titles (5)", emoji: "▶", color: "red", aliases: ["ai", "youtube", "title", "유튜브제목"] },
                    youtube_description: { title: "AI · YouTube description", emoji: "📺", color: "red", aliases: ["ai", "youtube", "description", "유튜브설명"] },
                    app_store_desc: { title: "AI · App store copy", emoji: "🛒", color: "blue", aliases: ["ai", "appstore", "copy", "앱스토어"] },
                    notification_copy: { title: "AI · Push notification (3)", emoji: "🔔", color: "yellow", aliases: ["ai", "push", "notification", "푸시카피"] },
                    email_subject_ab: { title: "AI · Email subject A/B (3)", emoji: "🆎", color: "blue", aliases: ["ai", "subject", "ab", "메일제목"] },
                    empty_state_copy: { title: "AI · Empty state copy", emoji: "🪟", color: "green", aliases: ["ai", "empty", "state", "빈상태카피"] },
                    message_404: { title: "AI · 404 page message", emoji: "🚧", color: "purple", aliases: ["ai", "404", "notfound", "404메시지"] },
                    maintenance_notice: { title: "AI · Maintenance notice", emoji: "🛠", color: "yellow", aliases: ["ai", "maintenance", "notice", "점검안내"] },
                    system_status_blurb: { title: "AI · Status page blurb", emoji: "🟢", color: "green", aliases: ["ai", "status", "blurb", "상태페이지"] },
                    holiday_greeting: { title: "AI · B2B holiday greeting", emoji: "🎄", color: "green", aliases: ["ai", "holiday", "greeting", "연말인사"] },
                    jira_ticket: { title: "AI · Jira ticket", emoji: "🟦", color: "blue", aliases: ["ai", "jira", "ticket", "지라"] },
                    linear_ticket: { title: "AI · Linear issue", emoji: "📐", color: "purple", aliases: ["ai", "linear", "issue", "리니어"] },
                    weekly_status: { title: "AI · Weekly status email", emoji: "📤", color: "blue", aliases: ["ai", "weekly", "status", "주간보고"] },
                    exec_1pager: { title: "AI · Exec 1-pager (decision)", emoji: "🗂", color: "purple", aliases: ["ai", "exec", "1pager", "경영진"] },
                    risk_rag: { title: "AI · Risk RAG table", emoji: "🚦", color: "red", aliases: ["ai", "risk", "rag", "RAG"] },
                    budget_narrative: { title: "AI · Budget request", emoji: "💸", color: "yellow", aliases: ["ai", "budget", "narrative", "예산"] },
                    faq_localize: { title: "AI · FAQ in EN/KO/JA", emoji: "🌐", color: "blue", aliases: ["ai", "faq", "localize", "다국어"] },
                    security_runbook: { title: "AI · Security runbook", emoji: "🛡", color: "red", aliases: ["ai", "security", "runbook", "보안"] },
                    incident_customer_comms: { title: "AI · Incident customer note", emoji: "📣", color: "red", aliases: ["ai", "incident", "comms", "장애안내"] },
                    tweet_rewrite: { title: "AI · Rewrite this tweet (3)", emoji: "🐤", color: "blue", aliases: ["ai", "tweet", "rewrite", "트윗"] },
                    linkedin_comment: { title: "AI · LinkedIn comment", emoji: "💬", color: "blue", aliases: ["ai", "linkedin", "comment", "코멘트"] },
                    yc_application: { title: "AI · YC application Qs", emoji: "🟧", color: "yellow", aliases: ["ai", "yc", "application", "와이콤"] },
                    cv_bullet: { title: "AI · CV bullet (X-Y-Z)", emoji: "🎯", color: "green", aliases: ["ai", "cv", "resume", "이력서불릿"] },
                    lightning_talk: { title: "AI · Lightning talk (5m)", emoji: "⚡", color: "yellow", aliases: ["ai", "lightning", "talk", "라이트닝토크"] },
                    conference_cfp: { title: "AI · Conference CFP", emoji: "📤", color: "purple", aliases: ["ai", "cfp", "conference", "발표제안"] },
                    talk_abstract: { title: "AI · Talk abstract", emoji: "📄", color: "blue", aliases: ["ai", "abstract", "talk", "발표초록"] },
                    intro_bio_speaker: { title: "AI · Speaker intro", emoji: "🎤", color: "blue", aliases: ["ai", "speaker", "intro", "발표자소개"] },
                    workshop_plan: { title: "AI · 2-hour workshop", emoji: "🛠", color: "green", aliases: ["ai", "workshop", "plan", "워크숍"] },
                    curriculum_outline: { title: "AI · 8-week curriculum", emoji: "📚", color: "blue", aliases: ["ai", "curriculum", "outline", "커리큘럼"] },
                    test_plan: { title: "AI · QA test plan", emoji: "🧪", color: "blue", aliases: ["ai", "qa", "test", "테스트계획"] },
                    bug_priority: { title: "AI · Triage bug priority", emoji: "🐛", color: "red", aliases: ["ai", "bug", "priority", "버그우선순위"] },
                    eli5_medical: { title: "AI · Medical for patients", emoji: "🩺", color: "purple", aliases: ["ai", "medical", "patient", "의학설명"] },
                    eli5_legal: { title: "AI · Legal in plain words", emoji: "⚖", color: "yellow", aliases: ["ai", "legal", "plain", "법률쉽게"] },
                    eli5_financial: { title: "AI · Finance plain words", emoji: "💴", color: "green", aliases: ["ai", "financial", "explain", "금융쉽게"] },
                    family_update: { title: "AI · Family update", emoji: "🏠", color: "yellow", aliases: ["ai", "family", "update", "가족안부"] },
                    old_friend_msg: { title: "AI · Reach out (old friend)", emoji: "🤗", color: "yellow", aliases: ["ai", "friend", "reach", "옛친구"] },
                    ad_mock_banner: { title: "AI · Banner ad copy", emoji: "🎯", color: "yellow", aliases: ["ai", "banner", "ad", "배너카피"] },
                    google_ad: { title: "AI · Google Ads copy", emoji: "🔎", color: "blue", aliases: ["ai", "google", "ad", "구글광고"] },
                    facebook_ad: { title: "AI · Meta/FB ad copy", emoji: "📘", color: "blue", aliases: ["ai", "facebook", "meta", "메타광고"] },
                    email_sequence_5: { title: "AI · 5-email drip", emoji: "💌", color: "blue", aliases: ["ai", "drip", "sequence", "이메일시퀀스"] },
                    welcome_flow: { title: "AI · 3-step welcome flow", emoji: "👣", color: "green", aliases: ["ai", "welcome", "onboarding", "환영플로우"] },
                    upsell_msg: { title: "AI · In-app upsell", emoji: "📈", color: "yellow", aliases: ["ai", "upsell", "upgrade", "업셀"] },
                    cancel_recovery: { title: "AI · Cancel save offer", emoji: "🛟", color: "red", aliases: ["ai", "cancel", "save", "해지방지"] },
                    winback: { title: "AI · Winback email", emoji: "↩", color: "purple", aliases: ["ai", "winback", "recover", "윈백"] },
                    nps_followup: { title: "AI · NPS follow-ups (3)", emoji: "📊", color: "blue", aliases: ["ai", "nps", "followup", "NPS후속"] },
                    csat_script: { title: "AI · CSAT survey (5 Q)", emoji: "🙂", color: "green", aliases: ["ai", "csat", "survey", "고객만족도"] },
                    handoff_summary: { title: "AI · Shift handoff", emoji: "🔁", color: "blue", aliases: ["ai", "handoff", "shift", "교대인수"] },
                    ooo_message: { title: "AI · OOO auto-reply", emoji: "🌴", color: "yellow", aliases: ["ai", "ooo", "vacation", "자리비움"] },
                    calendar_invite_note: { title: "AI · Calendar invite body", emoji: "📅", color: "blue", aliases: ["ai", "calendar", "invite", "초대장"] },
                    job_listing: { title: "AI · Job listing (LinkedIn)", emoji: "📌", color: "blue", aliases: ["ai", "job", "listing", "채용공고"] },
                    job_rejection_no_fit: { title: "AI · Rejection — culture fit", emoji: "📭", color: "red", aliases: ["ai", "rejection", "fit", "탈락컬쳐"] },
                    internship_jd: { title: "AI · Internship JD", emoji: "🧑‍🎓", color: "blue", aliases: ["ai", "internship", "jd", "인턴JD"] },
                    relocation_package: { title: "AI · Relocation package", emoji: "📦", color: "yellow", aliases: ["ai", "relocation", "moving", "이주패키지"] },
                    sabbatical_pitch: { title: "AI · Sabbatical request", emoji: "🌴", color: "yellow", aliases: ["ai", "sabbatical", "leave", "안식년"] },
                    raise_request: { title: "AI · Comp review request", emoji: "💰", color: "green", aliases: ["ai", "raise", "comp", "연봉인상"] },
                    promotion_self_pitch: { title: "AI · Self-promotion memo", emoji: "🪪", color: "purple", aliases: ["ai", "self", "promotion", "셀프승진"] },
                    transfer_request: { title: "AI · Team transfer", emoji: "🔀", color: "blue", aliases: ["ai", "transfer", "team", "부서이동"] },
                    remote_policy: { title: "AI · Remote work policy", emoji: "🏡", color: "green", aliases: ["ai", "remote", "policy", "원격근무"] },
                    handbook_page: { title: "AI · Handbook page", emoji: "📔", color: "blue", aliases: ["ai", "handbook", "policy", "사내핸드북"] },
                    code_of_conduct: { title: "AI · Code of conduct", emoji: "🛡", color: "purple", aliases: ["ai", "coc", "conduct", "행동강령"] },
                    community_rules: { title: "AI · Community rules (5)", emoji: "🤝", color: "green", aliases: ["ai", "community", "rules", "커뮤니티"] },
                    diversity_statement: { title: "AI · D&I statement", emoji: "🌈", color: "purple", aliases: ["ai", "diversity", "dei", "D&I"] },
                    social_bio: { title: "AI · Cross-social bio", emoji: "👤", color: "blue", aliases: ["ai", "social", "bio", "소셜바이오"] },
                    influencer_pitch: { title: "AI · Influencer outreach", emoji: "📣", color: "purple", aliases: ["ai", "influencer", "outreach", "인플루언서"] },
                    affiliate_pitch: { title: "AI · Affiliate program pitch", emoji: "🔗", color: "green", aliases: ["ai", "affiliate", "creator", "제휴"] },
                    landing_tour: { title: "AI · Landing section order", emoji: "🗺", color: "blue", aliases: ["ai", "landing", "sections", "랜딩구성"] },
                    security_policy: { title: "AI · Security policy", emoji: "🔐", color: "red", aliases: ["ai", "security", "policy", "보안정책"] },
                    incident_tweet: { title: "AI · Incident update tweet", emoji: "📡", color: "red", aliases: ["ai", "incident", "tweet", "장애트윗"] },
                    onboarding_tour: { title: "AI · 5-step product tour", emoji: "🧭", color: "blue", aliases: ["ai", "tour", "coachmark", "투어"] },
                    ff_rollout: { title: "AI · Feature flag rollout", emoji: "🚥", color: "purple", aliases: ["ai", "feature", "flag", "롤아웃"] },
                    experiment_plan: { title: "AI · A/B experiment plan", emoji: "⚗️", color: "blue", aliases: ["ai", "ab", "experiment", "실험계획"] },
                    experiment_readout: { title: "AI · A/B readout", emoji: "📑", color: "green", aliases: ["ai", "experiment", "readout", "실험결과"] },
                    metric_tree: { title: "AI · North-star metric tree", emoji: "⭐", color: "yellow", aliases: ["ai", "metric", "tree", "지표트리"] },
                    cohort_analysis: { title: "AI · Cohort narrative", emoji: "📊", color: "blue", aliases: ["ai", "cohort", "analysis", "코호트"] },
                    proposal_cover: { title: "AI · Proposal cover page", emoji: "🪪", color: "blue", aliases: ["ai", "proposal", "cover", "제안표지"] },
                    sow: { title: "AI · SOW (Statement of Work)", emoji: "📜", color: "purple", aliases: ["ai", "sow", "scope", "작업명세"] },
                    msa_summary: { title: "AI · MSA summary", emoji: "📑", color: "blue", aliases: ["ai", "msa", "contract", "MSA요약"] },
                    nda_summary: { title: "AI · NDA summary", emoji: "🤫", color: "purple", aliases: ["ai", "nda", "confidential", "NDA요약"] },
                    dpia: { title: "AI · DPIA skeleton", emoji: "🛡", color: "red", aliases: ["ai", "dpia", "privacy", "데이터영향"] },
                    soc2_readiness: { title: "AI · SOC 2 checklist", emoji: "✔", color: "green", aliases: ["ai", "soc2", "readiness", "SOC2"] },
                    gdpr_data_map: { title: "AI · GDPR data-flow map", emoji: "🗺", color: "blue", aliases: ["ai", "gdpr", "datamap", "데이터매핑"] },
                    dpa_clause: { title: "AI · DPA key clauses", emoji: "🔏", color: "purple", aliases: ["ai", "dpa", "clauses", "DPA"] },
                    rate_limit_msg: { title: "AI · API rate-limit JSON", emoji: "⛔", color: "red", aliases: ["ai", "rate", "limit", "rate한계"] },
                    billing_failure_msg: { title: "AI · Billing failure email", emoji: "💳", color: "red", aliases: ["ai", "billing", "failure", "결제실패"] },
                    refund_policy: { title: "AI · Refund policy", emoji: "↩", color: "yellow", aliases: ["ai", "refund", "policy", "환불정책"] },
                    data_retention_policy: { title: "AI · Data retention table", emoji: "🗄", color: "blue", aliases: ["ai", "retention", "data", "데이터보관"] },
                    cookie_banner_copy: { title: "AI · Cookie banner copy", emoji: "🍪", color: "yellow", aliases: ["ai", "cookie", "banner", "쿠키배너"] },
                    elevator_tldr: { title: "AI · TL;DR (1 sentence)", emoji: "✂️", color: "blue", aliases: ["ai", "tldr", "elevator", "한문장"] },
                    changelog_html: { title: "AI · Changelog (HTML)", emoji: "📑", color: "purple", aliases: ["ai", "changelog", "html", "체인지로그HTML"] },
                    sql_seed: { title: "AI · SQL seed (5 INSERT)", emoji: "🌱", color: "green", aliases: ["ai", "sql", "seed", "시드"] },
                    dockerfile: { title: "AI · Dockerfile", emoji: "🐳", color: "blue", aliases: ["ai", "docker", "dockerfile", "도커파일"] },
                    compose_yml: { title: "AI · docker-compose.yml", emoji: "🐙", color: "blue", aliases: ["ai", "compose", "docker", "컴포즈"] },
                    gh_actions: { title: "AI · GitHub Actions CI", emoji: "🟢", color: "green", aliases: ["ai", "github", "actions", "GH액션"] },
                    k8s_deploy: { title: "AI · K8s Deployment", emoji: "☸", color: "blue", aliases: ["ai", "k8s", "deployment", "쿠버네티스"] },
                    nginx_conf: { title: "AI · nginx config", emoji: "🟧", color: "green", aliases: ["ai", "nginx", "proxy", "nginx설정"] },
                    oauth_flow: { title: "AI · OAuth + PKCE flow", emoji: "🔐", color: "purple", aliases: ["ai", "oauth", "pkce", "OAuth"] },
                    jwt_claims: { title: "AI · JWT claims design", emoji: "🪙", color: "yellow", aliases: ["ai", "jwt", "claims", "JWT"] },
                    webhook_payload: { title: "AI · Webhook payload spec", emoji: "🪝", color: "blue", aliases: ["ai", "webhook", "payload", "웹훅"] },
                    data_model: { title: "AI · Relational data model", emoji: "🧱", color: "blue", aliases: ["ai", "data", "model", "데이터모델"] },
                    api_versioning: { title: "AI · API versioning policy", emoji: "🏷", color: "purple", aliases: ["ai", "api", "versioning", "API버전"] },
                    prd_section: { title: "AI · Expand a PRD section", emoji: "📑", color: "blue", aliases: ["ai", "prd", "section", "PRD섹션"] },
                    ux_copy_review: { title: "AI · UX copy review", emoji: "✏", color: "purple", aliases: ["ai", "ux", "copy", "UX검수"] },
                    accessibility_review: { title: "AI · A11y review", emoji: "♿", color: "blue", aliases: ["ai", "a11y", "accessibility", "접근성"] },
                    perf_budget: { title: "AI · Perf budget table", emoji: "⏱", color: "green", aliases: ["ai", "perf", "budget", "성능예산"] },
                    observability_plan: { title: "AI · Observability plan", emoji: "🔭", color: "blue", aliases: ["ai", "observability", "logs", "옵저버빌리티"] },
                    error_budget_slo: { title: "AI · SLO + error budget", emoji: "🎯", color: "red", aliases: ["ai", "slo", "sli", "SLO"] },
                    disaster_recovery: { title: "AI · DR plan (RTO/RPO)", emoji: "🆘", color: "red", aliases: ["ai", "dr", "disaster", "재해복구"] },
                    threat_model: { title: "AI · STRIDE threat model", emoji: "🕵", color: "red", aliases: ["ai", "threat", "stride", "위협모델"] },
                    api_deprecation: { title: "AI · API deprecation note", emoji: "⏳", color: "yellow", aliases: ["ai", "deprecation", "sunset", "API폐기"] },
                    feature_sunset: { title: "AI · Feature sunset note", emoji: "🌇", color: "yellow", aliases: ["ai", "sunset", "feature", "기능종료"] },
                    beta_invite: { title: "AI · Beta invitation", emoji: "🧪", color: "blue", aliases: ["ai", "beta", "invite", "베타초대"] },
                    waitlist_email: { title: "AI · Waitlist confirm", emoji: "📋", color: "blue", aliases: ["ai", "waitlist", "confirm", "대기명단"] },
                    early_access_email: { title: "AI · Early-access kickoff", emoji: "🚀", color: "green", aliases: ["ai", "early", "access", "얼리액세스"] },
                    emails_7day: { title: "AI · 7-day email course", emoji: "📅", color: "blue", aliases: ["ai", "course", "emails", "이메일코스"] },
                    lead_magnet_idea: { title: "AI · Lead magnets (5)", emoji: "🧲", color: "yellow", aliases: ["ai", "lead", "magnet", "리드마그넷"] },
                    landing_faq: { title: "AI · Landing FAQ (6)", emoji: "❓", color: "blue", aliases: ["ai", "landing", "faq", "랜딩FAQ"] },
                    landing_feature_grid: { title: "AI · Feature grid 3x2", emoji: "🟦", color: "blue", aliases: ["ai", "features", "grid", "기능그리드"] },
                    pricing_faq: { title: "AI · Pricing FAQ", emoji: "💲", color: "green", aliases: ["ai", "pricing", "faq", "가격FAQ"] },
                    comparison_grid: { title: "AI · 3-product comparison", emoji: "⚖", color: "purple", aliases: ["ai", "compare", "vs", "비교표"] },
                    vp_canvas: { title: "AI · VP canvas (Osterwalder)", emoji: "🧭", color: "blue", aliases: ["ai", "vpc", "value", "VPC"] },
                    jtbd: { title: "AI · JTBD statements (3)", emoji: "🛠", color: "purple", aliases: ["ai", "jtbd", "jobs", "JTBD"] },
                    north_star_narrative: { title: "AI · North-star + vision", emoji: "🌟", color: "yellow", aliases: ["ai", "north", "star", "북극성"] },
                    customer_journey: { title: "AI · Customer journey map", emoji: "🚶", color: "blue", aliases: ["ai", "journey", "customer", "고객여정"] },
                    pain_relief_list: { title: "AI · Pain → relief list", emoji: "🩹", color: "red", aliases: ["ai", "pain", "relief", "페인완화"] },
                    aha_moment: { title: "AI · Aha moments (3)", emoji: "💡", color: "yellow", aliases: ["ai", "aha", "moment", "아하모먼트"] },
                    activation_events: { title: "AI · Activation events (5)", emoji: "🔥", color: "green", aliases: ["ai", "activation", "events", "활성화이벤트"] },
                    funding_roadmap: { title: "AI · Fundraising roadmap", emoji: "💼", color: "blue", aliases: ["ai", "funding", "roadmap", "자금조달"] },
                    saas_pricing_page: { title: "AI · SaaS pricing page", emoji: "💲", color: "green", aliases: ["ai", "saas", "pricing", "SaaS가격"] },
                    usage_pricing: { title: "AI · Usage-based pricing", emoji: "📊", color: "blue", aliases: ["ai", "usage", "pricing", "사용량가격"] },
                    trial_conversion_email: { title: "AI · Trial conversion email", emoji: "🔁", color: "yellow", aliases: ["ai", "trial", "conversion", "트라이얼전환"] },
                    feat_deprecation_roadmap: { title: "AI · Feature deprecation table", emoji: "⏳", color: "red", aliases: ["ai", "deprecation", "roadmap", "폐기로드맵"] },
                    launch_day_checklist: { title: "AI · Launch-day checklist", emoji: "🚀", color: "green", aliases: ["ai", "launch", "day", "출시일"] },
                    product_hunt_launch: { title: "AI · Product Hunt launch", emoji: "🐱", color: "yellow", aliases: ["ai", "producthunt", "launch", "PH런치"] },
                    changelog_blog_post: { title: "AI · Changelog → blog post", emoji: "📝", color: "purple", aliases: ["ai", "changelog", "blog", "변경블로그"] },
                    release_tweet_thread: { title: "AI · 5-tweet launch thread", emoji: "🧵", color: "blue", aliases: ["ai", "tweet", "thread", "런치스레드"] },
                    dev_blog_post: { title: "AI · Engineering blog post", emoji: "👨‍💻", color: "blue", aliases: ["ai", "dev", "blog", "엔지니어링블로그"] },
                    api_doc_endpoint: { title: "AI · API endpoint doc", emoji: "📘", color: "blue", aliases: ["ai", "api", "doc", "API문서"] },
                    cli_tutorial: { title: "AI · CLI 5-min tutorial", emoji: "💻", color: "yellow", aliases: ["ai", "cli", "tutorial", "CLI튜토리얼"] },
                    sdk_getting_started: { title: "AI · SDK getting started", emoji: "📦", color: "green", aliases: ["ai", "sdk", "start", "SDK시작"] },
                    ux_microcopy: { title: "AI · UX microcopy (10)", emoji: "✍", color: "purple", aliases: ["ai", "ux", "microcopy", "마이크로카피"] },
                    dialog_confirm: { title: "AI · Confirm dialog copy", emoji: "⚠️", color: "red", aliases: ["ai", "dialog", "confirm", "확인다이얼로그"] },
                    form_error: { title: "AI · Form error messages", emoji: "🛑", color: "red", aliases: ["ai", "form", "error", "폼에러"] },
                    tooltip_copy: { title: "AI · Tooltip strings (5)", emoji: "💬", color: "blue", aliases: ["ai", "tooltip", "hint", "툴팁"] },
                    onboarding_tooltip_seq: { title: "AI · 7-tooltip onboarding", emoji: "🧭", color: "blue", aliases: ["ai", "onboarding", "tour", "온보딩투어"] },
                    empty_state_variations: { title: "AI · Empty-state — 3 tones", emoji: "🪟", color: "green", aliases: ["ai", "empty", "tones", "빈상태톤"] },
                    loading_skeleton_text: { title: "AI · Loading messages", emoji: "⏳", color: "yellow", aliases: ["ai", "loading", "skeleton", "로딩메시지"] },
                    cta_variants: { title: "AI · CTA variants (6)", emoji: "🎯", color: "yellow", aliases: ["ai", "cta", "variants", "CTA변형"] },
                    banner_promo: { title: "AI · Promo banner", emoji: "🪧", color: "yellow", aliases: ["ai", "banner", "promo", "프로모배너"] },
                    sale_headline: { title: "AI · Sale headlines (5)", emoji: "🏷", color: "red", aliases: ["ai", "sale", "headline", "세일헤드라인"] },
                    seasonal_campaign: { title: "AI · Seasonal campaign", emoji: "🎉", color: "purple", aliases: ["ai", "seasonal", "campaign", "시즌캠페인"] },
                    referral_program_copy: { title: "AI · Referral program copy", emoji: "🤝", color: "green", aliases: ["ai", "referral", "program", "레퍼럴프로그램"] },
                    discount_code_email: { title: "AI · Discount code email", emoji: "💸", color: "yellow", aliases: ["ai", "discount", "code", "할인쿠폰"] },
                    affiliate_terms: { title: "AI · Affiliate terms", emoji: "📜", color: "purple", aliases: ["ai", "affiliate", "terms", "제휴약관"] },
                    terms_of_service: { title: "AI · ToS skeleton", emoji: "⚖", color: "yellow", aliases: ["ai", "tos", "terms", "이용약관"] },
                    privacy_policy: { title: "AI · Privacy policy", emoji: "🔐", color: "purple", aliases: ["ai", "privacy", "policy", "개인정보처리방침"] },
                    eula: { title: "AI · EULA skeleton", emoji: "🔏", color: "yellow", aliases: ["ai", "eula", "license", "EULA"] },
                    sla_template: { title: "AI · SLA template", emoji: "🕰", color: "blue", aliases: ["ai", "sla", "template", "SLA"] },
                    acceptable_use: { title: "AI · Acceptable use policy", emoji: "🛡", color: "red", aliases: ["ai", "aup", "use", "AUP"] },
                    return_policy: { title: "AI · Return policy", emoji: "🔄", color: "yellow", aliases: ["ai", "return", "policy", "반품정책"] },
                    shipping_policy: { title: "AI · Shipping policy", emoji: "📦", color: "blue", aliases: ["ai", "shipping", "policy", "배송정책"] },
                    warranty_terms: { title: "AI · Warranty terms", emoji: "🪪", color: "green", aliases: ["ai", "warranty", "terms", "보증조건"] },
                    agency_pitch_deck: { title: "AI · Agency RFP deck", emoji: "🏢", color: "blue", aliases: ["ai", "agency", "rfp", "에이전시덱"] },
                    freelance_quote: { title: "AI · Freelance quote", emoji: "🧾", color: "green", aliases: ["ai", "freelance", "quote", "프리랜서견적"] },
                    client_onboarding: { title: "AI · Client onboarding flow", emoji: "🤝", color: "blue", aliases: ["ai", "client", "onboarding", "클라이언트온보딩"] },
                    invoice_narrative: { title: "AI · Invoice cover note", emoji: "💌", color: "yellow", aliases: ["ai", "invoice", "note", "청구서커버"] },
                    copywriter_feedback: { title: "AI · Copywriter feedback", emoji: "🖋", color: "purple", aliases: ["ai", "copywriter", "feedback", "카피피드백"] },
                    editor_rewrite: { title: "AI · Editor rewrite", emoji: "✂", color: "red", aliases: ["ai", "editor", "rewrite", "에디터교정"] },
                    translate_batch: { title: "AI · Translate (EN/KO/JA/ES)", emoji: "🌎", color: "blue", aliases: ["ai", "translate", "batch", "다국어"] },
                    transliterate: { title: "AI · Transliterate names", emoji: "🔠", color: "yellow", aliases: ["ai", "transliterate", "외래어", "한글표기"] },
                    native_rewrite: { title: "AI · Native-speaker rewrite", emoji: "🗣", color: "green", aliases: ["ai", "native", "natural", "원어민"] },
                    honorific_ko: { title: "AI · 존댓말로 다듬기", emoji: "🙇‍♂️", color: "blue", aliases: ["ai", "korean", "honorific", "존댓말"] },
                    casual_ko: { title: "AI · 반말로 바꾸기", emoji: "😎", color: "yellow", aliases: ["ai", "korean", "casual", "반말"] },
                    business_ko: { title: "AI · 비즈니스 한국어", emoji: "🏢", color: "blue", aliases: ["ai", "business", "korean", "비즈니스한국어"] },
                    email_ko_polite: { title: "AI · 정중한 한국어 메일", emoji: "📧", color: "purple", aliases: ["ai", "korean", "email", "정중한메일"] },
                    kakao_msg: { title: "AI · 카톡 메시지", emoji: "💬", color: "yellow", aliases: ["ai", "kakao", "katalk", "카톡"] },
                    announcement_ko: { title: "AI · 공지사항 작성", emoji: "📢", color: "blue", aliases: ["ai", "announcement", "공지", "공지사항"] },
                    biz_card_bio: { title: "AI · 명함용 약력", emoji: "💼", color: "green", aliases: ["ai", "bizcard", "bio", "명함"] },
                    elevator_mom_test: { title: "AI · 엄마도 알아듣는 피치", emoji: "👵", color: "green", aliases: ["ai", "mom", "test", "엄마테스트"] },
                    yo_style_ko: { title: "AI · 해요체로 다듬기", emoji: "🌸", color: "blue", aliases: ["ai", "yo", "style", "해요체"] },
                    grandma_explain: { title: "AI · 할머니 설명", emoji: "👵", color: "yellow", aliases: ["ai", "grandma", "explain", "할머니설명"] },
                    movie_pitch: { title: "AI · 영화 로그라인", emoji: "🎬", color: "purple", aliases: ["ai", "movie", "logline", "로그라인"] },
                    changelog_from_bullets: { title: "AI · Changelog from bullets", emoji: "📝", color: "green", aliases: ["ai", "changelog", "release", "변경요약"] },
                    contract_summary: { title: "AI · 계약서 요약", emoji: "📜", color: "blue", aliases: ["ai", "contract", "legal", "계약요약"] },
                    explain_acronym: { title: "AI · 약어 풀이", emoji: "🔠", color: "yellow", aliases: ["ai", "acronym", "abbrev", "약어풀이"] },
                    dramatize: { title: "AI · Dramatize", emoji: "🎭", color: "red", aliases: ["ai", "dramatize", "vivid", "각색"] },
                    karaoke_lyrics: { title: "AI · 노래방 가사", emoji: "🎤", color: "yellow", aliases: ["ai", "karaoke", "lyrics", "노래방"] },
                    legal_plain_ko: { title: "AI · 법률 → 쉬운 한국어", emoji: "⚖️", color: "blue", aliases: ["ai", "legal", "plain", "쉬운법률"] },
                    yc_pitch: { title: "AI · YC 스타일 피치", emoji: "🚀", color: "green", aliases: ["ai", "yc", "pitch", "YC피치"] },
                    meeting_minutes: { title: "AI · Meeting minutes", emoji: "🗒", color: "blue", aliases: ["ai", "meeting", "minutes", "회의록"] },
                    sprint_retro_detailed: { title: "AI · Sprint retro (DAKI)", emoji: "🔁", color: "purple", aliases: ["ai", "retro", "daki", "DAKI회고"] },
                    user_story_acceptance: { title: "AI · Story + acceptance", emoji: "✅", color: "green", aliases: ["ai", "story", "acceptance", "수락기준"] },
                    bug_repro: { title: "AI · Bug repro report", emoji: "🐞", color: "red", aliases: ["ai", "bug", "repro", "버그재현"] },
                    api_mock_response: { title: "AI · API mock response (3)", emoji: "📡", color: "blue", aliases: ["ai", "api", "mock", "mock응답"] },
                    changelog_merge: { title: "AI · Merge changelogs", emoji: "🔗", color: "green", aliases: ["ai", "merge", "changelog", "변경통합"] },
                    customer_followup_ko: { title: "AI · 고객 후속 메시지", emoji: "💌", color: "blue", aliases: ["ai", "followup", "customer", "고객후속"] },
                    release_blog_ko: { title: "AI · 한국어 릴리스 블로그", emoji: "📰", color: "green", aliases: ["ai", "release", "blog", "릴리스블로그"] },
                    sql_from_schema: { title: "AI · SQL from schema", emoji: "🧱", color: "purple", aliases: ["ai", "sql", "schema", "스키마쿼리"] },
                    excel_formula: { title: "AI · Excel formula", emoji: "🧮", color: "yellow", aliases: ["ai", "excel", "formula", "엑셀공식"] },
                    onboarding_survey_ko: { title: "AI · 한국어 온보딩 설문", emoji: "📋", color: "blue", aliases: ["ai", "onboarding", "survey", "온보딩설문"] },
                    refund_letter_ko: { title: "AI · 환불 요청서", emoji: "💸", color: "red", aliases: ["ai", "refund", "letter", "환불요청"] },
                    news_summary_ko: { title: "AI · 한국어 뉴스 요약", emoji: "📰", color: "blue", aliases: ["ai", "news", "summary", "뉴스요약"] },
                    recipe_shopping_list: { title: "AI · 장보기 리스트", emoji: "🛒", color: "green", aliases: ["ai", "shopping", "list", "장보기"] },
                    podcast_guest_questions: { title: "AI · Podcast guest Qs (10)", emoji: "🎙", color: "purple", aliases: ["ai", "podcast", "guest", "게스트질문"] },
                    email_subject_5: { title: "AI · Email subjects (5)", emoji: "✉", color: "yellow", aliases: ["ai", "subject", "email", "제목5"] },
                    research_summary: { title: "AI · Research paper summary", emoji: "🔬", color: "blue", aliases: ["ai", "research", "paper", "논문요약"] },
                    tough_questions: { title: "AI · Tough audience Qs (5)", emoji: "🎯", color: "red", aliases: ["ai", "tough", "questions", "까다로운질문"] },
                    legalese_detect: { title: "AI · Legalese risk scan", emoji: "⚠️", color: "red", aliases: ["ai", "legal", "risk", "법률위험"] },
                    translate_natural_en: { title: "AI · → Natural English", emoji: "🇬🇧", color: "blue", aliases: ["ai", "natural", "english", "자연영어"] },
                    safety_review: { title: "AI · Safety / risk scan", emoji: "🛡", color: "red", aliases: ["ai", "safety", "pii", "위험스캔"] },
                    style_mirror: { title: "AI · Style mirror", emoji: "🪞", color: "purple", aliases: ["ai", "style", "mirror", "스타일미러"] },
                    biz_eng_email: { title: "AI · Business English email", emoji: "📧", color: "blue", aliases: ["ai", "biz", "english", "비즈영어메일"] },
                    intro_ko_formal: { title: "AI · 정중한 자기소개 (한)", emoji: "🙇‍♀️", color: "blue", aliases: ["ai", "intro", "korean", "자기소개"] },
                    ui_spec_from_desc: { title: "AI · UI component spec", emoji: "🧩", color: "purple", aliases: ["ai", "ui", "spec", "UI스펙"] },
                    dad_jokes: { title: "AI · 아재 개그 (3)", emoji: "🤡", color: "yellow", aliases: ["ai", "dad", "joke", "아재개그"] },
                    jp_business_polite: { title: "AI · 일본어 비즈니스 (敬語)", emoji: "🇯🇵", color: "blue", aliases: ["ai", "japanese", "keigo", "일본어비즈"] },
                    git_conflict_resolve: { title: "AI · Git conflict resolve", emoji: "🪢", color: "red", aliases: ["ai", "git", "conflict", "머지충돌"] },
                    copy_3_tones: { title: "AI · Copy in 3 tones", emoji: "🎭", color: "purple", aliases: ["ai", "tones", "copy", "3톤"] },
                    sql_explain_ko: { title: "AI · SQL 설명 (한국어)", emoji: "🗃", color: "blue", aliases: ["ai", "sql", "explain", "SQL한국어"] },
                    jira_from_bug: { title: "AI · Jira ticket from bug", emoji: "🐛", color: "red", aliases: ["ai", "jira", "bug", "지라티켓"] },
                    slack_rephrase_ko: { title: "AI · 슬랙 3줄 메시지", emoji: "💬", color: "yellow", aliases: ["ai", "slack", "rephrase", "슬랙짧게"] },
                    pitch_slide_titles: { title: "AI · 10-slide titles", emoji: "🎞", color: "purple", aliases: ["ai", "slides", "titles", "슬라이드제목"] },
                    customer_quote_ko: { title: "AI · 한국어 고객 후기 (3)", emoji: "💬", color: "green", aliases: ["ai", "customer", "quote", "고객후기"] },
                    release_go_no_go: { title: "AI · Release Go/No-Go", emoji: "🚦", color: "red", aliases: ["ai", "release", "gonogo", "출시결정"] },
                    icp_profile: { title: "AI · ICP profile", emoji: "🎯", color: "blue", aliases: ["ai", "icp", "customer", "ICP"] },
                    competitive_moat: { title: "AI · Competitive moats (3)", emoji: "🏰", color: "purple", aliases: ["ai", "moat", "defensible", "해자"] },
                    postmortem_ko: { title: "AI · 한국어 장애 회고", emoji: "🩹", color: "red", aliases: ["ai", "postmortem", "incident", "장애회고"] },
                    headline_rewrite_ko: { title: "AI · 한국어 헤드라인 5종", emoji: "📰", color: "yellow", aliases: ["ai", "headline", "korean", "한국어헤드"] },
                    email_decline_ko: { title: "AI · 정중한 거절 메일", emoji: "✋", color: "blue", aliases: ["ai", "decline", "email", "거절메일"] },
                    api_docs_from_code: { title: "AI · API docs from code", emoji: "📘", color: "purple", aliases: ["ai", "api", "docs", "API문서"] },
                    db_schema_naming: { title: "AI · DB schema naming", emoji: "🗂", color: "blue", aliases: ["ai", "schema", "naming", "스키마명명"] },
                    translate_formal_en: { title: "AI · → Formal English", emoji: "🎩", color: "blue", aliases: ["ai", "formal", "english", "격식영어"] },
                    translate_formal_ko: { title: "AI · → 격식체 한국어", emoji: "📜", color: "blue", aliases: ["ai", "formal", "korean", "격식한국어"] },
                    customer_segments: { title: "AI · Customer segments (3-4)", emoji: "👥", color: "purple", aliases: ["ai", "segments", "customer", "고객세그먼트"] },
                    email_thread_summary: { title: "AI · Email thread summary", emoji: "📧", color: "blue", aliases: ["ai", "email", "thread", "스레드요약"] },
                    pr_review_checklist: { title: "AI · PR review checklist", emoji: "✅", color: "green", aliases: ["ai", "pr", "review", "PR체크리스트"] },
                    onboarding_30_60_90: { title: "AI · 30/60/90 onboarding", emoji: "📆", color: "blue", aliases: ["ai", "onboarding", "30-60-90", "온보딩30609"] },
                    sales_call_script_ko: { title: "AI · 영업 콜 스크립트 (한)", emoji: "📞", color: "green", aliases: ["ai", "sales", "call", "영업콜"] },
                    contract_redline: { title: "AI · Contract redline", emoji: "📑", color: "red", aliases: ["ai", "contract", "redline", "계약수정"] },
                    spec_to_test_cases: { title: "AI · Spec → test matrix", emoji: "🧪", color: "green", aliases: ["ai", "spec", "tests", "테스트매트릭스"] },
                    log_pattern_detect: { title: "AI · Log pattern + alerts", emoji: "📊", color: "blue", aliases: ["ai", "log", "pattern", "로그패턴"] },
                    regression_risk: { title: "AI · Regression risk", emoji: "⚠️", color: "red", aliases: ["ai", "regression", "risk", "회귀리스크"] },
                    db_migration_plan: { title: "AI · DB migration (6 steps)", emoji: "🚚", color: "purple", aliases: ["ai", "db", "migration", "DB마이그"] },
                    marketing_positioning: { title: "AI · Positioning 2x2", emoji: "🧭", color: "blue", aliases: ["ai", "positioning", "quadrant", "포지셔닝"] },
                    welcome_pack_ko: { title: "AI · 환영 메일팩 (3)", emoji: "🎁", color: "green", aliases: ["ai", "welcome", "pack", "환영팩"] },
                    incident_report_customer: { title: "AI · Customer incident report", emoji: "📨", color: "red", aliases: ["ai", "incident", "customer", "고객장애보고"] },
                    team_okr_quarterly: { title: "AI · Team quarterly OKRs", emoji: "🎯", color: "green", aliases: ["ai", "okr", "team", "팀OKR"] },
                    translate_academic_en: { title: "AI · → Academic English", emoji: "🎓", color: "blue", aliases: ["ai", "academic", "english", "학술영어"] },
                    sales_objection_handle_ko: { title: "AI · 영업 이의 응답 (한)", emoji: "🛡", color: "purple", aliases: ["ai", "objection", "sales", "영업이의"] },
                    competitor_feature_matrix: { title: "AI · Feature matrix vs comp", emoji: "🆚", color: "purple", aliases: ["ai", "matrix", "competitor", "기능매트릭스"] },
                    jira_from_spec: { title: "AI · Spec → Jira epic + issues", emoji: "🧩", color: "blue", aliases: ["ai", "spec", "jira", "스펙지라"] },
                    translate_poetic_ko: { title: "AI · 시적 번역 (한국어)", emoji: "🌷", color: "yellow", aliases: ["ai", "poetic", "korean", "시적번역"] },
                    sales_email_cold_ko: { title: "AI · 한국어 콜드 영업 메일", emoji: "❄️", color: "blue", aliases: ["ai", "cold", "sales", "콜드영업"] },
                    event_mc_script: { title: "AI · 행사 MC 스크립트", emoji: "🎤", color: "purple", aliases: ["ai", "mc", "event", "MC대본"] },
                    incident_rca_5whys: { title: "AI · 5 Whys RCA", emoji: "❓", color: "red", aliases: ["ai", "5whys", "rca", "5whys"] },
                    feature_naming: { title: "AI · Feature naming (5)", emoji: "🏷", color: "yellow", aliases: ["ai", "feature", "name", "기능네이밍"] },
                    release_note_internal: { title: "AI · Internal release note", emoji: "🔒", color: "blue", aliases: ["ai", "release", "internal", "내부릴리스"] },
                    cv_bullet_impact: { title: "AI · CV bullet (3 impact)", emoji: "📈", color: "green", aliases: ["ai", "cv", "bullet", "이력서불릿"] },
                    journal_prompt_ko: { title: "AI · 한국어 저널링 7", emoji: "📓", color: "purple", aliases: ["ai", "journal", "prompt", "저널링"] },
                    translate_natural_ko: { title: "AI · → 자연스러운 한국어", emoji: "🇰🇷", color: "blue", aliases: ["ai", "natural", "korean", "자연한국어"] },
                    release_tweet_thread_ko: { title: "AI · 릴리스 트윗 스레드 (한)", emoji: "🧵", color: "blue", aliases: ["ai", "tweet", "thread", "릴리스트윗"] },
                    feedback_rewrite_constructive: { title: "AI · 건설적 피드백 (SBI)", emoji: "🪴", color: "green", aliases: ["ai", "feedback", "sbi", "건설피드백"] },
                    bullets_to_paragraph: { title: "AI · 불릿 → 단락", emoji: "📜", color: "yellow", aliases: ["ai", "bullets", "prose", "단락으로"] },
                    paragraph_to_bullets: { title: "AI · 단락 → 불릿", emoji: "•", color: "yellow", aliases: ["ai", "paragraph", "bullets", "불릿으로"] },
                    code_comment_jsdoc: { title: "AI · JSDoc 주석", emoji: "📝", color: "purple", aliases: ["ai", "jsdoc", "comment", "JSDoc"] },
                    k8s_yaml_from_app: { title: "AI · K8s yaml from app", emoji: "☸", color: "blue", aliases: ["ai", "k8s", "yaml", "쿠버"] },
                    dockerfile_multistage: { title: "AI · Multi-stage Dockerfile", emoji: "🐳", color: "blue", aliases: ["ai", "dockerfile", "docker", "도커파일"] },
                    git_rebase_strategy: { title: "AI · Git rebase strategy", emoji: "🌿", color: "purple", aliases: ["ai", "git", "rebase", "git전략"] },
                    cors_config: { title: "AI · CORS config", emoji: "🌐", color: "blue", aliases: ["ai", "cors", "config", "CORS설정"] },
                    changelog_ko: { title: "AI · 한국어 changelog", emoji: "📋", color: "green", aliases: ["ai", "changelog", "korean", "변경로그"] },
                    scam_detect_ko: { title: "AI · 사기 메시지 탐지", emoji: "🚨", color: "red", aliases: ["ai", "scam", "phishing", "사기탐지"] },
                    contract_clause_explain_ko: { title: "AI · 계약 조항 풀이", emoji: "📑", color: "yellow", aliases: ["ai", "clause", "explain", "조항풀이"] },
                    study_cheatsheet: { title: "AI · 1-page 치트시트", emoji: "📑", color: "blue", aliases: ["ai", "cheatsheet", "study", "치트시트"] },
                    saas_onboarding_checklist: { title: "AI · SaaS 온보딩 7-step", emoji: "🪜", color: "green", aliases: ["ai", "saas", "onboarding", "SaaS온보딩"] },
                    email_thank_customer_ko: { title: "AI · 한국어 고객 감사 메일", emoji: "🙏", color: "blue", aliases: ["ai", "thank", "customer", "감사메일"] },
                    community_rules_ko: { title: "AI · 한국어 커뮤니티 규칙", emoji: "📜", color: "purple", aliases: ["ai", "community", "rules", "커뮤규칙"] },
                    translate_formal_jp: { title: "AI · → 격식 일본어 (敬語)", emoji: "🎌", color: "blue", aliases: ["ai", "japanese", "formal", "격식일본어"] },
                    dashboard_widgets_spec: { title: "AI · Dashboard widgets (6)", emoji: "📊", color: "blue", aliases: ["ai", "dashboard", "widgets", "위젯스펙"] },
                    error_message_friendly: { title: "AI · Friendly error msg", emoji: "🙂", color: "yellow", aliases: ["ai", "error", "friendly", "친절에러"] },
                    translate_academic_ko: { title: "AI · → 학술 한국어", emoji: "🎓", color: "blue", aliases: ["ai", "academic", "korean", "학술한국어"] },
                    code_explain_line_by_line: { title: "AI · Code line-by-line", emoji: "🔍", color: "purple", aliases: ["ai", "code", "explain", "라인설명"] },
                    sql_optimize_ko: { title: "AI · SQL 최적화 (한)", emoji: "⚡", color: "green", aliases: ["ai", "sql", "optimize", "SQL최적화한"] },
                    customer_call_script_ko: { title: "AI · CS 인바운드 콜 (한)", emoji: "☎️", color: "blue", aliases: ["ai", "cs", "call", "CS콜"] },
                    marketing_email_segments: { title: "AI · 세그먼트 마케팅 메일 (3)", emoji: "📨", color: "purple", aliases: ["ai", "segment", "email", "세그먼트메일"] },
                    youtube_script_3min: { title: "AI · 3분 유튜브 스크립트", emoji: "▶", color: "red", aliases: ["ai", "youtube", "script", "유튜브"] },
                    twitter_bio_3_ko: { title: "AI · 한국어 트위터 bio (3)", emoji: "🐦", color: "blue", aliases: ["ai", "twitter", "bio", "트위터bio"] },
                    sql_window_function: { title: "AI · SQL 윈도우 함수", emoji: "🪟", color: "purple", aliases: ["ai", "sql", "window", "윈도우함수"] },
                    release_rollback_plan: { title: "AI · Rollback plan", emoji: "🔙", color: "red", aliases: ["ai", "rollback", "release", "롤백플랜"] },
                    api_pagination_design: { title: "AI · API pagination design", emoji: "📄", color: "blue", aliases: ["ai", "pagination", "api", "페이지네이션"] },
                    diff_intent_explain: { title: "AI · Diff intent + review", emoji: "🔀", color: "purple", aliases: ["ai", "diff", "intent", "디프설명"] },
                    feature_flag_rollout: { title: "AI · FF rollout plan", emoji: "🚩", color: "blue", aliases: ["ai", "feature", "flag", "FF롤아웃"] },
                    release_notes_detailed_ko: { title: "AI · 한국어 상세 릴리스 노트", emoji: "📋", color: "green", aliases: ["ai", "release", "detailed", "상세릴리스"] },
                    translate_marketing_en: { title: "AI · → Marketing English", emoji: "📢", color: "yellow", aliases: ["ai", "marketing", "english", "마케팅영어"] },
                    devops_runbook: { title: "AI · DevOps service runbook", emoji: "📕", color: "red", aliases: ["ai", "devops", "runbook", "운영런북"] },
                    comment_intent_rewrite: { title: "AI · Comments → WHY", emoji: "💭", color: "purple", aliases: ["ai", "comment", "intent", "주석의도"] },
                    sales_discovery_questions_ko: { title: "AI · 한국어 발견 질문 (8)", emoji: "🧪", color: "blue", aliases: ["ai", "discovery", "sales", "발견질문"] },
                    db_er_diagram_mermaid: { title: "AI · ER diagram (Mermaid)", emoji: "🧬", color: "blue", aliases: ["ai", "er", "mermaid", "ER도식"] },
                    incident_comms_internal: { title: "AI · 내부 장애 comms (4)", emoji: "📢", color: "red", aliases: ["ai", "incident", "internal", "내부장애"] },
                    copy_rewrite_3_angles: { title: "AI · Copy 3 angles", emoji: "🎯", color: "purple", aliases: ["ai", "copy", "angles", "카피3앵글"] },
                    translate_casual_en: { title: "AI · → Casual English", emoji: "👋", color: "yellow", aliases: ["ai", "casual", "english", "캐주얼영어"] },
                    code_security_review: { title: "AI · Code security review", emoji: "🔒", color: "red", aliases: ["ai", "security", "owasp", "보안검토"] },
                    changelog_monthly_rollup: { title: "AI · Monthly changelog rollup", emoji: "📆", color: "green", aliases: ["ai", "monthly", "changelog", "월간롤업"] },
                    product_tour_script_ko: { title: "AI · 한국어 제품 투어 (5)", emoji: "🧭", color: "blue", aliases: ["ai", "tour", "korean", "제품투어"] },
                    email_intro_warm_ko: { title: "AI · 한국어 따뜻한 소개 메일", emoji: "🤝", color: "blue", aliases: ["ai", "intro", "warm", "소개메일"] },
                    log_redact_pii: { title: "AI · Log PII redact scan", emoji: "🕵", color: "red", aliases: ["ai", "log", "pii", "PII마스킹"] },
                    career_narrative_ko: { title: "AI · 한국어 커리어 narrative", emoji: "🧗", color: "purple", aliases: ["ai", "career", "narrative", "커리어내러티브"] },
                    api_error_codes: { title: "AI · API error catalog", emoji: "🔢", color: "red", aliases: ["ai", "error", "codes", "에러카탈로그"] },
                    standup_summary_team_ko: { title: "AI · 팀 standup 통합 (한)", emoji: "👥", color: "blue", aliases: ["ai", "standup", "team", "팀스탠드업"] },
                    regex_test_cases: { title: "AI · Regex test suite (10)", emoji: "🧪", color: "purple", aliases: ["ai", "regex", "tests", "정규식테스트"] },
                    error_msg_multilingual: { title: "AI · Error msg (KO/EN/JA)", emoji: "🌐", color: "yellow", aliases: ["ai", "error", "multilingual", "다국어에러"] },
                    team_intro_ko: { title: "AI · 한국어 팀 소개 글", emoji: "🙋", color: "blue", aliases: ["ai", "team", "intro", "팀소개"] },
                    strategy_1pager: { title: "AI · Strategy 1-pager", emoji: "🧭", color: "purple", aliases: ["ai", "strategy", "1pager", "전략1페이저"] },
                    translate_poetic_en: { title: "AI · → Poetic English", emoji: "🪶", color: "yellow", aliases: ["ai", "poetic", "english", "시적영어"] },
                    api_deprecation_ko: { title: "AI · 한국어 API 일몰 공지", emoji: "🌅", color: "red", aliases: ["ai", "api", "deprecate", "API일몰"] },
                    postmortem_detailed: { title: "AI · Detailed postmortem", emoji: "🩻", color: "red", aliases: ["ai", "postmortem", "detailed", "상세포스트모템"] },
                    customer_meeting_prep: { title: "AI · Customer meeting prep", emoji: "🤝", color: "blue", aliases: ["ai", "customer", "meeting", "고객미팅준비"] },
                    changelog_twitter_thread: { title: "AI · Changelog → tweet 5", emoji: "🧵", color: "blue", aliases: ["ai", "changelog", "tweet", "변경트윗"] },
                    translate_poetic_jp: { title: "AI · → 詩的な日本語", emoji: "🎋", color: "purple", aliases: ["ai", "poetic", "japanese", "시적일본어"] },
                    bio_3_lengths: { title: "AI · Bio (S/M/L)", emoji: "👤", color: "blue", aliases: ["ai", "bio", "lengths", "bio3길이"] },
                    landing_hero_3_variant: { title: "AI · Landing hero (3 variant)", emoji: "🦸", color: "purple", aliases: ["ai", "landing", "hero", "랜딩hero3"] },
                    release_blog_en: { title: "AI · Release blog (EN)", emoji: "📰", color: "green", aliases: ["ai", "release", "blog", "릴리스블로그EN"] },
                    translate_cs_formal_ko: { title: "AI · 정중한 CS 메시지 (한)", emoji: "🫶", color: "blue", aliases: ["ai", "cs", "formal", "CS정중"] },
                    api_readme_from_spec: { title: "AI · API README from spec", emoji: "📘", color: "purple", aliases: ["ai", "readme", "api", "APIreadme"] },
                    sprint_goal_statement: { title: "AI · Sprint goal (1 sentence)", emoji: "🎯", color: "green", aliases: ["ai", "sprint", "goal", "스프린트목표"] },
                    incident_tweet_public_ko: { title: "AI · 한국어 장애 공지 트윗", emoji: "🚨", color: "red", aliases: ["ai", "incident", "tweet", "장애트윗"] },
                    podcast_intro_host_ko: { title: "AI · 한국어 팟캐스트 오프닝", emoji: "🎙", color: "purple", aliases: ["ai", "podcast", "intro", "팟캐오프닝"] },
                    code_rename_suggest: { title: "AI · Code rename suggest", emoji: "🏷", color: "blue", aliases: ["ai", "rename", "code", "이름개선"] },
                    error_msg_empathic_ko: { title: "AI · 공감형 에러 메시지 (한)", emoji: "🤍", color: "yellow", aliases: ["ai", "error", "empathic", "공감에러"] },
                    recruiter_reply_ko: { title: "AI · 헤드헌터 답장 (한)", emoji: "📩", color: "blue", aliases: ["ai", "recruiter", "reply", "헤드헌터답장"] },
                    translate_business_jp: { title: "AI · → 비즈니스 일본어 메일", emoji: "🏯", color: "blue", aliases: ["ai", "business", "japanese", "비즈일본어"] },
                    landing_faq_ko: { title: "AI · 한국어 랜딩 FAQ (6)", emoji: "❓", color: "green", aliases: ["ai", "landing", "faq", "랜딩FAQ"] },
                    pricing_objection_ko: { title: "AI · 한국어 가격 이의 (4)", emoji: "💰", color: "purple", aliases: ["ai", "pricing", "objection", "가격이의"] },
                    competitor_positioning: { title: "AI · Competitor positioning", emoji: "🗺", color: "blue", aliases: ["ai", "competitor", "positioning", "경쟁포지션"] },
                    sql_explain_en: { title: "AI · SQL explain (EN)", emoji: "🗒", color: "blue", aliases: ["ai", "sql", "explain", "SQL영문"] },
                    contract_redline_ko: { title: "AI · 한국어 계약 redline", emoji: "📑", color: "red", aliases: ["ai", "contract", "redline", "계약수정한"] },
                    sql_from_csv: { title: "AI · CSV → CREATE + INSERT", emoji: "📥", color: "purple", aliases: ["ai", "csv", "sql", "CSV스키마"] },
                    release_1_liner: { title: "AI · Release 1-liner", emoji: "📣", color: "green", aliases: ["ai", "release", "oneliner", "릴리스한줄"] },
                    customer_story_narrative: { title: "AI · 3-min customer story", emoji: "📖", color: "yellow", aliases: ["ai", "story", "customer", "고객스토리"] },
                    api_error_codes_ko: { title: "AI · 한국어 API 에러 카탈로그", emoji: "🔢", color: "red", aliases: ["ai", "api", "error", "에러한국어"] },
                    translate_marketing_ko: { title: "AI · → 한국어 마케팅 카피", emoji: "📣", color: "yellow", aliases: ["ai", "marketing", "korean", "마케팅한"] },
                    refactor_suggest_ko: { title: "AI · 리팩토링 제안 (한)", emoji: "🧰", color: "purple", aliases: ["ai", "refactor", "suggest", "리팩토링제안"] },
                    test_strategy_doc: { title: "AI · Test strategy doc", emoji: "🧪", color: "green", aliases: ["ai", "test", "strategy", "테스트전략"] },
                    incident_summary_exec_ko: { title: "AI · 임원용 장애 요약", emoji: "🩺", color: "red", aliases: ["ai", "incident", "exec", "임원장애"] },
                    feedback_1_1_ko: { title: "AI · 한국어 1:1 피드백", emoji: "👥", color: "blue", aliases: ["ai", "1on1", "feedback", "한국1대1"] },
                    jira_epic_breakdown: { title: "AI · Epic → stories", emoji: "🧩", color: "blue", aliases: ["ai", "epic", "stories", "에픽분해"] },
                    sales_discovery_summary_ko: { title: "AI · 영업 발견 요약 (한)", emoji: "🔍", color: "blue", aliases: ["ai", "discovery", "summary", "발견요약"] },
                    landing_cta_5_variant: { title: "AI · Landing CTA × 5", emoji: "👆", color: "yellow", aliases: ["ai", "cta", "landing", "CTA5"] },
                    legal_clause_en: { title: "AI · Legal clause (EN)", emoji: "⚖", color: "purple", aliases: ["ai", "legal", "clause", "법률조항EN"] },
                    customer_research_synthesis: { title: "AI · Customer research synth", emoji: "🔬", color: "purple", aliases: ["ai", "research", "synth", "리서치종합"] },
                    sales_email_warm_ko: { title: "AI · 영업 따뜻한 후속 (한)", emoji: "💌", color: "yellow", aliases: ["ai", "sales", "warm", "영업후속"] },
                    changelog_html_ko: { title: "AI · 체인지로그 HTML (한)", emoji: "📰", color: "gray", aliases: ["ai", "changelog", "html", "체인지로그HTML"] },
                    discovery_call_prep_ko: { title: "AI · 발견 콜 준비 (한)", emoji: "🧭", color: "blue", aliases: ["ai", "discovery", "prep", "발견준비"] },
                    feature_request_response_ko: { title: "AI · 기능 요청 답변 (한)", emoji: "🙋", color: "green", aliases: ["ai", "feature", "request", "기능요청답변"] },
                    translate_legal_en: { title: "AI · Legal translate (EN)", emoji: "⚖", color: "purple", aliases: ["ai", "translate", "legal", "법률번역EN"] },
                    bug_repro_steps_ko: { title: "AI · 버그 재현 정리 (한)", emoji: "🐛", color: "red", aliases: ["ai", "bug", "repro", "버그재현"] },
                    weekly_status_summary_ko: { title: "AI · 주간 상태 (한)", emoji: "📅", color: "blue", aliases: ["ai", "weekly", "status", "주간상태"] },
                    ux_review_checklist: { title: "AI · UX 리뷰 체크리스트", emoji: "🔍", color: "purple", aliases: ["ai", "ux", "review", "UX리뷰"] },
                    api_error_friendly_ko: { title: "AI · API 에러 친절히 (한)", emoji: "💬", color: "orange", aliases: ["ai", "error", "api", "에러친절"] },
                    investor_followup_email_ko: { title: "AI · 투자자 후속 (한)", emoji: "💼", color: "green", aliases: ["ai", "investor", "followup", "투자자후속"] },
                    competitor_teardown_ko: { title: "AI · 경쟁사 분석 (한)", emoji: "🥊", color: "red", aliases: ["ai", "competitor", "teardown", "경쟁사분석"] },
                    user_persona_short_ko: { title: "AI · 짧은 페르소나 (한)", emoji: "👤", color: "blue", aliases: ["ai", "persona", "user", "페르소나짧"] },
                    sprint_demo_script_ko: { title: "AI · 스프린트 데모 (한)", emoji: "🎬", color: "purple", aliases: ["ai", "sprint", "demo", "스프린트데모"] },
                    blog_seo_outline_ko: { title: "AI · 블로그 SEO 아웃라인 (한)", emoji: "📝", color: "green", aliases: ["ai", "blog", "seo", "블로그SEO"] },
                    translate_marketing_jp: { title: "AI · 마케팅 번역 (JP)", emoji: "🌏", color: "yellow", aliases: ["ai", "translate", "marketing", "마케팅번역JP"] },
                    press_release_short_ko: { title: "AI · 짧은 보도자료 (한)", emoji: "📢", color: "gray", aliases: ["ai", "press", "release", "보도자료짧"] },
                    incident_status_page_ko: { title: "AI · 장애 상태 (한)", emoji: "🚦", color: "red", aliases: ["ai", "incident", "status", "장애상태"] },
                    qbr_deck_outline: { title: "AI · QBR 덱 아웃라인", emoji: "📊", color: "blue", aliases: ["ai", "qbr", "deck", "QBR아웃라인"] },
                    cs_followup_email_ko: { title: "AI · CS 후속 메일 (한)", emoji: "💁", color: "yellow", aliases: ["ai", "cs", "followup", "CS후속"] },
                    release_email_customer_ko: { title: "AI · 고객 릴리스 메일 (한)", emoji: "📨", color: "green", aliases: ["ai", "release", "email", "릴리스메일"] },
                    okr_personal_quarterly_ko: { title: "AI · 개인 분기 OKR (한)", emoji: "🎯", color: "blue", aliases: ["ai", "okr", "personal", "개인OKR"] },
                    stakeholder_update_email_ko: { title: "AI · 이해관계자 보고 (한)", emoji: "📡", color: "purple", aliases: ["ai", "stakeholder", "update", "이해관계자보고"] },
                    youtube_chapter_titles_ko: { title: "AI · YT 챕터 (한)", emoji: "📺", color: "red", aliases: ["ai", "youtube", "chapter", "YT챕터"] },
                    translate_business_ko: { title: "AI · 비즈니스 번역 (한)", emoji: "🌐", color: "gray", aliases: ["ai", "translate", "business", "비즈니스번역"] },
                    team_charter_ko: { title: "AI · 팀 헌장 (한)", emoji: "📜", color: "purple", aliases: ["ai", "team", "charter", "팀헌장"] },
                    negotiation_email_ko: { title: "AI · 협상 메일 (한)", emoji: "🤝", color: "yellow", aliases: ["ai", "negotiation", "email", "협상메일"] },
                    perf_review_self_ko: { title: "AI · 자기 평가 (한)", emoji: "🪞", color: "blue", aliases: ["ai", "perf", "self", "자기평가"] },
                    saas_trial_email_d3_ko: { title: "AI · 트라이얼 D+3 (한)", emoji: "📬", color: "green", aliases: ["ai", "trial", "d3", "트라이얼D3"] },
                    open_source_readme_ko: { title: "AI · OSS README (한)", emoji: "📘", color: "gray", aliases: ["ai", "oss", "readme", "OSS리드미"] },
                    code_review_feedback_ko: { title: "AI · 코드리뷰 피드백 (한)", emoji: "🔬", color: "red", aliases: ["ai", "code", "review", "코드리뷰피드백"] },
                    intro_email_to_team_ko: { title: "AI · 새 멤버 소개 (한)", emoji: "🎉", color: "green", aliases: ["ai", "intro", "team", "새멤버소개"] },
                    reorg_announcement_ko: { title: "AI · 조직개편 안내 (한)", emoji: "🗂", color: "purple", aliases: ["ai", "reorg", "announcement", "조직개편"] },
                    thank_you_customer_review_ko: { title: "AI · 리뷰 답례 (한)", emoji: "🙏", color: "yellow", aliases: ["ai", "review", "thank", "리뷰답례"] },
                    raise_request_email_ko: { title: "AI · 연봉 인상 요청 (한)", emoji: "💸", color: "green", aliases: ["ai", "raise", "salary", "연봉인상"] },
                    monthly_growth_recap_ko: { title: "AI · 월간 성장 리캡 (한)", emoji: "📈", color: "blue", aliases: ["ai", "monthly", "growth", "월간성장"] },
                    feature_kill_announcement_ko: { title: "AI · 기능 종료 안내 (한)", emoji: "🪦", color: "gray", aliases: ["ai", "sunset", "feature", "기능종료"] },
                    outage_post_mortem_ko: { title: "AI · 장애 사후 보고 (한)", emoji: "📝", color: "red", aliases: ["ai", "outage", "postmortem", "장애사후"] },
                    investor_pitch_one_liner: { title: "AI · 투자 한 줄 피치", emoji: "🚀", color: "purple", aliases: ["ai", "investor", "oneliner", "투자한줄"] },
                    trade_show_booth_copy_ko: { title: "AI · 전시회 부스 카피 (한)", emoji: "🎪", color: "orange", aliases: ["ai", "tradeshow", "booth", "전시회부스"] },
                    linkedin_post_thought_leader_ko: { title: "AI · LinkedIn TL 포스트 (한)", emoji: "💼", color: "blue", aliases: ["ai", "linkedin", "thought", "TL포스트"] },
                    translate_casual_ko: { title: "AI · 캐주얼 번역 (한)", emoji: "💬", color: "yellow", aliases: ["ai", "translate", "casual", "캐주얼번역"] },
                    haiku_ko: { title: "AI · 한국어 하이쿠", emoji: "🌸", color: "purple", aliases: ["ai", "haiku", "ko", "하이쿠"] },
                    sql_join_explain: { title: "AI · SQL JOIN 설명", emoji: "🔗", color: "blue", aliases: ["ai", "sql", "join", "JOIN설명"] },
                    yaml_to_table: { title: "AI · YAML → 표", emoji: "📋", color: "gray", aliases: ["ai", "yaml", "table", "YAML표"] },
                    investor_metrics_one_pager_ko: { title: "AI · IR 메트릭 1p (한)", emoji: "📊", color: "green", aliases: ["ai", "ir", "metrics", "IR1p"] },
                    tldr_3_layers: { title: "AI · TLDR 3-layer", emoji: "🪜", color: "orange", aliases: ["ai", "tldr", "layers", "3레이어"] },
                    ad_copy_3_languages: { title: "AI · 광고 3개국어", emoji: "🌐", color: "red", aliases: ["ai", "ad", "multilang", "광고3개국"] },
                    decision_doc_one_pager_ko: { title: "AI · 결정 1페이지 (한)", emoji: "🗳", color: "purple", aliases: ["ai", "decision", "doc", "결정1p"] },
                    founder_update_email_ko: { title: "AI · 창업자 월간 (한)", emoji: "🚢", color: "blue", aliases: ["ai", "founder", "monthly", "창업자월간"] },
                    brand_voice_audit_ko: { title: "AI · 브랜드 보이스 감리 (한)", emoji: "🎙", color: "purple", aliases: ["ai", "brand", "voice", "보이스감리"] },
                    scrum_standup_summary_ko: { title: "AI · 스탠드업 정리 (한)", emoji: "📋", color: "blue", aliases: ["ai", "standup", "summary", "스탠드업"] },
                    kickoff_meeting_agenda_ko: { title: "AI · 킥오프 아젠다 (한)", emoji: "🚀", color: "green", aliases: ["ai", "kickoff", "agenda", "킥오프"] },
                    podcast_show_notes_ko: { title: "AI · 팟캐스트 노트 (한)", emoji: "🎙", color: "purple", aliases: ["ai", "podcast", "notes", "팟캐스트"] },
                    translate_korean_dialect_seoul: { title: "AI · 사투리 → 표준어", emoji: "🗣", color: "yellow", aliases: ["ai", "dialect", "seoul", "사투리표준어"] },
                    user_onboarding_video_script_ko: { title: "AI · 온보딩 영상 스크립트 (한)", emoji: "🎬", color: "red", aliases: ["ai", "onboarding", "video", "온보딩영상"] },
                    social_media_calendar_week_ko: { title: "AI · 소셜 캘린더 1주 (한)", emoji: "🗓", color: "blue", aliases: ["ai", "social", "calendar", "소셜캘린더"] },
                    pricing_change_announcement_ko: { title: "AI · 요금 변경 안내 (한)", emoji: "💰", color: "orange", aliases: ["ai", "pricing", "change", "요금변경"] },
                    investor_anti_pitch_ko: { title: "AI · 안티 피치 (한)", emoji: "🪤", color: "red", aliases: ["ai", "antipitch", "investor", "안티피치"] },
                    weekly_1_1_agenda_ko: { title: "AI · 주간 1:1 아젠다 (한)", emoji: "👥", color: "blue", aliases: ["ai", "1on1", "agenda", "1대1"] },
                    marketing_tagline_ab_test_ko: { title: "AI · 태그라인 A/B (한)", emoji: "🧪", color: "purple", aliases: ["ai", "tagline", "ab", "태그라인AB"] },
                    user_journey_map_ko: { title: "AI · 사용자 여정 맵 (한)", emoji: "🗺", color: "blue", aliases: ["ai", "journey", "map", "여정맵"] },
                    translate_ko_to_chinese: { title: "AI · 한 → 중 번역", emoji: "🇨🇳", color: "red", aliases: ["ai", "translate", "chinese", "중국어번역"] },
                    fundraising_pipeline_update_ko: { title: "AI · 펀딩 파이프라인 (한)", emoji: "🪙", color: "yellow", aliases: ["ai", "fundraising", "pipeline", "펀딩파이프라인"] },
                    tech_debt_priority_ko: { title: "AI · 기술부채 우선순위 (한)", emoji: "🧮", color: "orange", aliases: ["ai", "techdebt", "priority", "기술부채"] },
                    saas_renewal_email_ko: { title: "AI · SaaS 갱신 메일 (한)", emoji: "🔄", color: "green", aliases: ["ai", "renewal", "saas", "갱신메일"] },
                    interview_invite_email_ko: { title: "AI · 인터뷰 초대 메일 (한)", emoji: "📨", color: "blue", aliases: ["ai", "interview", "invite", "인터뷰초대"] },
                    press_pitch_email_en: { title: "AI · 프레스 피치 (EN)", emoji: "📰", color: "gray", aliases: ["ai", "press", "pitch", "프레스피치"] },
                    release_video_script_ko: { title: "AI · 릴리스 영상 스크립트 (한)", emoji: "🎥", color: "red", aliases: ["ai", "release", "video", "릴리스영상"] },
                    user_research_plan_ko: { title: "AI · 사용자 리서치 계획 (한)", emoji: "🔬", color: "purple", aliases: ["ai", "research", "plan", "리서치계획"] },
                    stakeholder_meeting_summary_ko: { title: "AI · 이해관계자 미팅 정리 (한)", emoji: "📝", color: "blue", aliases: ["ai", "meeting", "stakeholder", "미팅정리"] },
                    support_ticket_response_ko: { title: "AI · 지원 티켓 응답 (한)", emoji: "💁", color: "yellow", aliases: ["ai", "support", "ticket", "지원응답"] },
                    github_issue_template_ko: { title: "AI · GH 이슈 템플릿 (한)", emoji: "🐙", color: "gray", aliases: ["ai", "github", "issue", "GH이슈"] },
                    data_dashboard_narrative_ko: { title: "AI · 대시보드 서사 (한)", emoji: "📈", color: "blue", aliases: ["ai", "dashboard", "narrative", "대시보드서사"] },
                    onboarding_checklist_30day_ko: { title: "AI · 30일 온보딩 (한)", emoji: "🌱", color: "green", aliases: ["ai", "onboarding", "30day", "30일온보딩"] },
                    advisor_outreach_ko: { title: "AI · 어드바이저 콜드 (한)", emoji: "👴", color: "purple", aliases: ["ai", "advisor", "outreach", "어드바이저"] },
                    product_hunt_launch_post_ko: { title: "AI · PH 런치 글 (한)", emoji: "🐱", color: "orange", aliases: ["ai", "producthunt", "launch", "PH런치"] },
                    customer_quote_card_ko: { title: "AI · 고객 인용 카드 (한)", emoji: "💬", color: "green", aliases: ["ai", "customer", "quote", "고객인용"] },
                    release_email_internal_ko: { title: "AI · 내부 릴리스 메일 (한)", emoji: "🏢", color: "blue", aliases: ["ai", "release", "internal", "내부릴리스"] },
                    ux_microcopy_5_states: { title: "AI · UX 마이크로 5상태", emoji: "🪧", color: "purple", aliases: ["ai", "ux", "microcopy", "UX5상태"] },
                    translate_jp_to_ko: { title: "AI · 일 → 한 번역", emoji: "🇯🇵", color: "red", aliases: ["ai", "translate", "jp", "일본어번역"] },
                    weekly_okr_check_in_ko: { title: "AI · OKR 주간 체크 (한)", emoji: "✅", color: "blue", aliases: ["ai", "okr", "weekly", "OKR주간"] },
                    executive_decision_brief_ko: { title: "AI · 임원 결정 브리프 (한)", emoji: "👔", color: "purple", aliases: ["ai", "exec", "decision", "임원결정"] },
                    translate_de_to_ko: { title: "AI · 독 → 한 번역", emoji: "🇩🇪", color: "gray", aliases: ["ai", "translate", "german", "독일어번역"] },
                    user_interview_invite_email_ko: { title: "AI · 사용자 인터뷰 초대 (한)", emoji: "🎙", color: "green", aliases: ["ai", "interview", "user", "사용자인터뷰"] },
                    ad_landing_copy_ko: { title: "AI · 광고 랜딩 카피 (한)", emoji: "🎯", color: "orange", aliases: ["ai", "ad", "landing", "광고랜딩"] },
                    marketing_campaign_brief_ko: { title: "AI · 마케팅 캠페인 브리프 (한)", emoji: "📣", color: "red", aliases: ["ai", "campaign", "brief", "캠페인브리프"] },
                    team_value_workshop_ko: { title: "AI · 팀 가치 워크숍 (한)", emoji: "💎", color: "purple", aliases: ["ai", "team", "workshop", "팀가치"] },
                    incident_runbook_ko: { title: "AI · 장애 런북 (한)", emoji: "🚨", color: "red", aliases: ["ai", "incident", "runbook", "장애런북"] },
                    product_market_fit_survey_ko: { title: "AI · PMF 서베이 (한)", emoji: "📊", color: "green", aliases: ["ai", "pmf", "survey", "PMF서베이"] },
                    investor_thank_you_pass_ko: { title: "AI · 투자 거절 답례 (한)", emoji: "🙏", color: "gray", aliases: ["ai", "investor", "pass", "투자거절"] },
                    engineering_onboarding_repo_ko: { title: "AI · 엔지니어링 온보딩 (한)", emoji: "👷", color: "gray", aliases: ["ai", "onboarding", "repo", "엔지니어링온보딩"] },
                    press_release_long_ko: { title: "AI · 긴 보도자료 (한)", emoji: "📰", color: "blue", aliases: ["ai", "press", "long", "긴보도자료"] },
                    founder_intro_email_warm_ko: { title: "AI · 창업자 인트로 (한)", emoji: "🤝", color: "yellow", aliases: ["ai", "founder", "intro", "창업자인트로"] },
                    customer_invoice_followup_ko: { title: "AI · 인보이스 후속 (한)", emoji: "💵", color: "green", aliases: ["ai", "invoice", "followup", "인보이스후속"] },
                    developer_advocate_post_ko: { title: "AI · DevAdvocate 글 (한)", emoji: "👩‍💻", color: "blue", aliases: ["ai", "devadvocate", "blog", "DA글"] },
                    stretch_goal_okr_ko: { title: "AI · Stretch OKR (한)", emoji: "🌟", color: "purple", aliases: ["ai", "stretch", "okr", "스트레치OKR"] },
                    translate_french_to_ko: { title: "AI · 불 → 한 번역", emoji: "🇫🇷", color: "blue", aliases: ["ai", "translate", "french", "불어번역"] },
                    support_macro_collection_ko: { title: "AI · 지원 매크로 모음 (한)", emoji: "🧰", color: "yellow", aliases: ["ai", "support", "macro", "지원매크로"] },
                    linkedin_referral_request_ko: { title: "AI · LinkedIn 추천 부탁 (한)", emoji: "🔗", color: "blue", aliases: ["ai", "linkedin", "referral", "LinkedIn추천"] },
                    dashboards_alert_thresholds_ko: { title: "AI · 알람 임계값 (한)", emoji: "🚨", color: "red", aliases: ["ai", "alert", "threshold", "알람임계"] },
                    podcast_intro_30sec_ko: { title: "AI · 팟캐스트 인트로 30초 (한)", emoji: "🎤", color: "purple", aliases: ["ai", "podcast", "intro", "팟캐스트인트로"] },
                    saas_winback_email_ko: { title: "AI · 윈백 메일 (한)", emoji: "🪃", color: "blue", aliases: ["ai", "winback", "saas", "윈백"] },
                    freelance_proposal_ko: { title: "AI · 프리랜서 제안서 (한)", emoji: "🧾", color: "green", aliases: ["ai", "freelance", "proposal", "프리랜서제안"] },
                    translate_es_to_ko: { title: "AI · 스 → 한 번역", emoji: "🇪🇸", color: "yellow", aliases: ["ai", "translate", "spanish", "스페인어번역"] },
                    weekly_email_newsletter_ko: { title: "AI · 주간 뉴스레터 (한)", emoji: "📰", color: "blue", aliases: ["ai", "newsletter", "weekly", "뉴스레터"] },
                    competitor_landing_breakdown_ko: { title: "AI · 경쟁사 랜딩 해부 (한)", emoji: "🔬", color: "red", aliases: ["ai", "competitor", "landing", "경쟁사랜딩"] },
                    engineering_blog_post_ko: { title: "AI · 엔지니어링 블로그 (한)", emoji: "🛠", color: "gray", aliases: ["ai", "engineering", "blog", "엔지니어링블로그"] },
                    intern_project_brief_ko: { title: "AI · 인턴 12주 브리프 (한)", emoji: "🎓", color: "green", aliases: ["ai", "intern", "brief", "인턴브리프"] },
                    investor_referral_intro_ko: { title: "AI · IR 포워딩 인트로 (한)", emoji: "📤", color: "yellow", aliases: ["ai", "investor", "forward", "IR포워딩"] },
                    customer_advisory_invite_ko: { title: "AI · CAB 초대 (한)", emoji: "💎", color: "purple", aliases: ["ai", "cab", "advisory", "CAB초대"] },
                    translate_pt_to_ko: { title: "AI · 포 → 한 번역", emoji: "🇧🇷", color: "green", aliases: ["ai", "translate", "portuguese", "포르투갈어"] },
                    ml_experiment_writeup_ko: { title: "AI · ML 실험 정리 (한)", emoji: "🧪", color: "purple", aliases: ["ai", "ml", "experiment", "ML실험"] },
                    ai_prompt_template_ko: { title: "AI · AI 프롬프트 템플릿 (한)", emoji: "🤖", color: "gray", aliases: ["ai", "prompt", "template", "AI프롬프트"] },
                    exit_interview_questions_ko: { title: "AI · 퇴사 인터뷰 질문 (한)", emoji: "👋", color: "yellow", aliases: ["ai", "exit", "interview", "퇴사인터뷰"] },
                    marketing_email_segments_3_ko: { title: "AI · 마케팅 메일 세그 3 (한)", emoji: "🎯", color: "blue", aliases: ["ai", "marketing", "segments", "세그3"] },
                    client_kickoff_email_ko: { title: "AI · 클라이언트 킥오프 (한)", emoji: "🤝", color: "green", aliases: ["ai", "client", "kickoff", "클라이언트킥오프"] },
                    team_retro_facilitation_ko: { title: "AI · 팀 회고 진행 (한)", emoji: "🔄", color: "purple", aliases: ["ai", "retro", "facilitate", "팀회고"] },
                    design_critique_template_ko: { title: "AI · 디자인 크리틱 (한)", emoji: "🎨", color: "orange", aliases: ["ai", "design", "critique", "디자인크리틱"] },
                    translate_it_to_ko: { title: "AI · 이 → 한 번역", emoji: "🇮🇹", color: "green", aliases: ["ai", "translate", "italian", "이탈리아어"] },
                    open_letter_to_community_ko: { title: "AI · 커뮤니티 공개 편지 (한)", emoji: "📜", color: "blue", aliases: ["ai", "openletter", "community", "공개편지"] },
                    tweetstorm_8_ko: { title: "AI · 트윗스톰 8 (한)", emoji: "🐦", color: "blue", aliases: ["ai", "tweet", "thread", "트윗스톰"] },
                    translate_ko_to_vietnamese: { title: "AI · 한 → 베트남 번역", emoji: "🇻🇳", color: "red", aliases: ["ai", "translate", "vietnamese", "베트남어"] },
                    data_request_email_ko: { title: "AI · 데이터 요청 메일 (한)", emoji: "🗄", color: "gray", aliases: ["ai", "data", "request", "데이터요청"] },
                    all_hands_speech_ko: { title: "AI · All-hands 스피치 (한)", emoji: "🎤", color: "purple", aliases: ["ai", "allhands", "speech", "올핸즈"] },
                    investor_data_room_index_ko: { title: "AI · 데이터룸 인덱스 (한)", emoji: "🗂", color: "green", aliases: ["ai", "dataroom", "investor", "데이터룸"] },
                    patent_disclosure_summary_ko: { title: "AI · 특허 명세 요약 (한)", emoji: "⚖", color: "purple", aliases: ["ai", "patent", "disclosure", "특허명세"] },
                    translate_ko_to_thai: { title: "AI · 한 → 태국 번역", emoji: "🇹🇭", color: "yellow", aliases: ["ai", "translate", "thai", "태국어"] },
                    youtube_metadata_ko: { title: "AI · YT 메타데이터 (한)", emoji: "📺", color: "red", aliases: ["ai", "youtube", "metadata", "YT메타"] },
                    office_hours_email_ko: { title: "AI · 오피스아워 안내 (한)", emoji: "🕐", color: "blue", aliases: ["ai", "office", "hours", "오피스아워"] },
                    annual_planning_one_pager_ko: { title: "AI · 연간 1페이지 (한)", emoji: "📅", color: "green", aliases: ["ai", "annual", "planning", "연간1p"] },
                    video_thumbnail_text_3_ko: { title: "AI · 썸네일 텍스트 3 (한)", emoji: "🖼", color: "orange", aliases: ["ai", "thumbnail", "video", "썸네일"] },
                    translate_ko_to_russian: { title: "AI · 한 → 러 번역", emoji: "🇷🇺", color: "red", aliases: ["ai", "translate", "russian", "러시아어"] },
                    incident_war_room_intro_ko: { title: "AI · 워룸 인트로 (한)", emoji: "🚨", color: "red", aliases: ["ai", "warroom", "incident", "워룸"] },
                    marketing_one_pager_partner_ko: { title: "AI · 파트너십 1p (한)", emoji: "🤝", color: "blue", aliases: ["ai", "partner", "onepager", "파트너1p"] },
                    translate_ru_to_ko: { title: "AI · 러 → 한 번역", emoji: "🇷🇺", color: "gray", aliases: ["ai", "translate", "russian", "러시아번역"] },
                    feature_specification_short_ko: { title: "AI · 기능 스펙 (한)", emoji: "📄", color: "blue", aliases: ["ai", "spec", "feature", "기능스펙"] },
                    talent_referral_email_ko: { title: "AI · 인재 추천 부탁 (한)", emoji: "🧑‍🤝‍🧑", color: "yellow", aliases: ["ai", "referral", "talent", "인재추천"] },
                    translate_zh_to_ko: { title: "AI · 중 → 한 번역", emoji: "🇨🇳", color: "red", aliases: ["ai", "translate", "chinese", "중국어번역"] },
                    press_followup_email_en: { title: "AI · 프레스 후속 (EN)", emoji: "📰", color: "gray", aliases: ["ai", "press", "followup", "프레스후속"] },
                    investor_intro_round_close_ko: { title: "AI · 라운드 마감 임박 (한)", emoji: "⏰", color: "orange", aliases: ["ai", "investor", "close", "라운드마감"] },
                    translate_ar_to_ko: { title: "AI · 아 → 한 번역", emoji: "🇸🇦", color: "green", aliases: ["ai", "translate", "arabic", "아랍어"] },
                    user_test_report_ko: { title: "AI · 사용자 테스트 보고 (한)", emoji: "🧪", color: "purple", aliases: ["ai", "usertest", "report", "사용자테스트"] },
                    release_notes_html_ko: { title: "AI · 릴리스노트 HTML (한)", emoji: "📰", color: "gray", aliases: ["ai", "release", "html", "릴리스HTML"] },
                    ai_safety_eval_plan_ko: { title: "AI · 안전성 평가 계획 (한)", emoji: "🛡", color: "red", aliases: ["ai", "safety", "eval", "안전성평가"] },
                    translate_ko_to_arabic: { title: "AI · 한 → 아 번역", emoji: "🇸🇦", color: "green", aliases: ["ai", "translate", "arabic", "아랍어번역"] },
                    demo_day_script_ko: { title: "AI · 데모데이 3분 (한)", emoji: "🎤", color: "red", aliases: ["ai", "demoday", "pitch", "데모데이"] },
                    discord_announcement_ko: { title: "AI · Discord 공지 (한)", emoji: "💬", color: "blue", aliases: ["ai", "discord", "announce", "디스코드공지"] },
                    compliance_questionnaire_ko: { title: "AI · 컴플라이언스 답변 (한)", emoji: "📋", color: "yellow", aliases: ["ai", "compliance", "questionnaire", "컴플라이언스"] },
                    translate_id_to_ko: { title: "AI · 인 → 한 번역", emoji: "🇮🇩", color: "red", aliases: ["ai", "translate", "indonesian", "인도네시아"] },
                    growth_experiment_log_ko: { title: "AI · 그로스 실험 로그 (한)", emoji: "📈", color: "green", aliases: ["ai", "growth", "experiment", "그로스실험"] },
                    translate_ko_to_indonesian: { title: "AI · 한 → 인 번역", emoji: "🇮🇩", color: "red", aliases: ["ai", "translate", "indonesian", "인도네시아번역"] },
                    user_journey_map_storyboard_ko: { title: "AI · 여정 스토리보드 (한)", emoji: "🎞", color: "purple", aliases: ["ai", "journey", "storyboard", "스토리보드"] },
                    translate_ko_to_german: { title: "AI · 한 → 독 번역", emoji: "🇩🇪", color: "yellow", aliases: ["ai", "translate", "german", "독일어번역"] },
                    support_escalation_template_ko: { title: "AI · 지원 에스컬레이션 (한)", emoji: "🆘", color: "red", aliases: ["ai", "support", "escalation", "에스컬레이션"] },
                    team_offsite_agenda_2day_ko: { title: "AI · 팀 오프사이트 2일 (한)", emoji: "🏕", color: "green", aliases: ["ai", "offsite", "team", "오프사이트"] },
                    translate_ko_to_french: { title: "AI · 한 → 불 번역", emoji: "🇫🇷", color: "blue", aliases: ["ai", "translate", "french", "불어번역"] },
                    internal_changelog_dev_ko: { title: "AI · 내부 개발 체인지로그 (한)", emoji: "📝", color: "gray", aliases: ["ai", "changelog", "internal", "내부체인지로그"] },
                    translate_ko_to_italian: { title: "AI · 한 → 이 번역", emoji: "🇮🇹", color: "green", aliases: ["ai", "translate", "italian", "이탈리아번역"] },
                    linkedin_company_post_ko: { title: "AI · LinkedIn 회사 포스트 (한)", emoji: "🏢", color: "blue", aliases: ["ai", "linkedin", "company", "LinkedIn회사"] },
                    translate_ko_to_spanish: { title: "AI · 한 → 스 번역", emoji: "🇪🇸", color: "yellow", aliases: ["ai", "translate", "spanish", "스페인어번역"] },
                    translate_ko_to_japanese_business: { title: "AI · 한 → 일 비즈니스", emoji: "🇯🇵", color: "blue", aliases: ["ai", "translate", "japanese", "일본비즈니스"] },
                    product_naming_brainstorm_ko: { title: "AI · 제품 네이밍 10 (한)", emoji: "🏷", color: "purple", aliases: ["ai", "naming", "brainstorm", "제품네이밍"] },
                    translate_ko_to_portuguese: { title: "AI · 한 → 포 번역", emoji: "🇵🇹", color: "green", aliases: ["ai", "translate", "portuguese", "포르투갈번역"] },
                    cross_team_async_update_ko: { title: "AI · 크로스팀 업데이트 (한)", emoji: "📡", color: "blue", aliases: ["ai", "crossteam", "async", "크로스팀"] },
                    customer_health_score_definition_ko: { title: "AI · 고객 헬스스코어 (한)", emoji: "💚", color: "green", aliases: ["ai", "health", "score", "헬스스코어"] },
                    translate_ko_to_polish: { title: "AI · 한 → 폴 번역", emoji: "🇵🇱", color: "red", aliases: ["ai", "translate", "polish", "폴란드번역"] },
                    marketing_email_ab_subject_5_ko: { title: "AI · 메일 제목 A/B 5 (한)", emoji: "✉️", color: "yellow", aliases: ["ai", "subject", "ab", "제목AB"] },
                    translate_ko_to_dutch: { title: "AI · 한 → 네 번역", emoji: "🇳🇱", color: "orange", aliases: ["ai", "translate", "dutch", "네덜란드번역"] },
                    pre_launch_checklist_ko: { title: "AI · 출시 전 체크 (한)", emoji: "🚀", color: "purple", aliases: ["ai", "launch", "checklist", "출시전"] },
                    founder_well_being_check_ko: { title: "AI · 창업자 자기점검 (한)", emoji: "🧘", color: "green", aliases: ["ai", "founder", "wellbeing", "자기점검"] },
                    translate_ko_to_swedish: { title: "AI · 한 → 스웨덴 번역", emoji: "🇸🇪", color: "blue", aliases: ["ai", "translate", "swedish", "스웨덴"] },
                    all_hands_qna_doc_ko: { title: "AI · 올핸즈 Q&A 문서 (한)", emoji: "❓", color: "purple", aliases: ["ai", "qa", "allhands", "올핸즈QA"] },
                    ux_writing_button_5_ko: { title: "AI · 버튼 카피 5 (한)", emoji: "🔘", color: "blue", aliases: ["ai", "button", "ux", "버튼카피"] },
                    partner_intro_call_followup_ko: { title: "AI · 파트너 콜 후속 (한)", emoji: "🤝", color: "green", aliases: ["ai", "partner", "followup", "파트너후속"] },
                    translate_ko_to_turkish: { title: "AI · 한 → 터키 번역", emoji: "🇹🇷", color: "red", aliases: ["ai", "translate", "turkish", "터키어"] },
                    security_advisory_user_ko: { title: "AI · 보안 안내 (한)", emoji: "🛡", color: "red", aliases: ["ai", "security", "advisory", "보안안내"] },
                    translate_ko_to_hebrew: { title: "AI · 한 → 히브리 번역", emoji: "🇮🇱", color: "blue", aliases: ["ai", "translate", "hebrew", "히브리"] },
                    retention_cohort_writeup_ko: { title: "AI · 리텐션 코호트 정리 (한)", emoji: "📊", color: "blue", aliases: ["ai", "retention", "cohort", "리텐션코호트"] },
                    talent_offer_letter_ko: { title: "AI · 채용 오퍼 레터 (한)", emoji: "📜", color: "green", aliases: ["ai", "offer", "letter", "오퍼레터"] },
                    translate_ko_to_norwegian: { title: "AI · 한 → 노르웨이 번역", emoji: "🇳🇴", color: "red", aliases: ["ai", "translate", "norwegian", "노르웨이"] },
                    investor_followup_silence_ko: { title: "AI · IR 침묵 후속 (한)", emoji: "🤐", color: "gray", aliases: ["ai", "investor", "silence", "IR침묵"] },
                    translate_ko_to_finnish: { title: "AI · 한 → 핀란드 번역", emoji: "🇫🇮", color: "blue", aliases: ["ai", "translate", "finnish", "핀란드"] },
                    brand_color_palette_ko: { title: "AI · 브랜드 컬러 (한)", emoji: "🎨", color: "purple", aliases: ["ai", "brand", "color", "브랜드컬러"] },
                    customer_pain_interview_qs_ko: { title: "AI · 고객 페인 질문 (한)", emoji: "🔍", color: "yellow", aliases: ["ai", "customer", "interview", "고객페인"] },
                    translate_ko_to_danish: { title: "AI · 한 → 덴마크 번역", emoji: "🇩🇰", color: "red", aliases: ["ai", "translate", "danish", "덴마크"] },
                    sales_email_winback_d60_ko: { title: "AI · 영업 D+60 윈백 (한)", emoji: "🪃", color: "blue", aliases: ["ai", "sales", "winback", "영업D60"] },
                    sprint_review_demo_outline_ko: { title: "AI · 스프린트 리뷰 (한)", emoji: "🏁", color: "green", aliases: ["ai", "sprint", "review", "스프린트리뷰"] },
                    translate_ko_to_czech: { title: "AI · 한 → 체코 번역", emoji: "🇨🇿", color: "blue", aliases: ["ai", "translate", "czech", "체코"] },
                    ad_copy_3_variations_ko: { title: "AI · 광고 카피 3변형 (한)", emoji: "📣", color: "orange", aliases: ["ai", "ad", "variations", "광고3변형"] },
                    ai_eval_rubric_ko: { title: "AI · AI 평가 루브릭 (한)", emoji: "📐", color: "purple", aliases: ["ai", "eval", "rubric", "AI평가"] },
                    translate_ko_to_greek: { title: "AI · 한 → 그리스 번역", emoji: "🇬🇷", color: "blue", aliases: ["ai", "translate", "greek", "그리스"] },
                    contract_negotiation_email_ko: { title: "AI · 계약 검토 메일 (한)", emoji: "📑", color: "gray", aliases: ["ai", "contract", "redline", "계약검토"] },
                    podcast_pitch_to_show_ko: { title: "AI · 팟캐스트 게스트 피치 (한)", emoji: "🎙", color: "purple", aliases: ["ai", "podcast", "pitch", "팟캐스트피치"] },
                    translate_ko_to_hungarian: { title: "AI · 한 → 헝가리 번역", emoji: "🇭🇺", color: "red", aliases: ["ai", "translate", "hungarian", "헝가리"] },
                    customer_referral_request_ko: { title: "AI · 고객 추천 부탁 (한)", emoji: "🌟", color: "yellow", aliases: ["ai", "referral", "customer", "고객추천"] },
                    translate_ko_to_romanian: { title: "AI · 한 → 루마니아 번역", emoji: "🇷🇴", color: "blue", aliases: ["ai", "translate", "romanian", "루마니아"] },
                    weekly_ic_writeup_ko: { title: "AI · IC 주간 정리 (한)", emoji: "📝", color: "blue", aliases: ["ai", "ic", "weekly", "IC주간"] },
                    faq_from_support_tickets_ko: { title: "AI · 티켓 FAQ 추출 (한)", emoji: "❓", color: "green", aliases: ["ai", "faq", "tickets", "FAQ추출"] },
                    translate_ko_to_swahili: { title: "AI · 한 → 스와힐리 번역", emoji: "🇰🇪", color: "green", aliases: ["ai", "translate", "swahili", "스와힐리"] },
                    growth_loop_design_ko: { title: "AI · 그로스 루프 (한)", emoji: "🔁", color: "green", aliases: ["ai", "growth", "loop", "그로스루프"] },
                    translate_ko_to_ukrainian: { title: "AI · 한 → 우크라 번역", emoji: "🇺🇦", color: "blue", aliases: ["ai", "translate", "ukrainian", "우크라"] },
                    decision_log_entry_ko: { title: "AI · 결정 로그 (한)", emoji: "🗳", color: "purple", aliases: ["ai", "decision", "log", "결정로그"] },
                    customer_video_testimonial_brief_ko: { title: "AI · 고객 영상 브리프 (한)", emoji: "🎬", color: "red", aliases: ["ai", "video", "testimonial", "고객영상"] },
                    translate_ko_to_bulgarian: { title: "AI · 한 → 불가리아 번역", emoji: "🇧🇬", color: "red", aliases: ["ai", "translate", "bulgarian", "불가리아"] },
                    recruiter_inmail_ko: { title: "AI · 리쿠르터 InMail (한)", emoji: "📧", color: "blue", aliases: ["ai", "recruiter", "inmail", "리쿠르터"] },
                    translate_ko_to_serbian: { title: "AI · 한 → 세르비아 번역", emoji: "🇷🇸", color: "red", aliases: ["ai", "translate", "serbian", "세르비아"] },
                    npm_package_readme_ko: { title: "AI · npm README (한)", emoji: "📦", color: "red", aliases: ["ai", "npm", "readme", "npmREADME"] },
                    translate_ko_to_filipino: { title: "AI · 한 → 필리핀 번역", emoji: "🇵🇭", color: "yellow", aliases: ["ai", "translate", "filipino", "필리핀"] },
                    sales_qbr_internal_ko: { title: "AI · 영업 QBR 내부 (한)", emoji: "📈", color: "blue", aliases: ["ai", "qbr", "sales", "영업QBR"] },
                    dei_statement_ko: { title: "AI · DEI 선언문 (한)", emoji: "🌈", color: "purple", aliases: ["ai", "dei", "statement", "DEI"] },
                    translate_ko_to_malay: { title: "AI · 한 → 말레이 번역", emoji: "🇲🇾", color: "yellow", aliases: ["ai", "translate", "malay", "말레이"] },
                    customer_call_prep_qbr_ko: { title: "AI · 고객 콜 QBR 준비 (한)", emoji: "📞", color: "blue", aliases: ["ai", "customer", "qbr", "고객QBR"] },
                    translate_ko_to_hindi: { title: "AI · 한 → 힌디 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "hindi", "힌디"] },
                    slack_channel_charter_ko: { title: "AI · Slack 채널 헌장 (한)", emoji: "💬", color: "purple", aliases: ["ai", "slack", "charter", "Slack헌장"] },
                    translate_ko_to_bengali: { title: "AI · 한 → 벵골 번역", emoji: "🇧🇩", color: "green", aliases: ["ai", "translate", "bengali", "벵골"] },
                    perf_calibration_doc_ko: { title: "AI · 평가 칼리브레이션 (한)", emoji: "⚖", color: "purple", aliases: ["ai", "perf", "calibration", "평가칼리"] },
                    translate_ko_to_tamil: { title: "AI · 한 → 타밀 번역", emoji: "🇮🇳", color: "red", aliases: ["ai", "translate", "tamil", "타밀"] },
                    employer_brand_post_ko: { title: "AI · 채용 브랜드 포스트 (한)", emoji: "🌟", color: "blue", aliases: ["ai", "employer", "brand", "채용브랜드"] },
                    translate_ko_to_urdu: { title: "AI · 한 → 우르두 번역", emoji: "🇵🇰", color: "green", aliases: ["ai", "translate", "urdu", "우르두"] },
                    ux_research_recruitment_screener_ko: { title: "AI · UX 리서치 모집 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "ux", "recruitment", "UX모집"] },
                    translate_ko_to_persian: { title: "AI · 한 → 페르시아 번역", emoji: "🇮🇷", color: "green", aliases: ["ai", "translate", "persian", "페르시아"] },
                    internal_tools_doc_ko: { title: "AI · 내부 툴 문서 (한)", emoji: "🛠", color: "gray", aliases: ["ai", "internal", "tools", "내부툴"] },
                    translate_ko_to_burmese: { title: "AI · 한 → 미얀마 번역", emoji: "🇲🇲", color: "red", aliases: ["ai", "translate", "burmese", "미얀마"] },
                    beta_feedback_request_ko: { title: "AI · 베타 피드백 요청 (한)", emoji: "🧪", color: "yellow", aliases: ["ai", "beta", "feedback", "베타피드백"] },
                    translate_ko_to_khmer: { title: "AI · 한 → 크메르 번역", emoji: "🇰🇭", color: "red", aliases: ["ai", "translate", "khmer", "크메르"] },
                    design_review_doc_ko: { title: "AI · 디자인 리뷰 문서 (한)", emoji: "🎨", color: "orange", aliases: ["ai", "design", "review", "디자인리뷰"] },
                    translate_ko_to_lao: { title: "AI · 한 → 라오 번역", emoji: "🇱🇦", color: "red", aliases: ["ai", "translate", "lao", "라오"] },
                    customer_renewal_call_prep_ko: { title: "AI · 갱신 콜 준비 (한)", emoji: "🔄", color: "green", aliases: ["ai", "renewal", "prep", "갱신준비"] },
                    translate_ko_to_mongolian: { title: "AI · 한 → 몽골 번역", emoji: "🇲🇳", color: "blue", aliases: ["ai", "translate", "mongolian", "몽골"] },
                    public_roadmap_intro_ko: { title: "AI · 공개 로드맵 인트로 (한)", emoji: "🗺", color: "blue", aliases: ["ai", "roadmap", "public", "공개로드맵"] },
                    translate_ko_to_uzbek: { title: "AI · 한 → 우즈벡 번역", emoji: "🇺🇿", color: "green", aliases: ["ai", "translate", "uzbek", "우즈벡"] },
                    board_meeting_prep_doc_ko: { title: "AI · 이사회 자료 (한)", emoji: "🏛", color: "blue", aliases: ["ai", "board", "meeting", "이사회"] },
                    translate_ko_to_kazakh: { title: "AI · 한 → 카자흐 번역", emoji: "🇰🇿", color: "yellow", aliases: ["ai", "translate", "kazakh", "카자흐"] },
                    employee_handbook_intro_ko: { title: "AI · 직원 핸드북 인트로 (한)", emoji: "📔", color: "purple", aliases: ["ai", "handbook", "employee", "직원핸드북"] },
                    translate_ko_to_georgian: { title: "AI · 한 → 조지아 번역", emoji: "🇬🇪", color: "red", aliases: ["ai", "translate", "georgian", "조지아"] },
                    sales_demo_followup_email_ko: { title: "AI · 영업 데모 후속 (한)", emoji: "📩", color: "blue", aliases: ["ai", "sales", "demo", "데모후속"] },
                    translate_ko_to_armenian: { title: "AI · 한 → 아르메니아 번역", emoji: "🇦🇲", color: "orange", aliases: ["ai", "translate", "armenian", "아르메니아"] },
                    contractor_offer_email_ko: { title: "AI · 계약직 제안 메일 (한)", emoji: "📑", color: "yellow", aliases: ["ai", "contractor", "offer", "계약직제안"] },
                    translate_ko_to_amharic: { title: "AI · 한 → 암하라 번역", emoji: "🇪🇹", color: "green", aliases: ["ai", "translate", "amharic", "암하라"] },
                    gdpr_dsr_response_ko: { title: "AI · GDPR DSR 응답 (한)", emoji: "🔒", color: "red", aliases: ["ai", "gdpr", "dsr", "GDPRDSR"] },
                    final_milestone_celebration_email_ko: { title: "AI · 마일스톤 자축 메일 (한)", emoji: "🎉", color: "yellow", aliases: ["ai", "milestone", "celebration", "마일스톤자축"] },
                    milestone_complete_announcement_ko: { title: "AI · 마일스톤 공개 발표 (한)", emoji: "🏁", color: "green", aliases: ["ai", "milestone", "complete", "마일스톤완료"] },
                    translate_ko_to_albanian: { title: "AI · 한 → 알바니아 번역", emoji: "🇦🇱", color: "red", aliases: ["ai", "translate", "albanian", "알바니아"] },
                    competitor_battle_card_ko: { title: "AI · 경쟁사 배틀카드 (한)", emoji: "⚔️", color: "red", aliases: ["ai", "competitor", "battle", "배틀카드"] },
                    translate_ko_to_macedonian: { title: "AI · 한 → 마케도니아 번역", emoji: "🇲🇰", color: "yellow", aliases: ["ai", "translate", "macedonian", "마케도니아"] },
                    incident_postmortem_blameless_ko: { title: "AI · 비난 없는 포스트모템 (한)", emoji: "🩺", color: "blue", aliases: ["ai", "postmortem", "blameless", "포스트모템"] },
                    translate_ko_to_estonian: { title: "AI · 한 → 에스토니아 번역", emoji: "🇪🇪", color: "blue", aliases: ["ai", "translate", "estonian", "에스토니아"] },
                    meeting_decision_log_ko: { title: "AI · 의사결정 로그 (한)", emoji: "🗂", color: "gray", aliases: ["ai", "decision", "log", "의사결정로그"] },
                    translate_ko_to_latvian: { title: "AI · 한 → 라트비아 번역", emoji: "🇱🇻", color: "red", aliases: ["ai", "translate", "latvian", "라트비아"] },
                    okr_q3_alignment_doc_ko: { title: "AI · OKR 정렬 문서 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "okr", "alignment", "OKR정렬"] },
                    translate_ko_to_lithuanian: { title: "AI · 한 → 리투아니아 번역", emoji: "🇱🇹", color: "yellow", aliases: ["ai", "translate", "lithuanian", "리투아니아"] },
                    customer_kickoff_email_ko: { title: "AI · 고객 킥오프 메일 (한)", emoji: "🚀", color: "green", aliases: ["ai", "customer", "kickoff", "고객킥오프"] },
                    translate_ko_to_slovenian: { title: "AI · 한 → 슬로베니아 번역", emoji: "🇸🇮", color: "blue", aliases: ["ai", "translate", "slovenian", "슬로베니아"] },
                    engineering_design_doc_short_ko: { title: "AI · 짧은 설계 문서 (한)", emoji: "📐", color: "blue", aliases: ["ai", "design", "doc", "설계문서"] },
                    translate_ko_to_slovak: { title: "AI · 한 → 슬로바키아 번역", emoji: "🇸🇰", color: "red", aliases: ["ai", "translate", "slovak", "슬로바키아"] },
                    partnership_proposal_email_ko: { title: "AI · 파트너십 제안 (한)", emoji: "🤝", color: "green", aliases: ["ai", "partnership", "proposal", "파트너십제안"] },
                    translate_ko_to_croatian: { title: "AI · 한 → 크로아티아 번역", emoji: "🇭🇷", color: "red", aliases: ["ai", "translate", "croatian", "크로아티아"] },
                    engineering_hiring_loop_doc_ko: { title: "AI · 엔지니어 채용 루프 (한)", emoji: "🧑‍💻", color: "purple", aliases: ["ai", "hiring", "engineering", "채용루프"] },
                    translate_ko_to_serbian_latin: { title: "AI · 한 → 세르비아 (Latin)", emoji: "🇷🇸", color: "yellow", aliases: ["ai", "translate", "serbian", "세르비아라틴"] },
                    customer_advocacy_program_intro_ko: { title: "AI · 고객 advocacy 소개 (한)", emoji: "💛", color: "yellow", aliases: ["ai", "advocacy", "customer", "고객advocacy"] },
                    translate_ko_to_bosnian: { title: "AI · 한 → 보스니아 번역", emoji: "🇧🇦", color: "blue", aliases: ["ai", "translate", "bosnian", "보스니아"] },
                    product_principles_doc_ko: { title: "AI · 제품 원칙 문서 (한)", emoji: "📜", color: "orange", aliases: ["ai", "principles", "product", "제품원칙"] },
                    translate_ko_to_montenegrin: { title: "AI · 한 → 몬테네그로 번역", emoji: "🇲🇪", color: "red", aliases: ["ai", "translate", "montenegrin", "몬테네그로"] },
                    growth_marketing_funnel_audit_ko: { title: "AI · 마케팅 퍼널 감사 (한)", emoji: "📈", color: "green", aliases: ["ai", "growth", "funnel", "퍼널감사"] },
                    translate_ko_to_maltese: { title: "AI · 한 → 몰타 번역", emoji: "🇲🇹", color: "red", aliases: ["ai", "translate", "maltese", "몰타"] },
                    internal_comms_layoff_announcement_ko: { title: "AI · 정리해고 사내 발표 (한)", emoji: "📢", color: "gray", aliases: ["ai", "layoff", "internal", "정리해고"] },
                    translate_ko_to_icelandic: { title: "AI · 한 → 아이슬란드 번역", emoji: "🇮🇸", color: "blue", aliases: ["ai", "translate", "icelandic", "아이슬란드"] },
                    customer_referral_program_intro_ko: { title: "AI · 고객 추천 프로그램 (한)", emoji: "👥", color: "purple", aliases: ["ai", "referral", "customer", "고객추천"] },
                    translate_ko_to_welsh: { title: "AI · 한 → 웨일스 번역", emoji: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", color: "red", aliases: ["ai", "translate", "welsh", "웨일스"] },
                    sales_negotiation_concession_ladder_ko: { title: "AI · 영업 양보 사다리 (한)", emoji: "🪜", color: "yellow", aliases: ["ai", "negotiation", "concession", "양보사다리"] },
                    translate_ko_to_irish: { title: "AI · 한 → 아일랜드 번역", emoji: "🇮🇪", color: "green", aliases: ["ai", "translate", "irish", "아일랜드"] },
                    quarterly_growth_review_email_ko: { title: "AI · 분기 그로스 리뷰 (한)", emoji: "📊", color: "blue", aliases: ["ai", "growth", "quarterly", "분기그로스"] },
                    translate_ko_to_scottish_gaelic: { title: "AI · 한 → 스코트게일 번역", emoji: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", color: "blue", aliases: ["ai", "translate", "gaelic", "스코트게일"] },
                    pm_weekly_writeup_to_eng_ko: (
                      { title: "AI · PM 주간 리포트 (한)", emoji: "📝", color: "blue", aliases: ["ai", "pm", "weekly", "PM주간"] }
                    ),
                    translate_ko_to_catalan: { title: "AI · 한 → 카탈루냐 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "catalan", "카탈루냐"] },
                    incident_communications_press_ko: { title: "AI · 사고 프레스 발표 (한)", emoji: "📰", color: "red", aliases: ["ai", "incident", "press", "사고프레스"] },
                    translate_ko_to_basque: { title: "AI · 한 → 바스크 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "basque", "바스크"] },
                    customer_health_review_call_ko: { title: "AI · 고객 헬스 리뷰 (한)", emoji: "🩺", color: "green", aliases: ["ai", "customer", "health", "고객헬스"] },
                    translate_ko_to_galician: { title: "AI · 한 → 갈리시아 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "galician", "갈리시아"] },
                    marketing_brief_template_ko: { title: "AI · 마케팅 브리프 (한)", emoji: "📋", color: "purple", aliases: ["ai", "marketing", "brief", "마케팅브리프"] },
                    translate_ko_to_yoruba: { title: "AI · 한 → 요루바 번역", emoji: "🇳🇬", color: "green", aliases: ["ai", "translate", "yoruba", "요루바"] },
                    engineering_team_charter_ko: { title: "AI · 엔지니어팀 차터 (한)", emoji: "📑", color: "blue", aliases: ["ai", "engineering", "charter", "엔지니어차터"] },
                    translate_ko_to_igbo: { title: "AI · 한 → 이그보 번역", emoji: "🇳🇬", color: "green", aliases: ["ai", "translate", "igbo", "이그보"] },
                    customer_first_30day_review_ko: { title: "AI · 고객 30일 리뷰 (한)", emoji: "📅", color: "green", aliases: ["ai", "customer", "30day", "고객30일"] },
                    translate_ko_to_hausa: { title: "AI · 한 → 하우사 번역", emoji: "🇳🇬", color: "yellow", aliases: ["ai", "translate", "hausa", "하우사"] },
                    executive_offsite_agenda_ko: { title: "AI · 임원 오프사이트 (한)", emoji: "🏞", color: "blue", aliases: ["ai", "offsite", "executive", "오프사이트"] },
                    translate_ko_to_zulu: { title: "AI · 한 → 줄루 번역", emoji: "🇿🇦", color: "red", aliases: ["ai", "translate", "zulu", "줄루"] },
                    quarterly_engineering_planning_ko: { title: "AI · 분기 엔지니어 계획 (한)", emoji: "🛠", color: "purple", aliases: ["ai", "engineering", "quarterly", "엔지니어계획"] },
                    translate_ko_to_xhosa: { title: "AI · 한 → 코사 번역", emoji: "🇿🇦", color: "blue", aliases: ["ai", "translate", "xhosa", "코사"] },
                    customer_pmf_survey_ko: { title: "AI · PMF 설문 (한)", emoji: "📊", color: "purple", aliases: ["ai", "pmf", "survey", "PMF설문"] },
                    translate_ko_to_pashto: { title: "AI · 한 → 파슈토 번역", emoji: "🇦🇫", color: "green", aliases: ["ai", "translate", "pashto", "파슈토"] },
                    pricing_proposal_internal_ko: { title: "AI · 가격 변경 제안 (한)", emoji: "💲", color: "yellow", aliases: ["ai", "pricing", "proposal", "가격제안"] },
                    translate_ko_to_sinhala: { title: "AI · 한 → 신할라 번역", emoji: "🇱🇰", color: "yellow", aliases: ["ai", "translate", "sinhala", "신할라"] },
                    customer_voice_synthesis_ko: { title: "AI · 고객 보이스 종합 (한)", emoji: "🎤", color: "purple", aliases: ["ai", "voc", "customer", "고객보이스"] },
                    translate_ko_to_punjabi: { title: "AI · 한 → 펀자브 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "punjabi", "펀자브"] },
                    engineering_oncall_handoff_doc_ko: { title: "AI · 온콜 핸드오프 (한)", emoji: "📟", color: "red", aliases: ["ai", "oncall", "handoff", "온콜핸드오프"] },
                    translate_ko_to_marathi: { title: "AI · 한 → 마라티 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "marathi", "마라티"] },
                    marketing_campaign_postmortem_ko: { title: "AI · 마케팅 캠페인 회고 (한)", emoji: "📉", color: "purple", aliases: ["ai", "marketing", "postmortem", "캠페인회고"] },
                    translate_ko_to_telugu: { title: "AI · 한 → 텔루구 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "telugu", "텔루구"] },
                    sales_pipeline_review_internal_ko: { title: "AI · 영업 파이프라인 리뷰 (한)", emoji: "🪈", color: "green", aliases: ["ai", "sales", "pipeline", "파이프라인리뷰"] },
                    translate_ko_to_kannada: { title: "AI · 한 → 칸나다 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "kannada", "칸나다"] },
                    team_meeting_async_format_ko: { title: "AI · 회의 → 비동기 전환 (한)", emoji: "⏱", color: "blue", aliases: ["ai", "meeting", "async", "비동기회의"] },
                    translate_ko_to_malayalam: { title: "AI · 한 → 말라얄람 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "malayalam", "말라얄람"] },
                    customer_quarterly_strategic_review_ko: { title: "AI · 고객 QSR 전략 리뷰 (한)", emoji: "🌐", color: "blue", aliases: ["ai", "qsr", "strategic", "QSR전략"] },
                    translate_ko_to_gujarati: { title: "AI · 한 → 구자라트 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "gujarati", "구자라트"] },
                    engineering_runbook_template_ko: { title: "AI · 엔지니어 런북 (한)", emoji: "📕", color: "red", aliases: ["ai", "runbook", "engineering", "런북"] },
                    translate_ko_to_odia: { title: "AI · 한 → 오리야 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "odia", "오리야"] },
                    marketing_pr_pitch_email_ko: { title: "AI · PR 피치 메일 (한)", emoji: "📣", color: "purple", aliases: ["ai", "pr", "pitch", "PR피치"] },
                    translate_ko_to_assamese: { title: "AI · 한 → 아삼 번역", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "assamese", "아삼"] },
                    customer_offboarding_email_ko: { title: "AI · 고객 오프보딩 (한)", emoji: "👋", color: "gray", aliases: ["ai", "customer", "offboarding", "오프보딩"] },
                    translate_ko_to_nepali: { title: "AI · 한 → 네팔 번역", emoji: "🇳🇵", color: "red", aliases: ["ai", "translate", "nepali", "네팔"] },
                    team_retro_continue_stop_start_ko: { title: "AI · 팀 회고 CSS (한)", emoji: "♻️", color: "green", aliases: ["ai", "retro", "team", "팀회고"] },
                    translate_ko_to_kashmiri: { title: "AI · 한 → 카슈미르 번역", emoji: "🇮🇳", color: "blue", aliases: ["ai", "translate", "kashmiri", "카슈미르"] },
                    engineering_arch_review_doc_ko: { title: "AI · 아키텍처 리뷰 문서 (한)", emoji: "🏗", color: "blue", aliases: ["ai", "architecture", "review", "아키리뷰"] },
                    translate_ko_to_dari: { title: "AI · 한 → 다리어 번역", emoji: "🇦🇫", color: "green", aliases: ["ai", "translate", "dari", "다리어"] },
                    customer_renewal_negotiation_email_ko: { title: "AI · 갱신 협상 메일 (한)", emoji: "🤝", color: "yellow", aliases: ["ai", "renewal", "negotiation", "갱신협상"] },
                    translate_ko_to_swiss_german: { title: "AI · 한 → 스위스 독일어 번역", emoji: "🇨🇭", color: "red", aliases: ["ai", "translate", "swiss", "스위스독일"] },
                    sales_cold_call_script_ko: { title: "AI · 콜드콜 스크립트 (한)", emoji: "📞", color: "green", aliases: ["ai", "cold", "call", "콜드콜"] },
                    translate_ko_to_pidgin_english: { title: "AI · 한 → 나이지리아 피진 번역", emoji: "🇳🇬", color: "green", aliases: ["ai", "translate", "pidgin", "피진"] },
                    culture_doc_principles_ko: { title: "AI · 회사 컬처 문서 (한)", emoji: "🌱", color: "green", aliases: ["ai", "culture", "principles", "컬처"] },
                    translate_ko_to_papiamento: { title: "AI · 한 → 파피아멘토 번역", emoji: "🇦🇼", color: "yellow", aliases: ["ai", "translate", "papiamento", "파피아멘토"] },
                    customer_check_in_30_day_email_ko: { title: "AI · 고객 30일 체크인 (한)", emoji: "📩", color: "blue", aliases: ["ai", "customer", "checkin", "30일체크인"] },
                    translate_ko_to_swiss_french: { title: "AI · 한 → 스위스 프랑스 번역", emoji: "🇨🇭", color: "red", aliases: ["ai", "translate", "swissfrench", "스위스프랑스"] },
                    customer_executive_qbr_pre_brief_ko: { title: "AI · QBR 임원 브리핑 (한)", emoji: "🧠", color: "blue", aliases: ["ai", "qbr", "exec", "임원브리핑"] },
                    translate_ko_to_quebec_french: { title: "AI · 한 → 퀘벡 프랑스 번역", emoji: "🇨🇦", color: "blue", aliases: ["ai", "translate", "quebec", "퀘벡"] },
                    brand_naming_brainstorm_ko: { title: "AI · 브랜드 네이밍 (한)", emoji: "🪄", color: "purple", aliases: ["ai", "brand", "naming", "네이밍"] },
                    translate_ko_to_brazilian_portuguese: { title: "AI · 한 → 브라질 포르투갈 번역", emoji: "🇧🇷", color: "green", aliases: ["ai", "translate", "brazilian", "브라질"] },
                    internal_announcement_promotion_ko: { title: "AI · 승진 사내 발표 (한)", emoji: "🎖", color: "yellow", aliases: ["ai", "promotion", "announcement", "승진발표"] },
                    translate_ko_to_mexican_spanish: { title: "AI · 한 → 멕시코 스페인 번역", emoji: "🇲🇽", color: "green", aliases: ["ai", "translate", "mexican", "멕시코"] },
                    customer_complaint_response_ko: { title: "AI · 고객 컴플레인 응답 (한)", emoji: "🛡", color: "red", aliases: ["ai", "complaint", "customer", "컴플레인"] },
                    translate_ko_to_argentinian_spanish: { title: "AI · 한 → 아르헨 스페인 번역", emoji: "🇦🇷", color: "blue", aliases: ["ai", "translate", "argentinian", "아르헨"] },
                    team_okr_check_in_doc_ko: { title: "AI · 팀 OKR 체크인 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "okr", "checkin", "OKR체크인"] },
                    translate_ko_to_castilian_spanish: { title: "AI · 한 → 카스티야 스페인 번역", emoji: "🇪🇸", color: "red", aliases: ["ai", "translate", "castilian", "카스티야"] },
                    customer_renewal_at_risk_email_ko: { title: "AI · 갱신 위험 메일 (한)", emoji: "⚠️", color: "red", aliases: ["ai", "renewal", "risk", "갱신위험"] },
                    translate_ko_to_european_portuguese: { title: "AI · 한 → 유럽 포르투갈 번역", emoji: "🇵🇹", color: "green", aliases: ["ai", "translate", "europortuguese", "유럽포르투갈"] },
                    legal_template_nda_short_ko: { title: "AI · 짧은 NDA 템플릿 (한)", emoji: "📃", color: "gray", aliases: ["ai", "nda", "legal", "NDA"] },
                    translate_ko_to_european_french: { title: "AI · 한 → 유럽 프랑스 번역", emoji: "🇫🇷", color: "blue", aliases: ["ai", "translate", "eurofrench", "유럽프랑스"] },
                    partnerships_intro_summary_ko: { title: "AI · 파트너십 인트로 (한)", emoji: "🔗", color: "blue", aliases: ["ai", "partnership", "intro", "파트너십인트로"] },
                    translate_ko_to_european_german: { title: "AI · 한 → 독일 표준 번역", emoji: "🇩🇪", color: "yellow", aliases: ["ai", "translate", "eurogerman", "독일표준"] },
                    customer_invoice_overdue_email_ko: { title: "AI · 송장 미납 메일 (한)", emoji: "🧾", color: "yellow", aliases: ["ai", "invoice", "overdue", "송장미납"] },
                    translate_ko_to_austrian_german: { title: "AI · 한 → 오스트리아 독일 번역", emoji: "🇦🇹", color: "red", aliases: ["ai", "translate", "austrian", "오스트리아"] },
                    weekly_team_health_pulse_ko: { title: "AI · 팀 헬스 펄스 (한)", emoji: "💓", color: "pink", aliases: ["ai", "health", "pulse", "헬스펄스"] },
                    translate_ko_to_andean_spanish: { title: "AI · 한 → 안데스 스페인 번역", emoji: "🏔", color: "yellow", aliases: ["ai", "translate", "andean", "안데스"] },
                    customer_qr_code_handout_ko: { title: "AI · QR 핸드아웃 (한)", emoji: "📲", color: "blue", aliases: ["ai", "qr", "handout", "QR핸드아웃"] },
                    translate_ko_to_caribbean_spanish: { title: "AI · 한 → 카리브 스페인 번역", emoji: "🏝", color: "blue", aliases: ["ai", "translate", "caribbean", "카리브"] },
                    exec_team_huddle_agenda_ko: { title: "AI · 임원팀 허들 (한)", emoji: "👥", color: "blue", aliases: ["ai", "huddle", "exec", "임원허들"] },
                    translate_ko_to_chilean_spanish: { title: "AI · 한 → 칠레 스페인 번역", emoji: "🇨🇱", color: "red", aliases: ["ai", "translate", "chilean", "칠레"] },
                    customer_loyalty_offer_email_ko: { title: "AI · 고객 충성 오퍼 (한)", emoji: "🎁", color: "purple", aliases: ["ai", "loyalty", "offer", "충성오퍼"] },
                    translate_ko_to_peruvian_spanish: { title: "AI · 한 → 페루 스페인 번역", emoji: "🇵🇪", color: "red", aliases: ["ai", "translate", "peruvian", "페루"] },
                    internal_skip_level_invite_ko: { title: "AI · 스킵레벨 1:1 초대 (한)", emoji: "☕", color: "brown", aliases: ["ai", "skiplevel", "invite", "스킵레벨"] },
                    translate_ko_to_colombian_spanish: { title: "AI · 한 → 콜롬비아 스페인 번역", emoji: "🇨🇴", color: "yellow", aliases: ["ai", "translate", "colombian", "콜롬비아"] },
                    customer_quarterly_winback_email_ko: { title: "AI · 고객 윈백 메일 (한)", emoji: "🔄", color: "green", aliases: ["ai", "winback", "customer", "윈백"] },
                    translate_ko_to_uruguayan_spanish: { title: "AI · 한 → 우루과이 스페인", emoji: "🇺🇾", color: "blue", aliases: ["ai", "translate", "uruguayan", "우루과이"] },
                    customer_executive_intro_email_ko: { title: "AI · 임원 인사 메일 (한)", emoji: "👔", color: "blue", aliases: ["ai", "exec", "intro", "임원인사"] },
                    translate_ko_to_paraguayan_spanish: { title: "AI · 한 → 파라과이 스페인", emoji: "🇵🇾", color: "red", aliases: ["ai", "translate", "paraguayan", "파라과이"] },
                    competitive_displacement_playbook_ko: { title: "AI · 경쟁사 displacement (한)", emoji: "⚔️", color: "red", aliases: ["ai", "displacement", "playbook", "경쟁교체"] },
                    translate_ko_to_venezuelan_spanish: { title: "AI · 한 → 베네수엘라 스페인", emoji: "🇻🇪", color: "yellow", aliases: ["ai", "translate", "venezuelan", "베네수엘라"] },
                    internal_offsite_planning_doc_ko: { title: "AI · 오프사이트 기획 문서 (한)", emoji: "🗺", color: "green", aliases: ["ai", "offsite", "planning", "오프사이트기획"] },
                    translate_ko_to_dominican_spanish: { title: "AI · 한 → 도미니카 스페인", emoji: "🇩🇴", color: "red", aliases: ["ai", "translate", "dominican", "도미니카"] },
                    customer_seat_expansion_email_ko: { title: "AI · 좌석 확장 메일 (한)", emoji: "💺", color: "blue", aliases: ["ai", "seat", "expansion", "좌석확장"] },
                    translate_ko_to_panamanian_spanish: { title: "AI · 한 → 파나마 스페인", emoji: "🇵🇦", color: "blue", aliases: ["ai", "translate", "panamanian", "파나마"] },
                    engineering_postmortem_template_ko: { title: "AI · 엔지니어링 포스트모템 (한)", emoji: "🔬", color: "gray", aliases: ["ai", "postmortem", "engineering", "포스트모템템플릿"] },
                    translate_ko_to_canadian_english: { title: "AI · 한 → 캐나다 영어", emoji: "🇨🇦", color: "red", aliases: ["ai", "translate", "canadian", "캐나다영어"] },
                    customer_segment_definition_doc_ko: { title: "AI · 고객 세그먼트 정의 (한)", emoji: "🧩", color: "purple", aliases: ["ai", "segment", "definition", "세그먼트정의"] },
                    translate_ko_to_australian_english: { title: "AI · 한 → 호주 영어", emoji: "🇦🇺", color: "blue", aliases: ["ai", "translate", "australian", "호주영어"] },
                    internal_all_hands_qna_doc_ko: { title: "AI · 올핸즈 Q&A 문서 (한)", emoji: "🙋", color: "blue", aliases: ["ai", "allhands", "qna", "올핸즈QA"] },
                    translate_ko_to_british_english: { title: "AI · 한 → 영국 영어", emoji: "🇬🇧", color: "red", aliases: ["ai", "translate", "british", "영국영어"] },
                    customer_journey_email_series_ko: { title: "AI · 고객 여정 메일 시리즈 (한)", emoji: "🛤", color: "blue", aliases: ["ai", "journey", "series", "여정시리즈"] },
                    translate_ko_to_indian_english: { title: "AI · 한 → 인도 영어", emoji: "🇮🇳", color: "orange", aliases: ["ai", "translate", "indian", "인도영어"] },
                    saas_metrics_glossary_ko: { title: "AI · SaaS 메트릭 사전 (한)", emoji: "📚", color: "blue", aliases: ["ai", "saas", "metrics", "SaaS메트릭"] },
                    translate_ko_to_singapore_english: { title: "AI · 한 → 싱가포르 영어", emoji: "🇸🇬", color: "red", aliases: ["ai", "translate", "singapore", "싱가포르영어"] },
                    team_growth_plan_individual_ko: { title: "AI · 개인 성장 플랜 (한)", emoji: "🌱", color: "green", aliases: ["ai", "growth", "individual", "개인성장"] },
                    translate_ko_to_irish_english: { title: "AI · 한 → 아일랜드 영어", emoji: "🇮🇪", color: "green", aliases: ["ai", "translate", "irisheng", "아일영어"] },
                    customer_renewal_30day_email_ko: { title: "AI · 갱신 30일 전 메일 (한)", emoji: "📆", color: "blue", aliases: ["ai", "renewal", "30day", "갱신30일"] },
                    translate_ko_to_south_african_english: { title: "AI · 한 → 남아공 영어", emoji: "🇿🇦", color: "yellow", aliases: ["ai", "translate", "saeng", "남아공영어"] },
                    employee_referral_program_ko: { title: "AI · 직원 추천 프로그램 (한)", emoji: "🪙", color: "yellow", aliases: ["ai", "referral", "employee", "직원추천"] },
                    translate_ko_to_new_zealand_english: { title: "AI · 한 → 뉴질랜드 영어", emoji: "🇳🇿", color: "blue", aliases: ["ai", "translate", "nzeng", "뉴질영어"] },
                    customer_advisory_board_invite_ko: { title: "AI · CAB 초대 메일 (한)", emoji: "🏛", color: "purple", aliases: ["ai", "cab", "advisory", "CAB초대"] },
                    translate_ko_to_hong_kong_english: { title: "AI · 한 → 홍콩 영어", emoji: "🇭🇰", color: "red", aliases: ["ai", "translate", "hkeng", "홍콩영어"] },
                    internal_eng_hiring_kickoff_ko: { title: "AI · 엔지니어 채용 킥오프 (한)", emoji: "🚀", color: "blue", aliases: ["ai", "hiring", "kickoff", "채용킥오프"] },
                    translate_ko_to_philippine_english: { title: "AI · 한 → 필리핀 영어", emoji: "🇵🇭", color: "blue", aliases: ["ai", "translate", "phileng", "필리핀영어"] },
                    customer_renewal_signed_thank_you_ko: { title: "AI · 갱신 완료 감사 (한)", emoji: "🙏", color: "green", aliases: ["ai", "renewal", "thanks", "갱신감사"] },
                    translate_ko_to_jamaican_english: { title: "AI · 한 → 자메이카 영어/파트와", emoji: "🇯🇲", color: "green", aliases: ["ai", "translate", "jamaican", "자메이카"] },
                    customer_csm_intro_email_ko: { title: "AI · CSM 인계 인사 메일 (한)", emoji: "👋", color: "blue", aliases: ["ai", "csm", "intro", "CSM인사"] },
                    translate_ko_to_kenyan_english: { title: "AI · 한 → 케냐 영어", emoji: "🇰🇪", color: "red", aliases: ["ai", "translate", "kenyan", "케냐영어"] },
                    eng_team_summit_outline_ko: { title: "AI · 엔지 팀 서밋 (한)", emoji: "🏕", color: "blue", aliases: ["ai", "summit", "engineering", "엔지서밋"] },
                    translate_ko_to_nigerian_english: { title: "AI · 한 → 나이지리아 영어", emoji: "🇳🇬", color: "green", aliases: ["ai", "translate", "nigeng", "나이지영어"] },
                    customer_referral_thanks_email_ko: { title: "AI · 고객 추천 감사 (한)", emoji: "💌", color: "pink", aliases: ["ai", "referral", "thanks", "추천감사"] },
                    translate_ko_to_ghanaian_english: { title: "AI · 한 → 가나 영어", emoji: "🇬🇭", color: "yellow", aliases: ["ai", "translate", "ghaeng", "가나영어"] },
                    internal_security_training_outline_ko: { title: "AI · 보안 교육 아웃라인 (한)", emoji: "🔐", color: "gray", aliases: ["ai", "security", "training", "보안교육"] },
                    translate_ko_to_tanzanian_english: { title: "AI · 한 → 탄자니아 영어", emoji: "🇹🇿", color: "blue", aliases: ["ai", "translate", "tzeng", "탄자영어"] },
                    customer_quarterly_open_house_ko: { title: "AI · 분기 오픈하우스 (한)", emoji: "🏠", color: "blue", aliases: ["ai", "openhouse", "quarterly", "오픈하우스"] },
                    translate_ko_to_caribbean_english: { title: "AI · 한 → 카리브 영어", emoji: "🏝", color: "blue", aliases: ["ai", "translate", "caribeng", "카리브영"] },
                    customer_pmf_interview_questions_ko: { title: "AI · PMF 인터뷰 질문 (한)", emoji: "🎙", color: "purple", aliases: ["ai", "pmf", "interview", "PMF인터뷰"] },
                    translate_ko_to_west_african_french: { title: "AI · 한 → 서아프 프랑스 번역", emoji: "🇸🇳", color: "yellow", aliases: ["ai", "translate", "wafrench", "서아프프랑스"] },
                    internal_compensation_change_announcement_ko: { title: "AI · 보상 변경 안내 (한)", emoji: "💰", color: "yellow", aliases: ["ai", "compensation", "announcement", "보상변경"] },
                    translate_ko_to_belgian_french: { title: "AI · 한 → 벨기에 프랑스 번역", emoji: "🇧🇪", color: "yellow", aliases: ["ai", "translate", "belfrench", "벨기에프랑스"] },
                    customer_health_dashboard_design_ko: { title: "AI · 고객 헬스 대시보드 (한)", emoji: "📊", color: "green", aliases: ["ai", "health", "dashboard", "헬스대시보드"] },
                    translate_ko_to_belgian_dutch: { title: "AI · 한 → 벨기에 더치 번역", emoji: "🇧🇪", color: "red", aliases: ["ai", "translate", "flemish", "플레밍"] },
                    internal_team_health_survey_quarterly_ko: { title: "AI · 분기 팀 헬스 서베이 (한)", emoji: "🩺", color: "pink", aliases: ["ai", "health", "survey", "팀헬스서베이"] },
                    translate_ko_to_netherlands_dutch: { title: "AI · 한 → 네덜란드 더치 번역", emoji: "🇳🇱", color: "orange", aliases: ["ai", "translate", "dutch", "네덜란드"] },
                    customer_handoff_email_csm_to_sales_ko: { title: "AI · CSM → 영업 인계 (한)", emoji: "🤝", color: "blue", aliases: ["ai", "handoff", "csm", "CSM영업인계"] },
                    translate_ko_to_swiss_italian: { title: "AI · 한 → 스위스 이탈리아 번역", emoji: "🇨🇭", color: "red", aliases: ["ai", "translate", "swissitalian", "스위스이탈"] },
                    customer_pricing_objection_response_ko: { title: "AI · 가격 반박 답변 (한)", emoji: "💸", color: "yellow", aliases: ["ai", "pricing", "objection", "가격반박"] },
                    translate_ko_to_italian_dialect_neapolitan: { title: "AI · 한 → 나폴리 방언 번역", emoji: "🇮🇹", color: "orange", aliases: ["ai", "translate", "neapolitan", "나폴리"] },
                    internal_strategy_change_memo_ko: { title: "AI · 전략 변경 메모 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "strategy", "change", "전략변경"] },
                    translate_ko_to_italian_dialect_sicilian: { title: "AI · 한 → 시칠리아 방언 번역", emoji: "🇮🇹", color: "yellow", aliases: ["ai", "translate", "sicilian", "시칠리아"] },
                    customer_q_and_a_template_blog_ko: { title: "AI · 고객 Q&A 블로그 (한)", emoji: "📝", color: "green", aliases: ["ai", "qna", "blog", "고객QA블로그"] },
                    translate_ko_to_italian_dialect_milanese: { title: "AI · 한 → 밀라노 방언 번역", emoji: "🇮🇹", color: "blue", aliases: ["ai", "translate", "milanese", "밀라노"] },
                    internal_eng_blameless_culture_doc_ko: { title: "AI · 비난 없는 엔지 문화 (한)", emoji: "🌿", color: "green", aliases: ["ai", "blameless", "culture", "비난없는문화"] },
                    translate_ko_to_swiss_romansh: { title: "AI · 한 → 로만시 번역", emoji: "🇨🇭", color: "red", aliases: ["ai", "translate", "romansh", "로만시"] },
                    customer_satisfaction_followup_email_ko: { title: "AI · CSAT 후속 메일 (한)", emoji: "💌", color: "blue", aliases: ["ai", "csat", "followup", "CSAT후속"] },
                    translate_ko_to_swahili_dialect: { title: "AI · 한 → 스와힐리 (Bantu)", emoji: "🇹🇿", color: "green", aliases: ["ai", "translate", "swahili", "스와힐리"] },
                    customer_co_marketing_brief_ko: { title: "AI · 공동 마케팅 브리프 (한)", emoji: "🤝", color: "purple", aliases: ["ai", "comarketing", "brief", "공동마케팅"] },
                    translate_ko_to_amharic_dialect: { title: "AI · 한 → 암하라 (변형)", emoji: "🇪🇹", color: "green", aliases: ["ai", "translate", "amharicv", "암하라변형"] },
                    internal_eng_quality_doc_ko: { title: "AI · 엔지니어 품질 문서 (한)", emoji: "✅", color: "green", aliases: ["ai", "quality", "engineering", "엔지품질"] },
                    translate_ko_to_thai_business: { title: "AI · 한 → 태국 비즈니스 번역", emoji: "🇹🇭", color: "blue", aliases: ["ai", "translate", "thaibiz", "태국비즈"] },
                    customer_first_renewal_letter_ko: { title: "AI · 첫 갱신 편지 (한)", emoji: "📜", color: "blue", aliases: ["ai", "firstrenewal", "letter", "첫갱신"] },
                    translate_ko_to_vietnamese_business: { title: "AI · 한 → 베트남 비즈니스 번역", emoji: "🇻🇳", color: "red", aliases: ["ai", "translate", "viebiz", "베트남비즈"] },
                    competitive_intelligence_brief_ko: { title: "AI · 경쟁 인텔리전스 (한)", emoji: "🕵", color: "gray", aliases: ["ai", "ci", "competitive", "경쟁인텔"] },
                    translate_ko_to_indonesian_business: { title: "AI · 한 → 인도네 비즈니스 번역", emoji: "🇮🇩", color: "red", aliases: ["ai", "translate", "indobiz", "인도네비즈"] },
                    customer_invoice_received_thanks_ko: { title: "AI · 결제 확인 감사 메일 (한)", emoji: "🧾", color: "green", aliases: ["ai", "invoice", "thanks", "결제감사"] },
                    translate_ko_to_burmese_business: { title: "AI · 한 → 미얀마 비즈니스 번역", emoji: "🇲🇲", color: "red", aliases: ["ai", "translate", "burmesebiz", "미얀마비즈"] },
                    customer_internal_champion_doc_ko: { title: "AI · 챔피언 enablement (한)", emoji: "🏆", color: "yellow", aliases: ["ai", "champion", "enablement", "챔피언"] },
                    translate_ko_to_khmer_business: { title: "AI · 한 → 크메르 비즈니스 번역", emoji: "🇰🇭", color: "red", aliases: ["ai", "translate", "khmerbiz", "크메르비즈"] },
                    internal_eng_postmortem_action_followup_ko: { title: "AI · PM 액션 follow-up (한)", emoji: "🔁", color: "blue", aliases: ["ai", "postmortem", "followup", "PM후속"] },
                    translate_ko_to_lao_business: { title: "AI · 한 → 라오 비즈니스 번역", emoji: "🇱🇦", color: "red", aliases: ["ai", "translate", "laobiz", "라오비즈"] },
                    customer_data_export_request_response_ko: { title: "AI · 데이터 export 응답 (한)", emoji: "📤", color: "gray", aliases: ["ai", "export", "data", "데이터export"] },
                    translate_ko_to_mongolian_business: { title: "AI · 한 → 몽골 비즈니스 번역", emoji: "🇲🇳", color: "blue", aliases: ["ai", "translate", "monbiz", "몽골비즈"] },
                    internal_eng_dx_survey_ko: { title: "AI · 엔지 DX 서베이 (한)", emoji: "🧪", color: "purple", aliases: ["ai", "dx", "survey", "DX서베이"] },
                    translate_ko_to_uzbek_business: { title: "AI · 한 → 우즈벡 비즈니스 번역", emoji: "🇺🇿", color: "green", aliases: ["ai", "translate", "uzbekbiz", "우즈벡비즈"] },
                    customer_lessons_learned_brief_ko: { title: "AI · 잃은 deal 학습 (한)", emoji: "📓", color: "gray", aliases: ["ai", "lessons", "lost", "잃은deal"] },
                    translate_ko_to_kazakh_business: { title: "AI · 한 → 카자흐 비즈니스 번역", emoji: "🇰🇿", color: "blue", aliases: ["ai", "translate", "kazbiz", "카자흐비즈"] },
                    customer_user_research_invite_ko: { title: "AI · 사용자 리서치 초대 (한)", emoji: "🔬", color: "purple", aliases: ["ai", "research", "invite", "리서치초대"] },
                    translate_ko_to_kazakh_cyrillic: { title: "AI · 한 → 카자흐 (Cyrillic)", emoji: "🇰🇿", color: "yellow", aliases: ["ai", "translate", "kazcyr", "카자흐키릴"] },
                    internal_eng_review_template_ko: { title: "AI · 엔지 perf 리뷰 (한)", emoji: "📋", color: "blue", aliases: ["ai", "review", "engineering", "엔지리뷰"] },
                    translate_ko_to_kyrgyz: { title: "AI · 한 → 키르기스 번역", emoji: "🇰🇬", color: "red", aliases: ["ai", "translate", "kyrgyz", "키르기스"] },
                    customer_renewal_signed_announcement_internal_ko: { title: "AI · 갱신 사내 발표 (한)", emoji: "🎉", color: "green", aliases: ["ai", "renewal", "announcement", "갱신사내"] },
                    translate_ko_to_turkmen: { title: "AI · 한 → 투르크멘 번역", emoji: "🇹🇲", color: "green", aliases: ["ai", "translate", "turkmen", "투르크멘"] },
                    internal_eng_capacity_planning_ko: { title: "AI · 엔지 capacity 계획 (한)", emoji: "📈", color: "blue", aliases: ["ai", "capacity", "planning", "capacity계획"] },
                    translate_ko_to_tajik: { title: "AI · 한 → 타지크 번역", emoji: "🇹🇯", color: "red", aliases: ["ai", "translate", "tajik", "타지크"] },
                    customer_survey_results_share_ko: { title: "AI · 설문 결과 공유 (한)", emoji: "📊", color: "blue", aliases: ["ai", "survey", "results", "설문공유"] },
                    translate_ko_to_baluchi: { title: "AI · 한 → 발루치 번역", emoji: "🇵🇰", color: "red", aliases: ["ai", "translate", "baluchi", "발루치"] },
                    customer_health_review_template_ko: { title: "AI · 고객 헬스 리뷰 템플릿 (한)", emoji: "🩺", color: "green", aliases: ["ai", "health", "review", "헬스리뷰템플"] },
                    translate_ko_to_sindhi: { title: "AI · 한 → 신디 번역", emoji: "🇵🇰", color: "green", aliases: ["ai", "translate", "sindhi", "신디"] },
                    internal_pm_org_strategy_doc_ko: { title: "AI · PM 조직 전략 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "pm", "strategy", "PM조직"] },
                    translate_ko_to_sorbian: { title: "AI · 한 → 소르브 번역", emoji: "🇩🇪", color: "yellow", aliases: ["ai", "translate", "sorbian", "소르브"] },
                    customer_lifecycle_email_d100_ko: { title: "AI · 100일 라이프사이클 (한)", emoji: "💯", color: "purple", aliases: ["ai", "lifecycle", "100day", "100일"] },
                    translate_ko_to_frisian: { title: "AI · 한 → 프리지아 번역", emoji: "🇳🇱", color: "blue", aliases: ["ai", "translate", "frisian", "프리지아"] },
                    internal_exec_decision_brief_template_ko: { title: "AI · 임원 결정 브리프 (한)", emoji: "🧠", color: "blue", aliases: ["ai", "decision", "brief", "임원결정"] },
                    translate_ko_to_walloon: { title: "AI · 한 → 왈론 번역", emoji: "🇧🇪", color: "red", aliases: ["ai", "translate", "walloon", "왈론"] },
                    customer_quarterly_innovation_share_ko: { title: "AI · 분기 출시 공유 (한)", emoji: "🚀", color: "purple", aliases: ["ai", "innovation", "quarterly", "분기출시"] },
                    translate_ko_to_chechen: { title: "AI · 한 → 체첸 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "chechen", "체첸"] },
                    customer_renewal_decision_tree_ko: (
                      { title: "AI · 갱신 결정 트리 (한)", emoji: "🌲", color: "green", aliases: ["ai", "renewal", "decision", "갱신트리"] }
                    ),
                    translate_ko_to_chuvash: { title: "AI · 한 → 추바시 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "chuvash", "추바시"] },
                    internal_eng_rfc_template_ko: { title: "AI · 엔지 RFC 템플릿 (한)", emoji: "📄", color: "blue", aliases: ["ai", "rfc", "engineering", "엔지RFC"] },
                    translate_ko_to_yakut: { title: "AI · 한 → 사하 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "yakut", "사하"] },
                    customer_email_intro_to_advisory_ko: { title: "AI · 어드바이저 소개 메일 (한)", emoji: "🤝", color: "blue", aliases: ["ai", "intro", "advisory", "어드바이저"] },
                    translate_ko_to_bashkir: { title: "AI · 한 → 바슈키르 번역", emoji: "🏴", color: "green", aliases: ["ai", "translate", "bashkir", "바슈키르"] },
                    internal_pm_okr_template_ko: { title: "AI · PM 연간 OKR (한)", emoji: "🎯", color: "purple", aliases: ["ai", "pm", "okr", "PM연간OKR"] },
                    translate_ko_to_tatar: { title: "AI · 한 → 타타르 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "tatar", "타타르"] },
                    customer_pricing_grandfather_email_ko: { title: "AI · 가격 grandfather (한)", emoji: "🛡", color: "blue", aliases: ["ai", "pricing", "grandfather", "가격보호"] },
                    translate_ko_to_buryat: { title: "AI · 한 → 부랴트 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "buryat", "부랴트"] },
                    customer_strategic_review_pre_brief_ko: { title: "AI · 전략 리뷰 프리브리프 (한)", emoji: "📌", color: "blue", aliases: ["ai", "strategic", "review", "전략리뷰"] },
                    translate_ko_to_kalmyk: { title: "AI · 한 → 칼미크 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "kalmyk", "칼미크"] },
                    internal_pm_eng_alignment_doc_ko: { title: "AI · PM-Eng 정렬 문서 (한)", emoji: "🪢", color: "purple", aliases: ["ai", "pm", "eng", "PMENG정렬"] },
                    translate_ko_to_avar: { title: "AI · 한 → 아바르 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "avar", "아바르"] },
                    customer_quarterly_listening_session_ko: { title: "AI · 분기 listening session (한)", emoji: "👂", color: "purple", aliases: ["ai", "listening", "quarterly", "listening"] },
                    translate_ko_to_ossetian: { title: "AI · 한 → 오세트 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "ossetian", "오세트"] },
                    internal_eng_promotion_calibration_ko: { title: "AI · 엔지 승진 calibration (한)", emoji: "📈", color: "blue", aliases: ["ai", "promotion", "calibration", "엔지승진"] },
                    translate_ko_to_ingush: { title: "AI · 한 → 잉구시 번역", emoji: "🏴", color: "green", aliases: ["ai", "translate", "ingush", "잉구시"] },
                    customer_implementation_kickoff_call_agenda_ko: { title: "AI · 구현 킥오프 콜 (한)", emoji: "🛠", color: "blue", aliases: ["ai", "kickoff", "implementation", "구현킥오프"] },
                    translate_ko_to_lezgian: { title: "AI · 한 → 레즈긴 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "lezgian", "레즈긴"] },
                    customer_renewal_negotiation_phone_script_ko: { title: "AI · 갱신 협상 콜 스크립트 (한)", emoji: "📞", color: "blue", aliases: ["ai", "renewal", "phone", "갱신콜"] },
                    translate_ko_to_kumyk: { title: "AI · 한 → 쿠미크 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "kumyk", "쿠미크"] },
                    internal_eng_oncall_rotation_doc_ko: { title: "AI · 온콜 로테이션 (한)", emoji: "🔔", color: "red", aliases: ["ai", "oncall", "rotation", "온콜로테이션"] },
                    translate_ko_to_karachay: { title: "AI · 한 → 카라차이 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "karachay", "카라차이"] },
                    customer_implementation_health_check_ko: { title: "AI · 구현 헬스 체크 (한)", emoji: "🩺", color: "blue", aliases: ["ai", "implementation", "health", "구현헬스"] },
                    translate_ko_to_balkar: { title: "AI · 한 → 발카르 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "balkar", "발카르"] },
                    internal_pm_user_research_intake_ko: { title: "AI · PM 리서치 요청 폼 (한)", emoji: "📥", color: "purple", aliases: ["ai", "pm", "intake", "PM리서치"] },
                    translate_ko_to_nogai: { title: "AI · 한 → 노가이 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "nogai", "노가이"] },
                    customer_renewal_lost_postmortem_ko: { title: "AI · 갱신 실패 PM (한)", emoji: "📓", color: "gray", aliases: ["ai", "lost", "postmortem", "갱신실패"] },
                    translate_ko_to_komi: { title: "AI · 한 → 코미 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "komi", "코미"] },
                    customer_quarterly_qbr_action_items_ko: { title: "AI · QBR 액션 아이템 (한)", emoji: "✅", color: "blue", aliases: ["ai", "qbr", "actions", "QBR액션"] },
                    translate_ko_to_udmurt: { title: "AI · 한 → 우드무르트 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "udmurt", "우드무르트"] },
                    internal_pm_planning_doc_template_ko: { title: "AI · PM 연간 계획 (한)", emoji: "🗓", color: "purple", aliases: ["ai", "pm", "planning", "PM연간계획"] },
                    translate_ko_to_mari_meadow: { title: "AI · 한 → 마리 (Meadow)", emoji: "🏴", color: "green", aliases: ["ai", "translate", "marim", "마리M"] },
                    customer_first_workflow_setup_email_ko: { title: "AI · 첫 워크플로우 셋업 (한)", emoji: "🧩", color: "blue", aliases: ["ai", "workflow", "setup", "워크플로우셋업"] },
                    translate_ko_to_mari_hill: { title: "AI · 한 → 마리 (Hill)", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "marih", "마리H"] },
                    internal_pm_strategy_offsite_outline_ko: { title: "AI · PM 전략 오프사이트 (한)", emoji: "🏔", color: "purple", aliases: ["ai", "pm", "offsite", "PM오프사이트"] },
                    translate_ko_to_erzya: { title: "AI · 한 → 에르자 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "erzya", "에르자"] },
                    customer_proof_of_concept_summary_ko: { title: "AI · PoC 요약 (한)", emoji: "🧪", color: "blue", aliases: ["ai", "poc", "summary", "PoC요약"] },
                    translate_ko_to_moksha: { title: "AI · 한 → 모크샤 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "moksha", "모크샤"] },
                    customer_strategic_account_summary_ko: { title: "AI · 전략 어카운트 1pg (한)", emoji: "🌟", color: "purple", aliases: ["ai", "strategic", "account", "전략어카운트"] },
                    translate_ko_to_karelian: { title: "AI · 한 → 카렐 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "karelian", "카렐"] },
                    internal_pm_research_synthesis_template_ko: { title: "AI · PM 리서치 종합 (한)", emoji: "🔬", color: "purple", aliases: ["ai", "research", "synthesis", "리서치종합"] },
                    translate_ko_to_veps: { title: "AI · 한 → 베프스 번역", emoji: "🏴", color: "green", aliases: ["ai", "translate", "veps", "베프스"] },
                    customer_upsell_proposal_doc_ko: { title: "AI · 업셀 제안 문서 (한)", emoji: "📈", color: "green", aliases: ["ai", "upsell", "proposal", "업셀제안"] },
                    translate_ko_to_livonian: { title: "AI · 한 → 리보니아 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "livonian", "리보니아"] },
                    internal_eng_team_capacity_calendar_ko: { title: "AI · 엔지 capacity 캘린더 (한)", emoji: "📅", color: "blue", aliases: ["ai", "capacity", "calendar", "엔지캘린더"] },
                    translate_ko_to_ingrian: { title: "AI · 한 → 잉그리아 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "ingrian", "잉그리아"] },
                    customer_renewal_pre_negotiation_doc_ko: { title: "AI · 갱신 협상 사전 (한)", emoji: "♟", color: "blue", aliases: ["ai", "renewal", "prenegotiation", "갱신사전"] },
                    translate_ko_to_yiddish: { title: "AI · 한 → 이디시 번역", emoji: "✡️", color: "blue", aliases: ["ai", "translate", "yiddish", "이디시"] },
                    customer_implementation_30day_review_ko: { title: "AI · 구현 30일 리뷰 (한)", emoji: "📆", color: "blue", aliases: ["ai", "implementation", "30day", "구현30일"] },
                    translate_ko_to_ladino: { title: "AI · 한 → 라디노 번역", emoji: "✡️", color: "yellow", aliases: ["ai", "translate", "ladino", "라디노"] },
                    internal_pm_research_intake_form_quick_ko: { title: "AI · PM 리서치 빠른 폼 (한)", emoji: "⚡", color: "purple", aliases: ["ai", "research", "quickintake", "빠른리서치"] },
                    translate_ko_to_judeo_arabic: { title: "AI · 한 → 유대아랍 번역", emoji: "✡️", color: "green", aliases: ["ai", "translate", "judeoarabic", "유대아랍"] },
                    customer_health_save_play_ko: { title: "AI · 고객 save play (한)", emoji: "🛟", color: "red", aliases: ["ai", "save", "play", "save플레이"] },
                    translate_ko_to_aramaic: { title: "AI · 한 → 아람어 번역", emoji: "📜", color: "yellow", aliases: ["ai", "translate", "aramaic", "아람어"] },
                    internal_eng_arch_governance_doc_ko: { title: "AI · 엔지 아키 거버넌스 (한)", emoji: "🏛", color: "blue", aliases: ["ai", "architecture", "governance", "아키거버"] },
                    translate_ko_to_coptic: { title: "AI · 한 → 콥트어 번역", emoji: "✟", color: "red", aliases: ["ai", "translate", "coptic", "콥트"] },
                    customer_implementation_60day_review_ko: { title: "AI · 구현 60일 리뷰 (한)", emoji: "📆", color: "blue", aliases: ["ai", "implementation", "60day", "구현60일"] },
                    translate_ko_to_circassian: { title: "AI · 한 → 체르카스 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "circassian", "체르카스"] },
                    customer_quarterly_summary_email_ko: { title: "AI · 분기 정리 메일 (한)", emoji: "📅", color: "blue", aliases: ["ai", "quarterly", "summary", "분기정리"] },
                    translate_ko_to_abkhaz: { title: "AI · 한 → 압하즈 번역", emoji: "🏴", color: "green", aliases: ["ai", "translate", "abkhaz", "압하즈"] },
                    internal_pm_decision_template_ko: { title: "AI · PM 결정 문서 (한)", emoji: "🪪", color: "purple", aliases: ["ai", "pm", "decision", "PM결정"] },
                    translate_ko_to_lak: { title: "AI · 한 → 라크 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "lak", "라크"] },
                    customer_implementation_90day_review_ko: { title: "AI · 구현 90일 리뷰 (한)", emoji: "📆", color: "blue", aliases: ["ai", "implementation", "90day", "구현90일"] },
                    translate_ko_to_dargin: { title: "AI · 한 → 다르긴 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "dargin", "다르긴"] },
                    internal_eng_oncall_postmortem_doc_ko: { title: "AI · 온콜 포스트모템 (한)", emoji: "📔", color: "red", aliases: ["ai", "oncall", "postmortem", "온콜PM"] },
                    translate_ko_to_tabasaran: { title: "AI · 한 → 타바사란 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "tabasaran", "타바사란"] },
                    customer_success_metrics_dashboard_ko: { title: "AI · CS 메트릭 대시보드 (한)", emoji: "📊", color: "green", aliases: ["ai", "cs", "metrics", "CS대시보드"] },
                    translate_ko_to_breton: { title: "AI · 한 → 브르타뉴 번역", emoji: "🇫🇷", color: "red", aliases: ["ai", "translate", "breton", "브르타뉴"] },
                    customer_renewal_quote_email_ko: { title: "AI · 갱신 견적 메일 (한)", emoji: "💸", color: "blue", aliases: ["ai", "renewal", "quote", "갱신견적"] },
                    translate_ko_to_cornish: { title: "AI · 한 → 콘월 번역", emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", color: "blue", aliases: ["ai", "translate", "cornish", "콘월"] },
                    internal_eng_alerting_strategy_doc_ko: { title: "AI · 엔지 알람 전략 (한)", emoji: "🚨", color: "red", aliases: ["ai", "alerting", "strategy", "알람전략"] },
                    translate_ko_to_manx: { title: "AI · 한 → 맹크스 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "manx", "맹크스"] },
                    customer_advisory_quarterly_recap_ko: { title: "AI · CAB 분기 회고 (한)", emoji: "🌟", color: "purple", aliases: ["ai", "cab", "recap", "CAB회고"] },
                    translate_ko_to_occitan: { title: "AI · 한 → 옥시탄 번역", emoji: "🇫🇷", color: "yellow", aliases: ["ai", "translate", "occitan", "옥시탄"] },
                    internal_design_review_protocol_ko: { title: "AI · 디자인 리뷰 프로토콜 (한)", emoji: "🖼", color: "orange", aliases: ["ai", "design", "review", "디자인리뷰프로토콜"] },
                    translate_ko_to_aromanian: { title: "AI · 한 → 아루마니아 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "aromanian", "아루마니아"] },
                    customer_data_retention_change_email_ko: { title: "AI · 데이터 보관 변경 안내 (한)", emoji: "🗄", color: "gray", aliases: ["ai", "retention", "change", "보관변경"] },
                    translate_ko_to_galician_variant: { title: "AI · 한 → 갈리시아 (변형)", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "galv", "갈리변형"] },
                    customer_implementation_lessons_doc_ko: { title: "AI · 구현 학습 내부 문서 (한)", emoji: "📒", color: "green", aliases: ["ai", "lessons", "implementation", "구현학습"] },
                    translate_ko_to_asturian: { title: "AI · 한 → 아스투리아 번역", emoji: "🇪🇸", color: "yellow", aliases: ["ai", "translate", "asturian", "아스투리아"] },
                    internal_pm_eng_sprint_planning_ko: { title: "AI · PM-Eng 스프린트 계획 (한)", emoji: "🏃", color: "blue", aliases: ["ai", "sprint", "planning", "스프린트계획"] },
                    translate_ko_to_aragonese: { title: "AI · 한 → 아라곤 번역", emoji: "🇪🇸", color: "red", aliases: ["ai", "translate", "aragonese", "아라곤"] },
                    customer_renewal_handoff_email_ko: { title: "AI · 갱신 인계 메일 (한)", emoji: "🤝", color: "blue", aliases: ["ai", "renewal", "handoff", "갱신인계"] },
                    translate_ko_to_leonese: { title: "AI · 한 → 레오네스 번역", emoji: "🇪🇸", color: "blue", aliases: ["ai", "translate", "leonese", "레오네스"] },
                    internal_eng_release_train_doc_ko: { title: "AI · 엔지 release train (한)", emoji: "🚂", color: "blue", aliases: ["ai", "release", "train", "릴리스트레인"] },
                    translate_ko_to_extremaduran: { title: "AI · 한 → 엑스트레마두라 번역", emoji: "🇪🇸", color: "green", aliases: ["ai", "translate", "extremaduran", "엑스트레"] },
                    customer_implementation_lessons_external_blog_ko: { title: "AI · 구현 학습 외부 블로그 (한)", emoji: "📰", color: "green", aliases: ["ai", "lessons", "blog", "구현학습블로그"] },
                    translate_ko_to_sardinian: { title: "AI · 한 → 사르데냐 번역", emoji: "🇮🇹", color: "yellow", aliases: ["ai", "translate", "sardinian", "사르데냐"] },
                    customer_renewal_thank_you_call_script_ko: { title: "AI · 갱신 감사 콜 (한)", emoji: "📞", color: "green", aliases: ["ai", "renewal", "thanks", "갱신감사콜"] },
                    translate_ko_to_corsican: { title: "AI · 한 → 코르시카 번역", emoji: "🇫🇷", color: "blue", aliases: ["ai", "translate", "corsican", "코르시카"] },
                    internal_eng_tech_debt_register_ko: { title: "AI · 테크 부채 레지스터 (한)", emoji: "🧾", color: "gray", aliases: ["ai", "techdebt", "register", "테크부채"] },
                    translate_ko_to_friulian: { title: "AI · 한 → 프리울리 번역", emoji: "🇮🇹", color: "red", aliases: ["ai", "translate", "friulian", "프리울리"] },
                    customer_renewal_lost_winback_plan_ko: { title: "AI · 갱신 실패 winback 플랜 (한)", emoji: "🔄", color: "blue", aliases: ["ai", "winback", "lost", "winback플랜"] },
                    translate_ko_to_ladin: { title: "AI · 한 → 라딘 번역", emoji: "🇮🇹", color: "green", aliases: ["ai", "translate", "ladin", "라딘"] },
                    internal_pm_feature_prioritization_ko: { title: "AI · 기능 우선순위 프레임 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "prioritization", "feature", "우선순위프레임"] },
                    translate_ko_to_romansh_sursilvan: { title: "AI · 한 → 로만시 (Sursilvan)", emoji: "🇨🇭", color: "red", aliases: ["ai", "translate", "sursilvan", "수르실반"] },
                    customer_qbr_deck_outline_detailed_ko: { title: "AI · QBR 덱 상세 아웃라인 (한)", emoji: "🖥", color: "blue", aliases: ["ai", "qbr", "deck", "QBR덱"] },
                    translate_ko_to_romansh_vallader: { title: "AI · 한 → 로만시 (Vallader)", emoji: "🇨🇭", color: "red", aliases: ["ai", "translate", "vallader", "발라더"] },
                    customer_renewal_save_email_ko: { title: "AI · 갱신 save 메일 (한)", emoji: "🛟", color: "red", aliases: ["ai", "renewal", "save", "갱신세이브"] },
                    translate_ko_to_romansh_puter: { title: "AI · 한 → 로만시 (Puter)", emoji: "🇨🇭", color: "blue", aliases: ["ai", "translate", "puter", "푸터"] },
                    internal_eng_incident_severity_doc_ko: { title: "AI · 사고 심각도 정의 (한)", emoji: "🚦", color: "red", aliases: ["ai", "incident", "severity", "심각도"] },
                    translate_ko_to_romansh_surmiran: { title: "AI · 한 → 로만시 (Surmiran)", emoji: "🇨🇭", color: "yellow", aliases: ["ai", "translate", "surmiran", "수르미란"] },
                    customer_quarterly_value_report_ko: { title: "AI · 분기 가치 리포트 (한)", emoji: "📈", color: "green", aliases: ["ai", "value", "report", "가치리포트"] },
                    translate_ko_to_romansh_sutsilvan: { title: "AI · 한 → 로만시 (Sutsilvan)", emoji: "🇨🇭", color: "green", aliases: ["ai", "translate", "sutsilvan", "수트실반"] },
                    internal_pm_user_feedback_triage_ko: { title: "AI · 피드백 triage 프로세스 (한)", emoji: "🗂", color: "purple", aliases: ["ai", "feedback", "triage", "피드백triage"] },
                    translate_ko_to_griko: { title: "AI · 한 → 그리코 번역", emoji: "🇮🇹", color: "blue", aliases: ["ai", "translate", "griko", "그리코"] },
                    customer_expansion_business_case_ko: { title: "AI · 확장 비즈니스 케이스 (한)", emoji: "💼", color: "green", aliases: ["ai", "expansion", "businesscase", "확장케이스"] },
                    translate_ko_to_griko_calabrian: { title: "AI · 한 → 칼라브리아 그리스", emoji: "🇮🇹", color: "blue", aliases: ["ai", "translate", "grikoc", "칼라브그리"] },
                    customer_health_qbr_combined_doc_ko: { title: "AI · 헬스+QBR 통합 문서 (한)", emoji: "🩺", color: "blue", aliases: ["ai", "health", "qbr", "헬스QBR"] },
                    translate_ko_to_arberesh: { title: "AI · 한 → 아르버레시 번역", emoji: "🇮🇹", color: "red", aliases: ["ai", "translate", "arberesh", "아르버레시"] },
                    internal_eng_slo_definition_doc_ko: { title: "AI · SLO 정의 문서 (한)", emoji: "📏", color: "blue", aliases: ["ai", "slo", "definition", "SLO정의"] },
                    translate_ko_to_cimbrian: { title: "AI · 한 → 침브리 번역", emoji: "🇮🇹", color: "green", aliases: ["ai", "translate", "cimbrian", "침브리"] },
                    customer_renewal_multi_year_proposal_ko: { title: "AI · 다년 갱신 제안 (한)", emoji: "📆", color: "green", aliases: ["ai", "renewal", "multiyear", "다년갱신"] },
                    translate_ko_to_mocheno: { title: "AI · 한 → 모케노 번역", emoji: "🇮🇹", color: "yellow", aliases: ["ai", "translate", "mocheno", "모케노"] },
                    internal_pm_metric_definition_doc_ko: { title: "AI · 제품 메트릭 정의 (한)", emoji: "⭐", color: "purple", aliases: ["ai", "metric", "definition", "메트릭정의"] },
                    translate_ko_to_walser: { title: "AI · 한 → 발저 독일어", emoji: "🏔", color: "red", aliases: ["ai", "translate", "walser", "발저"] },
                    customer_executive_business_review_agenda_ko: { title: "AI · EBR 어젠다 (한)", emoji: "🏛", color: "blue", aliases: ["ai", "ebr", "executive", "EBR어젠다"] },
                    translate_ko_to_gagauz: { title: "AI · 한 → 가가우즈 번역", emoji: "🇲🇩", color: "blue", aliases: ["ai", "translate", "gagauz", "가가우즈"] },
                    customer_renewal_executive_email_ko: { title: "AI · 갱신 임원 메일 (한)", emoji: "👔", color: "blue", aliases: ["ai", "renewal", "exec", "갱신임원"] },
                    translate_ko_to_crimean_tatar: { title: "AI · 한 → 크림 타타르 번역", emoji: "🏴", color: "yellow", aliases: ["ai", "translate", "crimeantatar", "크림타타르"] },
                    internal_eng_capacity_quarterly_review_ko: { title: "AI · 엔지 capacity 분기 리뷰 (한)", emoji: "📊", color: "blue", aliases: ["ai", "capacity", "review", "capacity리뷰"] },
                    translate_ko_to_karaim: { title: "AI · 한 → 카라임 번역", emoji: "🏴", color: "red", aliases: ["ai", "translate", "karaim", "카라임"] },
                    customer_account_plan_doc_ko: { title: "AI · 어카운트 플랜 (한)", emoji: "🗺", color: "purple", aliases: ["ai", "account", "plan", "어카운트플랜"] },
                    translate_ko_to_krymchak: { title: "AI · 한 → 크림차크 번역", emoji: "🏴", color: "green", aliases: ["ai", "translate", "krymchak", "크림차크"] },
                    internal_pm_launch_readiness_doc_ko: { title: "AI · 런칭 준비 문서 (한)", emoji: "🚀", color: "blue", aliases: ["ai", "launch", "readiness", "런칭준비"] },
                    translate_ko_to_urum: { title: "AI · 한 → 우룸 번역", emoji: "🏴", color: "blue", aliases: ["ai", "translate", "urum", "우룸"] },
                    customer_value_realization_plan_ko: { title: "AI · 가치 실현 플랜 (한)", emoji: "🎯", color: "green", aliases: ["ai", "value", "realization", "가치실현"] },
                    translate_ko_to_chuukese: { title: "AI · 한 → 추크 번역", emoji: "🇫🇲", color: "blue", aliases: ["ai", "translate", "chuukese", "추크"] },
                    customer_renewal_internal_brief_ko: { title: "AI · 갱신 내부 브리프 (한)", emoji: "📋", color: "blue", aliases: ["ai", "renewal", "brief", "갱신브리프"] },
                    translate_ko_to_marshallese: { title: "AI · 한 → 마셜 번역", emoji: "🇲🇭", color: "blue", aliases: ["ai", "translate", "marshallese", "마셜"] },
                    internal_eng_deploy_checklist_ko: { title: "AI · 배포 체크리스트 (한)", emoji: "✅", color: "green", aliases: ["ai", "deploy", "checklist", "배포체크"] },
                    translate_ko_to_palauan: { title: "AI · 한 → 팔라우 번역", emoji: "🇵🇼", color: "blue", aliases: ["ai", "translate", "palauan", "팔라우"] },
                    customer_onboarding_plan_30_60_90_ko: { title: "AI · 온보딩 30/60/90 (한)", emoji: "🗓", color: "blue", aliases: ["ai", "onboarding", "306090", "온보딩계획"] },
                    translate_ko_to_chamorro: { title: "AI · 한 → 차모로 번역", emoji: "🇬🇺", color: "yellow", aliases: ["ai", "translate", "chamorro", "차모로"] },
                    internal_pm_beta_program_doc_ko: { title: "AI · 베타 프로그램 문서 (한)", emoji: "🧪", color: "purple", aliases: ["ai", "beta", "program", "베타프로그램"] },
                    translate_ko_to_fijian: { title: "AI · 한 → 피지 번역", emoji: "🇫🇯", color: "blue", aliases: ["ai", "translate", "fijian", "피지"] },
                    customer_win_story_internal_ko: { title: "AI · 고객 win 스토리 (한)", emoji: "🏆", color: "yellow", aliases: ["ai", "win", "story", "win스토리"] },
                    translate_ko_to_tongan: { title: "AI · 한 → 통가 번역", emoji: "🇹🇴", color: "red", aliases: ["ai", "translate", "tongan", "통가"] },
                    customer_renewal_qbr_combined_email_ko: { title: "AI · 갱신+QBR 초대 (한)", emoji: "📅", color: "blue", aliases: ["ai", "renewal", "qbr", "갱신QBR초대"] },
                    translate_ko_to_samoan: { title: "AI · 한 → 사모아 번역", emoji: "🇼🇸", color: "blue", aliases: ["ai", "translate", "samoan", "사모아"] },
                    internal_eng_code_review_guide_ko: { title: "AI · 코드 리뷰 가이드 (한)", emoji: "👀", color: "green", aliases: ["ai", "codereview", "guide", "코드리뷰"] },
                    translate_ko_to_tahitian: { title: "AI · 한 → 타히티 번역", emoji: "🇵🇫", color: "blue", aliases: ["ai", "translate", "tahitian", "타히티"] },
                    customer_business_case_template_ko: { title: "AI · 고객 비즈니스 케이스 (한)", emoji: "💼", color: "purple", aliases: ["ai", "businesscase", "customer", "고객케이스"] },
                    translate_ko_to_maori: { title: "AI · 한 → 마오리 번역", emoji: "🇳🇿", color: "red", aliases: ["ai", "translate", "maori", "마오리"] },
                    internal_pm_competitive_teardown_ko: { title: "AI · 경쟁 teardown (한)", emoji: "🔍", color: "gray", aliases: ["ai", "competitive", "teardown", "경쟁teardown"] },
                    translate_ko_to_hawaiian: { title: "AI · 한 → 하와이 번역", emoji: "🌺", color: "green", aliases: ["ai", "translate", "hawaiian", "하와이"] },
                    customer_quarterly_check_in_call_ko: { title: "AI · 분기 체크인 콜 (한)", emoji: "📞", color: "blue", aliases: ["ai", "checkin", "call", "분기체크인콜"] },
                    translate_ko_to_tetum: { title: "AI · 한 → 테툼 번역", emoji: "🇹🇱", color: "red", aliases: ["ai", "translate", "tetum", "테툼"] },
                    customer_renewal_at_risk_internal_alert_ko: { title: "AI · 갱신 위험 알림 (한)", emoji: "🚨", color: "red", aliases: ["ai", "atrisk", "alert", "갱신위험알림"] },
                    translate_ko_to_bislama: { title: "AI · 한 → 비슬라마 번역", emoji: "🇻🇺", color: "green", aliases: ["ai", "translate", "bislama", "비슬라마"] },
                    internal_eng_branching_strategy_doc_ko: { title: "AI · 브랜칭 전략 (한)", emoji: "🌿", color: "green", aliases: ["ai", "branching", "git", "브랜칭"] },
                    translate_ko_to_tok_pisin: { title: "AI · 한 → 톡피신 번역", emoji: "🇵🇬", color: "yellow", aliases: ["ai", "translate", "tokpisin", "톡피신"] },
                    customer_quarterly_data_share_ko: { title: "AI · 분기 데이터 공유 (한)", emoji: "📊", color: "blue", aliases: ["ai", "data", "share", "데이터공유"] },
                    translate_ko_to_hiri_motu: { title: "AI · 한 → 히리모투 번역", emoji: "🇵🇬", color: "red", aliases: ["ai", "translate", "hirimotu", "히리모투"] },
                    internal_pm_roadmap_communication_ko: { title: "AI · 로드맵 소통 문서 (한)", emoji: "🗺", color: "purple", aliases: ["ai", "roadmap", "communication", "로드맵소통"] },
                    translate_ko_to_nauruan: { title: "AI · 한 → 나우루 번역", emoji: "🇳🇷", color: "blue", aliases: ["ai", "translate", "nauruan", "나우루"] },
                    customer_advocacy_case_study_outline_ko: { title: "AI · advocacy 사례 outline (한)", emoji: "📰", color: "green", aliases: ["ai", "advocacy", "casestudy", "advocacy사례"] },
                    translate_ko_to_greenlandic: { title: "AI · 한 → 그린란드 번역", emoji: "🇬🇱", color: "red", aliases: ["ai", "translate", "greenlandic", "그린란드"] },
                    customer_renewal_won_internal_ko: { title: "AI · 갱신 won 공유 (한)", emoji: "🎉", color: "green", aliases: ["ai", "renewal", "won", "갱신won"] },
                    translate_ko_to_inuktitut: { title: "AI · 한 → 이누이트 번역", emoji: "🇨🇦", color: "blue", aliases: ["ai", "translate", "inuktitut", "이누이트"] },
                    internal_eng_testing_strategy_doc_ko: { title: "AI · 테스트 전략 문서 (한)", emoji: "🧪", color: "green", aliases: ["ai", "testing", "strategy", "테스트전략"] },
                    translate_ko_to_cree: { title: "AI · 한 → 크리 번역", emoji: "🇨🇦", color: "yellow", aliases: ["ai", "translate", "cree", "크리"] },
                    customer_quarterly_recap_internal_ko: { title: "AI · 분기 portfolio 회고 (한)", emoji: "📊", color: "blue", aliases: ["ai", "quarterly", "recap", "분기회고"] },
                    translate_ko_to_ojibwe: { title: "AI · 한 → 오지브웨 번역", emoji: "🇨🇦", color: "green", aliases: ["ai", "translate", "ojibwe", "오지브웨"] },
                    internal_pm_experiment_design_doc_ko: { title: "AI · 실험 설계 문서 (한)", emoji: "🔬", color: "purple", aliases: ["ai", "experiment", "design", "실험설계"] },
                    translate_ko_to_navajo: { title: "AI · 한 → 나바호 번역", emoji: "🇺🇸", color: "red", aliases: ["ai", "translate", "navajo", "나바호"] },
                    customer_renewal_summary_finance_ko: { title: "AI · 갱신 Finance 요약 (한)", emoji: "🧾", color: "gray", aliases: ["ai", "renewal", "finance", "갱신finance"] },
                    translate_ko_to_quechua: { title: "AI · 한 → 케추아 번역", emoji: "🏔", color: "yellow", aliases: ["ai", "translate", "quechua", "케추아"] },
                    customer_renewal_recap_exec_ko: { title: "AI · 갱신 임원 회고 (한)", emoji: "👔", color: "blue", aliases: ["ai", "renewal", "exec", "갱신회고"] },
                    translate_ko_to_aymara: { title: "AI · 한 → 아이마라 번역", emoji: "🏔", color: "red", aliases: ["ai", "translate", "aymara", "아이마라"] },
                    internal_eng_observability_doc_ko: { title: "AI · 옵저버빌리티 문서 (한)", emoji: "🔭", color: "blue", aliases: ["ai", "observability", "monitoring", "옵저버빌리티"] },
                    translate_ko_to_guarani: { title: "AI · 한 → 과라니 번역", emoji: "🇵🇾", color: "green", aliases: ["ai", "translate", "guarani", "과라니"] },
                    customer_health_weekly_digest_ko: { title: "AI · 헬스 주간 다이제스트 (한)", emoji: "📋", color: "blue", aliases: ["ai", "health", "digest", "헬스다이제스트"] },
                    translate_ko_to_nahuatl: { title: "AI · 한 → 나우아틀 번역", emoji: "🇲🇽", color: "green", aliases: ["ai", "translate", "nahuatl", "나우아틀"] },
                    internal_pm_quarterly_review_doc_ko: { title: "AI · PM 분기 리뷰 (한)", emoji: "📊", color: "purple", aliases: ["ai", "pm", "review", "PM분기리뷰"] },
                    translate_ko_to_mapudungun: { title: "AI · 한 → 마푸체 번역", emoji: "🇨🇱", color: "blue", aliases: ["ai", "translate", "mapudungun", "마푸체"] },
                    customer_kickoff_recap_email_ko: { title: "AI · 킥오프 정리 메일 (한)", emoji: "📩", color: "blue", aliases: ["ai", "kickoff", "recap", "킥오프정리"] },
                    translate_ko_to_haitian_creole: { title: "AI · 한 → 아이티 크리올", emoji: "🇭🇹", color: "blue", aliases: ["ai", "translate", "haitian", "아이티"] },
                    customer_renewal_close_plan_ko: { title: "AI · 갱신 close 플랜 (한)", emoji: "🎯", color: "blue", aliases: ["ai", "renewal", "close", "갱신close"] },
                    translate_ko_to_jamaican_patois: { title: "AI · 한 → 자메이카 파트와", emoji: "🇯🇲", color: "green", aliases: ["ai", "translate", "patois", "파트와"] },
                    internal_eng_dependency_management_doc_ko: { title: "AI · 의존성 관리 문서 (한)", emoji: "📦", color: "gray", aliases: ["ai", "dependency", "management", "의존성"] },
                    translate_ko_to_seychellois_creole: { title: "AI · 한 → 세이셸 크리올", emoji: "🇸🇨", color: "blue", aliases: ["ai", "translate", "seselwa", "세이셸"] },
                    customer_quarterly_exec_email_ko: { title: "AI · 분기 임원 안부 (한)", emoji: "👔", color: "blue", aliases: ["ai", "quarterly", "exec", "분기임원"] },
                    translate_ko_to_mauritian_creole: { title: "AI · 한 → 모리셔스 크리올", emoji: "🇲🇺", color: "red", aliases: ["ai", "translate", "morisien", "모리셔스"] },
                    internal_pm_north_star_doc_ko: { title: "AI · North Star 문서 (한)", emoji: "⭐", color: "purple", aliases: ["ai", "northstar", "metric", "노스스타"] },
                    translate_ko_to_cape_verdean_creole: { title: "AI · 한 → 카보베르데 크리올", emoji: "🇨🇻", color: "blue", aliases: ["ai", "translate", "kriolu", "카보베르데"] },
                    customer_success_plan_annual_ko: { title: "AI · 연간 성공 플랜 (한)", emoji: "🗓", color: "green", aliases: ["ai", "success", "annual", "연간성공"] },
                    translate_ko_to_papuan_malay: { title: "AI · 한 → 파푸아 말레이", emoji: "🇮🇩", color: "red", aliases: ["ai", "translate", "papuanmalay", "파푸아말레이"] },
                    customer_renewal_negotiation_summary_ko: { title: "AI · 갱신 협상 요약 (한)", emoji: "🤝", color: "blue", aliases: ["ai", "renewal", "negotiation", "협상요약"] },
                    translate_ko_to_ambonese_malay: { title: "AI · 한 → 암본 말레이", emoji: "🇮🇩", color: "yellow", aliases: ["ai", "translate", "ambonese", "암본"] },
                    internal_eng_secrets_management_doc_ko: { title: "AI · 시크릿 관리 문서 (한)", emoji: "🔐", color: "red", aliases: ["ai", "secrets", "management", "시크릿관리"] },
                    translate_ko_to_betawi: { title: "AI · 한 → 베타위 번역", emoji: "🇮🇩", color: "blue", aliases: ["ai", "translate", "betawi", "베타위"] },
                    customer_qbr_followup_email_ko: { title: "AI · QBR 후속 메일 (한)", emoji: "📩", color: "blue", aliases: ["ai", "qbr", "followup", "QBR후속"] },
                    translate_ko_to_minangkabau: { title: "AI · 한 → 미낭카바우 번역", emoji: "🇮🇩", color: "green", aliases: ["ai", "translate", "minangkabau", "미낭카바우"] },
                    internal_pm_discovery_doc_ko: { title: "AI · 제품 디스커버리 (한)", emoji: "🔎", color: "purple", aliases: ["ai", "discovery", "product", "디스커버리"] },
                    translate_ko_to_sundanese: { title: "AI · 한 → 순다 번역", emoji: "🇮🇩", color: "yellow", aliases: ["ai", "translate", "sundanese", "순다"] },
                    customer_success_review_internal_ko: { title: "AI · 고객 성공 리뷰 내부 (한)", emoji: "🔬", color: "blue", aliases: ["ai", "success", "review", "성공리뷰"] },
                    translate_ko_to_javanese: { title: "AI · 한 → 자바 번역", emoji: "🇮🇩", color: "red", aliases: ["ai", "translate", "javanese", "자바"] },
                    customer_executive_sponsor_intro_ko: { title: "AI · Exec sponsor 인사 (한)", emoji: "👔", color: "blue", aliases: ["ai", "sponsor", "exec", "스폰서인사"] },
                    translate_ko_to_balinese: { title: "AI · 한 → 발리 번역", emoji: "🇮🇩", color: "yellow", aliases: ["ai", "translate", "balinese", "발리"] },
                    internal_eng_feature_flag_doc_ko: { title: "AI · 피처 플래그 문서 (한)", emoji: "🚩", color: "green", aliases: ["ai", "featureflag", "flag", "피처플래그"] },
                    translate_ko_to_madurese: { title: "AI · 한 → 마두라 번역", emoji: "🇮🇩", color: "blue", aliases: ["ai", "translate", "madurese", "마두라"] },
                    customer_renewal_lost_exec_summary_ko: { title: "AI · 갱신 실패 임원 요약 (한)", emoji: "📉", color: "red", aliases: ["ai", "lost", "exec", "실패요약"] },
                    translate_ko_to_acehnese: { title: "AI · 한 → 아체 번역", emoji: "🇮🇩", color: "green", aliases: ["ai", "translate", "acehnese", "아체"] },
                    internal_pm_user_persona_doc_ko: { title: "AI · 사용자 페르소나 (한)", emoji: "🧑", color: "purple", aliases: ["ai", "persona", "user", "페르소나"] },
                    translate_ko_to_buginese: { title: "AI · 한 → 부기 번역", emoji: "🇮🇩", color: "red", aliases: ["ai", "translate", "buginese", "부기"] },
                    customer_quarterly_nps_followup_ko: { title: "AI · 분기 NPS 후속 (한)", emoji: "📊", color: "blue", aliases: ["ai", "nps", "followup", "NPS후속"] },
                    translate_ko_to_cebuano: { title: "AI · 한 → 세부아노 번역", emoji: "🇵🇭", color: "blue", aliases: ["ai", "translate", "cebuano", "세부아노"] },
                    customer_renewal_pipeline_report_ko: { title: "AI · 갱신 파이프라인 리포트 (한)", emoji: "🪈", color: "blue", aliases: ["ai", "renewal", "pipeline", "갱신파이프"] },
                    translate_ko_to_hiligaynon: { title: "AI · 한 → 일롱고 번역", emoji: "🇵🇭", color: "yellow", aliases: ["ai", "translate", "hiligaynon", "일롱고"] },
                    internal_eng_database_migration_doc_ko: { title: "AI · DB 마이그레이션 문서 (한)", emoji: "🗃", color: "red", aliases: ["ai", "migration", "database", "DB마이그"] },
                    translate_ko_to_waray: { title: "AI · 한 → 와라이 번역", emoji: "🇵🇭", color: "green", aliases: ["ai", "translate", "waray", "와라이"] },
                    customer_quarterly_qbr_prep_internal_ko: { title: "AI · QBR 내부 준비 (한)", emoji: "📋", color: "blue", aliases: ["ai", "qbr", "prep", "QBR준비"] },
                    translate_ko_to_kapampangan: { title: "AI · 한 → 카팜팡안 번역", emoji: "🇵🇭", color: "red", aliases: ["ai", "translate", "kapampangan", "카팜팡안"] },
                    internal_pm_okr_retro_doc_ko: { title: "AI · OKR 회고 문서 (한)", emoji: "🔁", color: "purple", aliases: ["ai", "okr", "retro", "OKR회고"] },
                    translate_ko_to_bikol: { title: "AI · 한 → 비콜 번역", emoji: "🇵🇭", color: "yellow", aliases: ["ai", "translate", "bikol", "비콜"] },
                    customer_value_story_one_pager_ko: { title: "AI · 가치 스토리 1pg (한)", emoji: "📄", color: "green", aliases: ["ai", "value", "onepager", "가치스토리"] },
                    translate_ko_to_pangasinan: { title: "AI · 한 → 팡가시난 번역", emoji: "🇵🇭", color: "blue", aliases: ["ai", "translate", "pangasinan", "팡가시난"] },
                    customer_renewal_executive_summary_won_ko: { title: "AI · 갱신 임원 요약 won (한)", emoji: "🏆", color: "green", aliases: ["ai", "renewal", "execsummary", "갱신임원요약"] },
                    translate_ko_to_ilocano: { title: "AI · 한 → 일로카노 번역", emoji: "🇵🇭", color: "yellow", aliases: ["ai", "translate", "ilocano", "일로카노"] },
                    internal_eng_api_design_guide_ko: { title: "AI · API 설계 가이드 (한)", emoji: "🔌", color: "blue", aliases: ["ai", "api", "design", "API설계"] },
                    translate_ko_to_maranao: { title: "AI · 한 → 마라나오 번역", emoji: "🇵🇭", color: "green", aliases: ["ai", "translate", "maranao", "마라나오"] },
                    customer_health_escalation_doc_ko: { title: "AI · 고객 헬스 에스컬레이션 (한)", emoji: "🚨", color: "red", aliases: ["ai", "health", "escalation", "헬스에스컬"] },
                    translate_ko_to_tausug: { title: "AI · 한 → 타우수그 번역", emoji: "🇵🇭", color: "red", aliases: ["ai", "translate", "tausug", "타우수그"] },
                    internal_pm_competitive_positioning_doc_ko: { title: "AI · 경쟁 포지셔닝 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "competitive", "positioning", "포지셔닝"] },
                    translate_ko_to_maguindanao: { title: "AI · 한 → 마긴다나오 번역", emoji: "🇵🇭", color: "green", aliases: ["ai", "translate", "maguindanao", "마긴다나오"] },
                    customer_renewal_celebration_internal_ko: { title: "AI · 갱신 자축 사내 (한)", emoji: "🎉", color: "yellow", aliases: ["ai", "renewal", "celebration", "갱신자축"] },
                    translate_ko_to_chavacano: { title: "AI · 한 → 차바카노 번역", emoji: "🇵🇭", color: "red", aliases: ["ai", "translate", "chavacano", "차바카노"] },
                    customer_renewal_forecast_doc_ko: { title: "AI · 갱신 forecast 문서 (한)", emoji: "🔮", color: "blue", aliases: ["ai", "renewal", "forecast", "갱신forecast"] },
                    translate_ko_to_kankanaey: { title: "AI · 한 → 칸카나이 번역", emoji: "🇵🇭", color: "green", aliases: ["ai", "translate", "kankanaey", "칸카나이"] },
                    internal_eng_performance_optimization_doc_ko: { title: "AI · 성능 최적화 문서 (한)", emoji: "⚡", color: "yellow", aliases: ["ai", "performance", "optimization", "성능최적화"] },
                    translate_ko_to_ibanag: { title: "AI · 한 → 이바나그 번역", emoji: "🇵🇭", color: "blue", aliases: ["ai", "translate", "ibanag", "이바나그"] },
                    customer_qbr_executive_summary_ko: { title: "AI · QBR 임원 요약 (한)", emoji: "📄", color: "blue", aliases: ["ai", "qbr", "execsummary", "QBR임원요약"] },
                    translate_ko_to_ivatan: { title: "AI · 한 → 이바탄 번역", emoji: "🇵🇭", color: "yellow", aliases: ["ai", "translate", "ivatan", "이바탄"] },
                    internal_pm_release_planning_doc_ko: { title: "AI · 릴리스 계획 문서 (한)", emoji: "🚀", color: "purple", aliases: ["ai", "release", "planning", "릴리스계획"] },
                    translate_ko_to_sambal: { title: "AI · 한 → 삼발 번역", emoji: "🇵🇭", color: "red", aliases: ["ai", "translate", "sambal", "삼발"] },
                    customer_annual_review_letter_ko: { title: "AI · 연간 리뷰 편지 (한)", emoji: "📜", color: "green", aliases: ["ai", "annual", "letter", "연간편지"] },
                    c_series_completion_announcement_ko: { title: "AI · 이니셔티브 완료 발표 (한)", emoji: "🎊", color: "purple", aliases: ["ai", "completion", "announcement", "완료발표"] },
                    full_milestone_celebration_ko: { title: "AI · 마일스톤 회고 자축 (한)", emoji: "🏁", color: "green", aliases: ["ai", "milestone", "celebration", "마일스톤회고"] },
                    translate_ko_to_shona: { title: "AI · 쇼나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "shona", "쇼나"] },
                    translate_ko_to_sotho: { title: "AI · 세소토어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "sotho", "세소토"] },
                    translate_ko_to_tswana: { title: "AI · 츠와나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tswana", "츠와나"] },
                    translate_ko_to_tsonga: { title: "AI · 총가어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tsonga", "총가"] },
                    translate_ko_to_venda: { title: "AI · 벤다어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "venda", "벤다"] },
                    customer_health_score_review_ko: { title: "AI · 고객 헬스 스코어 리뷰 (한)", emoji: "🩺", color: "green", aliases: ["ai", "health", "csm", "헬스스코어"] },
                    internal_incident_retro_ko: { title: "AI · 인시던트 포스트모템 (한)", emoji: "🚨", color: "red", aliases: ["ai", "incident", "postmortem", "포스트모템"] },
                    sales_discovery_call_notes_ko: { title: "AI · 디스커버리 콜 노트 (한)", emoji: "📞", color: "blue", aliases: ["ai", "discovery", "sales", "디스커버리"] },
                    product_beta_feedback_summary_ko: { title: "AI · 베타 피드백 요약 (한)", emoji: "🧪", color: "purple", aliases: ["ai", "beta", "feedback", "베타피드백"] },
                    internal_hiring_scorecard_ko: { title: "AI · 인터뷰 스코어카드 (한)", emoji: "📋", color: "yellow", aliases: ["ai", "hiring", "scorecard", "스코어카드"] },
                    translate_ko_to_ndebele: { title: "AI · 은데벨레어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ndebele", "은데벨레"] },
                    translate_ko_to_swati: { title: "AI · 스와티어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "swati", "스와티"] },
                    translate_ko_to_chichewa: { title: "AI · 치체와어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "chichewa", "치체와"] },
                    translate_ko_to_bemba: { title: "AI · 벰바어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bemba", "벰바"] },
                    translate_ko_to_kinyarwanda: { title: "AI · 키냐르완다어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kinyarwanda", "키냐르완다"] },
                    gtm_campaign_brief_ko: { title: "AI · GTM 캠페인 브리프 (한)", emoji: "📣", color: "yellow", aliases: ["ai", "gtm", "campaign", "지티엠캠페인"] },
                    internal_okr_checkin_ko: { title: "AI · OKR 체크인 (한)", emoji: "🎯", color: "blue", aliases: ["ai", "okr", "checkin", "오케이알"] },
                    customer_churn_analysis_ko: { title: "AI · 고객 이탈 분석 (한)", emoji: "📉", color: "red", aliases: ["ai", "churn", "analysis", "이탈분석"] },
                    eng_design_doc_ko: { title: "AI · 엔지니어링 설계 문서 (한)", emoji: "📐", color: "purple", aliases: ["ai", "design", "rfc", "설계문서"] },
                    internal_team_offsite_agenda_ko: { title: "AI · 팀 오프사이트 아젠다 (한)", emoji: "🏕️", color: "green", aliases: ["ai", "offsite", "agenda", "오프사이트"] },
                    translate_ko_to_kirundi: { title: "AI · 키룬디어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kirundi", "키룬디"] },
                    translate_ko_to_luganda: { title: "AI · 루간다어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "luganda", "루간다"] },
                    translate_ko_to_kikuyu: { title: "AI · 키쿠유어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kikuyu", "키쿠유"] },
                    translate_ko_to_luo: { title: "AI · 루오어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "luo", "루오"] },
                    translate_ko_to_wolof: { title: "AI · 월로프어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "wolof", "월로프"] },
                    sales_qbr_deck_outline_ko: { title: "AI · QBR 덱 아웃라인 (한)", emoji: "📊", color: "blue", aliases: ["ai", "qbr", "deck", "큐비알"] },
                    internal_postmortem_action_tracker_ko: { title: "AI · 포스트모템 액션 트래커 (한)", emoji: "✅", color: "red", aliases: ["ai", "postmortem", "tracker", "액션트래커"] },
                    customer_adoption_plan_ko: { title: "AI · 고객 채택 플랜 (한)", emoji: "📈", color: "green", aliases: ["ai", "adoption", "plan", "채택플랜"] },
                    pm_feature_spec_ko: { title: "AI · 기능 스펙 (한)", emoji: "📝", color: "purple", aliases: ["ai", "feature", "spec", "기능스펙"] },
                    internal_perf_review_self_ko: { title: "AI · 자기평가 (성과 리뷰) (한)", emoji: "🪞", color: "yellow", aliases: ["ai", "review", "self", "자기평가"] },
                    translate_ko_to_twi: { title: "AI · 트위어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "twi", "트위"] },
                    translate_ko_to_ewe: { title: "AI · 에웨어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ewe", "에웨"] },
                    translate_ko_to_ga: { title: "AI · 가어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ga", "가어"] },
                    translate_ko_to_fon: { title: "AI · 폰어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "fon", "폰어"] },
                    translate_ko_to_bambara: { title: "AI · 밤바라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bambara", "밤바라"] },
                    exec_business_case_ko: { title: "AI · 경영 비즈니스 케이스 (한)", emoji: "💼", color: "blue", aliases: ["ai", "business", "case", "비즈니스케이스"] },
                    internal_sprint_retro_ko: { title: "AI · 스프린트 회고 (한)", emoji: "🔁", color: "green", aliases: ["ai", "sprint", "retro", "스프린트회고"] },
                    customer_escalation_summary_ko: { title: "AI · 고객 에스컬레이션 요약 (한)", emoji: "⚠️", color: "red", aliases: ["ai", "escalation", "summary", "에스컬레이션"] },
                    pm_competitive_teardown_ko: { title: "AI · 경쟁사 분해 분석 (한)", emoji: "🔍", color: "purple", aliases: ["ai", "competitive", "teardown", "경쟁분석"] },
                    internal_runbook_ko: { title: "AI · 운영 런북 (한)", emoji: "📒", color: "yellow", aliases: ["ai", "runbook", "ops", "런북"] },
                    translate_ko_to_dyula: { title: "AI · 줄라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "dyula", "줄라"] },
                    translate_ko_to_mossi: { title: "AI · 모시어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mossi", "모시"] },
                    translate_ko_to_susu: { title: "AI · 수수어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "susu", "수수"] },
                    translate_ko_to_krio: { title: "AI · 크리오어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "krio", "크리오"] },
                    translate_ko_to_temne: { title: "AI · 템네어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "temne", "템네"] },
                    internal_decision_record_adr_ko: { title: "AI · ADR 결정 기록 (한)", emoji: "🧱", color: "purple", aliases: ["ai", "adr", "decision", "결정기록"] },
                    sales_mutual_action_plan_ko: { title: "AI · 상호 액션 플랜 MAP (한)", emoji: "🤝", color: "blue", aliases: ["ai", "map", "mutual", "상호액션플랜"] },
                    customer_value_realization_ko: { title: "AI · 가치 실현 요약 (한)", emoji: "💎", color: "green", aliases: ["ai", "value", "realization", "가치실현"] },
                    pm_user_journey_map_ko: { title: "AI · 사용자 여정 맵 (한)", emoji: "🗺️", color: "purple", aliases: ["ai", "journey", "map", "사용자여정"] },
                    internal_capacity_planning_ko: { title: "AI · 캐파 플래닝 (한)", emoji: "📅", color: "yellow", aliases: ["ai", "capacity", "planning", "캐파플래닝"] },
                    translate_ko_to_tigre: { title: "AI · 티그레어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tigre", "티그레"] },
                    translate_ko_to_afar: { title: "AI · 아파르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "afar", "아파르"] },
                    translate_ko_to_saho: { title: "AI · 사호어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "saho", "사호"] },
                    translate_ko_to_beja: { title: "AI · 베자어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "beja", "베자"] },
                    translate_ko_to_nuer: { title: "AI · 누에르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nuer", "누에르"] },
                    internal_weekly_status_ko: { title: "AI · 주간 상태 업데이트 (한)", emoji: "🗓️", color: "blue", aliases: ["ai", "weekly", "status", "주간상태"] },
                    sales_proposal_exec_summary_ko: { title: "AI · 제안서 요약 (한)", emoji: "📄", color: "blue", aliases: ["ai", "proposal", "summary", "제안요약"] },
                    customer_success_plan_ko: { title: "AI · 고객 성공 플랜 (한)", emoji: "🌱", color: "green", aliases: ["ai", "success", "plan", "성공플랜"] },
                    pm_release_notes_external_ko: { title: "AI · 외부 릴리스 노트 (한)", emoji: "📰", color: "purple", aliases: ["ai", "release", "notes", "릴리스노트"] },
                    internal_meeting_notes_ko: { title: "AI · 회의록 정리 (한)", emoji: "🗒️", color: "yellow", aliases: ["ai", "meeting", "notes", "회의록"] },
                    translate_ko_to_dinka: { title: "AI · 딩카어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "dinka", "딩카"] },
                    translate_ko_to_kanuri: { title: "AI · 카누리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kanuri", "카누리"] },
                    translate_ko_to_zarma: { title: "AI · 자르마어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "zarma", "자르마"] },
                    translate_ko_to_maasai: { title: "AI · 마사이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "maasai", "마사이"] },
                    translate_ko_to_turkana: { title: "AI · 투르카나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "turkana", "투르카나"] },
                    internal_tech_spike_summary_ko: { title: "AI · 기술 스파이크 요약 (한)", emoji: "🔬", color: "purple", aliases: ["ai", "spike", "research", "스파이크"] },
                    sales_cold_outreach_sequence_ko: { title: "AI · 콜드 아웃리치 시퀀스 (한)", emoji: "✉️", color: "blue", aliases: ["ai", "outreach", "cold", "콜드아웃리치"] },
                    customer_renewal_followup_email_ko: { title: "AI · 갱신 팔로업 메일 (한)", emoji: "🔄", color: "green", aliases: ["ai", "renewal", "followup", "갱신팔로업"] },
                    pm_prioritization_rice_ko: { title: "AI · RICE 우선순위 (한)", emoji: "🍚", color: "yellow", aliases: ["ai", "rice", "prioritization", "라이스우선순위"] },
                    internal_onboarding_buddy_guide_ko: { title: "AI · 온보딩 버디 가이드 (한)", emoji: "🧑‍🤝‍🧑", color: "green", aliases: ["ai", "onboarding", "buddy", "버디가이드"] },
                    translate_ko_to_lingala: { title: "AI · 링갈라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lingala", "링갈라"] },
                    translate_ko_to_kongo: { title: "AI · 콩고어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kongo", "콩고"] },
                    translate_ko_to_tshiluba: { title: "AI · 칠루바어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tshiluba", "칠루바"] },
                    translate_ko_to_sango: { title: "AI · 상고어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "sango", "상고"] },
                    translate_ko_to_mongo: { title: "AI · 몽고어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mongo", "몽고어"] },
                    internal_kickoff_doc_ko: { title: "AI · 프로젝트 킥오프 (한)", emoji: "🚀", color: "blue", aliases: ["ai", "kickoff", "project", "킥오프"] },
                    sales_battlecard_ko: { title: "AI · 세일즈 배틀카드 (한)", emoji: "⚔️", color: "red", aliases: ["ai", "battlecard", "sales", "배틀카드"] },
                    customer_exec_business_review_ebr_ko: { title: "AI · EBR 임원 리뷰 (한)", emoji: "🏛️", color: "purple", aliases: ["ai", "ebr", "executive", "임원리뷰"] },
                    pm_experiment_design_ko: { title: "AI · A/B 실험 설계 (한)", emoji: "🧫", color: "purple", aliases: ["ai", "experiment", "abtest", "실험설계"] },
                    internal_oncall_handoff_ko: { title: "AI · 온콜 인계 노트 (한)", emoji: "📟", color: "yellow", aliases: ["ai", "oncall", "handoff", "온콜인계"] },
                    translate_ko_to_herero: { title: "AI · 헤레로어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "herero", "헤레로"] },
                    translate_ko_to_nama: { title: "AI · 나마어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nama", "나마"] },
                    translate_ko_to_oshiwambo: { title: "AI · 오시왐보어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "oshiwambo", "오시왐보"] },
                    translate_ko_to_lozi: { title: "AI · 로지어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lozi", "로지"] },
                    translate_ko_to_tonga_zambia: { title: "AI · 통가어(잠비아) 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tonga", "통가"] },
                    internal_change_management_plan_ko: { title: "AI · 변화 관리 플랜 (한)", emoji: "🔧", color: "yellow", aliases: ["ai", "change", "management", "변화관리"] },
                    sales_renewal_risk_assessment_ko: { title: "AI · 갱신 리스크 평가 (한)", emoji: "⚖️", color: "red", aliases: ["ai", "renewal", "risk", "갱신리스크"] },
                    customer_training_plan_ko: { title: "AI · 고객 교육 플랜 (한)", emoji: "🎓", color: "green", aliases: ["ai", "training", "plan", "교육플랜"] },
                    pm_north_star_metric_ko: { title: "AI · 노스스타 지표 정의 (한)", emoji: "⭐", color: "purple", aliases: ["ai", "northstar", "metric", "노스스타"] },
                    internal_quarterly_planning_ko: { title: "AI · 분기 플래닝 (한)", emoji: "📆", color: "blue", aliases: ["ai", "quarterly", "planning", "분기플래닝"] },
                    translate_ko_to_kalanga: { title: "AI · 칼랑가어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kalanga", "칼랑가"] },
                    translate_ko_to_ndau: { title: "AI · 은다우어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ndau", "은다우"] },
                    translate_ko_to_manyika: { title: "AI · 마니카어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "manyika", "마니카"] },
                    translate_ko_to_sena: { title: "AI · 세나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "sena", "세나"] },
                    translate_ko_to_chopi: { title: "AI · 초피어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "chopi", "초피"] },
                    internal_design_critique_notes_ko: { title: "AI · 디자인 크리틱 노트 (한)", emoji: "🎨", color: "purple", aliases: ["ai", "critique", "design", "크리틱"] },
                    sales_account_plan_ko: { title: "AI · 전략 어카운트 플랜 (한)", emoji: "🗂️", color: "blue", aliases: ["ai", "account", "plan", "어카운트플랜"] },
                    customer_voice_of_customer_ko: { title: "AI · VoC 리포트 (한)", emoji: "🗣️", color: "green", aliases: ["ai", "voc", "voice", "고객의소리"] },
                    pm_gtm_launch_plan_ko: { title: "AI · GTM 런치 플랜 (한)", emoji: "🎬", color: "purple", aliases: ["ai", "gtm", "launch", "런치플랜"] },
                    internal_skip_level_prep_ko: { title: "AI · 스킵레벨 준비 (한)", emoji: "🧗", color: "yellow", aliases: ["ai", "skiplevel", "prep", "스킵레벨"] },
                    translate_ko_to_enga: { title: "AI · 엥가어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "enga", "엥가"] },
                    translate_ko_to_huli: { title: "AI · 훌리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "huli", "훌리"] },
                    translate_ko_to_tolai: { title: "AI · 톨라이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tolai", "톨라이"] },
                    translate_ko_to_kuman: { title: "AI · 쿠만어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kuman", "쿠만"] },
                    translate_ko_to_melpa: { title: "AI · 멜파어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "melpa", "멜파"] },
                    internal_brainstorm_summary_ko: { title: "AI · 브레인스토밍 요약 (한)", emoji: "💡", color: "yellow", aliases: ["ai", "brainstorm", "summary", "브레인스토밍"] },
                    sales_win_loss_analysis_ko: { title: "AI · 승패 분석 (한)", emoji: "🏆", color: "blue", aliases: ["ai", "winloss", "analysis", "승패분석"] },
                    customer_qbr_prep_internal_ko: { title: "AI · QBR 내부 준비 (한)", emoji: "📋", color: "green", aliases: ["ai", "qbr", "prep", "큐비알준비"] },
                    pm_feature_flag_rollout_ko: { title: "AI · 피처 플래그 롤아웃 (한)", emoji: "🚩", color: "purple", aliases: ["ai", "flag", "rollout", "피처플래그"] },
                    internal_doc_style_guide_ko: { title: "AI · 문서 스타일 가이드 (한)", emoji: "✒️", color: "yellow", aliases: ["ai", "style", "guide", "스타일가이드"] },
                    translate_ko_to_kosraean: { title: "AI · 코스라에어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kosraean", "코스라에"] },
                    translate_ko_to_pohnpeian: { title: "AI · 폰페이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "pohnpeian", "폰페이"] },
                    translate_ko_to_yapese: { title: "AI · 야프어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "yapese", "야프"] },
                    translate_ko_to_gilbertese: { title: "AI · 키리바시어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "gilbertese", "키리바시"] },
                    translate_ko_to_mortlockese: { title: "AI · 모틀록어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mortlockese", "모틀록"] },
                    internal_team_charter_ko: { title: "AI · 팀 차터 (한)", emoji: "📜", color: "blue", aliases: ["ai", "charter", "team", "팀차터"] },
                    sales_demo_script_ko: { title: "AI · 데모 스크립트 (한)", emoji: "🎤", color: "blue", aliases: ["ai", "demo", "script", "데모스크립트"] },
                    customer_success_story_ko: { title: "AI · 고객 성공 스토리 (한)", emoji: "🌟", color: "green", aliases: ["ai", "success", "story", "성공스토리"] },
                    pm_okr_draft_ko: { title: "AI · OKR 초안 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "okr", "draft", "오케이알초안"] },
                    internal_incident_comms_external_ko: { title: "AI · 외부 인시던트 공지 (한)", emoji: "📢", color: "red", aliases: ["ai", "incident", "comms", "인시던트공지"] },
                    translate_ko_to_rotuman: { title: "AI · 로투마어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "rotuman", "로투마"] },
                    translate_ko_to_wallisian: { title: "AI · 왈리스어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "wallisian", "왈리스"] },
                    translate_ko_to_futunan: { title: "AI · 푸투나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "futunan", "푸투나"] },
                    translate_ko_to_niuean: { title: "AI · 니우에어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "niuean", "니우에"] },
                    translate_ko_to_tokelauan: { title: "AI · 토켈라우어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tokelauan", "토켈라우"] },
                    internal_slo_definition_ko: { title: "AI · SLO/SLI 정의 (한)", emoji: "📡", color: "yellow", aliases: ["ai", "slo", "sli", "에스엘오"] },
                    sales_pricing_proposal_ko: { title: "AI · 가격 제안 (한)", emoji: "💰", color: "blue", aliases: ["ai", "pricing", "proposal", "가격제안"] },
                    customer_business_review_recap_ko: { title: "AI · 비즈니스 리뷰 리캡 (한)", emoji: "📨", color: "green", aliases: ["ai", "review", "recap", "리뷰리캡"] },
                    pm_roadmap_narrative_ko: { title: "AI · 로드맵 내러티브 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "roadmap", "narrative", "로드맵"] },
                    internal_interview_loop_design_ko: { title: "AI · 인터뷰 루프 설계 (한)", emoji: "🔂", color: "yellow", aliases: ["ai", "interview", "loop", "인터뷰루프"] },
                    translate_ko_to_hmong: { title: "AI · 몽어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hmong", "몽어"] },
                    translate_ko_to_mien: { title: "AI · 미엔어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mien", "미엔"] },
                    translate_ko_to_shan: { title: "AI · 샨어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "shan", "샨어"] },
                    translate_ko_to_karen: { title: "AI · 카렌어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "karen", "카렌"] },
                    translate_ko_to_mon: { title: "AI · 몬어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mon", "몬어"] },
                    internal_data_request_spec_ko: { title: "AI · 데이터 요청 스펙 (한)", emoji: "📊", color: "yellow", aliases: ["ai", "data", "request", "데이터요청"] },
                    sales_negotiation_prep_ko: { title: "AI · 협상 준비 (한)", emoji: "🤝", color: "red", aliases: ["ai", "negotiation", "prep", "협상준비"] },
                    customer_kickoff_agenda_ko: { title: "AI · 고객 킥오프 아젠다 (한)", emoji: "🎌", color: "green", aliases: ["ai", "kickoff", "agenda", "킥오프아젠다"] },
                    pm_jobs_to_be_done_ko: { title: "AI · JTBD 분석 (한)", emoji: "🧩", color: "purple", aliases: ["ai", "jtbd", "jobs", "제이티비디"] },
                    internal_retro_action_review_ko: { title: "AI · 회고 액션 리뷰 (한)", emoji: "🔎", color: "yellow", aliases: ["ai", "retro", "action", "회고액션"] },
                    translate_ko_to_chin: { title: "AI · 친어(하카) 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "chin", "친어"] },
                    translate_ko_to_rakhine: { title: "AI · 라카인어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "rakhine", "라카인"] },
                    translate_ko_to_jingpho: { title: "AI · 카친어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "jingpho", "카친"] },
                    translate_ko_to_palaung: { title: "AI · 팔라웅어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "palaung", "팔라웅"] },
                    translate_ko_to_wa: { title: "AI · 와어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "wa", "와어"] },
                    internal_architecture_overview_ko: { title: "AI · 아키텍처 개요 (한)", emoji: "🏗️", color: "purple", aliases: ["ai", "architecture", "overview", "아키텍처"] },
                    sales_proof_of_concept_plan_ko: { title: "AI · POC 플랜 (한)", emoji: "🧪", color: "blue", aliases: ["ai", "poc", "plan", "피오씨"] },
                    customer_renewal_proposal_ko: { title: "AI · 갱신 제안서 (한)", emoji: "🔁", color: "green", aliases: ["ai", "renewal", "proposal", "갱신제안"] },
                    pm_release_readiness_checklist_ko: { title: "AI · 릴리스 준비 체크리스트 (한)", emoji: "🚦", color: "purple", aliases: ["ai", "release", "readiness", "릴리스체크"] },
                    internal_team_health_survey_ko: { title: "AI · 팀 헬스 서베이 (한)", emoji: "💚", color: "green", aliases: ["ai", "health", "survey", "팀헬스"] },
                    translate_ko_to_bhojpuri: { title: "AI · 보지푸리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bhojpuri", "보지푸리"] },
                    translate_ko_to_maithili: { title: "AI · 마이틸리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "maithili", "마이틸리"] },
                    translate_ko_to_konkani: { title: "AI · 콘칸어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "konkani", "콘칸"] },
                    translate_ko_to_tulu: { title: "AI · 툴루어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tulu", "툴루"] },
                    translate_ko_to_santali: { title: "AI · 산탈리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "santali", "산탈리"] },
                    internal_tech_debt_proposal_ko: { title: "AI · 기술 부채 제안 (한)", emoji: "🧹", color: "yellow", aliases: ["ai", "techdebt", "proposal", "기술부채"] },
                    sales_executive_briefing_ko: { title: "AI · 임원 브리핑 (한)", emoji: "🗞️", color: "red", aliases: ["ai", "executive", "briefing", "임원브리핑"] },
                    customer_usage_review_ko: { title: "AI · 제품 사용 리뷰 (한)", emoji: "📊", color: "green", aliases: ["ai", "usage", "review", "사용리뷰"] },
                    pm_metrics_dashboard_spec_ko: { title: "AI · 지표 대시보드 스펙 (한)", emoji: "📉", color: "purple", aliases: ["ai", "metrics", "dashboard", "대시보드스펙"] },
                    internal_promotion_case_ko: { title: "AI · 승진 케이스 (한)", emoji: "🪜", color: "yellow", aliases: ["ai", "promotion", "case", "승진케이스"] },
                    translate_ko_to_dogri: { title: "AI · 도그리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "dogri", "도그리"] },
                    translate_ko_to_bodo: { title: "AI · 보도어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bodo", "보도"] },
                    translate_ko_to_manipuri: { title: "AI · 마니푸르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "manipuri", "마니푸르"] },
                    translate_ko_to_khasi: { title: "AI · 카시어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "khasi", "카시"] },
                    translate_ko_to_mizo: { title: "AI · 미조어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mizo", "미조"] },
                    internal_dev_env_setup_guide_ko: { title: "AI · 개발 환경 셋업 가이드 (한)", emoji: "🛠️", color: "yellow", aliases: ["ai", "devenv", "setup", "환경셋업"] },
                    sales_close_plan_ko: { title: "AI · 딜 클로즈 플랜 (한)", emoji: "🏁", color: "red", aliases: ["ai", "close", "plan", "클로즈플랜"] },
                    customer_executive_alignment_ko: { title: "AI · 임원 정렬 문서 (한)", emoji: "🤝", color: "green", aliases: ["ai", "executive", "alignment", "임원정렬"] },
                    pm_feature_deprecation_plan_ko: { title: "AI · 기능 폐기 플랜 (한)", emoji: "🗑️", color: "purple", aliases: ["ai", "deprecation", "sunset", "기능폐기"] },
                    internal_proposal_one_pager_ko: { title: "AI · 원페이저 제안 (한)", emoji: "📃", color: "yellow", aliases: ["ai", "onepager", "proposal", "원페이저"] },
                    translate_ko_to_zhuang: { title: "AI · 좡어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "zhuang", "좡어"] },
                    translate_ko_to_uyghur: { title: "AI · 위구르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "uyghur", "위구르"] },
                    translate_ko_to_tibetan: { title: "AI · 티베트어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tibetan", "티베트"] },
                    translate_ko_to_dungan: { title: "AI · 둥간어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "dungan", "둥간"] },
                    translate_ko_to_salar: { title: "AI · 살라르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "salar", "살라르"] },
                    internal_security_review_ko: { title: "AI · 보안 리뷰 (한)", emoji: "🔐", color: "red", aliases: ["ai", "security", "review", "보안리뷰"] },
                    sales_reference_request_ko: { title: "AI · 레퍼런스 요청 (한)", emoji: "🙏", color: "blue", aliases: ["ai", "reference", "request", "레퍼런스"] },
                    customer_health_check_call_notes_ko: { title: "AI · 헬스 체크 콜 노트 (한)", emoji: "🩺", color: "green", aliases: ["ai", "healthcheck", "call", "헬스체크"] },
                    pm_competitive_positioning_ko: { title: "AI · 경쟁 포지셔닝 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "positioning", "competitive", "포지셔닝"] },
                    internal_quarterly_retro_ko: { title: "AI · 분기 회고 (한)", emoji: "🔭", color: "yellow", aliases: ["ai", "quarterly", "retro", "분기회고"] },
                    translate_ko_to_tuvan: { title: "AI · 투바어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tuvan", "투바"] },
                    translate_ko_to_khakas: { title: "AI · 하카스어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "khakas", "하카스"] },
                    translate_ko_to_altai: { title: "AI · 알타이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "altai", "알타이"] },
                    translate_ko_to_shor: { title: "AI · 쇼르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "shor", "쇼르"] },
                    translate_ko_to_dolgan: { title: "AI · 돌간어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "dolgan", "돌간"] },
                    internal_backlog_grooming_notes_ko: { title: "AI · 백로그 그루밍 노트 (한)", emoji: "🧺", color: "yellow", aliases: ["ai", "backlog", "grooming", "백로그"] },
                    sales_territory_plan_ko: { title: "AI · 영역 플랜 (한)", emoji: "🗺️", color: "blue", aliases: ["ai", "territory", "plan", "영역플랜"] },
                    customer_onboarding_status_ko: { title: "AI · 온보딩 상태 (한)", emoji: "🚦", color: "green", aliases: ["ai", "onboarding", "status", "온보딩상태"] },
                    pm_ab_test_results_ko: { title: "AI · A/B 결과 리드아웃 (한)", emoji: "📈", color: "purple", aliases: ["ai", "abtest", "results", "에이비결과"] },
                    internal_eng_weekly_digest_ko: { title: "AI · 엔지니어링 주간 다이제스트 (한)", emoji: "📰", color: "yellow", aliases: ["ai", "engineering", "weekly", "엔지니어링주간"] },
                    translate_ko_to_andi: { title: "AI · 안디어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "andi", "안디"] },
                    translate_ko_to_tsez: { title: "AI · 체즈어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tsez", "체즈"] },
                    translate_ko_to_rutul: { title: "AI · 루툴어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "rutul", "루툴"] },
                    translate_ko_to_tsakhur: { title: "AI · 차후르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tsakhur", "차후르"] },
                    translate_ko_to_aghul: { title: "AI · 아굴어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "aghul", "아굴"] },
                    internal_meeting_facilitation_guide_ko: { title: "AI · 미팅 퍼실리테이션 가이드 (한)", emoji: "🧑‍🏫", color: "yellow", aliases: ["ai", "facilitation", "meeting", "퍼실리테이션"] },
                    sales_deal_review_ko: { title: "AI · 딜 리뷰 (한)", emoji: "🔍", color: "red", aliases: ["ai", "deal", "review", "딜리뷰"] },
                    customer_feedback_loop_ko: { title: "AI · 피드백 루프 설계 (한)", emoji: "🔁", color: "green", aliases: ["ai", "feedback", "loop", "피드백루프"] },
                    pm_discovery_summary_ko: { title: "AI · 디스커버리 요약 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "discovery", "summary", "디스커버리요약"] },
                    internal_engineering_standards_ko: { title: "AI · 엔지니어링 표준 (한)", emoji: "📐", color: "yellow", aliases: ["ai", "standards", "engineering", "엔지니어링표준"] },
                    translate_ko_to_cherokee: { title: "AI · 체로키어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "cherokee", "체로키"] },
                    translate_ko_to_lakota: { title: "AI · 라코타어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lakota", "라코타"] },
                    translate_ko_to_choctaw: { title: "AI · 촉토어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "choctaw", "촉토"] },
                    translate_ko_to_apache: { title: "AI · 아파치어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "apache", "아파치"] },
                    translate_ko_to_hopi: { title: "AI · 호피어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hopi", "호피"] },
                    internal_pr_faq_ko: { title: "AI · PR/FAQ 워킹백워드 (한)", emoji: "📰", color: "purple", aliases: ["ai", "prfaq", "workingbackwards", "피알에프에이큐"] },
                    sales_pipeline_review_ko: { title: "AI · 파이프라인 리뷰 (한)", emoji: "🔭", color: "blue", aliases: ["ai", "pipeline", "review", "파이프라인"] },
                    customer_renewal_forecast_ko: { title: "AI · 갱신 포캐스트 (한)", emoji: "📊", color: "green", aliases: ["ai", "renewal", "forecast", "갱신예측"] },
                    pm_product_principles_ko: { title: "AI · 제품 원칙 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "principles", "product", "제품원칙"] },
                    internal_incident_exec_summary_ko: { title: "AI · 인시던트 임원 요약 (한)", emoji: "🚨", color: "red", aliases: ["ai", "incident", "executive", "인시던트요약"] },
                    translate_ko_to_mixtec: { title: "AI · 믹스텍어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mixtec", "믹스텍"] },
                    translate_ko_to_zapotec: { title: "AI · 사포텍어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "zapotec", "사포텍"] },
                    translate_ko_to_otomi: { title: "AI · 오토미어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "otomi", "오토미"] },
                    translate_ko_to_purepecha: { title: "AI · 푸레페차어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "purepecha", "푸레페차"] },
                    translate_ko_to_yucatec: { title: "AI · 유카텍 마야어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "yucatec", "유카텍"] },
                    internal_design_doc_review_checklist_ko: { title: "AI · 설계 문서 리뷰 체크리스트 (한)", emoji: "✅", color: "yellow", aliases: ["ai", "review", "checklist", "설계리뷰"] },
                    sales_renewal_playbook_ko: { title: "AI · 갱신 플레이북 (한)", emoji: "📘", color: "blue", aliases: ["ai", "renewal", "playbook", "갱신플레이북"] },
                    customer_quarterly_value_recap_ko: { title: "AI · 분기 가치 리캡 (한)", emoji: "💎", color: "green", aliases: ["ai", "value", "recap", "가치리캡"] },
                    pm_feature_acceptance_criteria_ko: { title: "AI · 인수 기준 (한)", emoji: "📝", color: "purple", aliases: ["ai", "acceptance", "criteria", "인수기준"] },
                    internal_oncall_rotation_policy_ko: { title: "AI · 온콜 로테이션 정책 (한)", emoji: "📟", color: "yellow", aliases: ["ai", "oncall", "rotation", "온콜정책"] },
                    translate_ko_to_wayuu: { title: "AI · 와유어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "wayuu", "와유"] },
                    translate_ko_to_shipibo: { title: "AI · 시피보어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "shipibo", "시피보"] },
                    translate_ko_to_kichwa: { title: "AI · 키추아어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kichwa", "키추아"] },
                    translate_ko_to_tupi: { title: "AI · 녱가투(투피)어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tupi", "투피"] },
                    translate_ko_to_yanomami: { title: "AI · 야노마미어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "yanomami", "야노마미"] },
                    internal_postmortem_5whys_ko: { title: "AI · 5 Whys 근본원인 (한)", emoji: "❓", color: "red", aliases: ["ai", "5whys", "rootcause", "파이브와이"] },
                    sales_loss_recovery_plan_ko: { title: "AI · 로스 리커버리 플랜 (한)", emoji: "♻️", color: "red", aliases: ["ai", "loss", "recovery", "로스리커버리"] },
                    customer_advocacy_program_ko: { title: "AI · 어드보커시 프로그램 (한)", emoji: "📣", color: "green", aliases: ["ai", "advocacy", "program", "어드보커시"] },
                    pm_release_retro_ko: { title: "AI · 릴리스 회고 (한)", emoji: "🔁", color: "purple", aliases: ["ai", "release", "retro", "릴리스회고"] },
                    internal_team_ramp_plan_ko: { title: "AI · 신규 입사 램프 플랜 (한)", emoji: "📈", color: "yellow", aliases: ["ai", "ramp", "onboarding", "램프플랜"] },
                    translate_ko_to_iban: { title: "AI · 이반어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "iban", "이반"] },
                    translate_ko_to_kadazan: { title: "AI · 카다잔어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kadazan", "카다잔"] },
                    translate_ko_to_dusun: { title: "AI · 두순어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "dusun", "두순"] },
                    translate_ko_to_murut: { title: "AI · 무룻어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "murut", "무룻"] },
                    translate_ko_to_bidayuh: { title: "AI · 비다유어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bidayuh", "비다유"] },
                    internal_eng_metrics_review_ko: { title: "AI · 엔지니어링 지표 리뷰 (한)", emoji: "📊", color: "yellow", aliases: ["ai", "metrics", "dora", "지표리뷰"] },
                    sales_champion_enablement_ko: { title: "AI · 챔피언 인에이블먼트 (한)", emoji: "🦸", color: "blue", aliases: ["ai", "champion", "enablement", "챔피언"] },
                    customer_onboarding_retrospective_ko: { title: "AI · 온보딩 회고 (한)", emoji: "🔁", color: "green", aliases: ["ai", "onboarding", "retro", "온보딩회고"] },
                    pm_beta_program_plan_ko: { title: "AI · 베타 프로그램 플랜 (한)", emoji: "🧪", color: "purple", aliases: ["ai", "beta", "program", "베타프로그램"] },
                    internal_alert_triage_guide_ko: { title: "AI · 알림 트리아지 가이드 (한)", emoji: "🚨", color: "red", aliases: ["ai", "alert", "triage", "알림트리아지"] },
                    translate_ko_to_toba_batak: { title: "AI · 토바 바탁어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "batak", "바탁"] },
                    translate_ko_to_nias: { title: "AI · 니아스어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nias", "니아스"] },
                    translate_ko_to_mentawai: { title: "AI · 멘타와이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mentawai", "멘타와이"] },
                    translate_ko_to_rejang: { title: "AI · 레장어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "rejang", "레장"] },
                    translate_ko_to_lampung: { title: "AI · 람풍어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lampung", "람풍"] },
                    internal_dependency_map_ko: { title: "AI · 의존성 맵 (한)", emoji: "🕸️", color: "yellow", aliases: ["ai", "dependency", "map", "의존성맵"] },
                    sales_enablement_one_pager_ko: { title: "AI · 세일즈 인에이블 원페이저 (한)", emoji: "📄", color: "blue", aliases: ["ai", "enablement", "onepager", "인에이블원페이저"] },
                    customer_renewal_checklist_ko: { title: "AI · 갱신 체크리스트 (한)", emoji: "✅", color: "green", aliases: ["ai", "renewal", "checklist", "갱신체크"] },
                    pm_market_sizing_ko: { title: "AI · 시장 규모 분석 (한)", emoji: "📐", color: "purple", aliases: ["ai", "market", "sizing", "시장규모"] },
                    internal_escalation_policy_ko: { title: "AI · 에스컬레이션 정책 (한)", emoji: "🪜", color: "red", aliases: ["ai", "escalation", "policy", "에스컬레이션정책"] },
                    translate_ko_to_sasak: { title: "AI · 사삭어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "sasak", "사삭"] },
                    translate_ko_to_bima: { title: "AI · 비마어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bima", "비마"] },
                    translate_ko_to_manggarai: { title: "AI · 망가라이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "manggarai", "망가라이"] },
                    translate_ko_to_sumbawa: { title: "AI · 숨바와어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "sumbawa", "숨바와"] },
                    translate_ko_to_ngada: { title: "AI · 응가다어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ngada", "응가다"] },
                    internal_release_comms_internal_ko: { title: "AI · 내부 릴리스 공지 (한)", emoji: "📣", color: "yellow", aliases: ["ai", "release", "comms", "내부릴리스"] },
                    sales_account_handoff_ko: { title: "AI · 어카운트 핸드오프 (한)", emoji: "🤝", color: "blue", aliases: ["ai", "account", "handoff", "핸드오프"] },
                    customer_expansion_proposal_ko: { title: "AI · 확장 제안 (한)", emoji: "📈", color: "green", aliases: ["ai", "expansion", "upsell", "확장제안"] },
                    pm_concept_validation_ko: { title: "AI · 컨셉 검증 플랜 (한)", emoji: "🔬", color: "purple", aliases: ["ai", "concept", "validation", "컨셉검증"] },
                    internal_decision_framework_ko: { title: "AI · 의사결정 프레임워크 (한)", emoji: "⚖️", color: "yellow", aliases: ["ai", "decision", "framework", "의사결정"] },
                    translate_ko_to_hokkien: { title: "AI · 민난어(호키엔) 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hokkien", "민난"] },
                    translate_ko_to_hakka: { title: "AI · 객가어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hakka", "객가"] },
                    translate_ko_to_cantonese: { title: "AI · 광둥어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "cantonese", "광둥"] },
                    translate_ko_to_teochew: { title: "AI · 차오저우어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "teochew", "차오저우"] },
                    translate_ko_to_okinawan: { title: "AI · 오키나와어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "okinawan", "오키나와"] },
                    internal_war_room_notes_ko: { title: "AI · 워룸 노트 (한)", emoji: "🚨", color: "red", aliases: ["ai", "warroom", "incident", "워룸"] },
                    sales_qualification_notes_ko: { title: "AI · 자격 검증 노트 (한)", emoji: "🔎", color: "blue", aliases: ["ai", "qualification", "bant", "자격검증"] },
                    customer_renewal_business_case_ko: { title: "AI · 갱신 비즈니스 케이스 (한)", emoji: "💼", color: "green", aliases: ["ai", "renewal", "businesscase", "갱신케이스"] },
                    pm_feature_kpi_definition_ko: { title: "AI · 기능 KPI 정의 (한)", emoji: "📏", color: "purple", aliases: ["ai", "kpi", "metric", "기능지표"] },
                    internal_sprint_demo_notes_ko: { title: "AI · 스프린트 데모 노트 (한)", emoji: "🎬", color: "yellow", aliases: ["ai", "demo", "review", "데모노트"] },
                    translate_ko_to_kashubian: { title: "AI · 카슈브어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kashubian", "카슈브"] },
                    translate_ko_to_silesian: { title: "AI · 실레시아어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "silesian", "실레시아"] },
                    translate_ko_to_rusyn: { title: "AI · 루신어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "rusyn", "루신"] },
                    translate_ko_to_sami_northern: { title: "AI · 북부 사미어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "sami", "사미"] },
                    translate_ko_to_voro: { title: "AI · 뵈로어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "voro", "뵈로"] },
                    internal_status_report_exec_ko: { title: "AI · 임원 상태 보고 (한)", emoji: "🗂️", color: "yellow", aliases: ["ai", "status", "executive", "임원보고"] },
                    sales_renewal_email_sequence_ko: { title: "AI · 갱신 이메일 시퀀스 (한)", emoji: "✉️", color: "blue", aliases: ["ai", "renewal", "sequence", "갱신시퀀스"] },
                    customer_business_outcomes_review_ko: { title: "AI · 비즈니스 성과 리뷰 (한)", emoji: "🎯", color: "green", aliases: ["ai", "outcomes", "review", "성과리뷰"] },
                    pm_assumption_log_ko: { title: "AI · 가정 로그 (한)", emoji: "📒", color: "purple", aliases: ["ai", "assumption", "log", "가정로그"] },
                    internal_meeting_action_tracker_ko: { title: "AI · 회의 액션 트래커 (한)", emoji: "✅", color: "yellow", aliases: ["ai", "action", "tracker", "액션트래커"] },
                    translate_ko_to_low_german: { title: "AI · 저지 독일어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lowgerman", "저지독일어"] },
                    translate_ko_to_limburgish: { title: "AI · 림뷔르흐어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "limburgish", "림뷔르흐"] },
                    translate_ko_to_picard: { title: "AI · 피카르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "picard", "피카르"] },
                    translate_ko_to_norman: { title: "AI · 노르만어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "norman", "노르만"] },
                    translate_ko_to_gascon: { title: "AI · 가스코뉴어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "gascon", "가스코뉴"] },
                    internal_okr_grading_ko: { title: "AI · OKR 채점 (한)", emoji: "🎯", color: "yellow", aliases: ["ai", "okr", "grading", "오케이알채점"] },
                    sales_post_demo_email_ko: { title: "AI · 데모 후 팔로업 메일 (한)", emoji: "✉️", color: "blue", aliases: ["ai", "demo", "followup", "데모팔로업"] },
                    customer_risk_mitigation_plan_ko: { title: "AI · 리스크 완화 플랜 (한)", emoji: "🛟", color: "red", aliases: ["ai", "risk", "mitigation", "리스크완화"] },
                    pm_feature_rollout_comms_ko: { title: "AI · 기능 롤아웃 커뮤니케이션 (한)", emoji: "📣", color: "purple", aliases: ["ai", "rollout", "comms", "롤아웃공지"] },
                    internal_eng_oncall_review_ko: { title: "AI · 온콜 리뷰 (한)", emoji: "📟", color: "yellow", aliases: ["ai", "oncall", "review", "온콜리뷰"] },
                    translate_ko_to_sorani: { title: "AI · 소라니 쿠르드어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "sorani", "소라니"] },
                    translate_ko_to_kurmanji: { title: "AI · 쿠르만지 쿠르드어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kurmanji", "쿠르만지"] },
                    translate_ko_to_zazaki: { title: "AI · 자자키어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "zazaki", "자자키"] },
                    translate_ko_to_gilaki: { title: "AI · 길라키어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "gilaki", "길라키"] },
                    translate_ko_to_mazandarani: { title: "AI · 마잔다란어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mazandarani", "마잔다란"] },
                    internal_deploy_checklist_ko: { title: "AI · 배포 체크리스트 (한)", emoji: "🚀", color: "yellow", aliases: ["ai", "deploy", "checklist", "배포체크"] },
                    sales_proposal_followup_ko: { title: "AI · 제안서 팔로업 (한)", emoji: "✉️", color: "blue", aliases: ["ai", "proposal", "followup", "제안팔로업"] },
                    customer_nps_response_plan_ko: { title: "AI · NPS 대응 플랜 (한)", emoji: "📈", color: "green", aliases: ["ai", "nps", "response", "엔피에스"] },
                    pm_survey_design_ko: { title: "AI · 설문 설계 (한)", emoji: "📋", color: "purple", aliases: ["ai", "survey", "design", "설문설계"] },
                    internal_eng_capacity_review_ko: { title: "AI · 엔지니어링 캐파 리뷰 (한)", emoji: "📊", color: "yellow", aliases: ["ai", "capacity", "review", "캐파리뷰"] },
                    translate_ko_to_carolinian: { title: "AI · 캐롤라이나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "carolinian", "캐롤라이나"] },
                    translate_ko_to_satawalese: { title: "AI · 사타왈어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "satawalese", "사타왈"] },
                    translate_ko_to_ulithian: { title: "AI · 울리티어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ulithian", "울리티"] },
                    translate_ko_to_woleaian: { title: "AI · 월레아이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "woleaian", "월레아이"] },
                    translate_ko_to_puluwat: { title: "AI · 풀루왓어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "puluwat", "풀루왓"] },
                    internal_tech_lead_weekly_ko: { title: "AI · 테크리드 주간 (한)", emoji: "🧑‍💻", color: "yellow", aliases: ["ai", "techlead", "weekly", "테크리드주간"] },
                    sales_account_research_brief_ko: { title: "AI · 계정 리서치 브리프 (한)", emoji: "🔍", color: "blue", aliases: ["ai", "account", "research", "계정리서치"] },
                    customer_quarterly_planning_ko: { title: "AI · 고객 분기 플랜 (한)", emoji: "📆", color: "green", aliases: ["ai", "quarterly", "plan", "고객분기"] },
                    pm_product_strategy_brief_ko: { title: "AI · 제품 전략 브리프 (한)", emoji: "♟️", color: "purple", aliases: ["ai", "strategy", "brief", "제품전략"] },
                    internal_architecture_review_notes_ko: { title: "AI · 아키텍처 리뷰 노트 (한)", emoji: "🏗️", color: "yellow", aliases: ["ai", "architecture", "review", "아키텍처리뷰"] },
                    translate_ko_to_acholi: { title: "AI · 아촐리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "acholi", "아촐리"] },
                    translate_ko_to_lango: { title: "AI · 랑고어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lango", "랑고"] },
                    translate_ko_to_ateso: { title: "AI · 아테소어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ateso", "아테소"] },
                    translate_ko_to_karamojong: { title: "AI · 카라모종어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "karamojong", "카라모종"] },
                    translate_ko_to_madi: { title: "AI · 마디어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "madi", "마디"] },
                    internal_release_go_nogo_ko: { title: "AI · 릴리스 Go/No-go (한)", emoji: "🚦", color: "red", aliases: ["ai", "gonogo", "release", "고노고"] },
                    sales_handoff_checklist_ko: { title: "AI · 세일즈 핸드오프 체크리스트 (한)", emoji: "✅", color: "blue", aliases: ["ai", "handoff", "checklist", "핸드오프체크"] },
                    customer_journey_milestone_review_ko: { title: "AI · 여정 마일스톤 리뷰 (한)", emoji: "🛣️", color: "green", aliases: ["ai", "journey", "milestone", "여정리뷰"] },
                    pm_feature_tradeoff_analysis_ko: { title: "AI · 기능 트레이드오프 분석 (한)", emoji: "⚖️", color: "purple", aliases: ["ai", "tradeoff", "analysis", "트레이드오프"] },
                    internal_postmortem_learnings_digest_ko: { title: "AI · 포스트모템 학습 다이제스트 (한)", emoji: "📚", color: "yellow", aliases: ["ai", "postmortem", "learnings", "학습다이제스트"] },
                    translate_ko_to_warlpiri: { title: "AI · 왈피리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "warlpiri", "왈피리"] },
                    translate_ko_to_pitjantjatjara: { title: "AI · 피찬차차라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "pitjantjatjara", "피찬차차라"] },
                    translate_ko_to_yolngu: { title: "AI · 욜릉구어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "yolngu", "욜릉구"] },
                    translate_ko_to_arrernte: { title: "AI · 아르안테어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "arrernte", "아르안테"] },
                    translate_ko_to_tiwi: { title: "AI · 티위어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tiwi", "티위"] },
                    internal_oncall_summary_weekly_ko: { title: "AI · 온콜 주간 요약 (한)", emoji: "📟", color: "yellow", aliases: ["ai", "oncall", "weekly", "온콜주간"] },
                    sales_upsell_pitch_ko: { title: "AI · 업셀 피치 (한)", emoji: "⬆️", color: "blue", aliases: ["ai", "upsell", "pitch", "업셀"] },
                    customer_qbr_action_plan_ko: { title: "AI · QBR 액션 플랜 (한)", emoji: "📋", color: "green", aliases: ["ai", "qbr", "action", "큐비알액션"] },
                    pm_impact_effort_matrix_ko: { title: "AI · 임팩트/노력 매트릭스 (한)", emoji: "🔲", color: "purple", aliases: ["ai", "impact", "effort", "임팩트노력"] },
                    internal_team_skills_matrix_ko: { title: "AI · 팀 스킬 매트릭스 (한)", emoji: "🗂️", color: "yellow", aliases: ["ai", "skills", "matrix", "스킬매트릭스"] },
                    translate_ko_to_kodava: { title: "AI · 코다바어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kodava", "코다바"] },
                    translate_ko_to_badaga: { title: "AI · 바다가어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "badaga", "바다가"] },
                    translate_ko_to_gondi: { title: "AI · 곤디어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "gondi", "곤디"] },
                    translate_ko_to_kui: { title: "AI · 쿠이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kui", "쿠이"] },
                    translate_ko_to_brahui: { title: "AI · 브라후이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "brahui", "브라후이"] },
                    internal_data_pipeline_design_ko: { title: "AI · 데이터 파이프라인 설계 (한)", emoji: "🔧", color: "purple", aliases: ["ai", "pipeline", "etl", "파이프라인설계"] },
                    sales_renewal_kickoff_ko: { title: "AI · 갱신 킥오프 (한)", emoji: "🔄", color: "blue", aliases: ["ai", "renewal", "kickoff", "갱신킥오프"] },
                    customer_onboarding_kickoff_email_ko: { title: "AI · 온보딩 킥오프 메일 (한)", emoji: "👋", color: "green", aliases: ["ai", "onboarding", "kickoff", "온보딩킥오프"] },
                    pm_quarterly_roadmap_review_ko: { title: "AI · 분기 로드맵 리뷰 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "roadmap", "review", "로드맵리뷰"] },
                    internal_incident_severity_guide_ko: { title: "AI · 인시던트 심각도 가이드 (한)", emoji: "🚨", color: "red", aliases: ["ai", "severity", "incident", "심각도"] },
                    translate_ko_to_makonde: { title: "AI · 마콘데어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "makonde", "마콘데"] },
                    translate_ko_to_chiyao: { title: "AI · 야오어(아프리카) 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "chiyao", "치야오"] },
                    translate_ko_to_makhuwa: { title: "AI · 마쿠와어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "makhuwa", "마쿠와"] },
                    translate_ko_to_tumbuka: { title: "AI · 툼부카어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tumbuka", "툼부카"] },
                    translate_ko_to_nyakyusa: { title: "AI · 냐큐사어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nyakyusa", "냐큐사"] },
                    internal_api_design_review_ko: { title: "AI · API 설계 리뷰 (한)", emoji: "🔌", color: "purple", aliases: ["ai", "api", "review", "에이피아이리뷰"] },
                    sales_weekly_forecast_ko: { title: "AI · 주간 세일즈 포캐스트 (한)", emoji: "📈", color: "blue", aliases: ["ai", "forecast", "weekly", "주간예측"] },
                    customer_success_metrics_review_ko: { title: "AI · CS 지표 리뷰 (한)", emoji: "📊", color: "green", aliases: ["ai", "csmetrics", "nrr", "씨에스지표"] },
                    pm_feature_request_triage_ko: { title: "AI · 기능 요청 트리아지 (한)", emoji: "🗳️", color: "purple", aliases: ["ai", "request", "triage", "요청트리아지"] },
                    internal_allhands_notes_ko: { title: "AI · 올핸즈 노트 (한)", emoji: "📢", color: "yellow", aliases: ["ai", "allhands", "notes", "올핸즈"] },
                    translate_ko_to_kituba: { title: "AI · 키투바어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kituba", "키투바"] },
                    translate_ko_to_fang: { title: "AI · 팡어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "fang", "팡어"] },
                    translate_ko_to_teke: { title: "AI · 테케어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "teke", "테케"] },
                    translate_ko_to_punu: { title: "AI · 푸누어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "punu", "푸누"] },
                    translate_ko_to_duala: { title: "AI · 두알라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "duala", "두알라"] },
                    internal_load_testing_plan_ko: { title: "AI · 부하 테스트 플랜 (한)", emoji: "🏋️", color: "purple", aliases: ["ai", "loadtest", "performance", "부하테스트"] },
                    sales_intro_email_ko: { title: "AI · 세일즈 인트로 메일 (한)", emoji: "✉️", color: "blue", aliases: ["ai", "intro", "email", "인트로메일"] },
                    customer_qbr_invite_email_ko: { title: "AI · QBR 초대 메일 (한)", emoji: "📨", color: "green", aliases: ["ai", "qbr", "invite", "큐비알초대"] },
                    pm_opportunity_solution_tree_ko: { title: "AI · 기회-솔루션 트리 (한)", emoji: "🌳", color: "purple", aliases: ["ai", "opportunity", "tree", "기회트리"] },
                    internal_retro_facilitation_guide_ko: { title: "AI · 회고 퍼실리테이션 가이드 (한)", emoji: "🔄", color: "yellow", aliases: ["ai", "retro", "facilitation", "회고가이드"] },
                    translate_ko_to_lue: { title: "AI · 타이르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lue", "타이르"] },
                    translate_ko_to_tai_dam: { title: "AI · 흑타이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "taidam", "흑타이"] },
                    translate_ko_to_nung: { title: "AI · 눙어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nung", "눙어"] },
                    translate_ko_to_tay: { title: "AI · 따이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tay", "따이"] },
                    translate_ko_to_bouyei: { title: "AI · 부이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bouyei", "부이"] },
                    internal_eng_quarterly_goals_ko: { title: "AI · 엔지니어링 분기 목표 (한)", emoji: "🎯", color: "yellow", aliases: ["ai", "quarterly", "goals", "엔지니어링목표"] },
                    sales_deal_desk_review_ko: { title: "AI · 딜 데스크 리뷰 (한)", emoji: "🧾", color: "red", aliases: ["ai", "dealdesk", "review", "딜데스크"] },
                    customer_executive_email_ko: { title: "AI · 임원 간 이메일 (한)", emoji: "📨", color: "green", aliases: ["ai", "executive", "email", "임원메일"] },
                    pm_changelog_entry_ko: { title: "AI · 체인지로그 항목 (한)", emoji: "📝", color: "purple", aliases: ["ai", "changelog", "entry", "체인지로그"] },
                    internal_code_review_guidelines_ko: { title: "AI · 코드 리뷰 가이드라인 (한)", emoji: "👀", color: "yellow", aliases: ["ai", "codereview", "guidelines", "코드리뷰가이드"] },
                    translate_ko_to_dagur: { title: "AI · 다구르어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "dagur", "다구르"] },
                    translate_ko_to_evenki: { title: "AI · 에벤키어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "evenki", "에벤키"] },
                    translate_ko_to_even: { title: "AI · 에벤어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "even", "에벤"] },
                    translate_ko_to_nanai: { title: "AI · 나나이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nanai", "나나이"] },
                    translate_ko_to_manchu: { title: "AI · 만주어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "manchu", "만주"] },
                    internal_release_train_plan_ko: { title: "AI · 릴리스 트레인 플랜 (한)", emoji: "🚂", color: "yellow", aliases: ["ai", "releasetrain", "cadence", "릴리스트레인"] },
                    sales_competitive_displacement_ko: { title: "AI · 경쟁 전환 플랜 (한)", emoji: "🔁", color: "red", aliases: ["ai", "displacement", "competitive", "경쟁전환"] },
                    customer_quarterly_check_in_email_ko: { title: "AI · 분기 체크인 메일 (한)", emoji: "📨", color: "green", aliases: ["ai", "checkin", "quarterly", "분기체크인"] },
                    pm_release_scope_decision_ko: { title: "AI · 릴리스 범위 결정 (한)", emoji: "✂️", color: "purple", aliases: ["ai", "scope", "decision", "범위결정"] },
                    internal_engineering_glossary_ko: { title: "AI · 엔지니어링 용어집 (한)", emoji: "📖", color: "yellow", aliases: ["ai", "glossary", "terms", "용어집"] },
                    translate_ko_to_kiche: { title: "AI · 키체 마야어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kiche", "키체"] },
                    translate_ko_to_qeqchi: { title: "AI · 케크치 마야어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "qeqchi", "케크치"] },
                    translate_ko_to_mam: { title: "AI · 맘 마야어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "mam", "맘어"] },
                    translate_ko_to_kaqchikel: { title: "AI · 카크치켈 마야어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kaqchikel", "카크치켈"] },
                    translate_ko_to_tzotzil: { title: "AI · 초칠 마야어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tzotzil", "초칠"] },
                    internal_eng_roadmap_ko: { title: "AI · 엔지니어링 로드맵 (한)", emoji: "🛤️", color: "yellow", aliases: ["ai", "roadmap", "engineering", "엔지니어링로드맵"] },
                    sales_quarterly_review_internal_ko: { title: "AI · 분기 영업 리뷰(내부) (한)", emoji: "📊", color: "red", aliases: ["ai", "quarterly", "sales", "분기영업"] },
                    customer_stakeholder_map_ko: { title: "AI · 스테이크홀더 맵 (한)", emoji: "🕸️", color: "green", aliases: ["ai", "stakeholder", "map", "스테이크홀더"] },
                    pm_feature_sunset_comms_ko: { title: "AI · 기능 종료 공지 (한)", emoji: "🌇", color: "purple", aliases: ["ai", "sunset", "comms", "기능종료"] },
                    internal_engineering_principles_ko: { title: "AI · 엔지니어링 원칙 (한)", emoji: "🧭", color: "yellow", aliases: ["ai", "principles", "engineering", "엔지니어링원칙"] },
                    translate_ko_to_kpelle: { title: "AI · 크펠레어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kpelle", "크펠레"] },
                    translate_ko_to_loma: { title: "AI · 로마어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "loma", "로마어"] },
                    translate_ko_to_vai: { title: "AI · 바이어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "vai", "바이"] },
                    translate_ko_to_gola: { title: "AI · 골라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "gola", "골라"] },
                    translate_ko_to_kissi: { title: "AI · 키시어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kissi", "키시"] },
                    internal_service_catalog_entry_ko: { title: "AI · 서비스 카탈로그 항목 (한)", emoji: "🗃️", color: "yellow", aliases: ["ai", "service", "catalog", "서비스카탈로그"] },
                    sales_pipeline_generation_plan_ko: { title: "AI · 파이프라인 생성 플랜 (한)", emoji: "🌱", color: "blue", aliases: ["ai", "pipeline", "generation", "파이프라인생성"] },
                    customer_health_improvement_plan_ko: { title: "AI · 헬스 개선 플랜 (한)", emoji: "💚", color: "green", aliases: ["ai", "health", "improvement", "헬스개선"] },
                    pm_definition_of_ready_ko: { title: "AI · Definition of Ready (한)", emoji: "✅", color: "purple", aliases: ["ai", "dor", "ready", "디오알"] },
                    internal_async_update_template_ko: { title: "AI · 비동기 업데이트 템플릿 (한)", emoji: "📝", color: "yellow", aliases: ["ai", "async", "update", "비동기업데이트"] },
                    translate_ko_to_shilluk: { title: "AI · 실루크어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "shilluk", "실루크"] },
                    translate_ko_to_anuak: { title: "AI · 아누악어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "anuak", "아누악"] },
                    translate_ko_to_bari: { title: "AI · 바리어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "bari", "바리어"] },
                    translate_ko_to_lotuko: { title: "AI · 로투코어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lotuko", "로투코"] },
                    translate_ko_to_zande: { title: "AI · 잔데어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "zande", "잔데"] },
                    internal_tech_radar_entry_ko: { title: "AI · 테크 레이더 항목 (한)", emoji: "📡", color: "yellow", aliases: ["ai", "techradar", "assess", "테크레이더"] },
                    sales_deal_loss_notification_ko: { title: "AI · 딜 로스 공지 (한)", emoji: "📉", color: "red", aliases: ["ai", "loss", "notification", "딜로스"] },
                    customer_relationship_review_ko: { title: "AI · 관계 리뷰 (한)", emoji: "🤝", color: "green", aliases: ["ai", "relationship", "review", "관계리뷰"] },
                    pm_problem_statement_ko: { title: "AI · 문제 정의 (한)", emoji: "❗", color: "purple", aliases: ["ai", "problem", "statement", "문제정의"] },
                    internal_handover_doc_ko: { title: "AI · 인계 문서 (한)", emoji: "📦", color: "yellow", aliases: ["ai", "handover", "transition", "인계문서"] },
                    translate_ko_to_ainu: { title: "AI · 아이누어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ainu", "아이누"] },
                    translate_ko_to_nivkh: { title: "AI · 니브흐어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nivkh", "니브흐"] },
                    translate_ko_to_chukchi: { title: "AI · 추크치어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "chukchi", "추크치"] },
                    translate_ko_to_koryak: { title: "AI · 코랴크어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "koryak", "코랴크"] },
                    translate_ko_to_itelmen: { title: "AI · 이텔멘어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "itelmen", "이텔멘"] },
                    internal_observability_plan_ko: { title: "AI · 관측성 플랜 (한)", emoji: "📡", color: "purple", aliases: ["ai", "observability", "monitoring", "관측성"] },
                    sales_pipeline_hygiene_review_ko: { title: "AI · 파이프라인 위생 리뷰 (한)", emoji: "🧹", color: "blue", aliases: ["ai", "pipeline", "hygiene", "파이프라인위생"] },
                    customer_kickoff_summary_email_ko: { title: "AI · 킥오프 요약 메일 (한)", emoji: "📨", color: "green", aliases: ["ai", "kickoff", "summary", "킥오프요약"] },
                    pm_metrics_review_monthly_ko: { title: "AI · 월간 지표 리뷰 (한)", emoji: "📈", color: "purple", aliases: ["ai", "metrics", "monthly", "월간지표"] },
                    internal_onboarding_plan_eng_ko: { title: "AI · 엔지니어 온보딩 플랜 (한)", emoji: "🧑‍💻", color: "yellow", aliases: ["ai", "onboarding", "engineer", "엔지니어온보딩"] },
                    translate_ko_to_aleut: { title: "AI · 알류트어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "aleut", "알류트"] },
                    translate_ko_to_yupik: { title: "AI · 유픽어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "yupik", "유픽"] },
                    translate_ko_to_inupiaq: { title: "AI · 이누피아크어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "inupiaq", "이누피아크"] },
                    translate_ko_to_alutiiq: { title: "AI · 알루티크어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "alutiiq", "알루티크"] },
                    translate_ko_to_tlingit: { title: "AI · 틀링깃어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tlingit", "틀링깃"] },
                    internal_eng_health_review_ko: { title: "AI · 엔지니어링 건강 리뷰 (한)", emoji: "🩺", color: "yellow", aliases: ["ai", "enghealth", "review", "엔지니어링건강"] },
                    sales_competitive_intel_update_ko: { title: "AI · 경쟁 인텔 업데이트 (한)", emoji: "🕵️", color: "red", aliases: ["ai", "competitive", "intel", "경쟁인텔"] },
                    customer_executive_sponsor_update_ko: { title: "AI · 임원 스폰서 업데이트 (한)", emoji: "📨", color: "green", aliases: ["ai", "sponsor", "update", "스폰서업데이트"] },
                    pm_product_health_review_ko: { title: "AI · 제품 건강 리뷰 (한)", emoji: "💗", color: "purple", aliases: ["ai", "producthealth", "review", "제품건강"] },
                    internal_eng_hiring_plan_ko: { title: "AI · 엔지니어링 채용 플랜 (한)", emoji: "🧑‍💼", color: "yellow", aliases: ["ai", "hiring", "plan", "채용플랜"] },
                    translate_ko_to_haida: { title: "AI · 하이다어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "haida", "하이다"] },
                    translate_ko_to_tsimshian: { title: "AI · 침시안어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "tsimshian", "침시안"] },
                    translate_ko_to_kwakwala: { title: "AI · 콰콰라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kwakwala", "콰콰라"] },
                    translate_ko_to_salish: { title: "AI · 살리시어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "salish", "살리시"] },
                    translate_ko_to_nuuchahnulth: { title: "AI · 누차눌스어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "nuuchahnulth", "누차눌스"] },
                    internal_runbook_audit_ko: { title: "AI · 런북 감사 (한)", emoji: "🔍", color: "yellow", aliases: ["ai", "runbook", "audit", "런북감사"] },
                    sales_account_tiering_ko: { title: "AI · 계정 티어링 (한)", emoji: "🪜", color: "blue", aliases: ["ai", "tiering", "account", "계정티어"] },
                    customer_executive_review_prep_ko: { title: "AI · 임원 리뷰 준비 (한)", emoji: "🏛️", color: "green", aliases: ["ai", "ebr", "prep", "임원리뷰준비"] },
                    pm_user_segmentation_ko: { title: "AI · 사용자 세분화 (한)", emoji: "🧩", color: "purple", aliases: ["ai", "segmentation", "users", "사용자세분화"] },
                    internal_team_ritual_design_ko: { title: "AI · 팀 리추얼 설계 (한)", emoji: "🔂", color: "yellow", aliases: ["ai", "ritual", "ceremony", "리추얼설계"] },
                    translate_ko_to_garifuna: { title: "AI · 가리푸나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "garifuna", "가리푸나"] },
                    translate_ko_to_miskito: { title: "AI · 미스키토어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "miskito", "미스키토"] },
                    translate_ko_to_kuna: { title: "AI · 구나어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "kuna", "구나"] },
                    translate_ko_to_embera: { title: "AI · 엠베라어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "embera", "엠베라"] },
                    translate_ko_to_ngabere: { title: "AI · 응가베레어 번역", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "ngabere", "응가베레"] },
                    internal_incident_trends_review_ko: { title: "AI · 인시던트 추세 리뷰 (한)", emoji: "📉", color: "red", aliases: ["ai", "incident", "trends", "인시던트추세"] },
                    sales_quota_planning_ko: { title: "AI · 쿼터 플래닝 (한)", emoji: "🎯", color: "blue", aliases: ["ai", "quota", "planning", "쿼터플래닝"] },
                    customer_onboarding_completion_review_ko: { title: "AI · 온보딩 완료 리뷰 (한)", emoji: "🏁", color: "green", aliases: ["ai", "onboarding", "completion", "온보딩완료"] },
                    pm_feature_postlaunch_review_ko: { title: "AI · 출시 후 리뷰 (한)", emoji: "🔬", color: "purple", aliases: ["ai", "postlaunch", "review", "출시후리뷰"] },
                    internal_decision_postmortem_ko: { title: "AI · 의사결정 포스트모템 (한)", emoji: "🧠", color: "yellow", aliases: ["ai", "decision", "postmortem", "결정포스트모템"] },
                    d_series_completion_announcement_ko: { title: "AI · 이니셔티브 완주 발표 (한)", emoji: "🏆", color: "green", aliases: ["ai", "completion", "announcement", "완주발표"] },
                    full_program_celebration_ko: { title: "AI · 프로그램 완주 자축 (한)", emoji: "🎉", color: "purple", aliases: ["ai", "program", "celebration", "프로그램완주"] },
                    translate_ko_to_classical_chinese: { title: "AI · 한국어 → 한문(漢文)", emoji: "📜", color: "default", aliases: ["ai", "translate", "classical chinese", "hanmun", "한문"] },
                    translate_ko_to_old_norse: { title: "AI · 한국어 → 고대 노르드어", emoji: "🛡️", color: "blue", aliases: ["ai", "translate", "old norse", "norse", "노르드"] },
                    translate_ko_to_egyptian_arabic: { title: "AI · 한국어 → 이집트 아랍어", emoji: "🐫", color: "yellow", aliases: ["ai", "translate", "egyptian arabic", "masri", "이집트"] },
                    translate_ko_to_gulf_arabic: { title: "AI · 한국어 → 걸프 아랍어", emoji: "🏜️", color: "yellow", aliases: ["ai", "translate", "gulf arabic", "khaleeji", "걸프"] },
                    translate_ko_to_bavarian: { title: "AI · 한국어 → 바이에른어", emoji: "🍺", color: "orange", aliases: ["ai", "translate", "bavarian", "boarisch", "바이에른"] },
                    incident_postmortem_detailed_ko: { title: "AI · 장애 회고 (상세, 한)", emoji: "🚨", color: "red", aliases: ["ai", "postmortem", "incident", "장애", "회고"] },
                    vendor_evaluation_memo_ko: { title: "AI · 벤더 평가 메모 (한)", emoji: "🧾", color: "default", aliases: ["ai", "vendor", "evaluation", "벤더", "평가"] },
                    sprint_review_script_ko: { title: "AI · 스프린트 리뷰 스크립트 (한)", emoji: "🎤", color: "purple", aliases: ["ai", "sprint", "review", "demo", "스프린트"] },
                    hiring_scorecard_ko: { title: "AI · 인터뷰 평가표 (한)", emoji: "📋", color: "green", aliases: ["ai", "hiring", "scorecard", "interview", "인터뷰"] },
                    customer_success_qbr_ko: { title: "AI · 고객 QBR 아웃라인 (한)", emoji: "📈", color: "blue", aliases: ["ai", "qbr", "customer success", "고객", "분기"] },
                    translate_eap_l1: { title: "AI · 한국어 → 프리울리아어", emoji: "📝", color: "blue", aliases: ["ai", "translate", "friulian"] },
                    translate_eap_l2: { title: "AI · 한국어 → 옥시탄어", emoji: "📘", color: "green", aliases: ["ai", "translate", "occitan"] },
                    translate_eap_l3: { title: "AI · 한국어 → 브르탕어", emoji: "📙", color: "yellow", aliases: ["ai", "translate", "breton"] },
                    translate_eap_l4: { title: "AI · 한국어 → 코리시어", emoji: "📚", color: "orange", aliases: ["ai", "translate", "cornish"] },
                    translate_eap_l5: { title: "AI · 한국어 → 맨섬어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "manx"] },
                    doc_eap_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eap_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eap_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eap_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_eap_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_ebe_l1: { title: "AI · 한국어 → 갈리시아어", emoji: "📚", color: "green", aliases: ["ai", "translate", "galician"] },
                    translate_ebe_l2: { title: "AI · 한국어 → 아스투리아스어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "asturian"] },
                    translate_ebe_l3: { title: "AI · 한국어 → 아로마니아어", emoji: "🖋️", color: "orange", aliases: ["ai", "translate", "aromanian"] },
                    translate_ebe_l4: { title: "AI · 한국어 → 라디노어", emoji: "📋", color: "red", aliases: ["ai", "translate", "ladino"] },
                    translate_ebe_l5: { title: "AI · 한국어 → 타타르어", emoji: "📈", color: "purple", aliases: ["ai", "translate", "tatar"] },
                    doc_ebe_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_ebe_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ebe_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ebe_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ebe_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_ebt_l1: { title: "AI · 한국어 → 바슈키르어", emoji: "📋", color: "yellow", aliases: ["ai", "translate", "bashkir"] },
                    translate_ebt_l2: { title: "AI · 한국어 → 추바쉬어", emoji: "📈", color: "orange", aliases: ["ai", "translate", "chuvash"] },
                    translate_ebt_l3: { title: "AI · 한국어 → 투바어", emoji: "📊", color: "red", aliases: ["ai", "translate", "tuvan"] },
                    translate_ebt_l4: { title: "AI · 한국어 → 부리야트어", emoji: "🧾", color: "purple", aliases: ["ai", "translate", "buryat"] },
                    translate_ebt_l5: { title: "AI · 한국어 → 칼믈크어", emoji: "📜", color: "default", aliases: ["ai", "translate", "kalmyk"] },
                    doc_ebt_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ebt_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ebt_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ebt_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ebt_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_eci_l1: { title: "AI · 한국어 → 우드무르트어", emoji: "🧾", color: "orange", aliases: ["ai", "translate", "udmurt"] },
                    translate_eci_l2: { title: "AI · 한국어 → 마리어", emoji: "📜", color: "red", aliases: ["ai", "translate", "mari"] },
                    translate_eci_l3: { title: "AI · 한국어 → 코미어", emoji: "📣", color: "purple", aliases: ["ai", "translate", "komi"] },
                    translate_eci_l4: { title: "AI · 한국어 → 에르지아어", emoji: "🔍", color: "default", aliases: ["ai", "translate", "erzya"] },
                    translate_eci_l5: { title: "AI · 한국어 → 북사미어", emoji: "🎯", color: "blue", aliases: ["ai", "translate", "northern sami"] },
                    doc_eci_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_eci_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_eci_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_eci_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eci_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_ecx_l1: { title: "AI · 한국어 → 카렐리아어", emoji: "🔍", color: "red", aliases: ["ai", "translate", "karelian"] },
                    translate_ecx_l2: { title: "AI · 한국어 → 잉구시어", emoji: "🎯", color: "purple", aliases: ["ai", "translate", "ingush"] },
                    translate_ecx_l3: { title: "AI · 한국어 → 아바르어", emoji: "🧭", color: "default", aliases: ["ai", "translate", "avar"] },
                    translate_ecx_l4: { title: "AI · 한국어 → 레즈기어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lezgian"] },
                    translate_ecx_l5: { title: "AI · 한국어 → 오세티아어", emoji: "💬", color: "green", aliases: ["ai", "translate", "ossetian"] },
                    doc_ecx_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ecx_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ecx_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_ecx_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_ecx_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_edm_l1: { title: "AI · 한국어 → 타지크어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "tajik"] },
                    translate_edm_l2: { title: "AI · 한국어 → 파슈토어", emoji: "💬", color: "default", aliases: ["ai", "translate", "pashto"] },
                    translate_edm_l3: { title: "AI · 한국어 → 발로치어", emoji: "🗺️", color: "blue", aliases: ["ai", "translate", "balochi"] },
                    translate_edm_l4: { title: "AI · 한국어 → 소라니쿠르드어", emoji: "📝", color: "green", aliases: ["ai", "translate", "kurdish sorani"] },
                    translate_edm_l5: { title: "AI · 한국어 → 신디어", emoji: "📘", color: "yellow", aliases: ["ai", "translate", "sindhi"] },
                    doc_edm_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_edm_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_edm_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_edm_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_edm_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_eeb_l1: { title: "AI · 한국어 → 콘카니어", emoji: "📝", color: "default", aliases: ["ai", "translate", "konkani"] },
                    translate_eeb_l2: { title: "AI · 한국어 → 투루어", emoji: "📘", color: "blue", aliases: ["ai", "translate", "tulu"] },
                    translate_eeb_l3: { title: "AI · 한국어 → 산탈리어", emoji: "📙", color: "green", aliases: ["ai", "translate", "santali"] },
                    translate_eeb_l4: { title: "AI · 한국어 → 메이테이어", emoji: "📚", color: "yellow", aliases: ["ai", "translate", "meitei"] },
                    translate_eeb_l5: { title: "AI · 한국어 → 종카어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "dzongkha"] },
                    doc_eeb_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eeb_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eeb_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eeb_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eeb_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_eer_l1: { title: "AI · 한국어 → 네와르어", emoji: "📚", color: "blue", aliases: ["ai", "translate", "newar"] },
                    translate_eer_l2: { title: "AI · 한국어 → 샨어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "shan"] },
                    translate_eer_l3: { title: "AI · 한국어 → 몽어", emoji: "🖋️", color: "yellow", aliases: ["ai", "translate", "hmong"] },
                    translate_eer_l4: { title: "AI · 한국어 → 참어", emoji: "📋", color: "orange", aliases: ["ai", "translate", "cham"] },
                    translate_eer_l5: { title: "AI · 한국어 → 아체어", emoji: "📈", color: "red", aliases: ["ai", "translate", "acehnese"] },
                    doc_eer_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eer_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eer_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eer_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_eer_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_efg_l1: { title: "AI · 한국어 → 미낭카바우어", emoji: "📋", color: "green", aliases: ["ai", "translate", "minangkabau"] },
                    translate_efg_l2: { title: "AI · 한국어 → 부기스어", emoji: "📈", color: "yellow", aliases: ["ai", "translate", "buginese"] },
                    translate_efg_l3: { title: "AI · 한국어 → 테투어", emoji: "📊", color: "orange", aliases: ["ai", "translate", "tetum"] },
                    translate_efg_l4: { title: "AI · 한국어 → 차모로어", emoji: "🧾", color: "red", aliases: ["ai", "translate", "chamorro"] },
                    translate_efg_l5: { title: "AI · 한국어 → 마셜제도어", emoji: "📜", color: "purple", aliases: ["ai", "translate", "marshallese"] },
                    doc_efg_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_efg_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_efg_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_efg_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_efg_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_efv_l1: { title: "AI · 한국어 → 길버트어", emoji: "🧾", color: "yellow", aliases: ["ai", "translate", "gilbertese"] },
                    translate_efv_l2: { title: "AI · 한국어 → 피지어", emoji: "📜", color: "orange", aliases: ["ai", "translate", "fijian"] },
                    translate_efv_l3: { title: "AI · 한국어 → 통가어", emoji: "📣", color: "red", aliases: ["ai", "translate", "tongan"] },
                    translate_efv_l4: { title: "AI · 한국어 → 타히티어", emoji: "🔍", color: "purple", aliases: ["ai", "translate", "tahitian"] },
                    translate_efv_l5: { title: "AI · 한국어 → 마르케사스어", emoji: "🎯", color: "default", aliases: ["ai", "translate", "marquesan"] },
                    doc_efv_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_efv_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_efv_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_efv_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_efv_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_egk_l1: { title: "AI · 한국어 → 라파누이어", emoji: "🔍", color: "orange", aliases: ["ai", "translate", "rapa nui"] },
                    translate_egk_l2: { title: "AI · 한국어 → 비슬라마어", emoji: "🎯", color: "red", aliases: ["ai", "translate", "bislama"] },
                    translate_egk_l3: { title: "AI · 한국어 → 톡피진", emoji: "🧭", color: "purple", aliases: ["ai", "translate", "tok pisin"] },
                    translate_egk_l4: { title: "AI · 한국어 → 히리모투어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "hiri motu"] },
                    translate_egk_l5: { title: "AI · 한국어 → 팔라우어", emoji: "💬", color: "blue", aliases: ["ai", "translate", "palauan"] },
                    doc_egk_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_egk_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_egk_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_egk_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_egk_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_egz_l1: { title: "AI · 한국어 → 야페어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "yapese"] },
                    translate_egz_l2: { title: "AI · 한국어 → 나와틀어", emoji: "💬", color: "purple", aliases: ["ai", "translate", "nahuatl"] },
                    translate_egz_l3: { title: "AI · 한국어 → 케추아어", emoji: "🗺️", color: "default", aliases: ["ai", "translate", "quechua"] },
                    translate_egz_l4: { title: "AI · 한국어 → 아이마라어", emoji: "📝", color: "blue", aliases: ["ai", "translate", "aymara"] },
                    translate_egz_l5: { title: "AI · 한국어 → 과라니어", emoji: "📘", color: "green", aliases: ["ai", "translate", "guarani"] },
                    doc_egz_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_egz_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_egz_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_egz_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_egz_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_eho_l1: { title: "AI · 한국어 → 마푸체어", emoji: "📝", color: "purple", aliases: ["ai", "translate", "mapuche"] },
                    translate_eho_l2: { title: "AI · 한국어 → 이눅티투트어", emoji: "📘", color: "default", aliases: ["ai", "translate", "greenlandic inuktitut"] },
                    translate_eho_l3: { title: "AI · 한국어 → 크리어", emoji: "📙", color: "blue", aliases: ["ai", "translate", "cree"] },
                    translate_eho_l4: { title: "AI · 한국어 → 오지브웨어", emoji: "📚", color: "green", aliases: ["ai", "translate", "ojibwe"] },
                    translate_eho_l5: { title: "AI · 한국어 → 나바호어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "navajo"] },
                    doc_eho_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_eho_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eho_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eho_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eho_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_eid_l1: { title: "AI · 한국어 → 체로키어", emoji: "📚", color: "default", aliases: ["ai", "translate", "cherokee"] },
                    translate_eid_l2: { title: "AI · 한국어 → 하와이어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hawaiian"] },
                    translate_eid_l3: { title: "AI · 한국어 → 마오리어", emoji: "🖋️", color: "green", aliases: ["ai", "translate", "maori"] },
                    translate_eid_l4: { title: "AI · 한국어 → 사모아어", emoji: "📋", color: "yellow", aliases: ["ai", "translate", "samoan"] },
                    translate_eid_l5: { title: "AI · 한국어 → 월로프어", emoji: "📈", color: "orange", aliases: ["ai", "translate", "wolof"] },
                    doc_eid_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eid_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eid_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eid_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eid_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_eis_l1: { title: "AI · 한국어 → 밤바라어", emoji: "📋", color: "blue", aliases: ["ai", "translate", "bambara"] },
                    translate_eis_l2: { title: "AI · 한국어 → 풀라니어", emoji: "📈", color: "green", aliases: ["ai", "translate", "fula"] },
                    translate_eis_l3: { title: "AI · 한국어 → 티그리냐어", emoji: "📊", color: "yellow", aliases: ["ai", "translate", "tigrinya"] },
                    translate_eis_l4: { title: "AI · 한국어 → 암하라어", emoji: "🧾", color: "orange", aliases: ["ai", "translate", "amharic"] },
                    translate_eis_l5: { title: "AI · 한국어 → 소말리아어", emoji: "📜", color: "red", aliases: ["ai", "translate", "somali"] },
                    doc_eis_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eis_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eis_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eis_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_eis_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_ejh_l1: { title: "AI · 한국어 → 오로모어", emoji: "🧾", color: "green", aliases: ["ai", "translate", "oromo"] },
                    translate_ejh_l2: { title: "AI · 한국어 → 쇼나어", emoji: "📜", color: "yellow", aliases: ["ai", "translate", "shona"] },
                    translate_ejh_l3: { title: "AI · 한국어 → 세소토어", emoji: "📣", color: "orange", aliases: ["ai", "translate", "sesotho"] },
                    translate_ejh_l4: { title: "AI · 한국어 → 츠와나어", emoji: "🔍", color: "red", aliases: ["ai", "translate", "tswana"] },
                    translate_ejh_l5: { title: "AI · 한국어 → 키쿠유어", emoji: "🎯", color: "purple", aliases: ["ai", "translate", "kikuyu"] },
                    doc_ejh_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_ejh_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ejh_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ejh_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ejh_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_ejw_l1: { title: "AI · 한국어 → 루간다어", emoji: "🔍", color: "yellow", aliases: ["ai", "translate", "luganda"] },
                    translate_ejw_l2: { title: "AI · 한국어 → 말라가시어", emoji: "🎯", color: "orange", aliases: ["ai", "translate", "malagasy"] },
                    translate_ejw_l3: { title: "AI · 한국어 → 페로어", emoji: "🧭", color: "red", aliases: ["ai", "translate", "faroese"] },
                    translate_ejw_l4: { title: "AI · 한국어 → 그린란드어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "greenlandic"] },
                    translate_ejw_l5: { title: "AI · 한국어 → 룩셈부르크어", emoji: "💬", color: "default", aliases: ["ai", "translate", "luxembourgish"] },
                    doc_ejw_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ejw_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ejw_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ejw_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ejw_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_ekl_l1: { title: "AI · 한국어 → 로망슈어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "romansh"] },
                    translate_ekl_l2: { title: "AI · 한국어 → 사르데냐어", emoji: "💬", color: "red", aliases: ["ai", "translate", "sardinian"] },
                    translate_ekl_l3: { title: "AI · 한국어 → 프리울리아어", emoji: "🗺️", color: "purple", aliases: ["ai", "translate", "friulian"] },
                    translate_ekl_l4: { title: "AI · 한국어 → 옥시탄어", emoji: "📝", color: "default", aliases: ["ai", "translate", "occitan"] },
                    translate_ekl_l5: { title: "AI · 한국어 → 브르탕어", emoji: "📘", color: "blue", aliases: ["ai", "translate", "breton"] },
                    doc_ekl_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ekl_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ekl_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ekl_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_ekl_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_ela_l1: { title: "AI · 한국어 → 코리시어", emoji: "📝", color: "red", aliases: ["ai", "translate", "cornish"] },
                    translate_ela_l2: { title: "AI · 한국어 → 맨섬어", emoji: "📘", color: "purple", aliases: ["ai", "translate", "manx"] },
                    translate_ela_l3: { title: "AI · 한국어 → 갈리시아어", emoji: "📙", color: "default", aliases: ["ai", "translate", "galician"] },
                    translate_ela_l4: { title: "AI · 한국어 → 아스투리아스어", emoji: "📚", color: "blue", aliases: ["ai", "translate", "asturian"] },
                    translate_ela_l5: { title: "AI · 한국어 → 아로마니아어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "aromanian"] },
                    doc_ela_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ela_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ela_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_ela_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_ela_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_elp_l1: { title: "AI · 한국어 → 라디노어", emoji: "📚", color: "purple", aliases: ["ai", "translate", "ladino"] },
                    translate_elp_l2: { title: "AI · 한국어 → 타타르어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "tatar"] },
                    translate_elp_l3: { title: "AI · 한국어 → 바슈키르어", emoji: "🖋️", color: "blue", aliases: ["ai", "translate", "bashkir"] },
                    translate_elp_l4: { title: "AI · 한국어 → 추바쉬어", emoji: "📋", color: "green", aliases: ["ai", "translate", "chuvash"] },
                    translate_elp_l5: { title: "AI · 한국어 → 투바어", emoji: "📈", color: "yellow", aliases: ["ai", "translate", "tuvan"] },
                    doc_elp_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_elp_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_elp_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_elp_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_elp_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_eme_l1: { title: "AI · 한국어 → 부리야트어", emoji: "📋", color: "default", aliases: ["ai", "translate", "buryat"] },
                    translate_eme_l2: { title: "AI · 한국어 → 칼믈크어", emoji: "📈", color: "blue", aliases: ["ai", "translate", "kalmyk"] },
                    translate_eme_l3: { title: "AI · 한국어 → 우드무르트어", emoji: "📊", color: "green", aliases: ["ai", "translate", "udmurt"] },
                    translate_eme_l4: { title: "AI · 한국어 → 마리어", emoji: "🧾", color: "yellow", aliases: ["ai", "translate", "mari"] },
                    translate_eme_l5: { title: "AI · 한국어 → 코미어", emoji: "📜", color: "orange", aliases: ["ai", "translate", "komi"] },
                    doc_eme_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eme_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eme_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eme_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eme_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_emt_l1: { title: "AI · 한국어 → 에르지아어", emoji: "🧾", color: "blue", aliases: ["ai", "translate", "erzya"] },
                    translate_emt_l2: { title: "AI · 한국어 → 북사미어", emoji: "📜", color: "green", aliases: ["ai", "translate", "northern sami"] },
                    translate_emt_l3: { title: "AI · 한국어 → 카렐리아어", emoji: "📣", color: "yellow", aliases: ["ai", "translate", "karelian"] },
                    translate_emt_l4: { title: "AI · 한국어 → 잉구시어", emoji: "🔍", color: "orange", aliases: ["ai", "translate", "ingush"] },
                    translate_emt_l5: { title: "AI · 한국어 → 아바르어", emoji: "🎯", color: "red", aliases: ["ai", "translate", "avar"] },
                    doc_emt_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_emt_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_emt_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_emt_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_emt_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_eni_l1: { title: "AI · 한국어 → 레즈기어", emoji: "🔍", color: "green", aliases: ["ai", "translate", "lezgian"] },
                    translate_eni_l2: { title: "AI · 한국어 → 오세티아어", emoji: "🎯", color: "yellow", aliases: ["ai", "translate", "ossetian"] },
                    translate_eni_l3: { title: "AI · 한국어 → 타지크어", emoji: "🧭", color: "orange", aliases: ["ai", "translate", "tajik"] },
                    translate_eni_l4: { title: "AI · 한국어 → 파슈토어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "pashto"] },
                    translate_eni_l5: { title: "AI · 한국어 → 발로치어", emoji: "💬", color: "purple", aliases: ["ai", "translate", "balochi"] },
                    doc_eni_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eni_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eni_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_eni_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_eni_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_enx_l1: { title: "AI · 한국어 → 소라니쿠르드어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "kurdish sorani"] },
                    translate_enx_l2: { title: "AI · 한국어 → 신디어", emoji: "💬", color: "orange", aliases: ["ai", "translate", "sindhi"] },
                    translate_enx_l3: { title: "AI · 한국어 → 콘카니어", emoji: "🗺️", color: "red", aliases: ["ai", "translate", "konkani"] },
                    translate_enx_l4: { title: "AI · 한국어 → 투루어", emoji: "📝", color: "purple", aliases: ["ai", "translate", "tulu"] },
                    translate_enx_l5: { title: "AI · 한국어 → 산탈리어", emoji: "📘", color: "default", aliases: ["ai", "translate", "santali"] },
                    doc_enx_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_enx_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_enx_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_enx_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_enx_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_eom_l1: { title: "AI · 한국어 → 메이테이어", emoji: "📝", color: "orange", aliases: ["ai", "translate", "meitei"] },
                    translate_eom_l2: { title: "AI · 한국어 → 종카어", emoji: "📘", color: "red", aliases: ["ai", "translate", "dzongkha"] },
                    translate_eom_l3: { title: "AI · 한국어 → 네와르어", emoji: "📙", color: "purple", aliases: ["ai", "translate", "newar"] },
                    translate_eom_l4: { title: "AI · 한국어 → 샨어", emoji: "📚", color: "default", aliases: ["ai", "translate", "shan"] },
                    translate_eom_l5: { title: "AI · 한국어 → 몽어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hmong"] },
                    doc_eom_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_eom_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_eom_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_eom_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eom_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_epb_l1: { title: "AI · 한국어 → 참어", emoji: "📚", color: "red", aliases: ["ai", "translate", "cham"] },
                    translate_epb_l2: { title: "AI · 한국어 → 아체어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "acehnese"] },
                    translate_epb_l3: { title: "AI · 한국어 → 미낭카바우어", emoji: "🖋️", color: "default", aliases: ["ai", "translate", "minangkabau"] },
                    translate_epb_l4: { title: "AI · 한국어 → 부기스어", emoji: "📋", color: "blue", aliases: ["ai", "translate", "buginese"] },
                    translate_epb_l5: { title: "AI · 한국어 → 테투어", emoji: "📈", color: "green", aliases: ["ai", "translate", "tetum"] },
                    doc_epb_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_epb_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_epb_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_epb_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_epb_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_epq_l1: { title: "AI · 한국어 → 차모로어", emoji: "📋", color: "purple", aliases: ["ai", "translate", "chamorro"] },
                    translate_epq_l2: { title: "AI · 한국어 → 마셜제도어", emoji: "📈", color: "default", aliases: ["ai", "translate", "marshallese"] },
                    translate_epq_l3: { title: "AI · 한국어 → 길버트어", emoji: "📊", color: "blue", aliases: ["ai", "translate", "gilbertese"] },
                    translate_epq_l4: { title: "AI · 한국어 → 피지어", emoji: "🧾", color: "green", aliases: ["ai", "translate", "fijian"] },
                    translate_epq_l5: { title: "AI · 한국어 → 통가어", emoji: "📜", color: "yellow", aliases: ["ai", "translate", "tongan"] },
                    doc_epq_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_epq_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_epq_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_epq_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_epq_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_eqf_l1: { title: "AI · 한국어 → 타히티어", emoji: "🧾", color: "default", aliases: ["ai", "translate", "tahitian"] },
                    translate_eqf_l2: { title: "AI · 한국어 → 마르케사스어", emoji: "📜", color: "blue", aliases: ["ai", "translate", "marquesan"] },
                    translate_eqf_l3: { title: "AI · 한국어 → 라파누이어", emoji: "📣", color: "green", aliases: ["ai", "translate", "rapa nui"] },
                    translate_eqf_l4: { title: "AI · 한국어 → 비슬라마어", emoji: "🔍", color: "yellow", aliases: ["ai", "translate", "bislama"] },
                    translate_eqf_l5: { title: "AI · 한국어 → 톡피진", emoji: "🎯", color: "orange", aliases: ["ai", "translate", "tok pisin"] },
                    doc_eqf_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eqf_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eqf_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eqf_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eqf_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_equ_l1: { title: "AI · 한국어 → 히리모투어", emoji: "🔍", color: "blue", aliases: ["ai", "translate", "hiri motu"] },
                    translate_equ_l2: { title: "AI · 한국어 → 팔라우어", emoji: "🎯", color: "green", aliases: ["ai", "translate", "palauan"] },
                    translate_equ_l3: { title: "AI · 한국어 → 야페어", emoji: "🧭", color: "yellow", aliases: ["ai", "translate", "yapese"] },
                    translate_equ_l4: { title: "AI · 한국어 → 나와틀어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "nahuatl"] },
                    translate_equ_l5: { title: "AI · 한국어 → 케추아어", emoji: "💬", color: "red", aliases: ["ai", "translate", "quechua"] },
                    doc_equ_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_equ_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_equ_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_equ_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_equ_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_erj_l1: { title: "AI · 한국어 → 아이마라어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "aymara"] },
                    translate_erj_l2: { title: "AI · 한국어 → 과라니어", emoji: "💬", color: "yellow", aliases: ["ai", "translate", "guarani"] },
                    translate_erj_l3: { title: "AI · 한국어 → 마푸체어", emoji: "🗺️", color: "orange", aliases: ["ai", "translate", "mapuche"] },
                    translate_erj_l4: { title: "AI · 한국어 → 이눅티투트어", emoji: "📝", color: "red", aliases: ["ai", "translate", "greenlandic inuktitut"] },
                    translate_erj_l5: { title: "AI · 한국어 → 크리어", emoji: "📘", color: "purple", aliases: ["ai", "translate", "cree"] },
                    doc_erj_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_erj_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_erj_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_erj_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_erj_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_ery_l1: { title: "AI · 한국어 → 오지브웨어", emoji: "📝", color: "yellow", aliases: ["ai", "translate", "ojibwe"] },
                    translate_ery_l2: { title: "AI · 한국어 → 나바호어", emoji: "📘", color: "orange", aliases: ["ai", "translate", "navajo"] },
                    translate_ery_l3: { title: "AI · 한국어 → 체로키어", emoji: "📙", color: "red", aliases: ["ai", "translate", "cherokee"] },
                    translate_ery_l4: { title: "AI · 한국어 → 하와이어", emoji: "📚", color: "purple", aliases: ["ai", "translate", "hawaiian"] },
                    translate_ery_l5: { title: "AI · 한국어 → 마오리어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "maori"] },
                    doc_ery_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ery_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ery_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ery_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ery_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_esn_l1: { title: "AI · 한국어 → 사모아어", emoji: "📚", color: "orange", aliases: ["ai", "translate", "samoan"] },
                    translate_esn_l2: { title: "AI · 한국어 → 월로프어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "wolof"] },
                    translate_esn_l3: { title: "AI · 한국어 → 밤바라어", emoji: "🖋️", color: "purple", aliases: ["ai", "translate", "bambara"] },
                    translate_esn_l4: { title: "AI · 한국어 → 풀라니어", emoji: "📋", color: "default", aliases: ["ai", "translate", "fula"] },
                    translate_esn_l5: { title: "AI · 한국어 → 티그리냐어", emoji: "📈", color: "blue", aliases: ["ai", "translate", "tigrinya"] },
                    doc_esn_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_esn_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_esn_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_esn_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_esn_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_etc_l1: { title: "AI · 한국어 → 암하라어", emoji: "📋", color: "red", aliases: ["ai", "translate", "amharic"] },
                    translate_etc_l2: { title: "AI · 한국어 → 소말리아어", emoji: "📈", color: "purple", aliases: ["ai", "translate", "somali"] },
                    translate_etc_l3: { title: "AI · 한국어 → 오로모어", emoji: "📊", color: "default", aliases: ["ai", "translate", "oromo"] },
                    translate_etc_l4: { title: "AI · 한국어 → 쇼나어", emoji: "🧾", color: "blue", aliases: ["ai", "translate", "shona"] },
                    translate_etc_l5: { title: "AI · 한국어 → 세소토어", emoji: "📜", color: "green", aliases: ["ai", "translate", "sesotho"] },
                    doc_etc_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_etc_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_etc_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_etc_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_etc_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_etr_l1: { title: "AI · 한국어 → 츠와나어", emoji: "🧾", color: "purple", aliases: ["ai", "translate", "tswana"] },
                    translate_etr_l2: { title: "AI · 한국어 → 키쿠유어", emoji: "📜", color: "default", aliases: ["ai", "translate", "kikuyu"] },
                    translate_etr_l3: { title: "AI · 한국어 → 루간다어", emoji: "📣", color: "blue", aliases: ["ai", "translate", "luganda"] },
                    translate_etr_l4: { title: "AI · 한국어 → 말라가시어", emoji: "🔍", color: "green", aliases: ["ai", "translate", "malagasy"] },
                    translate_etr_l5: { title: "AI · 한국어 → 페로어", emoji: "🎯", color: "yellow", aliases: ["ai", "translate", "faroese"] },
                    doc_etr_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_etr_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_etr_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_etr_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_etr_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_eug_l1: { title: "AI · 한국어 → 그린란드어", emoji: "🔍", color: "default", aliases: ["ai", "translate", "greenlandic"] },
                    translate_eug_l2: { title: "AI · 한국어 → 룩셈부르크어", emoji: "🎯", color: "blue", aliases: ["ai", "translate", "luxembourgish"] },
                    translate_eug_l3: { title: "AI · 한국어 → 로망슈어", emoji: "🧭", color: "green", aliases: ["ai", "translate", "romansh"] },
                    translate_eug_l4: { title: "AI · 한국어 → 사르데냐어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "sardinian"] },
                    translate_eug_l5: { title: "AI · 한국어 → 프리울리아어", emoji: "💬", color: "orange", aliases: ["ai", "translate", "friulian"] },
                    doc_eug_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eug_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eug_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eug_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eug_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_euv_l1: { title: "AI · 한국어 → 옥시탄어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "occitan"] },
                    translate_euv_l2: { title: "AI · 한국어 → 브르탕어", emoji: "💬", color: "green", aliases: ["ai", "translate", "breton"] },
                    translate_euv_l3: { title: "AI · 한국어 → 코리시어", emoji: "🗺️", color: "yellow", aliases: ["ai", "translate", "cornish"] },
                    translate_euv_l4: { title: "AI · 한국어 → 맨섬어", emoji: "📝", color: "orange", aliases: ["ai", "translate", "manx"] },
                    translate_euv_l5: { title: "AI · 한국어 → 갈리시아어", emoji: "📘", color: "red", aliases: ["ai", "translate", "galician"] },
                    doc_euv_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_euv_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_euv_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_euv_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_euv_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_evk_l1: { title: "AI · 한국어 → 아스투리아스어", emoji: "📝", color: "green", aliases: ["ai", "translate", "asturian"] },
                    translate_evk_l2: { title: "AI · 한국어 → 아로마니아어", emoji: "📘", color: "yellow", aliases: ["ai", "translate", "aromanian"] },
                    translate_evk_l3: { title: "AI · 한국어 → 라디노어", emoji: "📙", color: "orange", aliases: ["ai", "translate", "ladino"] },
                    translate_evk_l4: { title: "AI · 한국어 → 타타르어", emoji: "📚", color: "red", aliases: ["ai", "translate", "tatar"] },
                    translate_evk_l5: { title: "AI · 한국어 → 바슈키르어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "bashkir"] },
                    doc_evk_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_evk_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_evk_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_evk_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_evk_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_evz_l1: { title: "AI · 한국어 → 추바쉬어", emoji: "📚", color: "yellow", aliases: ["ai", "translate", "chuvash"] },
                    translate_evz_l2: { title: "AI · 한국어 → 투바어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "tuvan"] },
                    translate_evz_l3: { title: "AI · 한국어 → 부리야트어", emoji: "🖋️", color: "red", aliases: ["ai", "translate", "buryat"] },
                    translate_evz_l4: { title: "AI · 한국어 → 칼믈크어", emoji: "📋", color: "purple", aliases: ["ai", "translate", "kalmyk"] },
                    translate_evz_l5: { title: "AI · 한국어 → 우드무르트어", emoji: "📈", color: "default", aliases: ["ai", "translate", "udmurt"] },
                    doc_evz_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_evz_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_evz_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_evz_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_evz_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_ewo_l1: { title: "AI · 한국어 → 마리어", emoji: "📋", color: "orange", aliases: ["ai", "translate", "mari"] },
                    translate_ewo_l2: { title: "AI · 한국어 → 코미어", emoji: "📈", color: "red", aliases: ["ai", "translate", "komi"] },
                    translate_ewo_l3: { title: "AI · 한국어 → 에르지아어", emoji: "📊", color: "purple", aliases: ["ai", "translate", "erzya"] },
                    translate_ewo_l4: { title: "AI · 한국어 → 북사미어", emoji: "🧾", color: "default", aliases: ["ai", "translate", "northern sami"] },
                    translate_ewo_l5: { title: "AI · 한국어 → 카렐리아어", emoji: "📜", color: "blue", aliases: ["ai", "translate", "karelian"] },
                    doc_ewo_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ewo_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ewo_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ewo_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_ewo_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_exd_l1: { title: "AI · 한국어 → 잉구시어", emoji: "🧾", color: "red", aliases: ["ai", "translate", "ingush"] },
                    translate_exd_l2: { title: "AI · 한국어 → 아바르어", emoji: "📜", color: "purple", aliases: ["ai", "translate", "avar"] },
                    translate_exd_l3: { title: "AI · 한국어 → 레즈기어", emoji: "📣", color: "default", aliases: ["ai", "translate", "lezgian"] },
                    translate_exd_l4: { title: "AI · 한국어 → 오세티아어", emoji: "🔍", color: "blue", aliases: ["ai", "translate", "ossetian"] },
                    translate_exd_l5: { title: "AI · 한국어 → 타지크어", emoji: "🎯", color: "green", aliases: ["ai", "translate", "tajik"] },
                    doc_exd_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_exd_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_exd_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_exd_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_exd_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_exs_l1: { title: "AI · 한국어 → 파슈토어", emoji: "🔍", color: "purple", aliases: ["ai", "translate", "pashto"] },
                    translate_exs_l2: { title: "AI · 한국어 → 발로치어", emoji: "🎯", color: "default", aliases: ["ai", "translate", "balochi"] },
                    translate_exs_l3: { title: "AI · 한국어 → 소라니쿠르드어", emoji: "🧭", color: "blue", aliases: ["ai", "translate", "kurdish sorani"] },
                    translate_exs_l4: { title: "AI · 한국어 → 신디어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "sindhi"] },
                    translate_exs_l5: { title: "AI · 한국어 → 콘카니어", emoji: "💬", color: "yellow", aliases: ["ai", "translate", "konkani"] },
                    doc_exs_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_exs_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_exs_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_exs_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_exs_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_eyh_l1: { title: "AI · 한국어 → 투루어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "tulu"] },
                    translate_eyh_l2: { title: "AI · 한국어 → 산탈리어", emoji: "💬", color: "blue", aliases: ["ai", "translate", "santali"] },
                    translate_eyh_l3: { title: "AI · 한국어 → 메이테이어", emoji: "🗺️", color: "green", aliases: ["ai", "translate", "meitei"] },
                    translate_eyh_l4: { title: "AI · 한국어 → 종카어", emoji: "📝", color: "yellow", aliases: ["ai", "translate", "dzongkha"] },
                    translate_eyh_l5: { title: "AI · 한국어 → 네와르어", emoji: "📘", color: "orange", aliases: ["ai", "translate", "newar"] },
                    doc_eyh_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_eyh_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eyh_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eyh_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eyh_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_eyw_l1: { title: "AI · 한국어 → 샨어", emoji: "📝", color: "blue", aliases: ["ai", "translate", "shan"] },
                    translate_eyw_l2: { title: "AI · 한국어 → 몽어", emoji: "📘", color: "green", aliases: ["ai", "translate", "hmong"] },
                    translate_eyw_l3: { title: "AI · 한국어 → 참어", emoji: "📙", color: "yellow", aliases: ["ai", "translate", "cham"] },
                    translate_eyw_l4: { title: "AI · 한국어 → 아체어", emoji: "📚", color: "orange", aliases: ["ai", "translate", "acehnese"] },
                    translate_eyw_l5: { title: "AI · 한국어 → 미낭카바우어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "minangkabau"] },
                    doc_eyw_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_eyw_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_eyw_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_eyw_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_eyw_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_ezl_l1: { title: "AI · 한국어 → 부기스어", emoji: "📚", color: "green", aliases: ["ai", "translate", "buginese"] },
                    translate_ezl_l2: { title: "AI · 한국어 → 테투어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "tetum"] },
                    translate_ezl_l3: { title: "AI · 한국어 → 차모로어", emoji: "🖋️", color: "orange", aliases: ["ai", "translate", "chamorro"] },
                    translate_ezl_l4: { title: "AI · 한국어 → 마셜제도어", emoji: "📋", color: "red", aliases: ["ai", "translate", "marshallese"] },
                    translate_ezl_l5: { title: "AI · 한국어 → 길버트어", emoji: "📈", color: "purple", aliases: ["ai", "translate", "gilbertese"] },
                    doc_ezl_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_ezl_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ezl_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ezl_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ezl_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_faa_l1: { title: "AI · 한국어 → 페로어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "faroese"] },
                    translate_faa_l2: { title: "AI · 한국어 → 그린란드어", emoji: "💬", color: "blue", aliases: ["ai", "translate", "greenlandic"] },
                    translate_faa_l3: { title: "AI · 한국어 → 룩셈부르크어", emoji: "🗺️", color: "green", aliases: ["ai", "translate", "luxembourgish"] },
                    translate_faa_l4: { title: "AI · 한국어 → 로망슈어", emoji: "📝", color: "yellow", aliases: ["ai", "translate", "romansh"] },
                    translate_faa_l5: { title: "AI · 한국어 → 사르데냐어", emoji: "📘", color: "orange", aliases: ["ai", "translate", "sardinian"] },
                    doc_faa_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_faa_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_faa_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_faa_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_faa_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_faq_l1: { title: "AI · 한국어 → 프리울리아어", emoji: "📝", color: "blue", aliases: ["ai", "translate", "friulian"] },
                    translate_faq_l2: { title: "AI · 한국어 → 옥시탄어", emoji: "📘", color: "green", aliases: ["ai", "translate", "occitan"] },
                    translate_faq_l3: { title: "AI · 한국어 → 브르탕어", emoji: "📙", color: "yellow", aliases: ["ai", "translate", "breton"] },
                    translate_faq_l4: { title: "AI · 한국어 → 코리시어", emoji: "📚", color: "orange", aliases: ["ai", "translate", "cornish"] },
                    translate_faq_l5: { title: "AI · 한국어 → 맨섬어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "manx"] },
                    doc_faq_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_faq_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_faq_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_faq_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_faq_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_fbf_l1: { title: "AI · 한국어 → 갈리시아어", emoji: "📚", color: "green", aliases: ["ai", "translate", "galician"] },
                    translate_fbf_l2: { title: "AI · 한국어 → 아스투리아스어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "asturian"] },
                    translate_fbf_l3: { title: "AI · 한국어 → 아로마니아어", emoji: "🖋️", color: "orange", aliases: ["ai", "translate", "aromanian"] },
                    translate_fbf_l4: { title: "AI · 한국어 → 라디노어", emoji: "📋", color: "red", aliases: ["ai", "translate", "ladino"] },
                    translate_fbf_l5: { title: "AI · 한국어 → 타타르어", emoji: "📈", color: "purple", aliases: ["ai", "translate", "tatar"] },
                    doc_fbf_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fbf_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fbf_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fbf_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fbf_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_fbu_l1: { title: "AI · 한국어 → 바슈키르어", emoji: "📋", color: "yellow", aliases: ["ai", "translate", "bashkir"] },
                    translate_fbu_l2: { title: "AI · 한국어 → 추바쉬어", emoji: "📈", color: "orange", aliases: ["ai", "translate", "chuvash"] },
                    translate_fbu_l3: { title: "AI · 한국어 → 투바어", emoji: "📊", color: "red", aliases: ["ai", "translate", "tuvan"] },
                    translate_fbu_l4: { title: "AI · 한국어 → 부리야트어", emoji: "🧾", color: "purple", aliases: ["ai", "translate", "buryat"] },
                    translate_fbu_l5: { title: "AI · 한국어 → 칼믈크어", emoji: "📜", color: "default", aliases: ["ai", "translate", "kalmyk"] },
                    doc_fbu_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fbu_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fbu_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fbu_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fbu_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_fcj_l1: { title: "AI · 한국어 → 우드무르트어", emoji: "🧾", color: "orange", aliases: ["ai", "translate", "udmurt"] },
                    translate_fcj_l2: { title: "AI · 한국어 → 마리어", emoji: "📜", color: "red", aliases: ["ai", "translate", "mari"] },
                    translate_fcj_l3: { title: "AI · 한국어 → 코미어", emoji: "📣", color: "purple", aliases: ["ai", "translate", "komi"] },
                    translate_fcj_l4: { title: "AI · 한국어 → 에르지아어", emoji: "🔍", color: "default", aliases: ["ai", "translate", "erzya"] },
                    translate_fcj_l5: { title: "AI · 한국어 → 북사미어", emoji: "🎯", color: "blue", aliases: ["ai", "translate", "northern sami"] },
                    doc_fcj_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fcj_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fcj_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fcj_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fcj_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_fcy_l1: { title: "AI · 한국어 → 카렐리아어", emoji: "🔍", color: "red", aliases: ["ai", "translate", "karelian"] },
                    translate_fcy_l2: { title: "AI · 한국어 → 잉구시어", emoji: "🎯", color: "purple", aliases: ["ai", "translate", "ingush"] },
                    translate_fcy_l3: { title: "AI · 한국어 → 아바르어", emoji: "🧭", color: "default", aliases: ["ai", "translate", "avar"] },
                    translate_fcy_l4: { title: "AI · 한국어 → 레즈기어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "lezgian"] },
                    translate_fcy_l5: { title: "AI · 한국어 → 오세티아어", emoji: "💬", color: "green", aliases: ["ai", "translate", "ossetian"] },
                    doc_fcy_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fcy_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fcy_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fcy_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fcy_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_fdn_l1: { title: "AI · 한국어 → 타지크어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "tajik"] },
                    translate_fdn_l2: { title: "AI · 한국어 → 파슈토어", emoji: "💬", color: "default", aliases: ["ai", "translate", "pashto"] },
                    translate_fdn_l3: { title: "AI · 한국어 → 발로치어", emoji: "🗺️", color: "blue", aliases: ["ai", "translate", "balochi"] },
                    translate_fdn_l4: { title: "AI · 한국어 → 소라니쿠르드어", emoji: "📝", color: "green", aliases: ["ai", "translate", "kurdish sorani"] },
                    translate_fdn_l5: { title: "AI · 한국어 → 신디어", emoji: "📘", color: "yellow", aliases: ["ai", "translate", "sindhi"] },
                    doc_fdn_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fdn_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fdn_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fdn_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fdn_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_fec_l1: { title: "AI · 한국어 → 콘카니어", emoji: "📝", color: "default", aliases: ["ai", "translate", "konkani"] },
                    translate_fec_l2: { title: "AI · 한국어 → 투루어", emoji: "📘", color: "blue", aliases: ["ai", "translate", "tulu"] },
                    translate_fec_l3: { title: "AI · 한국어 → 산탈리어", emoji: "📙", color: "green", aliases: ["ai", "translate", "santali"] },
                    translate_fec_l4: { title: "AI · 한국어 → 메이테이어", emoji: "📚", color: "yellow", aliases: ["ai", "translate", "meitei"] },
                    translate_fec_l5: { title: "AI · 한국어 → 종카어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "dzongkha"] },
                    doc_fec_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fec_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fec_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fec_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fec_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_fer_l1: { title: "AI · 한국어 → 네와르어", emoji: "📚", color: "blue", aliases: ["ai", "translate", "newar"] },
                    translate_fer_l2: { title: "AI · 한국어 → 샨어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "shan"] },
                    translate_fer_l3: { title: "AI · 한국어 → 몽어", emoji: "🖋️", color: "yellow", aliases: ["ai", "translate", "hmong"] },
                    translate_fer_l4: { title: "AI · 한국어 → 참어", emoji: "📋", color: "orange", aliases: ["ai", "translate", "cham"] },
                    translate_fer_l5: { title: "AI · 한국어 → 아체어", emoji: "📈", color: "red", aliases: ["ai", "translate", "acehnese"] },
                    doc_fer_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fer_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fer_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fer_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fer_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_ffh_l1: { title: "AI · 한국어 → 미낭카바우어", emoji: "📋", color: "green", aliases: ["ai", "translate", "minangkabau"] },
                    translate_ffh_l2: { title: "AI · 한국어 → 부기스어", emoji: "📈", color: "yellow", aliases: ["ai", "translate", "buginese"] },
                    translate_ffh_l3: { title: "AI · 한국어 → 테투어", emoji: "📊", color: "orange", aliases: ["ai", "translate", "tetum"] },
                    translate_ffh_l4: { title: "AI · 한국어 → 차모로어", emoji: "🧾", color: "red", aliases: ["ai", "translate", "chamorro"] },
                    translate_ffh_l5: { title: "AI · 한국어 → 마셜제도어", emoji: "📜", color: "purple", aliases: ["ai", "translate", "marshallese"] },
                    doc_ffh_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_ffh_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ffh_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ffh_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ffh_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_ffw_l1: { title: "AI · 한국어 → 길버트어", emoji: "🧾", color: "yellow", aliases: ["ai", "translate", "gilbertese"] },
                    translate_ffw_l2: { title: "AI · 한국어 → 피지어", emoji: "📜", color: "orange", aliases: ["ai", "translate", "fijian"] },
                    translate_ffw_l3: { title: "AI · 한국어 → 통가어", emoji: "📣", color: "red", aliases: ["ai", "translate", "tongan"] },
                    translate_ffw_l4: { title: "AI · 한국어 → 타히티어", emoji: "🔍", color: "purple", aliases: ["ai", "translate", "tahitian"] },
                    translate_ffw_l5: { title: "AI · 한국어 → 마르케사스어", emoji: "🎯", color: "default", aliases: ["ai", "translate", "marquesan"] },
                    doc_ffw_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_ffw_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_ffw_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ffw_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ffw_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_fgl_l1: { title: "AI · 한국어 → 라파누이어", emoji: "🔍", color: "orange", aliases: ["ai", "translate", "rapa nui"] },
                    translate_fgl_l2: { title: "AI · 한국어 → 비슬라마어", emoji: "🎯", color: "red", aliases: ["ai", "translate", "bislama"] },
                    translate_fgl_l3: { title: "AI · 한국어 → 톡피진", emoji: "🧭", color: "purple", aliases: ["ai", "translate", "tok pisin"] },
                    translate_fgl_l4: { title: "AI · 한국어 → 히리모투어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "hiri motu"] },
                    translate_fgl_l5: { title: "AI · 한국어 → 팔라우어", emoji: "💬", color: "blue", aliases: ["ai", "translate", "palauan"] },
                    doc_fgl_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fgl_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fgl_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fgl_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fgl_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_fha_l1: { title: "AI · 한국어 → 야페어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "yapese"] },
                    translate_fha_l2: { title: "AI · 한국어 → 나와틀어", emoji: "💬", color: "purple", aliases: ["ai", "translate", "nahuatl"] },
                    translate_fha_l3: { title: "AI · 한국어 → 케추아어", emoji: "🗺️", color: "default", aliases: ["ai", "translate", "quechua"] },
                    translate_fha_l4: { title: "AI · 한국어 → 아이마라어", emoji: "📝", color: "blue", aliases: ["ai", "translate", "aymara"] },
                    translate_fha_l5: { title: "AI · 한국어 → 과라니어", emoji: "📘", color: "green", aliases: ["ai", "translate", "guarani"] },
                    doc_fha_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fha_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fha_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fha_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fha_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_fhp_l1: { title: "AI · 한국어 → 마푸체어", emoji: "📝", color: "purple", aliases: ["ai", "translate", "mapuche"] },
                    translate_fhp_l2: { title: "AI · 한국어 → 이눅티투트어", emoji: "📘", color: "default", aliases: ["ai", "translate", "greenlandic inuktitut"] },
                    translate_fhp_l3: { title: "AI · 한국어 → 크리어", emoji: "📙", color: "blue", aliases: ["ai", "translate", "cree"] },
                    translate_fhp_l4: { title: "AI · 한국어 → 오지브웨어", emoji: "📚", color: "green", aliases: ["ai", "translate", "ojibwe"] },
                    translate_fhp_l5: { title: "AI · 한국어 → 나바호어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "navajo"] },
                    doc_fhp_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fhp_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fhp_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fhp_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fhp_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_fie_l1: { title: "AI · 한국어 → 체로키어", emoji: "📚", color: "default", aliases: ["ai", "translate", "cherokee"] },
                    translate_fie_l2: { title: "AI · 한국어 → 하와이어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hawaiian"] },
                    translate_fie_l3: { title: "AI · 한국어 → 마오리어", emoji: "🖋️", color: "green", aliases: ["ai", "translate", "maori"] },
                    translate_fie_l4: { title: "AI · 한국어 → 사모아어", emoji: "📋", color: "yellow", aliases: ["ai", "translate", "samoan"] },
                    translate_fie_l5: { title: "AI · 한국어 → 월로프어", emoji: "📈", color: "orange", aliases: ["ai", "translate", "wolof"] },
                    doc_fie_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fie_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fie_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fie_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fie_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_fit_l1: { title: "AI · 한국어 → 밤바라어", emoji: "📋", color: "blue", aliases: ["ai", "translate", "bambara"] },
                    translate_fit_l2: { title: "AI · 한국어 → 풀라니어", emoji: "📈", color: "green", aliases: ["ai", "translate", "fula"] },
                    translate_fit_l3: { title: "AI · 한국어 → 티그리냐어", emoji: "📊", color: "yellow", aliases: ["ai", "translate", "tigrinya"] },
                    translate_fit_l4: { title: "AI · 한국어 → 암하라어", emoji: "🧾", color: "orange", aliases: ["ai", "translate", "amharic"] },
                    translate_fit_l5: { title: "AI · 한국어 → 소말리아어", emoji: "📜", color: "red", aliases: ["ai", "translate", "somali"] },
                    doc_fit_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fit_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fit_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fit_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fit_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_fji_l1: { title: "AI · 한국어 → 오로모어", emoji: "🧾", color: "green", aliases: ["ai", "translate", "oromo"] },
                    translate_fji_l2: { title: "AI · 한국어 → 쇼나어", emoji: "📜", color: "yellow", aliases: ["ai", "translate", "shona"] },
                    translate_fji_l3: { title: "AI · 한국어 → 세소토어", emoji: "📣", color: "orange", aliases: ["ai", "translate", "sesotho"] },
                    translate_fji_l4: { title: "AI · 한국어 → 츠와나어", emoji: "🔍", color: "red", aliases: ["ai", "translate", "tswana"] },
                    translate_fji_l5: { title: "AI · 한국어 → 키쿠유어", emoji: "🎯", color: "purple", aliases: ["ai", "translate", "kikuyu"] },
                    doc_fji_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fji_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fji_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fji_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fji_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_fjx_l1: { title: "AI · 한국어 → 루간다어", emoji: "🔍", color: "yellow", aliases: ["ai", "translate", "luganda"] },
                    translate_fjx_l2: { title: "AI · 한국어 → 말라가시어", emoji: "🎯", color: "orange", aliases: ["ai", "translate", "malagasy"] },
                    translate_fjx_l3: { title: "AI · 한국어 → 페로어", emoji: "🧭", color: "red", aliases: ["ai", "translate", "faroese"] },
                    translate_fjx_l4: { title: "AI · 한국어 → 그린란드어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "greenlandic"] },
                    translate_fjx_l5: { title: "AI · 한국어 → 룩셈부르크어", emoji: "💬", color: "default", aliases: ["ai", "translate", "luxembourgish"] },
                    doc_fjx_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fjx_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fjx_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fjx_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fjx_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_fkm_l1: { title: "AI · 한국어 → 로망슈어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "romansh"] },
                    translate_fkm_l2: { title: "AI · 한국어 → 사르데냐어", emoji: "💬", color: "red", aliases: ["ai", "translate", "sardinian"] },
                    translate_fkm_l3: { title: "AI · 한국어 → 프리울리아어", emoji: "🗺️", color: "purple", aliases: ["ai", "translate", "friulian"] },
                    translate_fkm_l4: { title: "AI · 한국어 → 옥시탄어", emoji: "📝", color: "default", aliases: ["ai", "translate", "occitan"] },
                    translate_fkm_l5: { title: "AI · 한국어 → 브르탕어", emoji: "📘", color: "blue", aliases: ["ai", "translate", "breton"] },
                    doc_fkm_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fkm_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fkm_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fkm_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fkm_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_flb_l1: { title: "AI · 한국어 → 코리시어", emoji: "📝", color: "red", aliases: ["ai", "translate", "cornish"] },
                    translate_flb_l2: { title: "AI · 한국어 → 맨섬어", emoji: "📘", color: "purple", aliases: ["ai", "translate", "manx"] },
                    translate_flb_l3: { title: "AI · 한국어 → 갈리시아어", emoji: "📙", color: "default", aliases: ["ai", "translate", "galician"] },
                    translate_flb_l4: { title: "AI · 한국어 → 아스투리아스어", emoji: "📚", color: "blue", aliases: ["ai", "translate", "asturian"] },
                    translate_flb_l5: { title: "AI · 한국어 → 아로마니아어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "aromanian"] },
                    doc_flb_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_flb_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_flb_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_flb_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_flb_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_flq_l1: { title: "AI · 한국어 → 라디노어", emoji: "📚", color: "purple", aliases: ["ai", "translate", "ladino"] },
                    translate_flq_l2: { title: "AI · 한국어 → 타타르어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "tatar"] },
                    translate_flq_l3: { title: "AI · 한국어 → 바슈키르어", emoji: "🖋️", color: "blue", aliases: ["ai", "translate", "bashkir"] },
                    translate_flq_l4: { title: "AI · 한국어 → 추바쉬어", emoji: "📋", color: "green", aliases: ["ai", "translate", "chuvash"] },
                    translate_flq_l5: { title: "AI · 한국어 → 투바어", emoji: "📈", color: "yellow", aliases: ["ai", "translate", "tuvan"] },
                    doc_flq_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_flq_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_flq_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_flq_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_flq_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_fmf_l1: { title: "AI · 한국어 → 부리야트어", emoji: "📋", color: "default", aliases: ["ai", "translate", "buryat"] },
                    translate_fmf_l2: { title: "AI · 한국어 → 칼믈크어", emoji: "📈", color: "blue", aliases: ["ai", "translate", "kalmyk"] },
                    translate_fmf_l3: { title: "AI · 한국어 → 우드무르트어", emoji: "📊", color: "green", aliases: ["ai", "translate", "udmurt"] },
                    translate_fmf_l4: { title: "AI · 한국어 → 마리어", emoji: "🧾", color: "yellow", aliases: ["ai", "translate", "mari"] },
                    translate_fmf_l5: { title: "AI · 한국어 → 코미어", emoji: "📜", color: "orange", aliases: ["ai", "translate", "komi"] },
                    doc_fmf_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fmf_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fmf_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fmf_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fmf_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_fmu_l1: { title: "AI · 한국어 → 에르지아어", emoji: "🧾", color: "blue", aliases: ["ai", "translate", "erzya"] },
                    translate_fmu_l2: { title: "AI · 한국어 → 북사미어", emoji: "📜", color: "green", aliases: ["ai", "translate", "northern sami"] },
                    translate_fmu_l3: { title: "AI · 한국어 → 카렐리아어", emoji: "📣", color: "yellow", aliases: ["ai", "translate", "karelian"] },
                    translate_fmu_l4: { title: "AI · 한국어 → 잉구시어", emoji: "🔍", color: "orange", aliases: ["ai", "translate", "ingush"] },
                    translate_fmu_l5: { title: "AI · 한국어 → 아바르어", emoji: "🎯", color: "red", aliases: ["ai", "translate", "avar"] },
                    doc_fmu_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fmu_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fmu_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fmu_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fmu_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_fnj_l1: { title: "AI · 한국어 → 레즈기어", emoji: "🔍", color: "green", aliases: ["ai", "translate", "lezgian"] },
                    translate_fnj_l2: { title: "AI · 한국어 → 오세티아어", emoji: "🎯", color: "yellow", aliases: ["ai", "translate", "ossetian"] },
                    translate_fnj_l3: { title: "AI · 한국어 → 타지크어", emoji: "🧭", color: "orange", aliases: ["ai", "translate", "tajik"] },
                    translate_fnj_l4: { title: "AI · 한국어 → 파슈토어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "pashto"] },
                    translate_fnj_l5: { title: "AI · 한국어 → 발로치어", emoji: "💬", color: "purple", aliases: ["ai", "translate", "balochi"] },
                    doc_fnj_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fnj_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fnj_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fnj_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fnj_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_fny_l1: { title: "AI · 한국어 → 소라니쿠르드어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "kurdish sorani"] },
                    translate_fny_l2: { title: "AI · 한국어 → 신디어", emoji: "💬", color: "orange", aliases: ["ai", "translate", "sindhi"] },
                    translate_fny_l3: { title: "AI · 한국어 → 콘카니어", emoji: "🗺️", color: "red", aliases: ["ai", "translate", "konkani"] },
                    translate_fny_l4: { title: "AI · 한국어 → 투루어", emoji: "📝", color: "purple", aliases: ["ai", "translate", "tulu"] },
                    translate_fny_l5: { title: "AI · 한국어 → 산탈리어", emoji: "📘", color: "default", aliases: ["ai", "translate", "santali"] },
                    doc_fny_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fny_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fny_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fny_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fny_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_fon_l1: { title: "AI · 한국어 → 메이테이어", emoji: "📝", color: "orange", aliases: ["ai", "translate", "meitei"] },
                    translate_fon_l2: { title: "AI · 한국어 → 종카어", emoji: "📘", color: "red", aliases: ["ai", "translate", "dzongkha"] },
                    translate_fon_l3: { title: "AI · 한국어 → 네와르어", emoji: "📙", color: "purple", aliases: ["ai", "translate", "newar"] },
                    translate_fon_l4: { title: "AI · 한국어 → 샨어", emoji: "📚", color: "default", aliases: ["ai", "translate", "shan"] },
                    translate_fon_l5: { title: "AI · 한국어 → 몽어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "hmong"] },
                    doc_fon_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fon_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fon_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fon_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fon_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_fpc_l1: { title: "AI · 한국어 → 참어", emoji: "📚", color: "red", aliases: ["ai", "translate", "cham"] },
                    translate_fpc_l2: { title: "AI · 한국어 → 아체어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "acehnese"] },
                    translate_fpc_l3: { title: "AI · 한국어 → 미낭카바우어", emoji: "🖋️", color: "default", aliases: ["ai", "translate", "minangkabau"] },
                    translate_fpc_l4: { title: "AI · 한국어 → 부기스어", emoji: "📋", color: "blue", aliases: ["ai", "translate", "buginese"] },
                    translate_fpc_l5: { title: "AI · 한국어 → 테투어", emoji: "📈", color: "green", aliases: ["ai", "translate", "tetum"] },
                    doc_fpc_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fpc_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fpc_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fpc_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fpc_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_fpr_l1: { title: "AI · 한국어 → 차모로어", emoji: "📋", color: "purple", aliases: ["ai", "translate", "chamorro"] },
                    translate_fpr_l2: { title: "AI · 한국어 → 마셜제도어", emoji: "📈", color: "default", aliases: ["ai", "translate", "marshallese"] },
                    translate_fpr_l3: { title: "AI · 한국어 → 길버트어", emoji: "📊", color: "blue", aliases: ["ai", "translate", "gilbertese"] },
                    translate_fpr_l4: { title: "AI · 한국어 → 피지어", emoji: "🧾", color: "green", aliases: ["ai", "translate", "fijian"] },
                    translate_fpr_l5: { title: "AI · 한국어 → 통가어", emoji: "📜", color: "yellow", aliases: ["ai", "translate", "tongan"] },
                    doc_fpr_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fpr_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fpr_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fpr_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fpr_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_fqg_l1: { title: "AI · 한국어 → 타히티어", emoji: "🧾", color: "default", aliases: ["ai", "translate", "tahitian"] },
                    translate_fqg_l2: { title: "AI · 한국어 → 마르케사스어", emoji: "📜", color: "blue", aliases: ["ai", "translate", "marquesan"] },
                    translate_fqg_l3: { title: "AI · 한국어 → 라파누이어", emoji: "📣", color: "green", aliases: ["ai", "translate", "rapa nui"] },
                    translate_fqg_l4: { title: "AI · 한국어 → 비슬라마어", emoji: "🔍", color: "yellow", aliases: ["ai", "translate", "bislama"] },
                    translate_fqg_l5: { title: "AI · 한국어 → 톡피진", emoji: "🎯", color: "orange", aliases: ["ai", "translate", "tok pisin"] },
                    doc_fqg_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fqg_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fqg_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fqg_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fqg_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_fqv_l1: { title: "AI · 한국어 → 히리모투어", emoji: "🔍", color: "blue", aliases: ["ai", "translate", "hiri motu"] },
                    translate_fqv_l2: { title: "AI · 한국어 → 팔라우어", emoji: "🎯", color: "green", aliases: ["ai", "translate", "palauan"] },
                    translate_fqv_l3: { title: "AI · 한국어 → 야페어", emoji: "🧭", color: "yellow", aliases: ["ai", "translate", "yapese"] },
                    translate_fqv_l4: { title: "AI · 한국어 → 나와틀어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "nahuatl"] },
                    translate_fqv_l5: { title: "AI · 한국어 → 케추아어", emoji: "💬", color: "red", aliases: ["ai", "translate", "quechua"] },
                    doc_fqv_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fqv_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fqv_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fqv_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fqv_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_frk_l1: { title: "AI · 한국어 → 아이마라어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "aymara"] },
                    translate_frk_l2: { title: "AI · 한국어 → 과라니어", emoji: "💬", color: "yellow", aliases: ["ai", "translate", "guarani"] },
                    translate_frk_l3: { title: "AI · 한국어 → 마푸체어", emoji: "🗺️", color: "orange", aliases: ["ai", "translate", "mapuche"] },
                    translate_frk_l4: { title: "AI · 한국어 → 이눅티투트어", emoji: "📝", color: "red", aliases: ["ai", "translate", "greenlandic inuktitut"] },
                    translate_frk_l5: { title: "AI · 한국어 → 크리어", emoji: "📘", color: "purple", aliases: ["ai", "translate", "cree"] },
                    doc_frk_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_frk_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_frk_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_frk_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_frk_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_frz_l1: { title: "AI · 한국어 → 오지브웨어", emoji: "📝", color: "yellow", aliases: ["ai", "translate", "ojibwe"] },
                    translate_frz_l2: { title: "AI · 한국어 → 나바호어", emoji: "📘", color: "orange", aliases: ["ai", "translate", "navajo"] },
                    translate_frz_l3: { title: "AI · 한국어 → 체로키어", emoji: "📙", color: "red", aliases: ["ai", "translate", "cherokee"] },
                    translate_frz_l4: { title: "AI · 한국어 → 하와이어", emoji: "📚", color: "purple", aliases: ["ai", "translate", "hawaiian"] },
                    translate_frz_l5: { title: "AI · 한국어 → 마오리어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "maori"] },
                    doc_frz_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_frz_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_frz_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_frz_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_frz_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_fso_l1: { title: "AI · 한국어 → 사모아어", emoji: "📚", color: "orange", aliases: ["ai", "translate", "samoan"] },
                    translate_fso_l2: { title: "AI · 한국어 → 월로프어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "wolof"] },
                    translate_fso_l3: { title: "AI · 한국어 → 밤바라어", emoji: "🖋️", color: "purple", aliases: ["ai", "translate", "bambara"] },
                    translate_fso_l4: { title: "AI · 한국어 → 풀라니어", emoji: "📋", color: "default", aliases: ["ai", "translate", "fula"] },
                    translate_fso_l5: { title: "AI · 한국어 → 티그리냐어", emoji: "📈", color: "blue", aliases: ["ai", "translate", "tigrinya"] },
                    doc_fso_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fso_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fso_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fso_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fso_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_ftd_l1: { title: "AI · 한국어 → 암하라어", emoji: "📋", color: "red", aliases: ["ai", "translate", "amharic"] },
                    translate_ftd_l2: { title: "AI · 한국어 → 소말리아어", emoji: "📈", color: "purple", aliases: ["ai", "translate", "somali"] },
                    translate_ftd_l3: { title: "AI · 한국어 → 오로모어", emoji: "📊", color: "default", aliases: ["ai", "translate", "oromo"] },
                    translate_ftd_l4: { title: "AI · 한국어 → 쇼나어", emoji: "🧾", color: "blue", aliases: ["ai", "translate", "shona"] },
                    translate_ftd_l5: { title: "AI · 한국어 → 세소토어", emoji: "📜", color: "green", aliases: ["ai", "translate", "sesotho"] },
                    doc_ftd_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_ftd_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_ftd_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_ftd_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_ftd_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_fts_l1: { title: "AI · 한국어 → 츠와나어", emoji: "🧾", color: "purple", aliases: ["ai", "translate", "tswana"] },
                    translate_fts_l2: { title: "AI · 한국어 → 키쿠유어", emoji: "📜", color: "default", aliases: ["ai", "translate", "kikuyu"] },
                    translate_fts_l3: { title: "AI · 한국어 → 루간다어", emoji: "📣", color: "blue", aliases: ["ai", "translate", "luganda"] },
                    translate_fts_l4: { title: "AI · 한국어 → 말라가시어", emoji: "🔍", color: "green", aliases: ["ai", "translate", "malagasy"] },
                    translate_fts_l5: { title: "AI · 한국어 → 페로어", emoji: "🎯", color: "yellow", aliases: ["ai", "translate", "faroese"] },
                    doc_fts_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fts_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fts_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fts_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fts_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_fuh_l1: { title: "AI · 한국어 → 그린란드어", emoji: "🔍", color: "default", aliases: ["ai", "translate", "greenlandic"] },
                    translate_fuh_l2: { title: "AI · 한국어 → 룩셈부르크어", emoji: "🎯", color: "blue", aliases: ["ai", "translate", "luxembourgish"] },
                    translate_fuh_l3: { title: "AI · 한국어 → 로망슈어", emoji: "🧭", color: "green", aliases: ["ai", "translate", "romansh"] },
                    translate_fuh_l4: { title: "AI · 한국어 → 사르데냐어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "sardinian"] },
                    translate_fuh_l5: { title: "AI · 한국어 → 프리울리아어", emoji: "💬", color: "orange", aliases: ["ai", "translate", "friulian"] },
                    doc_fuh_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fuh_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fuh_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fuh_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fuh_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_fuw_l1: { title: "AI · 한국어 → 옥시탄어", emoji: "🌐", color: "blue", aliases: ["ai", "translate", "occitan"] },
                    translate_fuw_l2: { title: "AI · 한국어 → 브르탕어", emoji: "💬", color: "green", aliases: ["ai", "translate", "breton"] },
                    translate_fuw_l3: { title: "AI · 한국어 → 코리시어", emoji: "🗺️", color: "yellow", aliases: ["ai", "translate", "cornish"] },
                    translate_fuw_l4: { title: "AI · 한국어 → 맨섬어", emoji: "📝", color: "orange", aliases: ["ai", "translate", "manx"] },
                    translate_fuw_l5: { title: "AI · 한국어 → 갈리시아어", emoji: "📘", color: "red", aliases: ["ai", "translate", "galician"] },
                    doc_fuw_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fuw_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fuw_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fuw_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fuw_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_fvl_l1: { title: "AI · 한국어 → 아스투리아스어", emoji: "📝", color: "green", aliases: ["ai", "translate", "asturian"] },
                    translate_fvl_l2: { title: "AI · 한국어 → 아로마니아어", emoji: "📘", color: "yellow", aliases: ["ai", "translate", "aromanian"] },
                    translate_fvl_l3: { title: "AI · 한국어 → 라디노어", emoji: "📙", color: "orange", aliases: ["ai", "translate", "ladino"] },
                    translate_fvl_l4: { title: "AI · 한국어 → 타타르어", emoji: "📚", color: "red", aliases: ["ai", "translate", "tatar"] },
                    translate_fvl_l5: { title: "AI · 한국어 → 바슈키르어", emoji: "🌐", color: "purple", aliases: ["ai", "translate", "bashkir"] },
                    doc_fvl_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fvl_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fvl_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fvl_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fvl_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_fwa_l1: { title: "AI · 한국어 → 추바쉬어", emoji: "📚", color: "yellow", aliases: ["ai", "translate", "chuvash"] },
                    translate_fwa_l2: { title: "AI · 한국어 → 투바어", emoji: "🌐", color: "orange", aliases: ["ai", "translate", "tuvan"] },
                    translate_fwa_l3: { title: "AI · 한국어 → 부리야트어", emoji: "🖋️", color: "red", aliases: ["ai", "translate", "buryat"] },
                    translate_fwa_l4: { title: "AI · 한국어 → 칼믈크어", emoji: "📋", color: "purple", aliases: ["ai", "translate", "kalmyk"] },
                    translate_fwa_l5: { title: "AI · 한국어 → 우드무르트어", emoji: "📈", color: "default", aliases: ["ai", "translate", "udmurt"] },
                    doc_fwa_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fwa_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fwa_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fwa_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fwa_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    translate_fwp_l1: { title: "AI · 한국어 → 마리어", emoji: "📋", color: "orange", aliases: ["ai", "translate", "mari"] },
                    translate_fwp_l2: { title: "AI · 한국어 → 코미어", emoji: "📈", color: "red", aliases: ["ai", "translate", "komi"] },
                    translate_fwp_l3: { title: "AI · 한국어 → 에르지아어", emoji: "📊", color: "purple", aliases: ["ai", "translate", "erzya"] },
                    translate_fwp_l4: { title: "AI · 한국어 → 북사미어", emoji: "🧾", color: "default", aliases: ["ai", "translate", "northern sami"] },
                    translate_fwp_l5: { title: "AI · 한국어 → 카렐리아어", emoji: "📜", color: "blue", aliases: ["ai", "translate", "karelian"] },
                    doc_fwp_d1: { title: "AI · 로드맵 개요 (한)", emoji: "📣", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fwp_d2: { title: "AI · 스프린트 회고 (한)", emoji: "🔍", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fwp_d3: { title: "AI · 의사결정 메모 (한)", emoji: "🎯", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fwp_d4: { title: "AI · FAQ 문서 (한)", emoji: "🧭", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fwp_d5: { title: "AI · 보도자료 (한)", emoji: "🌐", color: "orange", aliases: ["ai", "doc", "korean"] },
                    translate_fxe_l1: { title: "AI · 한국어 → 잉구시어", emoji: "🧾", color: "red", aliases: ["ai", "translate", "ingush"] },
                    translate_fxe_l2: { title: "AI · 한국어 → 아바르어", emoji: "📜", color: "purple", aliases: ["ai", "translate", "avar"] },
                    translate_fxe_l3: { title: "AI · 한국어 → 레즈기어", emoji: "📣", color: "default", aliases: ["ai", "translate", "lezgian"] },
                    translate_fxe_l4: { title: "AI · 한국어 → 오세티아어", emoji: "🔍", color: "blue", aliases: ["ai", "translate", "ossetian"] },
                    translate_fxe_l5: { title: "AI · 한국어 → 타지크어", emoji: "🎯", color: "green", aliases: ["ai", "translate", "tajik"] },
                    doc_fxe_d1: { title: "AI · 기능 스펙 문서 (한)", emoji: "🧭", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fxe_d2: { title: "AI · 해지/종료 안내문 (한)", emoji: "🌐", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fxe_d3: { title: "AI · 가격 제안서 (한)", emoji: "💬", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fxe_d4: { title: "AI · 백로그 개요 (한)", emoji: "🗺️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fxe_d5: { title: "AI · 고객 설문 설계 (한)", emoji: "📝", color: "red", aliases: ["ai", "doc", "korean"] },
                    translate_fxt_l1: { title: "AI · 한국어 → 파슈토어", emoji: "🔍", color: "purple", aliases: ["ai", "translate", "pashto"] },
                    translate_fxt_l2: { title: "AI · 한국어 → 발로치어", emoji: "🎯", color: "default", aliases: ["ai", "translate", "balochi"] },
                    translate_fxt_l3: { title: "AI · 한국어 → 소라니쿠르드어", emoji: "🧭", color: "blue", aliases: ["ai", "translate", "kurdish sorani"] },
                    translate_fxt_l4: { title: "AI · 한국어 → 신디어", emoji: "🌐", color: "green", aliases: ["ai", "translate", "sindhi"] },
                    translate_fxt_l5: { title: "AI · 한국어 → 콘카니어", emoji: "💬", color: "yellow", aliases: ["ai", "translate", "konkani"] },
                    doc_fxt_d1: { title: "AI · 대외 발표 소개글 (한)", emoji: "🗺️", color: "green", aliases: ["ai", "doc", "korean"] },
                    doc_fxt_d2: { title: "AI · 분기 사업 리뷰(QBR) (한)", emoji: "📝", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fxt_d3: { title: "AI · 장애 회고 (한)", emoji: "📘", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fxt_d4: { title: "AI · 뉴스레터 초안 (한)", emoji: "📙", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fxt_d5: { title: "AI · 면접 평가표 (한)", emoji: "📚", color: "purple", aliases: ["ai", "doc", "korean"] },
                    translate_fyi_l1: { title: "AI · 한국어 → 투루어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "tulu"] },
                    translate_fyi_l2: { title: "AI · 한국어 → 산탈리어", emoji: "💬", color: "blue", aliases: ["ai", "translate", "santali"] },
                    translate_fyi_l3: { title: "AI · 한국어 → 메이테이어", emoji: "🗺️", color: "green", aliases: ["ai", "translate", "meitei"] },
                    translate_fyi_l4: { title: "AI · 한국어 → 종카어", emoji: "📝", color: "yellow", aliases: ["ai", "translate", "dzongkha"] },
                    translate_fyi_l5: { title: "AI · 한국어 → 네와르어", emoji: "📘", color: "orange", aliases: ["ai", "translate", "newar"] },
                    doc_fyi_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_fyi_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fyi_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fyi_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fyi_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_fyx_l1: { title: "AI · 한국어 → 샨어", emoji: "📝", color: "blue", aliases: ["ai", "translate", "shan"] },
                    translate_fyx_l2: { title: "AI · 한국어 → 몽어", emoji: "📘", color: "green", aliases: ["ai", "translate", "hmong"] },
                    translate_fyx_l3: { title: "AI · 한국어 → 참어", emoji: "📙", color: "yellow", aliases: ["ai", "translate", "cham"] },
                    translate_fyx_l4: { title: "AI · 한국어 → 아체어", emoji: "📚", color: "orange", aliases: ["ai", "translate", "acehnese"] },
                    translate_fyx_l5: { title: "AI · 한국어 → 미낭카바우어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "minangkabau"] },
                    doc_fyx_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_fyx_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fyx_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fyx_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fyx_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "blue", aliases: ["ai", "doc", "korean"] },
                    translate_fzm_l1: { title: "AI · 한국어 → 부기스어", emoji: "📚", color: "green", aliases: ["ai", "translate", "buginese"] },
                    translate_fzm_l2: { title: "AI · 한국어 → 테투어", emoji: "🌐", color: "yellow", aliases: ["ai", "translate", "tetum"] },
                    translate_fzm_l3: { title: "AI · 한국어 → 차모로어", emoji: "🖋️", color: "orange", aliases: ["ai", "translate", "chamorro"] },
                    translate_fzm_l4: { title: "AI · 한국어 → 마셜제도어", emoji: "📋", color: "red", aliases: ["ai", "translate", "marshallese"] },
                    translate_fzm_l5: { title: "AI · 한국어 → 길버트어", emoji: "📈", color: "purple", aliases: ["ai", "translate", "gilbertese"] },
                    doc_fzm_d1: { title: "AI · OKR 초안 (한)", emoji: "📊", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_fzm_d2: { title: "AI · 기술 설계 문서 (한)", emoji: "🧾", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_fzm_d3: { title: "AI · 사용자 인터뷰 스크립트 (한)", emoji: "📜", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_fzm_d4: { title: "AI · 경쟁사 분석 (한)", emoji: "📣", color: "blue", aliases: ["ai", "doc", "korean"] },
                    doc_fzm_d5: { title: "AI · 에스컬레이션 메일 (한)", emoji: "🔍", color: "green", aliases: ["ai", "doc", "korean"] },
                    translate_gaa_l1: { title: "AI · 한국어 → 페로어", emoji: "🌐", color: "default", aliases: ["ai", "translate", "faroese"] },
                    translate_gaa_l2: { title: "AI · 한국어 → 그린란드어", emoji: "💬", color: "blue", aliases: ["ai", "translate", "greenlandic"] },
                    translate_gaa_l3: { title: "AI · 한국어 → 룩셈부르크어", emoji: "🗺️", color: "green", aliases: ["ai", "translate", "luxembourgish"] },
                    translate_gaa_l4: { title: "AI · 한국어 → 로망슈어", emoji: "📝", color: "yellow", aliases: ["ai", "translate", "romansh"] },
                    translate_gaa_l5: { title: "AI · 한국어 → 사르데냐어", emoji: "📘", color: "orange", aliases: ["ai", "translate", "sardinian"] },
                    doc_gaa_d1: { title: "AI · 기획 제안서 (한)", emoji: "📙", color: "yellow", aliases: ["ai", "doc", "korean"] },
                    doc_gaa_d2: { title: "AI · 주간 업무 보고 (한)", emoji: "📚", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_gaa_d3: { title: "AI · 회의록 (한)", emoji: "🌐", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_gaa_d4: { title: "AI · 제품 요구사항 문서(PRD) (한)", emoji: "🖋️", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_gaa_d5: { title: "AI · 고객 응대 스크립트 (한)", emoji: "📋", color: "default", aliases: ["ai", "doc", "korean"] },
                    translate_gap_l1: { title: "AI · 한국어 → 프리울리아어", emoji: "📝", color: "blue", aliases: ["ai", "translate", "friulian"] },
                    translate_gap_l2: { title: "AI · 한국어 → 옥시탄어", emoji: "📘", color: "green", aliases: ["ai", "translate", "occitan"] },
                    translate_gap_l3: { title: "AI · 한국어 → 브르탕어", emoji: "📙", color: "yellow", aliases: ["ai", "translate", "breton"] },
                    translate_gap_l4: { title: "AI · 한국어 → 코리시어", emoji: "📚", color: "orange", aliases: ["ai", "translate", "cornish"] },
                    translate_gap_l5: { title: "AI · 한국어 → 맨섬어", emoji: "🌐", color: "red", aliases: ["ai", "translate", "manx"] },
                    doc_gap_d1: { title: "AI · 배포 노트 (한)", emoji: "🖋️", color: "orange", aliases: ["ai", "doc", "korean"] },
                    doc_gap_d2: { title: "AI · 채용 공고 (한)", emoji: "📋", color: "red", aliases: ["ai", "doc", "korean"] },
                    doc_gap_d3: { title: "AI · 영업 제안 메일 (한)", emoji: "📈", color: "purple", aliases: ["ai", "doc", "korean"] },
                    doc_gap_d4: { title: "AI · 온보딩 가이드 (한)", emoji: "📊", color: "default", aliases: ["ai", "doc", "korean"] },
                    doc_gap_d5: { title: "AI · 성과 평가 자기서술 (한)", emoji: "🧾", color: "blue", aliases: ["ai", "doc", "korean"] },
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

const EMOJI_LIB: { name: string; emoji: string; keywords?: string }[] = [
  { name: "smile", emoji: "😄" }, { name: "laugh", emoji: "😂" },
  { name: "wink", emoji: "😉" }, { name: "thinking", emoji: "🤔" },
  { name: "shrug", emoji: "🤷" }, { name: "eyes", emoji: "👀" },
  { name: "sad", emoji: "😢" }, { name: "angry", emoji: "😠" },
  { name: "sweat", emoji: "😅" }, { name: "pray", emoji: "🙏" },
  { name: "muscle", emoji: "💪" }, { name: "brain", emoji: "🧠" },
  { name: "heart", emoji: "❤️" }, { name: "thumbsup", emoji: "👍" },
  { name: "thumbsdown", emoji: "👎" }, { name: "clap", emoji: "👏" },
  { name: "fire", emoji: "🔥" }, { name: "rocket", emoji: "🚀" },
  { name: "tada", emoji: "🎉" }, { name: "party", emoji: "🥳" },
  { name: "check", emoji: "✅" }, { name: "cross", emoji: "❌" },
  { name: "warning", emoji: "⚠️" }, { name: "star", emoji: "⭐" },
  { name: "sparkles", emoji: "✨" }, { name: "bulb", emoji: "💡" },
  { name: "memo", emoji: "📝" }, { name: "pin", emoji: "📌" },
  { name: "link", emoji: "🔗" }, { name: "zap", emoji: "⚡" },
  { name: "calendar", emoji: "📅" }, { name: "clock", emoji: "⏰" },
  { name: "phone", emoji: "📱" }, { name: "mag", emoji: "🔍" },
  { name: "chart", emoji: "📊" }, { name: "bug", emoji: "🐛" },
  { name: "wrench", emoji: "🔧" }, { name: "lock", emoji: "🔒" },
  { name: "unlock", emoji: "🔓" }, { name: "coffee", emoji: "☕" },
  { name: "pizza", emoji: "🍕" }, { name: "cake", emoji: "🎂" },
  { name: "tea", emoji: "🍵" }, { name: "book", emoji: "📚" },
  { name: "rainbow", emoji: "🌈" }, { name: "sun", emoji: "☀️" },
  { name: "moon", emoji: "🌙" }, { name: "snowflake", emoji: "❄️" },
  { name: "earth", emoji: "🌍" }, { name: "robot", emoji: "🤖" },
];

function EmojiPickerOverlay() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    const onOpen = () => {
      setQ("");
      setOpen(true);
    };
    window.addEventListener("noteforge:emoji-picker", onOpen);
    return () => window.removeEventListener("noteforge:emoji-picker", onOpen);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? EMOJI_LIB.filter((e) =>
        (e.name + " " + (e.keywords ?? "")).toLowerCase().includes(ql),
      )
    : EMOJI_LIB;
  const insert = (em: string) => {
    setOpen(false);
    setTimeout(() => {
      try {
        document.execCommand("insertText", false, em);
      } catch {}
    }, 30);
  };
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-24 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[420px] max-w-[95vw] p-3">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search emoji…"
          className="w-full border border-gray-200 rounded px-2 py-1 text-sm mb-2 outline-none focus:border-gray-400"
        />
        <div className="grid grid-cols-8 gap-1 max-h-72 overflow-y-auto">
          {filtered.map((e) => (
            <button
              key={e.name}
              onClick={() => insert(e.emoji)}
              className="aspect-square text-xl rounded hover:bg-black/5"
              title={`:${e.name}:`}
            >
              {e.emoji}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="col-span-8 text-xs text-gray-500 px-1 py-2">No match.</p>
          )}
        </div>
      </div>
    </div>
  );
}
