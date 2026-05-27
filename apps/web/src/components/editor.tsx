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
                ? (["summarize", "one_liner", "translate", "improve", "proofread", "continue", "explain", "outline", "keywords", "ideas", "checklist", "poll", "email", "action_items", "quote", "tone", "longer", "shorter", "glossary", "sentiment", "next_steps", "critique", "agenda", "eli5", "pros_cons", "risks", "timeline", "faq", "counter", "hashtags", "headlines", "slug", "tweet_thread", "citations", "study_notes", "flashcards", "quiz", "persona", "swot", "release_notes", "objections", "decision_log", "user_stories", "test_cases", "rhyme", "lyrics", "regex", "sql", "commit_msg", "standup", "retro", "jargon", "mind_map", "elevator_pitch", "job_desc", "follow_up", "sub_headings", "anti_pattern", "dictionary", "expand_acronyms", "star_method", "key_takeaways", "email_reply", "cover_letter", "pre_publish", "tagline", "metaphor", "press_release", "interview_questions", "linkedin_post", "blog_outline", "testimonials", "contrarian", "dialog", "seo_keywords", "news_headline", "recommendation_letter", "scenario", "risk_matrix", "api_spec", "raci", "value_prop", "cta", "landing_hero", "onboarding_email", "insight_3", "dictation_clean", "clean_formatting", "inverse_pyramid", "contrast_vs", "buyer_persona", "feature_benefit", "learn_vocab", "business_canvas", "competitive_analysis", "postmortem", "case_study", "customer_interview", "release_tweet", "job_offer_email", "spec_template", "okrs", "onboarding_checklist", "prd", "sales_pitch", "cold_email", "q_and_a", "agenda_action", "escalation_email", "proposal", "roadmap", "sprint_plan", "standup_async", "release_detailed", "code_review", "devil_advocate", "objection_handler", "changelog_emoji", "inverse_faq", "style_guide", "email_friendly", "persona_quote", "voice_script", "short_bio", "long_bio", "job_rejection", "recruiting_msg", "exec_summary", "lessons_learned", "decision_memo", "release_faq", "launch_checklist", "feedback_questions", "user_research_plan", "discovery_questions", "product_tour", "day_in_life", "founder_story", "positioning", "ad_copy", "headline_test", "before_after", "social_proof", "error_msg", "migration_guide", "legal_disclaimer", "privacy_summary", "api_changelog", "whitepaper_outline", "press_quote", "customer_quote", "content_calendar", "seo_meta", "alt_text", "thumbnail_text", "survey_design", "system_prompt", "talking_points", "brief_from_bullets", "haiku", "quotes_on_topic", "tldr_emoji", "icebreaker", "one_on_one", "customer_pain", "pivot_options", "risk_register", "team_charter", "values_statement", "swot_personal", "career_pitch", "resignation_letter", "welcome_message", "exit_interview", "checkin_questions", "lunch_and_learn", "coffee_chat", "personal_mission", "book_summary_3", "weekly_review", "monthly_review", "goal_tree", "habits_list", "reading_list", "mantra", "vision_statement", "quarterly_okrs", "negotiation_script", "performance_review", "perf_feedback", "skip_level", "feedback_360", "career_ladder", "comp_band", "pip_plan", "reorg_memo", "hiring_rubric", "reference_check", "promotion_case", "short_story", "character_bio", "worldbuilding", "dialogue_scene", "lesson_plan", "study_plan", "architecture_review", "docstring", "sample_data", "json_schema", "sql_optimize", "code_comment", "investor_update", "board_update", "pitch_deck", "gtm_plan", "pricing_strategy", "financial_narrative", "branding_attributes", "tone_voice", "editorial_calendar", "cs_playbook", "discovery_deck", "github_issue", "github_pr", "apology_letter", "thank_you_note", "reddit_post", "hn_post", "screenplay_scene", "story_arc", "sonnet", "free_verse", "idiom_translate", "comedian_bit", "yelp_review", "recipe", "handover_doc", "runbook", "troubleshooting", "partnership_pitch", "demo_day_pitch", "angel_update", "buying_guide", "comparison_vs", "one_pager", "meeting_recap", "knowledge_transfer", "eli_expert", "press_statement", "investor_faq", "linkedin_newsletter", "thought_leader", "podcast_notes", "video_script", "infographic_labels", "toast_speech", "wedding_toast", "birthday_message", "condolence", "referral_request", "linkedin_profile", "substack_post", "elevator_no_jargon", "data_table_narrative", "chart_caption", "dashboard_summary", "sql_explain", "cli_help", "error_explain", "refactor_suggest", "test_edge_cases", "name_suggest", "explain_diagram", "sequence_diagram", "state_machine", "ad_headlines", "og_tags", "commit_template", "branch_name", "unit_test_skeleton", "readme_skeleton", "contributing_md", "license_pick", "cron_explain", "regex_explain", "env_var_doc", "elevator_perspectives", "twitter_bio", "instagram_caption", "tiktok_hook", "youtube_title", "youtube_description", "app_store_desc", "notification_copy", "email_subject_ab", "empty_state_copy", "message_404", "maintenance_notice", "system_status_blurb", "holiday_greeting", "jira_ticket", "linear_ticket", "weekly_status", "exec_1pager", "risk_rag", "budget_narrative", "faq_localize", "security_runbook", "incident_customer_comms", "tweet_rewrite", "linkedin_comment", "yc_application", "cv_bullet", "lightning_talk", "conference_cfp", "talk_abstract", "intro_bio_speaker", "workshop_plan", "curriculum_outline", "test_plan", "bug_priority", "eli5_medical", "eli5_legal", "eli5_financial", "family_update", "old_friend_msg", "ad_mock_banner", "google_ad", "facebook_ad", "email_sequence_5", "welcome_flow", "upsell_msg", "cancel_recovery", "winback", "nps_followup", "csat_script", "handoff_summary", "ooo_message", "calendar_invite_note", "job_listing", "job_rejection_no_fit", "internship_jd", "relocation_package", "sabbatical_pitch", "raise_request", "promotion_self_pitch", "transfer_request", "remote_policy", "handbook_page", "code_of_conduct", "community_rules", "diversity_statement", "social_bio", "influencer_pitch", "affiliate_pitch", "landing_tour", "security_policy", "incident_tweet", "onboarding_tour", "ff_rollout", "experiment_plan", "experiment_readout", "metric_tree", "cohort_analysis", "proposal_cover", "sow", "msa_summary", "nda_summary", "dpia", "soc2_readiness", "gdpr_data_map", "dpa_clause", "rate_limit_msg", "billing_failure_msg", "refund_policy", "data_retention_policy", "cookie_banner_copy", "elevator_tldr", "changelog_html", "sql_seed", "dockerfile", "compose_yml", "gh_actions", "k8s_deploy", "nginx_conf", "oauth_flow", "jwt_claims", "webhook_payload", "data_model", "api_versioning", "prd_section", "ux_copy_review", "accessibility_review", "perf_budget", "observability_plan", "error_budget_slo", "disaster_recovery", "threat_model", "api_deprecation", "feature_sunset", "beta_invite", "waitlist_email", "early_access_email", "emails_7day", "lead_magnet_idea", "landing_faq", "landing_feature_grid", "pricing_faq", "comparison_grid", "vp_canvas", "jtbd", "north_star_narrative", "customer_journey", "pain_relief_list", "aha_moment", "activation_events", "funding_roadmap", "saas_pricing_page", "usage_pricing", "trial_conversion_email", "feat_deprecation_roadmap", "launch_day_checklist", "product_hunt_launch", "changelog_blog_post", "release_tweet_thread", "dev_blog_post", "api_doc_endpoint", "cli_tutorial", "sdk_getting_started", "ux_microcopy", "dialog_confirm", "form_error", "tooltip_copy", "onboarding_tooltip_seq", "empty_state_variations", "loading_skeleton_text", "cta_variants", "banner_promo", "sale_headline", "seasonal_campaign", "referral_program_copy", "discount_code_email", "affiliate_terms", "terms_of_service", "privacy_policy", "eula", "sla_template", "acceptable_use", "return_policy", "shipping_policy", "warranty_terms", "agency_pitch_deck", "freelance_quote", "client_onboarding", "invoice_narrative", "copywriter_feedback", "editor_rewrite", "translate_batch", "transliterate", "native_rewrite", "honorific_ko", "casual_ko", "business_ko", "email_ko_polite", "kakao_msg", "announcement_ko", "biz_card_bio", "elevator_mom_test", "yo_style_ko", "grandma_explain", "movie_pitch", "changelog_from_bullets", "contract_summary", "explain_acronym", "dramatize", "karaoke_lyrics", "legal_plain_ko", "yc_pitch", "meeting_minutes", "sprint_retro_detailed", "user_story_acceptance", "bug_repro", "api_mock_response", "changelog_merge", "customer_followup_ko", "release_blog_ko", "sql_from_schema", "excel_formula", "onboarding_survey_ko", "refund_letter_ko", "news_summary_ko", "recipe_shopping_list", "podcast_guest_questions", "email_subject_5", "research_summary", "tough_questions", "legalese_detect", "translate_natural_en", "safety_review", "style_mirror", "biz_eng_email", "intro_ko_formal", "ui_spec_from_desc", "dad_jokes", "jp_business_polite", "git_conflict_resolve", "copy_3_tones", "sql_explain_ko", "jira_from_bug", "slack_rephrase_ko", "pitch_slide_titles", "customer_quote_ko", "release_go_no_go", "icp_profile", "competitive_moat", "postmortem_ko", "headline_rewrite_ko", "email_decline_ko", "api_docs_from_code", "db_schema_naming", "translate_formal_en", "translate_formal_ko", "customer_segments", "email_thread_summary", "pr_review_checklist", "onboarding_30_60_90", "sales_call_script_ko", "contract_redline", "spec_to_test_cases", "log_pattern_detect", "regression_risk", "db_migration_plan", "marketing_positioning", "welcome_pack_ko", "incident_report_customer", "team_okr_quarterly", "translate_academic_en", "sales_objection_handle_ko", "competitor_feature_matrix", "jira_from_spec", "translate_poetic_ko", "sales_email_cold_ko", "event_mc_script", "incident_rca_5whys", "feature_naming", "release_note_internal", "cv_bullet_impact", "journal_prompt_ko", "translate_natural_ko", "release_tweet_thread_ko", "feedback_rewrite_constructive", "bullets_to_paragraph", "paragraph_to_bullets", "code_comment_jsdoc", "k8s_yaml_from_app", "dockerfile_multistage", "git_rebase_strategy", "cors_config", "changelog_ko", "scam_detect_ko", "contract_clause_explain_ko", "study_cheatsheet", "saas_onboarding_checklist", "email_thank_customer_ko", "community_rules_ko", "translate_formal_jp", "dashboard_widgets_spec", "error_message_friendly", "translate_academic_ko", "code_explain_line_by_line", "sql_optimize_ko", "customer_call_script_ko", "marketing_email_segments", "youtube_script_3min", "twitter_bio_3_ko", "sql_window_function", "release_rollback_plan", "api_pagination_design", "diff_intent_explain", "feature_flag_rollout", "release_notes_detailed_ko", "translate_marketing_en", "devops_runbook", "comment_intent_rewrite", "sales_discovery_questions_ko", "db_er_diagram_mermaid", "incident_comms_internal", "copy_rewrite_3_angles", "translate_casual_en", "code_security_review", "changelog_monthly_rollup", "product_tour_script_ko", "email_intro_warm_ko", "log_redact_pii", "career_narrative_ko", "api_error_codes", "standup_summary_team_ko", "regex_test_cases", "error_msg_multilingual", "team_intro_ko", "strategy_1pager", "translate_poetic_en", "api_deprecation_ko", "postmortem_detailed", "customer_meeting_prep", "changelog_twitter_thread", "translate_poetic_jp", "bio_3_lengths", "landing_hero_3_variant", "release_blog_en", "translate_cs_formal_ko", "api_readme_from_spec", "sprint_goal_statement", "incident_tweet_public_ko", "podcast_intro_host_ko", "code_rename_suggest", "error_msg_empathic_ko", "recruiter_reply_ko", "edit"] as const)
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
