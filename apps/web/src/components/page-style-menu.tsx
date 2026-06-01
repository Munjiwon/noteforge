"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  archivePage,
  duplicatePage,
  movePageToRoot,
  setPageAsTemplate,
  setPageExpiry,
  setPageFont,
  setPageSlug,
  setPageStatus,
  setPageWidth,
  setPageWordGoal,
  togglePageLock,
  togglePagePinned,
  unarchivePage,
} from "@/app/w/[slug]/actions";
import { useRouter } from "next/navigation";

export type PageWidth = "normal" | "wide" | "full";
export type PageFont = "default" | "serif" | "mono";

// Walks the BlockNote DOM tree and emits a best-effort Markdown rendering.
// Conversion is intentionally lossy (no nested-list indent, no per-cell table
// formatting) — good enough for export/copy-paste, not a Pandoc replacement.
function renderPageAsMarkdown(): string {
  const root =
    document.querySelector(".bn-container") ||
    document.querySelector(".bn-editor");
  if (!root) return "";
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".bn-block"));
  const out: string[] = [];
  for (const block of blocks) {
    // Skip blocks nested under another block (we'll get them flat at top level).
    const parentBlock = block.parentElement?.closest(".bn-block");
    if (parentBlock) continue;
    const inner = block.querySelector<HTMLElement>("[data-content-type]");
    const type = inner?.getAttribute("data-content-type") ?? "";
    const text = (block.querySelector("[data-node-view-content-react], .bn-inline-content")?.textContent
      ?? block.textContent
      ?? ""
    ).trim();
    if (!text && type !== "image" && type !== "table") continue;
    switch (type) {
      case "heading": {
        const lvl = parseInt(inner?.getAttribute("data-level") ?? "1", 10) || 1;
        out.push(`${"#".repeat(Math.min(6, Math.max(1, lvl)))} ${text}`);
        break;
      }
      case "bulletListItem":
        out.push(`- ${text}`);
        break;
      case "numberedListItem":
        out.push(`1. ${text}`);
        break;
      case "checkListItem": {
        const checked =
          inner?.querySelector('input[type="checkbox"]') instanceof
            HTMLInputElement &&
          (
            inner.querySelector(
              'input[type="checkbox"]',
            ) as HTMLInputElement
          ).checked;
        out.push(`- [${checked ? "x" : " "}] ${text}`);
        break;
      }
      case "quote":
        out.push(`> ${text}`);
        break;
      case "codeBlock": {
        const lang = inner?.getAttribute("data-language") ?? "";
        out.push("```" + lang);
        out.push(text);
        out.push("```");
        break;
      }
      case "callout":
      case "toggle":
        out.push(text);
        break;
      case "image": {
        const src = inner?.querySelector("img")?.getAttribute("src") ?? "";
        if (src) out.push(`![](${src})`);
        break;
      }
      case "divider":
        out.push("---");
        break;
      default:
        out.push(text);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function PageStyleMenu({
  slug,
  pageId,
  width,
  font,
  locked,
  isTemplate = false,
  customSlug = null,
  expiresAt = null,
  pinned = false,
  status = null,
  wordGoal = null,
  canEdit,
}: {
  slug: string;
  pageId: string;
  width: PageWidth;
  font: PageFont;
  locked: boolean;
  isTemplate?: boolean;
  customSlug?: string | null;
  expiresAt?: string | null;
  pinned?: boolean;
  status?: "draft" | "in_review" | "published" | null;
  wordGoal?: number | null;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
        title="Page style"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded-md shadow-lg w-[240px] p-2">
          <div className="text-[10px] uppercase text-gray-500 px-1 py-1">Width</div>
          <div className="flex gap-1 mb-2">
            {(["normal", "wide", "full"] as PageWidth[]).map((w) => (
              <button
                key={w}
                onClick={() => start(() => setPageWidth(slug, pageId, w))}
                disabled={!canEdit}
                className={
                  "flex-1 text-xs px-2 py-1 rounded border " +
                  (w === width
                    ? "bg-gray-900 text-white border-gray-900"
                    : "border-gray-200 hover:bg-black/5")
                }
              >
                {w}
              </button>
            ))}
          </div>
          <div className="text-[10px] uppercase text-gray-500 px-1 py-1">Font</div>
          <div className="flex gap-1 mb-2">
            {(["default", "serif", "mono"] as PageFont[]).map((f) => (
              <button
                key={f}
                onClick={() => start(() => setPageFont(slug, pageId, f))}
                disabled={!canEdit}
                className={
                  "flex-1 text-xs px-2 py-1 rounded border " +
                  (f === font
                    ? "bg-gray-900 text-white border-gray-900"
                    : "border-gray-200 hover:bg-black/5") +
                  " " +
                  fontClass(f)
                }
              >
                {f}
              </button>
            ))}
          </div>
          {canEdit && (
            <>
              {locked ? (
                <button
                  onClick={() => start(() => togglePageLock(slug, pageId))}
                  className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                >
                  🔓 Unlock page
                </button>
              ) : (
                <LockRow slug={slug} pageId={pageId} />
              )}
              <button
                onClick={() => start(() => togglePagePinned(slug, pageId))}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                {pinned ? "📌 Unpin from sidebar" : "📌 Pin to sidebar"}
              </button>
              <button
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("noteforge:page-move-open", {
                      detail: { pageId },
                    }),
                  );
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                ↪ Move to…
              </button>
              <button
                onClick={() => {
                  const u = new URL(window.location.href);
                  if (u.searchParams.get("preview") === "viewer") {
                    u.searchParams.delete("preview");
                  } else {
                    u.searchParams.set("preview", "viewer");
                  }
                  window.location.href = u.toString();
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                👁 Preview as viewer
              </button>
              <button
                onClick={() => {
                  window.open(window.location.href, "_blank", "noopener");
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                🪟 Open in new window
              </button>
              <button
                onClick={() => {
                  // Compact popout window for side-by-side reading.
                  const w = 560;
                  const h = Math.min(900, window.screen.availHeight - 80);
                  const left = Math.max(0, window.screen.availWidth - w - 24);
                  window.open(
                    window.location.href.split("?")[0] + "?focus=1",
                    "noteforge-popout-" + pageId,
                    `popup=1,noopener,width=${w},height=${h},left=${left},top=40`,
                  );
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Open this page in a small side-panel window"
              >
                🪟 Open as popout (narrow)
              </button>
              <button
                onClick={() => {
                  const title =
                    (document.querySelector(
                      'input[placeholder="Untitled"]',
                    ) as HTMLInputElement | null)?.value || "Untitled";
                  const url = window.location.href.split("?")[0];
                  const subject = encodeURIComponent(`Have a look: ${title}`);
                  const body = encodeURIComponent(
                    `Hi,\n\nThought you'd find this useful: ${title}\n${url}\n\n— sent from noteforge`,
                  );
                  window.location.href = `mailto:?subject=${subject}&body=${body}`;
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Compose an email with the page link pre-filled"
              >
                📧 Share via email
              </button>
              <button
                onClick={() => {
                  const sel = window.getSelection?.();
                  const text = sel?.toString().trim();
                  if (!text || text.length < 4) {
                    alert(
                      "Select some text on the page first (4+ chars), then click again.",
                    );
                    return;
                  }
                  // Use only first ~80 chars to keep URLs reasonable, and
                  // strip linebreaks for the fragment per the spec.
                  const fragment = text.replace(/\s+/g, " ").slice(0, 80);
                  const url =
                    window.location.href.split("#")[0].split("?")[0] +
                    `#:~:text=${encodeURIComponent(fragment)}`;
                  void navigator.clipboard?.writeText(url).then(() => {
                    const tip = document.createElement("div");
                    tip.textContent = "Selection link copied";
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1400);
                  });
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Copy a deep link that scrolls + highlights the selected text (Chromium/Edge/Safari TP)"
              >
                🔗 Copy link to selection
              </button>
              <button
                onClick={() => {
                  start(() => movePageToRoot(slug, pageId));
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Move this page to the workspace root (un-nest)"
              >
                ⤴ Move to workspace root
              </button>
              <button
                onClick={async () => {
                  setOpen(false);
                  const newId = await duplicatePage(slug, pageId, {
                    withChildren: false,
                  });
                  if (newId) router.push(`/w/${slug}/p/${newId}`);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Copy this page without any sub-pages"
              >
                ⎘ Duplicate (no children)
              </button>
              <button
                onClick={async () => {
                  if (
                    !confirm(
                      "Mark every open comment on this page as resolved?",
                    )
                  )
                    return;
                  setOpen(false);
                  const { resolveAllComments } = await import(
                    "@/app/w/[slug]/comment-actions"
                  );
                  await resolveAllComments(slug, pageId);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Resolve every open comment on this page in one go"
              >
                ✅ Mark all comments resolved
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(
                    new CustomEvent("noteforge:open-activity", {
                      detail: { pageId },
                    }),
                  );
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="View who did what on this page"
              >
                📜 Activity log
              </button>
              <button
                onClick={() => {
                  const editor =
                    document.querySelector(".bn-container") ||
                    document.querySelector(".bn-editor");
                  const blocks = editor
                    ? editor.querySelectorAll(".bn-block").length
                    : 0;
                  const content = (editor?.textContent ?? "").length;
                  const ua = navigator.userAgent;
                  alert(
                    `🛠 Debug info\n\n` +
                      `Page ID: ${pageId}\n` +
                      `Block count: ${blocks}\n` +
                      `Visible char count: ${content.toLocaleString()}\n` +
                      `URL: ${window.location.href}\n` +
                      `User agent: ${ua}\n` +
                      `localStorage size: ${
                        Object.keys(localStorage).length
                      } keys`,
                  );
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Show debug info for this page (for support)"
              >
                🛠 Show debug info
              </button>
              <button
                onClick={() => {
                  window.open(`/api/page/${pageId}`, "_blank", "noopener");
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Open the raw JSON in a new tab (debugging)"
              >
                🧰 View raw JSON
              </button>
              <button
                onClick={() => {
                  const md = renderPageAsMarkdown();
                  if (!md) {
                    alert("Nothing to copy.");
                    return;
                  }
                  void navigator.clipboard?.writeText(md).then(() => {
                    const tip = document.createElement("div");
                    tip.textContent = `Markdown copied (${md.length} chars)`;
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1500);
                  });
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                📝 Copy body as Markdown
              </button>
              <button
                onClick={() => {
                  const md = renderPageAsMarkdown();
                  const title =
                    (document.querySelector(
                      'input[placeholder="Untitled"]',
                    ) as HTMLInputElement | null)?.value || "Untitled";
                  const out = `# ${title}\n\n${md}`;
                  const blob = new Blob([out], {
                    type: "text/markdown;charset=utf-8",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${title.replace(/[^\w\-]+/g, "_")}.md`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                ⬇ Download as Markdown
              </button>
              <button
                onClick={async () => {
                  try {
                    const r = await fetch(`/api/page/${pageId}`);
                    if (!r.ok) return;
                    const json = await r.text();
                    const blob = new Blob([json], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${pageId}.json`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                  } catch {}
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                ⬇ Download JSON
              </button>
              <button
                onClick={() => {
                  const title =
                    (document.querySelector(
                      'input[placeholder="Untitled"]',
                    ) as HTMLInputElement | null)?.value || "Untitled";
                  const md = `[${title}](${window.location.href.split("?")[0]})`;
                  void navigator.clipboard?.writeText(md).then(() => {
                    const tip = document.createElement("div");
                    tip.textContent = "Cite markdown copied";
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1200);
                  });
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                📝 Cite this page (Markdown)
              </button>
              <button
                onClick={() => {
                  const editor =
                    document.querySelector(".bn-container") ||
                    document.querySelector(".bn-editor");
                  const text = (editor?.textContent ?? "")
                    .replace(/ /g, " ")
                    .replace(/[ \t]+\n/g, "\n")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim();
                  if (!text) {
                    alert("Nothing to copy.");
                    return;
                  }
                  void navigator.clipboard?.writeText(text).then(() => {
                    const tip = document.createElement("div");
                    tip.textContent = `Copied ${text.length} chars`;
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1200);
                  });
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                📄 Copy as plain text
              </button>
              <button
                onClick={() => {
                  const editor =
                    document.querySelector(".bn-container") ||
                    document.querySelector(".bn-editor");
                  if (!editor) {
                    alert("Editor not ready.");
                    return;
                  }
                  const headings = Array.from(
                    editor.querySelectorAll("h1, h2, h3, h4, h5, h6"),
                  ) as HTMLElement[];
                  const lines = headings
                    .map((h) => {
                      const lvl = Number(h.tagName.slice(1));
                      const t = (h.textContent ?? "").trim();
                      return t ? `${"#".repeat(lvl)} ${t}` : "";
                    })
                    .filter(Boolean);
                  const out = lines.join("\n");
                  if (!out) {
                    alert("No headings on this page.");
                    return;
                  }
                  void navigator.clipboard?.writeText(out).then(() => {
                    const tip = document.createElement("div");
                    tip.textContent = `Outline copied (${lines.length})`;
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1200);
                  });
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                🧭 Copy outline (Markdown)
              </button>
              <div className="flex gap-1 mb-1">
                <button
                  onClick={() => {
                    // ToggleBlock renders a <button aria-label="expand"> when
                    // collapsed and aria-label="collapse" when open.
                    const ts = document.querySelectorAll<HTMLButtonElement>(
                      '.bn-editor button[aria-label="expand"]',
                    );
                    ts.forEach((b) => b.click());
                    const n = ts.length;
                    const tip = document.createElement("div");
                    tip.textContent = n ? `Expanded ${n} toggles` : "No collapsed toggles";
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1200);
                    setOpen(false);
                  }}
                  className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
                >
                  ➕ Expand all
                </button>
                <button
                  onClick={() => {
                    const ts = document.querySelectorAll<HTMLButtonElement>(
                      '.bn-editor button[aria-label="collapse"]',
                    );
                    ts.forEach((b) => b.click());
                    const n = ts.length;
                    const tip = document.createElement("div");
                    tip.textContent = n ? `Collapsed ${n} toggles` : "No expanded toggles";
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1200);
                    setOpen(false);
                  }}
                  className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
                >
                  ➖ Collapse all
                </button>
              </div>
              <button
                onClick={() => {
                  try {
                    const key = `hide-cover:${pageId}`;
                    const cur = localStorage.getItem(key) === "1";
                    if (cur) localStorage.removeItem(key);
                    else localStorage.setItem(key, "1");
                    window.dispatchEvent(
                      new CustomEvent("noteforge:cover-hidden-changed", {
                        detail: { pageId },
                      }),
                    );
                  } catch {}
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Hide or show the cover image for this page on this device"
              >
                🚫 Toggle cover (this device)
              </button>
              <button
                onClick={() => {
                  try {
                    const key = `hide-wordchip:${pageId}`;
                    const cur = localStorage.getItem(key) === "1";
                    if (cur) localStorage.removeItem(key);
                    else localStorage.setItem(key, "1");
                    window.dispatchEvent(
                      new CustomEvent("noteforge:wordchip-changed", {
                        detail: { pageId },
                      }),
                    );
                  } catch {}
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Hide or show the word count chip below the title"
              >
                🔢 Toggle word chip
              </button>
              <button
                onClick={() => {
                  try {
                    const cur =
                      localStorage.getItem("noteforge:comments-compact") === "1";
                    if (cur)
                      localStorage.removeItem("noteforge:comments-compact");
                    else localStorage.setItem("noteforge:comments-compact", "1");
                    document.body.classList.toggle("comments-compact", !cur);
                  } catch {}
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Show comments in a tighter layout"
              >
                💬 Toggle comments compact
              </button>
              <button
                onClick={() => {
                  try {
                    const cur =
                      localStorage.getItem("noteforge:print-no-comments") === "1";
                    if (cur)
                      localStorage.removeItem("noteforge:print-no-comments");
                    else
                      localStorage.setItem("noteforge:print-no-comments", "1");
                    document.body.classList.toggle("print-no-comments", !cur);
                  } catch {}
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Hide the comments section when printing"
              >
                🖨 Toggle print-hide comments
              </button>
              <button
                onClick={() => {
                  window.open(window.location.href, "_blank", "noopener");
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                ↗ Open in new window
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  // give the menu a tick to close before opening the print dialog
                  setTimeout(() => window.print(), 50);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                🖨 Print now
              </button>
              <button
                onClick={() => {
                  // "Clean print" — temporarily hide cover/comments/tags/reactions
                  // for printing, then revert after the print dialog closes.
                  const prev = {
                    cover: !!document.querySelector(".nf-print-hide"),
                    classes: [
                      "print-no-comments",
                      "hide-tags",
                      "hide-reactions",
                      "hide-subpages",
                      "hide-backlinks",
                    ].filter((c) => document.body.classList.contains(c)),
                  };
                  document.body.classList.add(
                    "print-no-comments",
                    "hide-tags",
                    "hide-reactions",
                    "hide-subpages",
                    "hide-backlinks",
                  );
                  setOpen(false);
                  setTimeout(() => {
                    window.print();
                    // restore — we toggled, so remove only what we added
                    setTimeout(() => {
                      const restore = [
                        "print-no-comments",
                        "hide-tags",
                        "hide-reactions",
                        "hide-subpages",
                        "hide-backlinks",
                      ];
                      for (const c of restore) {
                        if (!prev.classes.includes(c))
                          document.body.classList.remove(c);
                      }
                    }, 500);
                  }, 60);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Print cover/comments/tags/reactions hidden for this print only"
              >
                🧼 Clean print
              </button>
              <button
                onClick={() => {
                  const SET = [
                    "zen-mode",
                    "hide-breadcrumb",
                    "hide-outline",
                    "hide-reactions",
                    "hide-tags",
                    "hide-subpages",
                    "hide-backlinks",
                    "focus-mode",
                  ];
                  const isWriter = SET.every((k) =>
                    document.body.classList.contains(k),
                  );
                  for (const k of SET) {
                    try {
                      const lsKey = `noteforge:${k}`;
                      if (isWriter) {
                        localStorage.removeItem(lsKey);
                        document.body.classList.remove(k);
                      } else {
                        localStorage.setItem(lsKey, "1");
                        document.body.classList.add(k);
                      }
                    } catch {}
                  }
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Toggle Zen + hide breadcrumb/outline/reactions/tags/sub-pages/backlinks + focus mode in one click"
              >
                ✍ Writer mode (all distractions off)
              </button>
              <div className="mb-1 mt-1">
                <label className="text-[10px] uppercase text-gray-500 px-1">
                  Reading toggles
                </label>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  {(
                    [
                      { key: "heading-numbers", label: "# numbers" },
                      { key: "bionic", label: "Bionic" },
                      { key: "zen-mode", label: "Zen mode" },
                      { key: "highlight-links", label: "Highlight links" },
                      { key: "dyslexia", label: "Dyslexia" },
                      { key: "justify-text", label: "Justify" },
                      { key: "larger-font", label: "Larger font" },
                      { key: "sticky-title", label: "Sticky title" },
                      { key: "db-striped", label: "DB striped" },
                      { key: "bg-grid", label: "Grid bg" },
                      { key: "bg-dots", label: "Dots bg" },
                      { key: "bg-ruled", label: "Ruled bg" },
                      { key: "hide-reactions", label: "Hide reactions" },
                      { key: "hide-tags", label: "Hide tags" },
                      { key: "hide-subpages", label: "Hide sub-pages" },
                      { key: "hide-backlinks", label: "Hide backlinks" },
                      { key: "breadcrumb-sticky", label: "Sticky breadcrumb" },
                      { key: "sidebar-hide-icons", label: "No tree icons" },
                      { key: "sidebar-group-by-kind", label: "Group by kind" },
                      { key: "hide-outline", label: "Hide outline" },
                      { key: "hide-trash", label: "Hide trash" },
                      { key: "page-dark", label: "Page-only dark" },
                      { key: "compact-title", label: "Compact title" },
                      { key: "spacing-roomy", label: "Roomy spacing" },
                      { key: "db-sticky-head", label: "DB sticky header" },
                      { key: "larger-touch", label: "Larger touch" },
                      { key: "hide-breadcrumb", label: "Hide breadcrumb" },
                      { key: "sticky-h2", label: "Sticky H2" },
                      { key: "center-title", label: "Center title" },
                      { key: "hide-footer", label: "Hide footer" },
                      { key: "show-block-ids", label: "Show block IDs" },
                      { key: "side-menu-on", label: "Side menu always on" },
                      { key: "code-larger", label: "Larger code font" },
                      { key: "quote-accent", label: "Quote purple accent" },
                      { key: "code-line-numbers", label: "Code line numbers" },
                      { key: "image-rounded", label: "Rounded images" },
                      { key: "line-loose", label: "Loose line-height" },
                      { key: "bookworm", label: "Bookworm serif" },
                      { key: "compact-subpage-cards", label: "Compact sub-pages" },
                      { key: "dotted-divider", label: "Dotted divider" },
                      { key: "hide-footer-dates", label: "Hide footer dates" },
                      { key: "no-emoji-icons", label: "No emoji icons" },
                      { key: "compact-callouts", label: "Compact callouts" },
                      { key: "two-col-reading", label: "2-column reading" },
                      { key: "print-page-numbers", label: "Print page #" },
                      { key: "print-no-images", label: "Print: no images" },
                      { key: "wide-page", label: "Wide page" },
                      { key: "meta-on-hover", label: "Meta on hover" },
                      { key: "mono-code", label: "Mono code blocks" },
                      { key: "indent-guides", label: "Indent guides" },
                      { key: "highlight-todos", label: "Highlight TODOs" },
                      { key: "no-animations", label: "No animations" },
                      { key: "heading-separator", label: "Heading separator" },
                      { key: "highlight-urls", label: "Highlight URLs" },
                      { key: "image-zoom-cursor", label: "Image zoom cursor" },
                      { key: "big-numbered-list", label: "Big numbers (ol)" },
                      { key: "selection-accent", label: "Selection accent" },
                      { key: "block-hover-lift", label: "Block hover lift" },
                      { key: "reduced-contrast", label: "Reduced contrast" },
                      { key: "checklist-strike", label: "Checklist strike" },
                      { key: "wider-gutters", label: "Wider gutters" },
                      { key: "blockquote-drama", label: "Big quote marks" },
                      { key: "db-compact-rows", label: "DB compact rows" },
                      { key: "sidebar-small-text", label: "Small sidebar" },
                      { key: "h1-as-h2", label: "H1 = H2 size" },
                      { key: "sidebar-wide", label: "Sidebar wide" },
                      { key: "outline-pinned", label: "Outline pinned" },
                      { key: "sidebar-darker", label: "Sidebar darker" },
                      { key: "mobile-narrow", label: "Mobile-narrow" },
                      { key: "big-headings", label: "Big headings" },
                      { key: "square-bullets", label: "Square bullets" },
                      { key: "auto-num-headings", label: "Auto # headings" },
                      { key: "para-indent", label: "Paragraph indent" },
                      { key: "print-toggle-expand", label: "Print: expand toggles" },
                      { key: "thick-caret", label: "Thick caret" },
                      { key: "code-chip", label: "Code chip" },
                      { key: "caret-block-highlight", label: "Caret block hi" },
                      { key: "no-image-captions", label: "No image captions" },
                      { key: "larger-checkbox", label: "Larger checkbox" },
                      { key: "reading-ruler", label: "Reading ruler" },
                      { key: "mini-sidebar-icons", label: "Mini sb icons" },
                      { key: "two-tone-tags", label: "Two-tone tags" },
                      { key: "neutral-links", label: "Neutral links" },
                      { key: "link-underline-hover", label: "Underline on hover" },
                      { key: "code-line-wrap", label: "Code line wrap" },
                      { key: "heading-anchor-hover", label: "Heading anchors" },
                      { key: "no-selection", label: "No selection" },
                      { key: "italic-accent", label: "Italic accent" },
                      { key: "heading-shadow", label: "Heading shadow" },
                      { key: "external-link-icon", label: "↗ on ext links" },
                      { key: "italic-serif", label: "Italic serif" },
                      { key: "big-checklist-text", label: "Big checklist text" },
                      { key: "strikethrough-faded", label: "Strike faded" },
                      { key: "drop-cap", label: "Drop cap" },
                      { key: "highlight-accent", label: "Highlight accent" },
                      { key: "cream-bg", label: "Cream background" },
                      { key: "outline-current-ring", label: "Outline current" },
                      { key: "thin-scrollbar", label: "Thin scrollbar" },
                      { key: "lock-page-title", label: "Lock page title" },
                      { key: "paragraph-separators", label: "¶ separators" },
                      { key: "title-underline", label: "Title underline" },
                      { key: "quote-left-ribbon", label: "Quote ribbon" },
                      { key: "image-rounded-xl", label: "Image rounded-xl" },
                      { key: "sidebar-accent", label: "Sidebar accent" },
                      { key: "compact-spacing", label: "Compact spacing" },
                      { key: "scroll-snap-headings", label: "Snap to headings" },
                      { key: "mono-sidebar", label: "Mono sidebar" },
                      { key: "bigger-cursor", label: "Bigger cursor" },
                      { key: "title-no-emoji", label: "Title no emoji" },
                      { key: "dark-code-always", label: "Dark code always" },
                      { key: "tag-pills", label: "Tag pills" },
                      { key: "numbered-outline", label: "# outline" },
                      { key: "bold-accent", label: "Bold accent" },
                      { key: "internal-link-arrow", label: "Internal → arrow" },
                      { key: "no-focus-ring", label: "No focus ring" },
                      { key: "reading-focus-card", label: "Focus card" },
                      { key: "title-gradient", label: "Title gradient" },
                      { key: "list-marker-bold", label: "List marker bold" },
                      { key: "print-no-header", label: "Print: no header" },
                      { key: "custom-toggle-arrow", label: "▶ toggle arrow" },
                      { key: "bullet-emoji", label: "Emoji bullets" },
                      { key: "heading-uppercase", label: "Heading UPPER" },
                      { key: "page-side-ribbon", label: "Side ribbon" },
                      { key: "smaller-callout-emoji", label: "Small callout emoji" },
                      { key: "sidebar-collapsed-init", label: "Sidebar mini" },
                      { key: "callout-italic-text", label: "Callout italic" },
                      { key: "list-marker-bold", label: "Bold markers" },
                      { key: "h1-letter-spacing", label: "H1 tracking" },
                      { key: "paragraph-justify", label: "Justify body" },
                      { key: "first-paragraph-lead", label: "Lead paragraph" },
                      { key: "code-inline-mono", label: "Inline mono" },
                      { key: "blockquote-large", label: "Big quote" },
                      { key: "h3-italic", label: "H3 italic" },
                      { key: "checkbox-larger", label: "Big checkbox" },
                      { key: "page-vignette", label: "Vignette" },
                      { key: "table-zebra", label: "Zebra table" },
                      { key: "image-rounded-xl", label: "Round images" },
                      { key: "code-block-stripes", label: "Code stripes" },
                      { key: "selection-accent", label: "Accent select" },
                      { key: "scrollbar-thin-accent", label: "Thin scrollbar" },
                      { key: "h2-numbered-auto", label: "H2 numbered" },
                      { key: "image-grayscale", label: "Gray images" },
                      { key: "callout-shadow", label: "Callout shadow" },
                      { key: "link-no-underline", label: "Plain links" },
                      { key: "letter-spacing-body", label: "Body tracking" },
                      { key: "ul-disc-square", label: "Square bullets" },
                      { key: "ol-roman", label: "Roman numerals" },
                      { key: "page-grid-bg", label: "Grid bg" },
                      { key: "first-line-indent", label: "First-line indent" },
                      { key: "caption-italic", label: "Italic captions" },
                      { key: "h1-italic-accent", label: "H1 italic stripe" },
                      { key: "quote-marks-large", label: "Big quotes" },
                      { key: "list-spacing-airy", label: "Airy lists" },
                      { key: "table-header-uppercase", label: "TABLE HEADERS" },
                      { key: "checkbox-strikethrough", label: "Strike done" },
                      { key: "h4-uppercase", label: "H4 UPPER" },
                      { key: "code-block-tab-2", label: "Code tab 2" },
                      { key: "paragraph-narrow-line", label: "Tight lines" },
                      { key: "callout-emoji-large", label: "Big callout 🔔" },
                      { key: "page-background-paper", label: "Paper bg" },
                      { key: "block-hover-highlight", label: "Hover blocks" },
                      { key: "h2-numbered-dot", label: "H2 • prefix" },
                      { key: "code-inline-color", label: "Color inline" },
                      { key: "image-border-thick", label: "Thick img border" },
                      { key: "selection-mono-font", label: "Select mono" },
                      { key: "page-icon-bigger", label: "Big page icon" },
                      { key: "h3-with-bar", label: "H3 bar" },
                      { key: "code-block-rounded", label: "Round code" },
                      { key: "tag-pill-style", label: "Tag pills" },
                      { key: "image-shadow-soft", label: "Soft img shadow" },
                      { key: "h1-with-emoji-divider", label: "H1 ✦ divider" },
                      { key: "ul-checkmarks", label: "✓ bullets" },
                      { key: "table-rounded", label: "Round table" },
                      { key: "code-block-numbered", label: "Line numbers" },
                      { key: "page-edge-glow", label: "Edge glow" },
                      { key: "h5-uppercase-tiny", label: "H5 tiny CAPS" },
                      { key: "code-block-window-bar", label: "Code window" },
                      { key: "callout-tip-emoji", label: "Callout label" },
                      { key: "table-header-bold-bg", label: "Table header bg" },
                      { key: "page-side-margins-wider", label: "Wide margins" },
                      { key: "h2-with-underline-gradient", label: "H2 grad underline" },
                      { key: "code-block-no-background", label: "Code no bg" },
                      { key: "table-borderless", label: "Borderless table" },
                      { key: "callout-numbered-prefix", label: "Callout #" },
                      { key: "page-corner-flag", label: "Corner flag" },
                      { key: "page-watermark-text", label: "DRAFT watermark" },
                      { key: "h1-shadow-text", label: "H1 text shadow" },
                      { key: "ul-arrow-marker", label: "→ bullets" },
                      { key: "table-cell-padding-wider", label: "Roomy cells" },
                      { key: "callout-rounded-pill", label: "Callout pill" },
                      { key: "h3-color-blue", label: "Blue H3" },
                      { key: "ul-dash-marker", label: "— bullets" },
                      { key: "table-row-hover", label: "Row hover" },
                      { key: "code-inline-uppercase", label: "Inline UPPER" },
                      { key: "page-margin-rule", label: "Margin rule" },
                      { key: "h6-monospace", label: "H6 mono" },
                      { key: "code-block-large-text", label: "Big code" },
                      { key: "ol-zero-indexed", label: "0-index OL" },
                      { key: "table-first-column-bold", label: "Bold 1st col" },
                      { key: "page-no-paragraph-margin", label: "Tight paragraphs" },
                      { key: "h1-aligned-center", label: "Center H1" },
                      { key: "code-inline-italic", label: "Italic inline" },
                      { key: "table-stripes-vertical", label: "Vertical stripes" },
                      { key: "callout-bg-translucent", label: "Glass callout" },
                      { key: "page-side-tab", label: "Side tab" },
                      { key: "h2-color-accent", label: "Accent H2" },
                      { key: "code-block-mono-only", label: "Pure mono code" },
                      { key: "table-alt-text-color", label: "Alt row text" },
                      { key: "callout-border-dashed", label: "Dashed callout" },
                      { key: "page-rule-tip-corner", label: "Tip corner" },
                      { key: "bullet-numbered-prefix", label: "Auto # bullets" },
                      { key: "h4-color-orange", label: "Orange H4" },
                      { key: "code-block-rainbow-border", label: "Rainbow code" },
                      { key: "table-zebra-blue", label: "Blue zebra" },
                      { key: "page-spotlight-cursor", label: "Spotlight" },
                      { key: "ol-uppercase-alpha", label: "A. B. C." },
                      { key: "h1-with-prefix-section", label: "H1 §" },
                      { key: "callout-border-thick", label: "Thick callout" },
                      { key: "table-no-grid", label: "No grid table" },
                      { key: "page-paper-edge", label: "Paper edge" },
                      { key: "h2-color-purple", label: "Purple H2" },
                      { key: "code-block-glass", label: "Glass code" },
                      { key: "table-row-numbered", label: "Row #" },
                      { key: "callout-quote-style", label: "Quote callout" },
                      { key: "page-corner-fold", label: "Corner fold" },
                      { key: "h3-with-decoration", label: "H3 ✦ deco" },
                      { key: "ul-emoji-marker", label: "👉 bullets" },
                      { key: "table-large-font", label: "Big table text" },
                      { key: "code-block-shadow", label: "Shadow code" },
                      { key: "callout-icon-emoji-only", label: "Icon-only callout" },
                      { key: "h1-tracking-tight", label: "H1 tight" },
                      { key: "code-line-wrap", label: "Wrap code lines" },
                      { key: "table-borderless-headers", label: "Header-only border" },
                      { key: "callout-pulse-animation", label: "Pulse callout" },
                      { key: "page-print-only-margin", label: "Print extra margin" },
                      { key: "h2-numbered-roman", label: "H2 Roman #" },
                      { key: "ol-bracket-style", label: "[1] OL" },
                      { key: "callout-shadow-soft", label: "Soft callout shadow" },
                      { key: "table-merge-header", label: "Merge header bg" },
                      { key: "page-print-bleed", label: "Print bleed" },
                      { key: "h6-italic-tiny", label: "H6 italic tiny" },
                      { key: "code-block-no-radius", label: "Square code" },
                      { key: "table-fixed-layout", label: "Fixed cols" },
                      { key: "callout-emoji-prefix-warn", label: "⚠ callout" },
                      { key: "page-grid-square", label: "Grid square" },
                      { key: "h1-with-final-marker", label: "H1 🏁" },
                      { key: "page-completion-stamp", label: "DONE stamp" },
                      { key: "h1-with-arrow-prefix", label: "H1 ▶ arrow" },
                      { key: "code-block-line-divider", label: "Code line div" },
                      { key: "table-rounded-cells", label: "Rounded cells" },
                      { key: "callout-elevated-shadow", label: "Callout lift" },
                      { key: "page-corner-stitch", label: "Corner stitch" },
                      { key: "h2-with-bullet-dot", label: "H2 • dot" },
                      { key: "code-block-pastel-bg", label: "Pastel code" },
                      { key: "table-zebra-vertical", label: "V-zebra" },
                      { key: "callout-rotate-tiny", label: "Tilt callout" },
                      { key: "page-frame-border", label: "Frame border" },
                      { key: "h3-with-double-bar", label: "H3 ‖ bar" },
                      { key: "code-block-traffic-lights", label: "Traffic lights" },
                      { key: "table-header-emoji-prefix", label: "📌 header" },
                      { key: "callout-corner-fold-decoration", label: "Callout fold" },
                      { key: "page-edge-rule-left", label: "Edge rule" },
                      { key: "h4-with-square-bullet", label: "H4 ◾" },
                      { key: "code-block-typewriter", label: "Typewriter" },
                      { key: "table-soft-divider", label: "Soft divider" },
                      { key: "callout-double-border", label: "2× border" },
                      { key: "page-tape-corner", label: "Washi tape" },
                      { key: "h5-with-arrow-prefix", label: "H5 → arrow" },
                      { key: "code-block-blueprint", label: "Blueprint" },
                      { key: "table-cell-empty-mark", label: "Empty ✗" },
                      { key: "callout-curved-tab", label: "Curved tab" },
                      { key: "page-coffee-stain", label: "Coffee stain" },
                      { key: "h6-with-tilde-prefix", label: "H6 ~ tilde" },
                      { key: "code-block-paper-feel", label: "Paper code" },
                      { key: "table-row-numbered-roman", label: "Row Roman #" },
                      { key: "callout-pin-decoration", label: "📍 callout" },
                      { key: "page-margin-notes-area", label: "Margin notes" },
                      { key: "h1-with-bullet-square", label: "H1 ■ square" },
                      { key: "code-block-purple-night", label: "Purple night" },
                      { key: "table-borderless-rounded", label: "BL rounded" },
                      { key: "callout-no-bg", label: "Border-only" },
                      { key: "page-graph-paper-bg", label: "Graph paper" },
                      { key: "h2-with-block-prefix", label: "H2 ▌ block" },
                      { key: "code-block-amber-terminal", label: "Amber term" },
                      { key: "table-header-pill", label: "Pill header" },
                      { key: "callout-cut-corner", label: "Cut corner" },
                      { key: "page-side-folder-tab", label: "Folder tab" },
                      { key: "h3-with-folder-prefix", label: "H3 📁" },
                      { key: "code-block-mint-bg", label: "Mint code" },
                      { key: "table-cells-shadowed", label: "Cell shadow" },
                      { key: "callout-leaf-marker", label: "🍃 callout" },
                      { key: "page-tabbed-edge-top", label: "Top tab" },
                      { key: "h4-with-asterisk-prefix", label: "H4 ✱" },
                      { key: "code-block-monokai", label: "Monokai" },
                      { key: "table-first-row-highlight", label: "1st row hl" },
                      { key: "callout-quote-mark-large", label: "Quote mark" },
                      { key: "page-side-page-numbers", label: "Side pg #" },
                      { key: "h5-with-diamond-prefix", label: "H5 ◇" },
                      { key: "code-block-solarized-light", label: "Solarized" },
                      { key: "table-numbered-cols", label: "Col #" },
                      { key: "callout-pulse-once", label: "Pulse once" },
                      { key: "page-side-rule-right", label: "Right rule" },
                      { key: "h6-with-bullet-prefix", label: "H6 ◦" },
                      { key: "code-block-dracula", label: "Dracula" },
                      { key: "table-emphasized-row-first", label: "1st row big" },
                      { key: "callout-arrow-marker-right", label: "Arrow right" },
                      { key: "page-side-clip", label: "Side clip" },
                      { key: "h1-with-page-mark", label: "H1 §" },
                      { key: "code-block-github-light", label: "GH light" },
                      { key: "table-row-divider-thick", label: "Thick row div" },
                      { key: "callout-corner-flag", label: "Corner flag" },
                      { key: "page-side-binder-rings", label: "Binder rings" },
                      { key: "h2-with-page-mark", label: "H2 §" },
                      { key: "code-block-night-owl", label: "Night Owl" },
                      { key: "table-row-divider-dashed", label: "Dashed rows" },
                      { key: "callout-corner-flag-yellow", label: "Yellow flag" },
                      { key: "page-side-perforated", label: "Perforated" },
                      { key: "h3-with-page-mark", label: "H3 §" },
                      { key: "code-block-cobalt", label: "Cobalt" },
                      { key: "table-row-divider-gradient", label: "Grad rows" },
                      { key: "callout-tag-marker", label: "🏷 callout" },
                      { key: "page-side-ribbon-blue", label: "Blue ribbon" },
                      { key: "h4-with-page-mark", label: "H4 §" },
                      { key: "code-block-tokyo-night", label: "Tokyo Night" },
                      { key: "table-header-italic", label: "Italic head" },
                      { key: "callout-bar-left-thick", label: "Thick L bar" },
                      { key: "page-side-bookmark", label: "Bookmark" },
                      { key: "h5-with-page-mark", label: "H5 §" },
                      { key: "code-block-light-gray-stripes", label: "Gray stripes" },
                      { key: "table-row-divider-thin", label: "Thin rows" },
                      { key: "callout-bordered-curved", label: "Curved bdr" },
                      { key: "page-side-margin-paragraph", label: "Margin para" },
                      { key: "h6-with-page-mark", label: "H6 §" },
                      { key: "code-block-rosy-pink", label: "Rosy code" },
                      { key: "table-row-divider-double", label: "Double rows" },
                      { key: "callout-stamp-overlay", label: "Stamp" },
                      { key: "page-side-margin-icon-area", label: "Icon area" },
                      { key: "h1-with-corner-radius-blob", label: "H1 blob" },
                      { key: "code-block-rainbow-stripes", label: "Rainbow V" },
                      { key: "table-header-vertical-orientation", label: "V-head" },
                      { key: "callout-hand-pointer", label: "👉 callout" },
                      { key: "page-side-clip-paper-corner", label: "Clip+corner" },
                      { key: "h2-with-corner-radius-blob", label: "H2 blob" },
                      { key: "code-block-checkered", label: "Checkered" },
                      { key: "table-row-divider-zigzag", label: "Zigzag rows" },
                      { key: "callout-pin-overlay", label: "📌 overlay" },
                      { key: "page-side-double-margin", label: "2x margin" },
                      { key: "h3-with-corner-radius-blob", label: "H3 blob" },
                      { key: "code-block-strict-grayscale", label: "Grayscale" },
                      { key: "table-data-cell-mono", label: "Mono data" },
                      { key: "callout-cross-pattern-bg", label: "Cross bg" },
                      { key: "page-side-double-rule", label: "2x side rule" },
                      { key: "h4-corner-radius-blob", label: "H4 blob" },
                      { key: "code-block-line-spacing-loose", label: "Loose code" },
                      { key: "table-row-hover-emphasize", label: "Hover emphasize" },
                      { key: "callout-side-tab-large", label: "Large tab" },
                      { key: "page-edge-gradient", label: "Edge grad" },
                      { key: "h5-corner-radius-blob", label: "H5 blob" },
                      { key: "code-block-cool-fade", label: "Cool fade" },
                      { key: "table-row-divider-color-blue", label: "Blue rows" },
                      { key: "callout-side-tab-pill", label: "Pill tab" },
                      { key: "page-side-tab-corner", label: "Corner tab" },
                      { key: "h6-corner-radius-blob", label: "H6 blob" },
                      { key: "code-block-warm-fade", label: "Warm fade" },
                      { key: "table-row-divider-color-red", label: "Red rows" },
                      { key: "callout-side-tab-square", label: "Sq tab" },
                      { key: "page-side-tab-bottom", label: "Bottom tab" },
                      { key: "h1-with-side-marker", label: "H1 L-bar" },
                      { key: "code-block-grayscale-banded", label: "Banded gray" },
                      { key: "table-row-divider-color-green", label: "Green rows" },
                      { key: "callout-side-tab-arrow", label: "Arrow tab" },
                      { key: "page-side-tab-top-right", label: "TR tab" },
                      { key: "h2-with-side-marker", label: "H2 L-bar" },
                      { key: "code-block-noise-bg", label: "Noise code" },
                      { key: "table-row-divider-color-purple", label: "Purple rows" },
                      { key: "callout-side-tab-rounded", label: "Round tab" },
                      { key: "page-side-tab-top-left", label: "TL tab" },
                      { key: "h3-with-side-marker", label: "H3 L-bar" },
                      { key: "code-block-warm-banded", label: "Warm banded" },
                      { key: "table-row-divider-color-orange", label: "Orange rows" },
                      { key: "callout-side-tab-chevron", label: "Chevron tab" },
                      { key: "page-side-tab-mid-left", label: "Mid tab" },
                      { key: "h4-with-side-marker", label: "H4 L-bar" },
                      { key: "code-block-cool-banded", label: "Cool banded" },
                      { key: "table-row-divider-color-pink", label: "Pink rows" },
                      { key: "callout-side-tab-dot", label: "Dot tab" },
                      { key: "page-side-tab-mid-right", label: "Mid R tab" },
                      { key: "h5-with-side-marker", label: "H5 L-bar" },
                      { key: "code-block-cyber-grid", label: "Cyber grid" },
                      { key: "table-row-divider-color-teal", label: "Teal rows" },
                      { key: "callout-side-tab-grip", label: "Grip tab" },
                      { key: "page-side-shadow-soft", label: "Soft shadow" },
                      { key: "h6-with-side-marker", label: "H6 L-bar" },
                      { key: "code-block-blueprint-grid", label: "BP grid" },
                      { key: "table-row-divider-color-gray", label: "Gray rows" },
                      { key: "callout-side-tab-flag", label: "Flag tab" },
                      { key: "page-side-shadow-strong", label: "Strong shadow" },
                      { key: "h1-with-underline-double", label: "H1 2x underline" },
                      { key: "code-block-magenta-night", label: "Magenta night" },
                      { key: "table-cell-corner-accent", label: "Corner accent" },
                      { key: "callout-rounded-large-shadow", label: "Round shadow" },
                      { key: "page-bg-subtle-dots", label: "Subtle dots" },
                      { key: "h2-with-underline-double", label: "H2 2x underline" },
                      { key: "code-block-forest-green", label: "Forest code" },
                      { key: "table-cell-corner-accent-tr", label: "TR accent" },
                      { key: "callout-glow-border", label: "Glow border" },
                      { key: "page-bg-subtle-lines", label: "Subtle lines" },
                      { key: "h3-with-underline-double", label: "H3 2x underline" },
                      { key: "code-block-sunset", label: "Sunset code" },
                      { key: "table-cell-corner-accent-br", label: "BR accent" },
                      { key: "callout-neon-glow", label: "Neon glow" },
                      { key: "page-bg-graph-fine", label: "Fine graph" },
                      { key: "h4-with-underline-double", label: "H4 2x underline" },
                      { key: "code-block-ocean", label: "Ocean code" },
                      { key: "table-zebra-three-tone", label: "3-tone zebra" },
                      { key: "callout-glow-pink", label: "Pink glow" },
                      { key: "page-bg-isometric", label: "Isometric" },
                      { key: "h5-with-underline-double", label: "H5 2x underline" },
                      { key: "code-block-volcano", label: "Volcano code" },
                      { key: "table-zebra-blue-tone", label: "Blue zebra" },
                      { key: "callout-glow-green", label: "Green glow" },
                      { key: "page-bg-hexagon", label: "Hexagon" },
                      { key: "h6-with-underline-double", label: "H6 2x underline" },
                      { key: "code-block-rose", label: "Rose code" },
                      { key: "table-zebra-green-tone", label: "Green zebra" },
                      { key: "callout-glow-orange", label: "Orange glow" },
                      { key: "page-bg-diagonal-lines", label: "Diagonal" },
                      { key: "h1-with-dotted-underline", label: "H1 dot underline" },
                      { key: "code-block-aurora", label: "Aurora code" },
                      { key: "table-header-gradient", label: "Grad header" },
                      { key: "callout-glow-blue", label: "Blue glow" },
                      { key: "page-bg-wave", label: "Wave bg" },
                      { key: "h2-with-dotted-underline", label: "H2 dot underline" },
                      { key: "code-block-midnight-blue", label: "Midnight" },
                      { key: "table-header-gradient-warm", label: "Warm header" },
                      { key: "callout-glow-purple", label: "Purple glow" },
                      { key: "page-bg-confetti", label: "Confetti" },
                      { key: "h3-with-dotted-underline", label: "H3 dot underline" },
                      { key: "code-block-slate", label: "Slate code" },
                      { key: "table-header-gradient-cool", label: "Cool header" },
                      { key: "callout-glow-teal", label: "Teal glow" },
                      { key: "page-bg-bubbles", label: "Bubbles" },
                      { key: "h4-with-dotted-underline", label: "H4 dot underline" },
                      { key: "code-block-charcoal", label: "Charcoal" },
                      { key: "table-header-gradient-purple", label: "Purple header" },
                      { key: "callout-glow-red", label: "Red glow" },
                      { key: "page-bg-triangles", label: "Triangles" },
                      { key: "h5-with-dotted-underline", label: "H5 dot underline" },
                      { key: "code-block-emerald", label: "Emerald code" },
                      { key: "table-cell-hover-highlight", label: "Cell hover" },
                      { key: "callout-glow-amber", label: "Amber glow" },
                      { key: "page-bg-plus-pattern", label: "Plus pattern" },
                      { key: "h6-with-dotted-underline", label: "H6 dot underline" },
                      { key: "code-block-indigo", label: "Indigo code" },
                      { key: "table-cell-hover-row-col", label: "Cross hover" },
                      { key: "callout-glow-cyan", label: "Cyan glow" },
                      { key: "page-bg-cross-hatch", label: "Cross-hatch" },
                      { key: "h1-with-box-around", label: "H1 box" },
                      { key: "code-block-crimson", label: "Crimson code" },
                      { key: "table-header-sticky-shadow", label: "Sticky shadow" },
                      { key: "callout-stripe-left", label: "Stripe left" },
                      { key: "page-bg-zigzag", label: "Zigzag bg" },
                      { key: "h2-with-box-around", label: "H2 box" },
                      { key: "code-block-teal-night", label: "Teal night" },
                      { key: "table-header-uppercase-bold", label: "UPPER head" },
                      { key: "callout-stripe-top", label: "Stripe top" },
                      { key: "page-bg-scallop", label: "Scallop" },
                      { key: "h3-with-box-around", label: "H3 box" },
                      { key: "code-block-graphite", label: "Graphite" },
                      { key: "table-header-bottom-accent", label: "Bottom accent" },
                      { key: "callout-stripe-right", label: "Stripe right" },
                      { key: "page-bg-grid-dots-combo", label: "Grid+dots" },
                      { key: "h1-with-c-series-marker", label: "H1 🎊" },
                      { key: "page-c-series-complete-stamp", label: "C-SERIES stamp" },
                      { key: "h2-with-double-arrow", label: "H2 »" },
                      { key: "code-block-nord-theme", label: "Nord" },
                      { key: "table-cell-roomy", label: "Roomy cells" },
                      { key: "callout-corner-fold", label: "Corner fold" },
                      { key: "page-bg-vertical-rule", label: "Vertical rule" },
                      { key: "h3-with-chevron", label: "H3 ›" },
                      { key: "code-block-github-light", label: "GitHub light" },
                      { key: "table-first-col-bold", label: "1st col bold" },
                      { key: "callout-left-accent-thick", label: "Thick accent" },
                      { key: "page-bg-diagonal-stripes", label: "Diagonal" },
                      { key: "h4-with-bullet", label: "H4 •" },
                      { key: "code-block-one-dark", label: "One Dark" },
                      { key: "table-zebra-columns", label: "Zebra cols" },
                      { key: "callout-icon-large", label: "Big icon" },
                      { key: "page-bg-graph-paper", label: "Graph paper" },
                      { key: "h5-with-dash", label: "H5 –" },
                      { key: "code-block-gruvbox", label: "Gruvbox" },
                      { key: "table-compact-rows", label: "Compact rows" },
                      { key: "callout-shadow-inset", label: "Inset shadow" },
                      { key: "page-bg-weave", label: "Weave" },
                      { key: "h6-with-arrow", label: "H6 →" },
                      { key: "code-block-tomorrow-night", label: "Tomorrow" },
                      { key: "table-border-double", label: "Double border" },
                      { key: "callout-gradient-bg", label: "Gradient bg" },
                      { key: "page-bg-polka-large", label: "Big polka" },
                      { key: "heading-all-letterspaced", label: "Tracked head" },
                      { key: "code-block-palenight", label: "Palenight" },
                      { key: "table-rounded-corners", label: "Rounded table" },
                      { key: "callout-dashed-border", label: "Dashed border" },
                      { key: "page-bg-chevron-pattern", label: "Chevron" },
                      { key: "heading-italic-all", label: "Italic head" },
                      { key: "code-block-ayu-dark", label: "Ayu dark" },
                      { key: "table-header-sticky", label: "Sticky head" },
                      { key: "callout-pill-shape", label: "Pill shape" },
                      { key: "page-bg-stars", label: "Stars" },
                      { key: "heading-underline-all", label: "Underlined" },
                      { key: "code-block-synthwave", label: "Synthwave" },
                      { key: "table-no-borders", label: "Borderless" },
                      { key: "callout-3d-raised", label: "Raised" },
                      { key: "page-bg-blueprint", label: "Blueprint" },
                      { key: "heading-shadow-text", label: "Text shadow" },
                      { key: "code-block-monokai-pro", label: "Monokai Pro" },
                      { key: "table-striped-thick", label: "Thick stripe" },
                      { key: "callout-neon-outline", label: "Neon outline" },
                      { key: "page-bg-honeycomb", label: "Honeycomb" },
                      { key: "heading-gradient-fill", label: "Gradient text" },
                      { key: "code-block-dracula-pro", label: "Dracula Pro" },
                      { key: "table-hover-highlight", label: "Hover row" },
                      { key: "callout-emoji-hidden", label: "Hide icon" },
                      { key: "page-bg-circuit", label: "Circuit" },
                      { key: "heading-numbered-auto", label: "Auto number" },
                      { key: "code-block-horizon", label: "Horizon" },
                      { key: "table-cell-center", label: "Center cells" },
                      { key: "callout-top-border-accent", label: "Top accent" },
                      { key: "page-bg-noise", label: "Noise" },
                      { key: "heading-uppercase-all", label: "UPPER head" },
                      { key: "code-block-catppuccin", label: "Catppuccin" },
                      { key: "table-row-numbers", label: "Row numbers" },
                      { key: "callout-glass-blur", label: "Glass blur" },
                      { key: "page-bg-gradient-radial", label: "Radial fade" },
                      { key: "heading-left-border", label: "Head bar" },
                      { key: "code-block-everforest", label: "Everforest" },
                      { key: "table-header-2tone", label: "2-tone head" },
                      { key: "callout-rounded-left", label: "Round left" },
                      { key: "page-bg-topographic", label: "Topographic" },
                      { key: "heading-double-underline", label: "Dbl underline" },
                      { key: "code-block-kanagawa", label: "Kanagawa" },
                      { key: "table-vertical-lines", label: "V-lines only" },
                      { key: "callout-soft-tint", label: "Soft tint" },
                      { key: "page-bg-droplets", label: "Droplets" },
                      { key: "heading-small-caps", label: "Small caps" },
                      { key: "code-block-rose-pine", label: "Rosé Pine" },
                      { key: "table-alt-col-tint", label: "Alt col tint" },
                      { key: "callout-inset-border", label: "Inset border" },
                      { key: "page-bg-plus-grid", label: "Plus grid" },
                      { key: "heading-mono-font", label: "Mono head" },
                      { key: "code-block-zenburn", label: "Zenburn" },
                      { key: "table-header-tracked", label: "Tracked head" },
                      { key: "callout-bg-striped", label: "Striped bg" },
                      { key: "page-bg-maze", label: "Maze" },
                      { key: "heading-colored-h1", label: "Color H1" },
                      { key: "code-block-oceanic", label: "Oceanic" },
                      { key: "table-zebra-rounded", label: "Zebra round" },
                      { key: "callout-quote-bar", label: "Quote bar" },
                      { key: "page-bg-scales", label: "Scales" },
                      { key: "heading-bg-highlight", label: "Highlight bg" },
                      { key: "code-block-material", label: "Material" },
                      { key: "table-first-row-accent", label: "Row accent" },
                      { key: "callout-icon-circle", label: "Icon circle" },
                      { key: "page-bg-waves", label: "Waves" },
                      { key: "heading-bracket-wrap", label: "Bracketed" },
                      { key: "code-block-nord-light", label: "Nord light" },
                      { key: "table-dense-borders", label: "Dense border" },
                      { key: "callout-rounded-top", label: "Round top" },
                      { key: "page-bg-dots-diagonal", label: "Diag dots" },
                      { key: "heading-overline", label: "Overline" },
                      { key: "code-block-iceberg", label: "Iceberg" },
                      { key: "table-cell-right-align", label: "Right align" },
                      { key: "callout-frosted", label: "Frosted" },
                      { key: "page-bg-grid-fade", label: "Grid fade" },
                      { key: "heading-tiny-caps-label", label: "Label caps" },
                      { key: "code-block-gruvbox-light", label: "Gruvbox lt" },
                      { key: "table-zebra-emerald", label: "Emerald zebra" },
                      { key: "callout-gradient-border", label: "Gradient bdr" },
                      { key: "page-bg-spotlight", label: "Spotlight" },
                      { key: "heading-corner-tab", label: "Corner tab" },
                      { key: "code-block-gotham", label: "Gotham" },
                      { key: "table-borderless-zebra", label: "Bare zebra" },
                      { key: "callout-icon-top", label: "Icon top" },
                      { key: "page-bg-soft-vignette", label: "Vignette" },
                      { key: "heading-side-number", label: "Side number" },
                      { key: "code-block-base16", label: "Base16" },
                      { key: "table-thick-header-line", label: "Header line" },
                      { key: "callout-corner-ribbon", label: "Ribbon" },
                      { key: "page-bg-subtle-checker", label: "Checker" },
                      { key: "heading-italic-h1-only", label: "Italic H1" },
                      { key: "code-block-spacegray", label: "Space Gray" },
                      { key: "table-row-hover-scale", label: "Hover lift" },
                      { key: "callout-left-icon-bar", label: "Icon bar" },
                      { key: "page-bg-confetti-dots", label: "Confetti dots" },
                      { key: "heading-condensed", label: "Condensed" },
                      { key: "code-block-tokyo-storm", label: "Tokyo Storm" },
                      { key: "table-cell-vertical-center", label: "V-center" },
                      { key: "callout-outline-only", label: "Outline only" },
                      { key: "page-bg-diamonds", label: "Diamonds" },
                      { key: "heading-serif-font", label: "Serif head" },
                      { key: "code-block-ayu-mirage", label: "Ayu Mirage" },
                      { key: "table-zebra-amber", label: "Amber zebra" },
                      { key: "callout-pulse-border", label: "Pulse border" },
                      { key: "page-bg-grid-bold", label: "Bold grid" },
                      { key: "heading-shadow-offset", label: "Hard shadow" },
                      { key: "code-block-vscode-dark", label: "VSCode dark" },
                      { key: "table-rounded-header", label: "Round header" },
                      { key: "callout-left-tab-label", label: "Tab label" },
                      { key: "page-bg-carbon", label: "Carbon" },
                      { key: "heading-all-bold-black", label: "Black weight" },
                      { key: "code-block-github-dark", label: "GitHub dark" },
                      { key: "table-header-lowercase", label: "lower head" },
                      { key: "callout-thin-border", label: "Thin border" },
                      { key: "page-bg-soft-grid-dots", label: "Soft dots" },
                      { key: "heading-underline-gradient", label: "Gradient line" },
                      { key: "code-block-night-owl-light", label: "Night Owl lt" },
                      { key: "table-cell-borders-dashed", label: "Dashed cells" },
                      { key: "callout-shadow-lg", label: "Big shadow" },
                      { key: "page-bg-radial-dots", label: "Radial dots" },
                      { key: "heading-pill-bg", label: "Pill bg" },
                      { key: "code-block-min-light", label: "Min light" },
                      { key: "table-compact-font", label: "Small font" },
                      { key: "callout-icon-square", label: "Icon square" },
                      { key: "page-bg-soft-noise2", label: "Fine noise" },
                      { key: "heading-letterpress", label: "Letterpress" },
                      { key: "code-block-panda", label: "Panda" },
                      { key: "table-header-pill-cells", label: "Pill cells" },
                      { key: "callout-corner-accent", label: "Corner accent" },
                      { key: "page-bg-grid-thin", label: "Thin grid" },
                      { key: "heading-dotted-underline", label: "Dotted line" },
                      { key: "code-block-snazzy", label: "Snazzy" },
                      { key: "table-first-col-sticky", label: "Sticky col" },
                      { key: "callout-text-uppercase", label: "UPPER text" },
                      { key: "page-bg-grain", label: "Grain" },
                      { key: "heading-double-color", label: "Two-color" },
                      { key: "code-block-bluloco", label: "Bluloco" },
                      { key: "table-cell-monospace", label: "Mono cells" },
                      { key: "callout-rounded-2xl", label: "Extra round" },
                      { key: "page-bg-mesh-gradient", label: "Mesh" },
                      { key: "heading-tag-prefix", label: "#tag prefix" },
                      { key: "code-block-poimandres", label: "Poimandres" },
                      { key: "table-cell-top-align", label: "Top align" },
                      { key: "callout-no-padding", label: "Tight" },
                      { key: "page-bg-blobs", label: "Blobs" },
                      { key: "heading-wavy-underline", label: "Wavy line" },
                      { key: "code-block-flexoki", label: "Flexoki" },
                      { key: "table-cell-nowrap", label: "No wrap" },
                      { key: "callout-side-accent-gradient", label: "Side gradient" },
                      { key: "page-bg-corner-glow", label: "Corner glow" },
                      { key: "heading-bg-stripe", label: "BG stripe" },
                      { key: "code-block-vesper", label: "Vesper" },
                      { key: "table-row-divider-bold", label: "Bold rows" },
                      { key: "callout-icon-spin", label: "Spin icon" },
                      { key: "page-bg-soft-rays", label: "Rays" },
                      { key: "heading-margin-note", label: "Margin note" },
                      { key: "code-block-aura", label: "Aura" },
                      { key: "table-striped-purple", label: "Purple zebra" },
                      { key: "callout-emoji-bounce", label: "Bounce icon" },
                      { key: "page-bg-aurora", label: "Aurora" },
                      { key: "heading-italic-serif", label: "Italic serif" },
                      { key: "code-block-rose-pine-dawn", label: "Rosé Dawn" },
                      { key: "table-cell-borders-thick", label: "Thick cells" },
                      { key: "callout-rounded-bottom", label: "Round bottom" },
                      { key: "page-bg-soft-checker2", label: "Big checker" },
                      { key: "heading-ribbon", label: "Ribbon head" },
                      { key: "code-block-gruvbox-material", label: "Gruvbox Mat" },
                      { key: "table-header-dark", label: "Dark header" },
                      { key: "callout-elevated-card", label: "Card" },
                      { key: "page-bg-soft-glow-center", label: "Center glow" },
                      { key: "heading-caps-accent", label: "Caps accent" },
                      { key: "code-block-night-fox", label: "Night Fox" },
                      { key: "table-zebra-rose", label: "Rose zebra" },
                      { key: "callout-badge-corner", label: "Badge" },
                      { key: "page-bg-soft-lines-h", label: "H-lines" },
                      { key: "heading-side-bracket", label: "Side bracket" },
                      { key: "code-block-everblush", label: "Everblush" },
                      { key: "table-zebra-slate", label: "Slate zebra" },
                      { key: "callout-left-dot", label: "Left dot" },
                      { key: "page-bg-soft-lines-v", label: "V-lines" },
                      { key: "heading-gradient-bar", label: "Gradient bar" },
                      { key: "code-block-melange", label: "Melange" },
                      { key: "table-zebra-teal", label: "Teal zebra" },
                      { key: "callout-double-stripe", label: "Double stripe" },
                      { key: "page-bg-soft-glow-tl", label: "TL glow" },
                      { key: "heading-marker-square", label: "■ marker" },
                      { key: "code-block-modus", label: "Modus" },
                      { key: "table-zebra-indigo", label: "Indigo zebra" },
                      { key: "callout-top-tab", label: "Top tab" },
                      { key: "page-bg-soft-glow-br", label: "BR glow" },
                      { key: "heading-marker-diamond", label: "◆ marker" },
                      { key: "code-block-flexoki-light", label: "Flexoki lt" },
                      { key: "table-zebra-cyan", label: "Cyan zebra" },
                      { key: "callout-bottom-tab", label: "Bottom tab" },
                      { key: "page-bg-soft-glow-bl", label: "BL glow" },
                      { key: "heading-marker-circle", label: "● marker" },
                      { key: "code-block-tokyo-day", label: "Tokyo Day" },
                      { key: "table-zebra-fuchsia", label: "Fuchsia zebra" },
                      { key: "callout-glow-bottom", label: "Bottom glow" },
                      { key: "page-bg-soft-glow-tr", label: "TR glow" },
                      { key: "h1-with-d-series-marker", label: "H1 🏆" },
                      { key: "page-d-series-complete-stamp", label: "D-SERIES stamp" },
                      { key: "code-block-rose-pine-moon", label: "Rosé Pine" },
                      { key: "table-border-double-emerald", label: "Double emerald" },
                      { key: "callout-emerald-tint", label: "Emerald tint" },
                      { key: "page-bg-engraved-grid", label: "Engraved grid" },
                      { key: "heading-emerald-underline", label: "Emerald underline" },
                      { key: "code-block-eap-1", label: "code-block eap1" },
                      { key: "table-eap-2", label: "table eap2" },
                      { key: "callout-eap-3", label: "callout eap3" },
                      { key: "page-bg-eap-4", label: "page-bg eap4" },
                      { key: "heading-eap-5", label: "heading eap5" },
                      { key: "code-block-ebe-1", label: "code-block ebe1" },
                      { key: "table-ebe-2", label: "table ebe2" },
                      { key: "callout-ebe-3", label: "callout ebe3" },
                      { key: "page-bg-ebe-4", label: "page-bg ebe4" },
                      { key: "heading-ebe-5", label: "heading ebe5" },
                      { key: "code-block-ebt-1", label: "code-block ebt1" },
                      { key: "table-ebt-2", label: "table ebt2" },
                      { key: "callout-ebt-3", label: "callout ebt3" },
                      { key: "page-bg-ebt-4", label: "page-bg ebt4" },
                      { key: "heading-ebt-5", label: "heading ebt5" },
                      { key: "code-block-eci-1", label: "code-block eci1" },
                      { key: "table-eci-2", label: "table eci2" },
                      { key: "callout-eci-3", label: "callout eci3" },
                      { key: "page-bg-eci-4", label: "page-bg eci4" },
                      { key: "heading-eci-5", label: "heading eci5" },
                      { key: "code-block-ecx-1", label: "code-block ecx1" },
                      { key: "table-ecx-2", label: "table ecx2" },
                      { key: "callout-ecx-3", label: "callout ecx3" },
                      { key: "page-bg-ecx-4", label: "page-bg ecx4" },
                      { key: "heading-ecx-5", label: "heading ecx5" },
                      { key: "code-block-edm-1", label: "code-block edm1" },
                      { key: "table-edm-2", label: "table edm2" },
                      { key: "callout-edm-3", label: "callout edm3" },
                      { key: "page-bg-edm-4", label: "page-bg edm4" },
                      { key: "heading-edm-5", label: "heading edm5" },
                      { key: "code-block-eeb-1", label: "code-block eeb1" },
                      { key: "table-eeb-2", label: "table eeb2" },
                      { key: "callout-eeb-3", label: "callout eeb3" },
                      { key: "page-bg-eeb-4", label: "page-bg eeb4" },
                      { key: "heading-eeb-5", label: "heading eeb5" },
                      { key: "code-block-eer-1", label: "code-block eer1" },
                      { key: "table-eer-2", label: "table eer2" },
                      { key: "callout-eer-3", label: "callout eer3" },
                      { key: "page-bg-eer-4", label: "page-bg eer4" },
                      { key: "heading-eer-5", label: "heading eer5" },
                      { key: "code-block-efg-1", label: "code-block efg1" },
                      { key: "table-efg-2", label: "table efg2" },
                      { key: "callout-efg-3", label: "callout efg3" },
                      { key: "page-bg-efg-4", label: "page-bg efg4" },
                      { key: "heading-efg-5", label: "heading efg5" },
                      { key: "code-block-efv-1", label: "code-block efv1" },
                      { key: "table-efv-2", label: "table efv2" },
                      { key: "callout-efv-3", label: "callout efv3" },
                      { key: "page-bg-efv-4", label: "page-bg efv4" },
                      { key: "heading-efv-5", label: "heading efv5" },
                      { key: "code-block-egk-1", label: "code-block egk1" },
                      { key: "table-egk-2", label: "table egk2" },
                      { key: "callout-egk-3", label: "callout egk3" },
                      { key: "page-bg-egk-4", label: "page-bg egk4" },
                      { key: "heading-egk-5", label: "heading egk5" },
                      { key: "code-block-egz-1", label: "code-block egz1" },
                      { key: "table-egz-2", label: "table egz2" },
                      { key: "callout-egz-3", label: "callout egz3" },
                      { key: "page-bg-egz-4", label: "page-bg egz4" },
                      { key: "heading-egz-5", label: "heading egz5" },
                      { key: "code-block-eho-1", label: "code-block eho1" },
                      { key: "table-eho-2", label: "table eho2" },
                      { key: "callout-eho-3", label: "callout eho3" },
                      { key: "page-bg-eho-4", label: "page-bg eho4" },
                      { key: "heading-eho-5", label: "heading eho5" },
                      { key: "code-block-eid-1", label: "code-block eid1" },
                      { key: "table-eid-2", label: "table eid2" },
                      { key: "callout-eid-3", label: "callout eid3" },
                      { key: "page-bg-eid-4", label: "page-bg eid4" },
                      { key: "heading-eid-5", label: "heading eid5" },
                      { key: "code-block-eis-1", label: "code-block eis1" },
                      { key: "table-eis-2", label: "table eis2" },
                      { key: "callout-eis-3", label: "callout eis3" },
                      { key: "page-bg-eis-4", label: "page-bg eis4" },
                      { key: "heading-eis-5", label: "heading eis5" },
                      { key: "code-block-ejh-1", label: "code-block ejh1" },
                      { key: "table-ejh-2", label: "table ejh2" },
                      { key: "callout-ejh-3", label: "callout ejh3" },
                      { key: "page-bg-ejh-4", label: "page-bg ejh4" },
                      { key: "heading-ejh-5", label: "heading ejh5" },
                      { key: "code-block-ejw-1", label: "code-block ejw1" },
                      { key: "table-ejw-2", label: "table ejw2" },
                      { key: "callout-ejw-3", label: "callout ejw3" },
                      { key: "page-bg-ejw-4", label: "page-bg ejw4" },
                      { key: "heading-ejw-5", label: "heading ejw5" },
                      { key: "code-block-ekl-1", label: "code-block ekl1" },
                      { key: "table-ekl-2", label: "table ekl2" },
                      { key: "callout-ekl-3", label: "callout ekl3" },
                      { key: "page-bg-ekl-4", label: "page-bg ekl4" },
                      { key: "heading-ekl-5", label: "heading ekl5" },
                      { key: "code-block-ela-1", label: "code-block ela1" },
                      { key: "table-ela-2", label: "table ela2" },
                      { key: "callout-ela-3", label: "callout ela3" },
                      { key: "page-bg-ela-4", label: "page-bg ela4" },
                      { key: "heading-ela-5", label: "heading ela5" },
                      { key: "code-block-elp-1", label: "code-block elp1" },
                      { key: "table-elp-2", label: "table elp2" },
                      { key: "callout-elp-3", label: "callout elp3" },
                      { key: "page-bg-elp-4", label: "page-bg elp4" },
                      { key: "heading-elp-5", label: "heading elp5" },
                      { key: "code-block-eme-1", label: "code-block eme1" },
                      { key: "table-eme-2", label: "table eme2" },
                      { key: "callout-eme-3", label: "callout eme3" },
                      { key: "page-bg-eme-4", label: "page-bg eme4" },
                      { key: "heading-eme-5", label: "heading eme5" },
                      { key: "code-block-emt-1", label: "code-block emt1" },
                      { key: "table-emt-2", label: "table emt2" },
                      { key: "callout-emt-3", label: "callout emt3" },
                      { key: "page-bg-emt-4", label: "page-bg emt4" },
                      { key: "heading-emt-5", label: "heading emt5" },
                      { key: "code-block-eni-1", label: "code-block eni1" },
                      { key: "table-eni-2", label: "table eni2" },
                      { key: "callout-eni-3", label: "callout eni3" },
                      { key: "page-bg-eni-4", label: "page-bg eni4" },
                      { key: "heading-eni-5", label: "heading eni5" },
                      { key: "code-block-enx-1", label: "code-block enx1" },
                      { key: "table-enx-2", label: "table enx2" },
                      { key: "callout-enx-3", label: "callout enx3" },
                      { key: "page-bg-enx-4", label: "page-bg enx4" },
                      { key: "heading-enx-5", label: "heading enx5" },
                      { key: "code-block-eom-1", label: "code-block eom1" },
                      { key: "table-eom-2", label: "table eom2" },
                      { key: "callout-eom-3", label: "callout eom3" },
                      { key: "page-bg-eom-4", label: "page-bg eom4" },
                      { key: "heading-eom-5", label: "heading eom5" },
                      { key: "code-block-epb-1", label: "code-block epb1" },
                      { key: "table-epb-2", label: "table epb2" },
                      { key: "callout-epb-3", label: "callout epb3" },
                      { key: "page-bg-epb-4", label: "page-bg epb4" },
                      { key: "heading-epb-5", label: "heading epb5" },
                      { key: "code-block-epq-1", label: "code-block epq1" },
                      { key: "table-epq-2", label: "table epq2" },
                      { key: "callout-epq-3", label: "callout epq3" },
                      { key: "page-bg-epq-4", label: "page-bg epq4" },
                      { key: "heading-epq-5", label: "heading epq5" },
                      { key: "code-block-eqf-1", label: "code-block eqf1" },
                      { key: "table-eqf-2", label: "table eqf2" },
                      { key: "callout-eqf-3", label: "callout eqf3" },
                      { key: "page-bg-eqf-4", label: "page-bg eqf4" },
                      { key: "heading-eqf-5", label: "heading eqf5" },
                      { key: "code-block-equ-1", label: "code-block equ1" },
                      { key: "table-equ-2", label: "table equ2" },
                      { key: "callout-equ-3", label: "callout equ3" },
                      { key: "page-bg-equ-4", label: "page-bg equ4" },
                      { key: "heading-equ-5", label: "heading equ5" },
                      { key: "code-block-erj-1", label: "code-block erj1" },
                      { key: "table-erj-2", label: "table erj2" },
                      { key: "callout-erj-3", label: "callout erj3" },
                      { key: "page-bg-erj-4", label: "page-bg erj4" },
                      { key: "heading-erj-5", label: "heading erj5" },
                      { key: "code-block-ery-1", label: "code-block ery1" },
                      { key: "table-ery-2", label: "table ery2" },
                      { key: "callout-ery-3", label: "callout ery3" },
                      { key: "page-bg-ery-4", label: "page-bg ery4" },
                      { key: "heading-ery-5", label: "heading ery5" },
                      { key: "code-block-esn-1", label: "code-block esn1" },
                      { key: "table-esn-2", label: "table esn2" },
                      { key: "callout-esn-3", label: "callout esn3" },
                      { key: "page-bg-esn-4", label: "page-bg esn4" },
                      { key: "heading-esn-5", label: "heading esn5" },
                      { key: "code-block-etc-1", label: "code-block etc1" },
                      { key: "table-etc-2", label: "table etc2" },
                      { key: "callout-etc-3", label: "callout etc3" },
                      { key: "page-bg-etc-4", label: "page-bg etc4" },
                      { key: "heading-etc-5", label: "heading etc5" },
                      { key: "code-block-etr-1", label: "code-block etr1" },
                      { key: "table-etr-2", label: "table etr2" },
                      { key: "callout-etr-3", label: "callout etr3" },
                      { key: "page-bg-etr-4", label: "page-bg etr4" },
                      { key: "heading-etr-5", label: "heading etr5" },
                      { key: "code-block-eug-1", label: "code-block eug1" },
                      { key: "table-eug-2", label: "table eug2" },
                      { key: "callout-eug-3", label: "callout eug3" },
                      { key: "page-bg-eug-4", label: "page-bg eug4" },
                      { key: "heading-eug-5", label: "heading eug5" },
                      { key: "code-block-euv-1", label: "code-block euv1" },
                      { key: "table-euv-2", label: "table euv2" },
                      { key: "callout-euv-3", label: "callout euv3" },
                      { key: "page-bg-euv-4", label: "page-bg euv4" },
                      { key: "heading-euv-5", label: "heading euv5" },
                      { key: "code-block-evk-1", label: "code-block evk1" },
                      { key: "table-evk-2", label: "table evk2" },
                      { key: "callout-evk-3", label: "callout evk3" },
                      { key: "page-bg-evk-4", label: "page-bg evk4" },
                      { key: "heading-evk-5", label: "heading evk5" },
                      { key: "code-block-evz-1", label: "code-block evz1" },
                      { key: "table-evz-2", label: "table evz2" },
                      { key: "callout-evz-3", label: "callout evz3" },
                      { key: "page-bg-evz-4", label: "page-bg evz4" },
                      { key: "heading-evz-5", label: "heading evz5" },
                      { key: "code-block-ewo-1", label: "code-block ewo1" },
                      { key: "table-ewo-2", label: "table ewo2" },
                      { key: "callout-ewo-3", label: "callout ewo3" },
                      { key: "page-bg-ewo-4", label: "page-bg ewo4" },
                      { key: "heading-ewo-5", label: "heading ewo5" },
                      { key: "code-block-exd-1", label: "code-block exd1" },
                      { key: "table-exd-2", label: "table exd2" },
                      { key: "callout-exd-3", label: "callout exd3" },
                      { key: "page-bg-exd-4", label: "page-bg exd4" },
                      { key: "heading-exd-5", label: "heading exd5" },
                      { key: "code-block-exs-1", label: "code-block exs1" },
                      { key: "table-exs-2", label: "table exs2" },
                      { key: "callout-exs-3", label: "callout exs3" },
                      { key: "page-bg-exs-4", label: "page-bg exs4" },
                      { key: "heading-exs-5", label: "heading exs5" },
                      { key: "code-block-eyh-1", label: "code-block eyh1" },
                      { key: "table-eyh-2", label: "table eyh2" },
                      { key: "callout-eyh-3", label: "callout eyh3" },
                      { key: "page-bg-eyh-4", label: "page-bg eyh4" },
                      { key: "heading-eyh-5", label: "heading eyh5" },
                      { key: "code-block-eyw-1", label: "code-block eyw1" },
                      { key: "table-eyw-2", label: "table eyw2" },
                      { key: "callout-eyw-3", label: "callout eyw3" },
                      { key: "page-bg-eyw-4", label: "page-bg eyw4" },
                      { key: "heading-eyw-5", label: "heading eyw5" },
                      { key: "code-block-ezl-1", label: "code-block ezl1" },
                      { key: "table-ezl-2", label: "table ezl2" },
                      { key: "callout-ezl-3", label: "callout ezl3" },
                      { key: "page-bg-ezl-4", label: "page-bg ezl4" },
                      { key: "heading-ezl-5", label: "heading ezl5" },
                      { key: "code-block-faa-1", label: "code-block faa1" },
                      { key: "table-faa-2", label: "table faa2" },
                      { key: "callout-faa-3", label: "callout faa3" },
                      { key: "page-bg-faa-4", label: "page-bg faa4" },
                      { key: "heading-faa-5", label: "heading faa5" },
                      { key: "code-block-faq-1", label: "code-block faq1" },
                      { key: "table-faq-2", label: "table faq2" },
                      { key: "callout-faq-3", label: "callout faq3" },
                      { key: "page-bg-faq-4", label: "page-bg faq4" },
                      { key: "heading-faq-5", label: "heading faq5" },
                      { key: "code-block-fbf-1", label: "code-block fbf1" },
                      { key: "table-fbf-2", label: "table fbf2" },
                      { key: "callout-fbf-3", label: "callout fbf3" },
                      { key: "page-bg-fbf-4", label: "page-bg fbf4" },
                      { key: "heading-fbf-5", label: "heading fbf5" },
                      { key: "code-block-fbu-1", label: "code-block fbu1" },
                      { key: "table-fbu-2", label: "table fbu2" },
                      { key: "callout-fbu-3", label: "callout fbu3" },
                      { key: "page-bg-fbu-4", label: "page-bg fbu4" },
                      { key: "heading-fbu-5", label: "heading fbu5" },
                      { key: "code-block-fcj-1", label: "code-block fcj1" },
                      { key: "table-fcj-2", label: "table fcj2" },
                      { key: "callout-fcj-3", label: "callout fcj3" },
                      { key: "page-bg-fcj-4", label: "page-bg fcj4" },
                      { key: "heading-fcj-5", label: "heading fcj5" },
                      { key: "code-block-fcy-1", label: "code-block fcy1" },
                      { key: "table-fcy-2", label: "table fcy2" },
                      { key: "callout-fcy-3", label: "callout fcy3" },
                      { key: "page-bg-fcy-4", label: "page-bg fcy4" },
                      { key: "heading-fcy-5", label: "heading fcy5" },
                      { key: "code-block-fdn-1", label: "code-block fdn1" },
                      { key: "table-fdn-2", label: "table fdn2" },
                      { key: "callout-fdn-3", label: "callout fdn3" },
                      { key: "page-bg-fdn-4", label: "page-bg fdn4" },
                      { key: "heading-fdn-5", label: "heading fdn5" },
                      { key: "code-block-fec-1", label: "code-block fec1" },
                      { key: "table-fec-2", label: "table fec2" },
                      { key: "callout-fec-3", label: "callout fec3" },
                      { key: "page-bg-fec-4", label: "page-bg fec4" },
                      { key: "heading-fec-5", label: "heading fec5" },
                      { key: "code-block-fer-1", label: "code-block fer1" },
                      { key: "table-fer-2", label: "table fer2" },
                      { key: "callout-fer-3", label: "callout fer3" },
                      { key: "page-bg-fer-4", label: "page-bg fer4" },
                      { key: "heading-fer-5", label: "heading fer5" },
                      { key: "code-block-ffh-1", label: "code-block ffh1" },
                      { key: "table-ffh-2", label: "table ffh2" },
                      { key: "callout-ffh-3", label: "callout ffh3" },
                      { key: "page-bg-ffh-4", label: "page-bg ffh4" },
                      { key: "heading-ffh-5", label: "heading ffh5" },
                      { key: "code-block-ffw-1", label: "code-block ffw1" },
                      { key: "table-ffw-2", label: "table ffw2" },
                      { key: "callout-ffw-3", label: "callout ffw3" },
                      { key: "page-bg-ffw-4", label: "page-bg ffw4" },
                      { key: "heading-ffw-5", label: "heading ffw5" },
                      { key: "code-block-fgl-1", label: "code-block fgl1" },
                      { key: "table-fgl-2", label: "table fgl2" },
                      { key: "callout-fgl-3", label: "callout fgl3" },
                      { key: "page-bg-fgl-4", label: "page-bg fgl4" },
                      { key: "heading-fgl-5", label: "heading fgl5" },
                      { key: "code-block-fha-1", label: "code-block fha1" },
                      { key: "table-fha-2", label: "table fha2" },
                      { key: "callout-fha-3", label: "callout fha3" },
                      { key: "page-bg-fha-4", label: "page-bg fha4" },
                      { key: "heading-fha-5", label: "heading fha5" },
                      { key: "code-block-fhp-1", label: "code-block fhp1" },
                      { key: "table-fhp-2", label: "table fhp2" },
                      { key: "callout-fhp-3", label: "callout fhp3" },
                      { key: "page-bg-fhp-4", label: "page-bg fhp4" },
                      { key: "heading-fhp-5", label: "heading fhp5" },
                      { key: "code-block-fie-1", label: "code-block fie1" },
                      { key: "table-fie-2", label: "table fie2" },
                      { key: "callout-fie-3", label: "callout fie3" },
                      { key: "page-bg-fie-4", label: "page-bg fie4" },
                      { key: "heading-fie-5", label: "heading fie5" },
                      { key: "code-block-fit-1", label: "code-block fit1" },
                      { key: "table-fit-2", label: "table fit2" },
                      { key: "callout-fit-3", label: "callout fit3" },
                      { key: "page-bg-fit-4", label: "page-bg fit4" },
                      { key: "heading-fit-5", label: "heading fit5" },
                      { key: "code-block-fji-1", label: "code-block fji1" },
                      { key: "table-fji-2", label: "table fji2" },
                      { key: "callout-fji-3", label: "callout fji3" },
                      { key: "page-bg-fji-4", label: "page-bg fji4" },
                      { key: "heading-fji-5", label: "heading fji5" },
                      { key: "code-block-fjx-1", label: "code-block fjx1" },
                      { key: "table-fjx-2", label: "table fjx2" },
                      { key: "callout-fjx-3", label: "callout fjx3" },
                      { key: "page-bg-fjx-4", label: "page-bg fjx4" },
                      { key: "heading-fjx-5", label: "heading fjx5" },
                      { key: "code-block-fkm-1", label: "code-block fkm1" },
                      { key: "table-fkm-2", label: "table fkm2" },
                      { key: "callout-fkm-3", label: "callout fkm3" },
                      { key: "page-bg-fkm-4", label: "page-bg fkm4" },
                      { key: "heading-fkm-5", label: "heading fkm5" },
                      { key: "code-block-flb-1", label: "code-block flb1" },
                      { key: "table-flb-2", label: "table flb2" },
                      { key: "callout-flb-3", label: "callout flb3" },
                      { key: "page-bg-flb-4", label: "page-bg flb4" },
                      { key: "heading-flb-5", label: "heading flb5" },
                      { key: "code-block-flq-1", label: "code-block flq1" },
                      { key: "table-flq-2", label: "table flq2" },
                      { key: "callout-flq-3", label: "callout flq3" },
                      { key: "page-bg-flq-4", label: "page-bg flq4" },
                      { key: "heading-flq-5", label: "heading flq5" },
                      { key: "code-block-fmf-1", label: "code-block fmf1" },
                      { key: "table-fmf-2", label: "table fmf2" },
                      { key: "callout-fmf-3", label: "callout fmf3" },
                      { key: "page-bg-fmf-4", label: "page-bg fmf4" },
                      { key: "heading-fmf-5", label: "heading fmf5" },
                      { key: "code-block-fmu-1", label: "code-block fmu1" },
                      { key: "table-fmu-2", label: "table fmu2" },
                      { key: "callout-fmu-3", label: "callout fmu3" },
                      { key: "page-bg-fmu-4", label: "page-bg fmu4" },
                      { key: "heading-fmu-5", label: "heading fmu5" },
                      { key: "code-block-fnj-1", label: "code-block fnj1" },
                      { key: "table-fnj-2", label: "table fnj2" },
                      { key: "callout-fnj-3", label: "callout fnj3" },
                      { key: "page-bg-fnj-4", label: "page-bg fnj4" },
                      { key: "heading-fnj-5", label: "heading fnj5" },
                      { key: "code-block-fny-1", label: "code-block fny1" },
                      { key: "table-fny-2", label: "table fny2" },
                      { key: "callout-fny-3", label: "callout fny3" },
                      { key: "page-bg-fny-4", label: "page-bg fny4" },
                      { key: "heading-fny-5", label: "heading fny5" },
                      { key: "code-block-fon-1", label: "code-block fon1" },
                      { key: "table-fon-2", label: "table fon2" },
                      { key: "callout-fon-3", label: "callout fon3" },
                      { key: "page-bg-fon-4", label: "page-bg fon4" },
                      { key: "heading-fon-5", label: "heading fon5" },
                      { key: "code-block-fpc-1", label: "code-block fpc1" },
                      { key: "table-fpc-2", label: "table fpc2" },
                      { key: "callout-fpc-3", label: "callout fpc3" },
                      { key: "page-bg-fpc-4", label: "page-bg fpc4" },
                      { key: "heading-fpc-5", label: "heading fpc5" },
                      { key: "code-block-fpr-1", label: "code-block fpr1" },
                      { key: "table-fpr-2", label: "table fpr2" },
                      { key: "callout-fpr-3", label: "callout fpr3" },
                      { key: "page-bg-fpr-4", label: "page-bg fpr4" },
                      { key: "heading-fpr-5", label: "heading fpr5" },
                      { key: "code-block-fqg-1", label: "code-block fqg1" },
                      { key: "table-fqg-2", label: "table fqg2" },
                      { key: "callout-fqg-3", label: "callout fqg3" },
                      { key: "page-bg-fqg-4", label: "page-bg fqg4" },
                      { key: "heading-fqg-5", label: "heading fqg5" },
                      { key: "code-block-fqv-1", label: "code-block fqv1" },
                      { key: "table-fqv-2", label: "table fqv2" },
                      { key: "callout-fqv-3", label: "callout fqv3" },
                      { key: "page-bg-fqv-4", label: "page-bg fqv4" },
                      { key: "heading-fqv-5", label: "heading fqv5" },
                      { key: "code-block-frk-1", label: "code-block frk1" },
                      { key: "table-frk-2", label: "table frk2" },
                      { key: "callout-frk-3", label: "callout frk3" },
                      { key: "page-bg-frk-4", label: "page-bg frk4" },
                      { key: "heading-frk-5", label: "heading frk5" },
                      { key: "code-block-frz-1", label: "code-block frz1" },
                      { key: "table-frz-2", label: "table frz2" },
                      { key: "callout-frz-3", label: "callout frz3" },
                      { key: "page-bg-frz-4", label: "page-bg frz4" },
                      { key: "heading-frz-5", label: "heading frz5" },
                      { key: "code-block-fso-1", label: "code-block fso1" },
                      { key: "table-fso-2", label: "table fso2" },
                      { key: "callout-fso-3", label: "callout fso3" },
                      { key: "page-bg-fso-4", label: "page-bg fso4" },
                      { key: "heading-fso-5", label: "heading fso5" },
                      { key: "code-block-ftd-1", label: "code-block ftd1" },
                      { key: "table-ftd-2", label: "table ftd2" },
                      { key: "callout-ftd-3", label: "callout ftd3" },
                      { key: "page-bg-ftd-4", label: "page-bg ftd4" },
                      { key: "heading-ftd-5", label: "heading ftd5" },
                      { key: "code-block-fts-1", label: "code-block fts1" },
                      { key: "table-fts-2", label: "table fts2" },
                      { key: "callout-fts-3", label: "callout fts3" },
                      { key: "page-bg-fts-4", label: "page-bg fts4" },
                      { key: "heading-fts-5", label: "heading fts5" },
                      { key: "code-block-fuh-1", label: "code-block fuh1" },
                      { key: "table-fuh-2", label: "table fuh2" },
                      { key: "callout-fuh-3", label: "callout fuh3" },
                      { key: "page-bg-fuh-4", label: "page-bg fuh4" },
                      { key: "heading-fuh-5", label: "heading fuh5" },
                      { key: "code-block-fuw-1", label: "code-block fuw1" },
                      { key: "table-fuw-2", label: "table fuw2" },
                      { key: "callout-fuw-3", label: "callout fuw3" },
                      { key: "page-bg-fuw-4", label: "page-bg fuw4" },
                      { key: "heading-fuw-5", label: "heading fuw5" },
                      { key: "code-block-fvl-1", label: "code-block fvl1" },
                      { key: "table-fvl-2", label: "table fvl2" },
                      { key: "callout-fvl-3", label: "callout fvl3" },
                      { key: "page-bg-fvl-4", label: "page-bg fvl4" },
                      { key: "heading-fvl-5", label: "heading fvl5" },
                      { key: "code-block-fwa-1", label: "code-block fwa1" },
                      { key: "table-fwa-2", label: "table fwa2" },
                      { key: "callout-fwa-3", label: "callout fwa3" },
                      { key: "page-bg-fwa-4", label: "page-bg fwa4" },
                      { key: "heading-fwa-5", label: "heading fwa5" },
                      { key: "code-block-fwp-1", label: "code-block fwp1" },
                      { key: "table-fwp-2", label: "table fwp2" },
                      { key: "callout-fwp-3", label: "callout fwp3" },
                      { key: "page-bg-fwp-4", label: "page-bg fwp4" },
                      { key: "heading-fwp-5", label: "heading fwp5" },
                      { key: "code-block-fxe-1", label: "code-block fxe1" },
                      { key: "table-fxe-2", label: "table fxe2" },
                      { key: "callout-fxe-3", label: "callout fxe3" },
                      { key: "page-bg-fxe-4", label: "page-bg fxe4" },
                      { key: "heading-fxe-5", label: "heading fxe5" },
                      { key: "code-block-fxt-1", label: "code-block fxt1" },
                      { key: "table-fxt-2", label: "table fxt2" },
                      { key: "callout-fxt-3", label: "callout fxt3" },
                      { key: "page-bg-fxt-4", label: "page-bg fxt4" },
                      { key: "heading-fxt-5", label: "heading fxt5" },
                      { key: "code-block-fyi-1", label: "code-block fyi1" },
                      { key: "table-fyi-2", label: "table fyi2" },
                      { key: "callout-fyi-3", label: "callout fyi3" },
                      { key: "page-bg-fyi-4", label: "page-bg fyi4" },
                      { key: "heading-fyi-5", label: "heading fyi5" },
                      { key: "code-block-fyx-1", label: "code-block fyx1" },
                      { key: "table-fyx-2", label: "table fyx2" },
                      { key: "callout-fyx-3", label: "callout fyx3" },
                      { key: "page-bg-fyx-4", label: "page-bg fyx4" },
                      { key: "heading-fyx-5", label: "heading fyx5" },
                      { key: "code-block-fzm-1", label: "code-block fzm1" },
                      { key: "table-fzm-2", label: "table fzm2" },
                      { key: "callout-fzm-3", label: "callout fzm3" },
                      { key: "page-bg-fzm-4", label: "page-bg fzm4" },
                      { key: "code-block-gaa-1", label: "code-block gaa1" },
                      { key: "table-gaa-2", label: "table gaa2" },
                      { key: "callout-gaa-3", label: "callout gaa3" },
                      { key: "page-bg-gaa-4", label: "page-bg gaa4" },
                      { key: "heading-gaa-5", label: "heading gaa5" },
                      { key: "code-block-gap-1", label: "code-block gap1" },
                      { key: "table-gap-2", label: "table gap2" },
                      { key: "callout-gap-3", label: "callout gap3" },
                      { key: "page-bg-gap-4", label: "page-bg gap4" },
                      { key: "heading-gap-5", label: "heading gap5" },
                      { key: "code-block-gbe-1", label: "code-block gbe1" },
                      { key: "table-gbe-2", label: "table gbe2" },
                      { key: "callout-gbe-3", label: "callout gbe3" },
                      { key: "page-bg-gbe-4", label: "page-bg gbe4" },
                      { key: "heading-gbe-5", label: "heading gbe5" },
                      { key: "code-block-gbt-1", label: "code-block gbt1" },
                      { key: "table-gbt-2", label: "table gbt2" },
                      { key: "callout-gbt-3", label: "callout gbt3" },
                      { key: "page-bg-gbt-4", label: "page-bg gbt4" },
                      { key: "heading-gbt-5", label: "heading gbt5" },
                      { key: "code-block-gci-1", label: "code-block gci1" },
                      { key: "table-gci-2", label: "table gci2" },
                      { key: "callout-gci-3", label: "callout gci3" },
                      { key: "page-bg-gci-4", label: "page-bg gci4" },
                      { key: "heading-gci-5", label: "heading gci5" },
                      { key: "code-block-gcx-1", label: "code-block gcx1" },
                      { key: "table-gcx-2", label: "table gcx2" },
                      { key: "callout-gcx-3", label: "callout gcx3" },
                      { key: "page-bg-gcx-4", label: "page-bg gcx4" },
                      { key: "heading-gcx-5", label: "heading gcx5" },
                      { key: "code-block-gdm-1", label: "code-block gdm1" },
                      { key: "table-gdm-2", label: "table gdm2" },
                      { key: "callout-gdm-3", label: "callout gdm3" },
                      { key: "page-bg-gdm-4", label: "page-bg gdm4" },
                      { key: "heading-gdm-5", label: "heading gdm5" },
                      { key: "code-block-geb-1", label: "code-block geb1" },
                      { key: "table-geb-2", label: "table geb2" },
                      { key: "callout-geb-3", label: "callout geb3" },
                      { key: "page-bg-geb-4", label: "page-bg geb4" },
                      { key: "heading-geb-5", label: "heading geb5" },
                      { key: "code-block-geq-1", label: "code-block geq1" },
                      { key: "table-geq-2", label: "table geq2" },
                      { key: "callout-geq-3", label: "callout geq3" },
                      { key: "page-bg-geq-4", label: "page-bg geq4" },
                      { key: "heading-geq-5", label: "heading geq5" },
                      { key: "code-block-gff-1", label: "code-block gff1" },
                      { key: "table-gff-2", label: "table gff2" },
                      { key: "callout-gff-3", label: "callout gff3" },
                      { key: "page-bg-gff-4", label: "page-bg gff4" },
                      { key: "heading-gff-5", label: "heading gff5" },
                      { key: "code-block-gfu-1", label: "code-block gfu1" },
                      { key: "table-gfu-2", label: "table gfu2" },
                      { key: "callout-gfu-3", label: "callout gfu3" },
                      { key: "page-bg-gfu-4", label: "page-bg gfu4" },
                      { key: "heading-gfu-5", label: "heading gfu5" },
                      { key: "code-block-ggk-1", label: "code-block ggk1" },
                      { key: "table-ggk-2", label: "table ggk2" },
                      { key: "callout-ggk-3", label: "callout ggk3" },
                      { key: "page-bg-ggk-4", label: "page-bg ggk4" },
                      { key: "heading-ggk-5", label: "heading ggk5" },
                      { key: "code-block-ggz-1", label: "code-block ggz1" },
                      { key: "table-ggz-2", label: "table ggz2" },
                      { key: "callout-ggz-3", label: "callout ggz3" },
                      { key: "page-bg-ggz-4", label: "page-bg ggz4" },
                      { key: "heading-ggz-5", label: "heading ggz5" },
                      { key: "code-block-gho-1", label: "code-block gho1" },
                      { key: "table-gho-2", label: "table gho2" },
                      { key: "callout-gho-3", label: "callout gho3" },
                      { key: "page-bg-gho-4", label: "page-bg gho4" },
                      { key: "heading-gho-5", label: "heading gho5" },
                      { key: "code-block-gid-1", label: "code-block gid1" },
                      { key: "table-gid-2", label: "table gid2" },
                      { key: "callout-gid-3", label: "callout gid3" },
                      { key: "page-bg-gid-4", label: "page-bg gid4" },
                      { key: "heading-gid-5", label: "heading gid5" },
                      { key: "code-block-gis-1", label: "code-block gis1" },
                      { key: "table-gis-2", label: "table gis2" },
                      { key: "callout-gis-3", label: "callout gis3" },
                      { key: "page-bg-gis-4", label: "page-bg gis4" },
                      { key: "heading-gis-5", label: "heading gis5" },
                      { key: "code-block-gjh-1", label: "code-block gjh1" },
                      { key: "table-gjh-2", label: "table gjh2" },
                      { key: "callout-gjh-3", label: "callout gjh3" },
                      { key: "page-bg-gjh-4", label: "page-bg gjh4" },
                      { key: "heading-gjh-5", label: "heading gjh5" },
                      { key: "code-block-gjw-1", label: "code-block gjw1" },
                      { key: "table-gjw-2", label: "table gjw2" },
                      { key: "callout-gjw-3", label: "callout gjw3" },
                      { key: "page-bg-gjw-4", label: "page-bg gjw4" },
                      { key: "heading-gjw-5", label: "heading gjw5" },
                      { key: "code-block-gkl-1", label: "code-block gkl1" },
                      { key: "table-gkl-2", label: "table gkl2" },
                      { key: "callout-gkl-3", label: "callout gkl3" },
                      { key: "page-bg-gkl-4", label: "page-bg gkl4" },
                      { key: "heading-gkl-5", label: "heading gkl5" },
                      { key: "code-block-gla-1", label: "code-block gla1" },
                      { key: "table-gla-2", label: "table gla2" },
                      { key: "callout-gla-3", label: "callout gla3" },
                      { key: "page-bg-gla-4", label: "page-bg gla4" },
                      { key: "heading-gla-5", label: "heading gla5" },
                      { key: "code-block-glp-1", label: "code-block glp1" },
                      { key: "table-glp-2", label: "table glp2" },
                      { key: "callout-glp-3", label: "callout glp3" },
                      { key: "page-bg-glp-4", label: "page-bg glp4" },
                      { key: "heading-glp-5", label: "heading glp5" },
                      { key: "code-block-gme-1", label: "code-block gme1" },
                      { key: "table-gme-2", label: "table gme2" },
                      { key: "callout-gme-3", label: "callout gme3" },
                      { key: "page-bg-gme-4", label: "page-bg gme4" },
                      { key: "heading-gme-5", label: "heading gme5" },
                      { key: "code-block-gmt-1", label: "code-block gmt1" },
                      { key: "table-gmt-2", label: "table gmt2" },
                      { key: "callout-gmt-3", label: "callout gmt3" },
                      { key: "page-bg-gmt-4", label: "page-bg gmt4" },
                      { key: "heading-gmt-5", label: "heading gmt5" },
                      { key: "code-block-gni-1", label: "code-block gni1" },
                      { key: "table-gni-2", label: "table gni2" },
                      { key: "callout-gni-3", label: "callout gni3" },
                      { key: "page-bg-gni-4", label: "page-bg gni4" },
                      { key: "heading-gni-5", label: "heading gni5" },
                      { key: "code-block-gnx-1", label: "code-block gnx1" },
                      { key: "table-gnx-2", label: "table gnx2" },
                      { key: "callout-gnx-3", label: "callout gnx3" },
                      { key: "page-bg-gnx-4", label: "page-bg gnx4" },
                      { key: "heading-gnx-5", label: "heading gnx5" },
                      { key: "code-block-gom-1", label: "code-block gom1" },
                      { key: "table-gom-2", label: "table gom2" },
                      { key: "callout-gom-3", label: "callout gom3" },
                      { key: "page-bg-gom-4", label: "page-bg gom4" },
                      { key: "heading-gom-5", label: "heading gom5" },
                      { key: "code-block-gpb-1", label: "code-block gpb1" },
                      { key: "table-gpb-2", label: "table gpb2" },
                      { key: "callout-gpb-3", label: "callout gpb3" },
                      { key: "page-bg-gpb-4", label: "page-bg gpb4" },
                      { key: "heading-gpb-5", label: "heading gpb5" },
                      { key: "code-block-gpq-1", label: "code-block gpq1" },
                      { key: "table-gpq-2", label: "table gpq2" },
                      { key: "callout-gpq-3", label: "callout gpq3" },
                      { key: "page-bg-gpq-4", label: "page-bg gpq4" },
                      { key: "heading-gpq-5", label: "heading gpq5" },
                      { key: "code-block-gqf-1", label: "code-block gqf1" },
                      { key: "table-gqf-2", label: "table gqf2" },
                      { key: "callout-gqf-3", label: "callout gqf3" },
                      { key: "page-bg-gqf-4", label: "page-bg gqf4" },
                      { key: "heading-gqf-5", label: "heading gqf5" },
                      { key: "code-block-gqu-1", label: "code-block gqu1" },
                      { key: "table-gqu-2", label: "table gqu2" },
                      { key: "callout-gqu-3", label: "callout gqu3" },
                      { key: "page-bg-gqu-4", label: "page-bg gqu4" },
                      { key: "heading-gqu-5", label: "heading gqu5" },
                      { key: "code-block-grj-1", label: "code-block grj1" },
                      { key: "table-grj-2", label: "table grj2" },
                      { key: "callout-grj-3", label: "callout grj3" },
                      { key: "page-bg-grj-4", label: "page-bg grj4" },
                      { key: "heading-grj-5", label: "heading grj5" },
                      { key: "code-block-gry-1", label: "code-block gry1" },
                      { key: "table-gry-2", label: "table gry2" },
                      { key: "callout-gry-3", label: "callout gry3" },
                      { key: "page-bg-gry-4", label: "page-bg gry4" },
                      { key: "heading-gry-5", label: "heading gry5" },
                      { key: "code-block-gsn-1", label: "code-block gsn1" },
                      { key: "table-gsn-2", label: "table gsn2" },
                      { key: "callout-gsn-3", label: "callout gsn3" },
                      { key: "page-bg-gsn-4", label: "page-bg gsn4" },
                      { key: "heading-gsn-5", label: "heading gsn5" },
                      { key: "code-block-gtc-1", label: "code-block gtc1" },
                      { key: "table-gtc-2", label: "table gtc2" },
                      { key: "callout-gtc-3", label: "callout gtc3" },
                      { key: "page-bg-gtc-4", label: "page-bg gtc4" },
                      { key: "heading-gtc-5", label: "heading gtc5" },
                      { key: "code-block-gtr-1", label: "code-block gtr1" },
                      { key: "table-gtr-2", label: "table gtr2" },
                      { key: "callout-gtr-3", label: "callout gtr3" },
                      { key: "page-bg-gtr-4", label: "page-bg gtr4" },
                      { key: "heading-gtr-5", label: "heading gtr5" },
                      { key: "code-block-gug-1", label: "code-block gug1" },
                      { key: "table-gug-2", label: "table gug2" },
                      { key: "callout-gug-3", label: "callout gug3" },
                      { key: "page-bg-gug-4", label: "page-bg gug4" },
                      { key: "heading-gug-5", label: "heading gug5" },
                      { key: "code-block-guv-1", label: "code-block guv1" },
                      { key: "table-guv-2", label: "table guv2" },
                      { key: "callout-guv-3", label: "callout guv3" },
                      { key: "page-bg-guv-4", label: "page-bg guv4" },
                      { key: "heading-guv-5", label: "heading guv5" },
                      { key: "code-block-gvk-1", label: "code-block gvk1" },
                      { key: "table-gvk-2", label: "table gvk2" },
                      { key: "callout-gvk-3", label: "callout gvk3" },
                      { key: "page-bg-gvk-4", label: "page-bg gvk4" },
                      { key: "heading-gvk-5", label: "heading gvk5" },
                      { key: "code-block-gvz-1", label: "code-block gvz1" },
                      { key: "table-gvz-2", label: "table gvz2" },
                      { key: "callout-gvz-3", label: "callout gvz3" },
                      { key: "page-bg-gvz-4", label: "page-bg gvz4" },
                      { key: "heading-gvz-5", label: "heading gvz5" },
                      { key: "code-block-gwo-1", label: "code-block gwo1" },
                      { key: "table-gwo-2", label: "table gwo2" },
                      { key: "callout-gwo-3", label: "callout gwo3" },
                      { key: "page-bg-gwo-4", label: "page-bg gwo4" },
                      { key: "heading-gwo-5", label: "heading gwo5" },
                      { key: "code-block-gxd-1", label: "code-block gxd1" },
                      { key: "table-gxd-2", label: "table gxd2" },
                      { key: "callout-gxd-3", label: "callout gxd3" },
                      { key: "page-bg-gxd-4", label: "page-bg gxd4" },
                      { key: "heading-gxd-5", label: "heading gxd5" },
                      { key: "code-block-gxs-1", label: "code-block gxs1" },
                      { key: "table-gxs-2", label: "table gxs2" },
                      { key: "callout-gxs-3", label: "callout gxs3" },
                      { key: "page-bg-gxs-4", label: "page-bg gxs4" },
                      { key: "heading-gxs-5", label: "heading gxs5" },
                      { key: "code-block-gyh-1", label: "code-block gyh1" },
                      { key: "table-gyh-2", label: "table gyh2" },
                      { key: "callout-gyh-3", label: "callout gyh3" },
                      { key: "page-bg-gyh-4", label: "page-bg gyh4" },
                      { key: "heading-gyh-5", label: "heading gyh5" },
                      { key: "code-block-gyw-1", label: "code-block gyw1" },
                      { key: "table-gyw-2", label: "table gyw2" },
                      { key: "callout-gyw-3", label: "callout gyw3" },
                      { key: "page-bg-gyw-4", label: "page-bg gyw4" },
                      { key: "heading-gyw-5", label: "heading gyw5" },
                      { key: "code-block-gzl-1", label: "code-block gzl1" },
                      { key: "table-gzl-2", label: "table gzl2" },
                      { key: "callout-gzl-3", label: "callout gzl3" },
                      { key: "page-bg-gzl-4", label: "page-bg gzl4" },
                      { key: "heading-gzl-5", label: "heading gzl5" },
                      { key: "code-block-haa-1", label: "code-block haa1" },
                      { key: "table-haa-2", label: "table haa2" },
                      { key: "callout-haa-3", label: "callout haa3" },
                      { key: "page-bg-haa-4", label: "page-bg haa4" },
                      { key: "heading-haa-5", label: "heading haa5" },
                      { key: "code-block-hap-1", label: "code-block hap1" },
                      { key: "table-hap-2", label: "table hap2" },
                      { key: "callout-hap-3", label: "callout hap3" },
                      { key: "page-bg-hap-4", label: "page-bg hap4" },
                      { key: "heading-hap-5", label: "heading hap5" },
                      { key: "code-block-hbe-1", label: "code-block hbe1" },
                      { key: "table-hbe-2", label: "table hbe2" },
                      { key: "callout-hbe-3", label: "callout hbe3" },
                      { key: "page-bg-hbe-4", label: "page-bg hbe4" },
                      { key: "heading-hbe-5", label: "heading hbe5" },
                      { key: "code-block-hbt-1", label: "code-block hbt1" },
                      { key: "table-hbt-2", label: "table hbt2" },
                      { key: "callout-hbt-3", label: "callout hbt3" },
                      { key: "page-bg-hbt-4", label: "page-bg hbt4" },
                      { key: "heading-hbt-5", label: "heading hbt5" },
                      { key: "code-block-hci-1", label: "code-block hci1" },
                      { key: "table-hci-2", label: "table hci2" },
                      { key: "callout-hci-3", label: "callout hci3" },
                      { key: "page-bg-hci-4", label: "page-bg hci4" },
                      { key: "heading-hci-5", label: "heading hci5" },
                      { key: "code-block-hcx-1", label: "code-block hcx1" },
                      { key: "table-hcx-2", label: "table hcx2" },
                      { key: "callout-hcx-3", label: "callout hcx3" },
                      { key: "page-bg-hcx-4", label: "page-bg hcx4" },
                      { key: "heading-hcx-5", label: "heading hcx5" },
                      { key: "code-block-hdm-1", label: "code-block hdm1" },
                      { key: "table-hdm-2", label: "table hdm2" },
                      { key: "callout-hdm-3", label: "callout hdm3" },
                      { key: "page-bg-hdm-4", label: "page-bg hdm4" },
                      { key: "heading-hdm-5", label: "heading hdm5" },
                      { key: "code-block-heb-1", label: "code-block heb1" },
                      { key: "table-heb-2", label: "table heb2" },
                      { key: "callout-heb-3", label: "callout heb3" },
                      { key: "page-bg-heb-4", label: "page-bg heb4" },
                      { key: "heading-heb-5", label: "heading heb5" },
                      { key: "code-block-heq-1", label: "code-block heq1" },
                      { key: "table-heq-2", label: "table heq2" },
                      { key: "callout-heq-3", label: "callout heq3" },
                      { key: "page-bg-heq-4", label: "page-bg heq4" },
                      { key: "heading-heq-5", label: "heading heq5" },
                      { key: "code-block-hff-1", label: "code-block hff1" },
                      { key: "table-hff-2", label: "table hff2" },
                      { key: "callout-hff-3", label: "callout hff3" },
                      { key: "page-bg-hff-4", label: "page-bg hff4" },
                      { key: "heading-hff-5", label: "heading hff5" },
                      { key: "code-block-hfu-1", label: "code-block hfu1" },
                      { key: "table-hfu-2", label: "table hfu2" },
                      { key: "callout-hfu-3", label: "callout hfu3" },
                      { key: "page-bg-hfu-4", label: "page-bg hfu4" },
                      { key: "heading-hfu-5", label: "heading hfu5" },
                      { key: "code-block-hgj-1", label: "code-block hgj1" },
                      { key: "table-hgj-2", label: "table hgj2" },
                      { key: "callout-hgj-3", label: "callout hgj3" },
                      { key: "page-bg-hgj-4", label: "page-bg hgj4" },
                      { key: "heading-hgj-5", label: "heading hgj5" },
                      { key: "code-block-hgy-1", label: "code-block hgy1" },
                      { key: "table-hgy-2", label: "table hgy2" },
                      { key: "callout-hgy-3", label: "callout hgy3" },
                      { key: "page-bg-hgy-4", label: "page-bg hgy4" },
                      { key: "heading-hgy-5", label: "heading hgy5" },
                      { key: "code-block-hho-1", label: "code-block hho1" },
                      { key: "table-hho-2", label: "table hho2" },
                      { key: "callout-hho-3", label: "callout hho3" },
                      { key: "page-bg-hho-4", label: "page-bg hho4" },
                      { key: "heading-hho-5", label: "heading hho5" },
                      { key: "code-block-hid-1", label: "code-block hid1" },
                      { key: "table-hid-2", label: "table hid2" },
                      { key: "callout-hid-3", label: "callout hid3" },
                      { key: "page-bg-hid-4", label: "page-bg hid4" },
                      { key: "heading-hid-5", label: "heading hid5" },
                      { key: "code-block-his-1", label: "code-block his1" },
                      { key: "table-his-2", label: "table his2" },
                      { key: "callout-his-3", label: "callout his3" },
                      { key: "page-bg-his-4", label: "page-bg his4" },
                      { key: "heading-his-5", label: "heading his5" },
                      { key: "code-block-hjh-1", label: "code-block hjh1" },
                      { key: "table-hjh-2", label: "table hjh2" },
                      { key: "callout-hjh-3", label: "callout hjh3" },
                      { key: "page-bg-hjh-4", label: "page-bg hjh4" },
                      { key: "heading-hjh-5", label: "heading hjh5" },
                      { key: "code-block-hjw-1", label: "code-block hjw1" },
                      { key: "table-hjw-2", label: "table hjw2" },
                      { key: "callout-hjw-3", label: "callout hjw3" },
                      { key: "page-bg-hjw-4", label: "page-bg hjw4" },
                      { key: "heading-hjw-5", label: "heading hjw5" },
                      { key: "code-block-hkl-1", label: "code-block hkl1" },
                      { key: "table-hkl-2", label: "table hkl2" },
                      { key: "callout-hkl-3", label: "callout hkl3" },
                      { key: "page-bg-hkl-4", label: "page-bg hkl4" },
                      { key: "heading-hkl-5", label: "heading hkl5" },
                      { key: "code-block-hla-1", label: "code-block hla1" },
                      { key: "table-hla-2", label: "table hla2" },
                      { key: "callout-hla-3", label: "callout hla3" },
                      { key: "page-bg-hla-4", label: "page-bg hla4" },
                      { key: "heading-hla-5", label: "heading hla5" },
                      { key: "code-block-hlp-1", label: "code-block hlp1" },
                      { key: "table-hlp-2", label: "table hlp2" },
                      { key: "callout-hlp-3", label: "callout hlp3" },
                      { key: "page-bg-hlp-4", label: "page-bg hlp4" },
                      { key: "heading-hlp-5", label: "heading hlp5" },
                      { key: "code-block-hme-1", label: "code-block hme1" },
                      { key: "table-hme-2", label: "table hme2" },
                      { key: "callout-hme-3", label: "callout hme3" },
                      { key: "page-bg-hme-4", label: "page-bg hme4" },
                      { key: "heading-hme-5", label: "heading hme5" },
                      { key: "code-block-hmt-1", label: "code-block hmt1" },
                      { key: "table-hmt-2", label: "table hmt2" },
                      { key: "callout-hmt-3", label: "callout hmt3" },
                      { key: "page-bg-hmt-4", label: "page-bg hmt4" },
                      { key: "heading-hmt-5", label: "heading hmt5" },
                      { key: "code-block-hni-1", label: "code-block hni1" },
                      { key: "table-hni-2", label: "table hni2" },
                      { key: "callout-hni-3", label: "callout hni3" },
                      { key: "page-bg-hni-4", label: "page-bg hni4" },
                      { key: "heading-hni-5", label: "heading hni5" },
                      { key: "code-block-hnx-1", label: "code-block hnx1" },
                      { key: "table-hnx-2", label: "table hnx2" },
                      { key: "callout-hnx-3", label: "callout hnx3" },
                      { key: "page-bg-hnx-4", label: "page-bg hnx4" },
                      { key: "heading-hnx-5", label: "heading hnx5" },
                      { key: "code-block-hom-1", label: "code-block hom1" },
                      { key: "table-hom-2", label: "table hom2" },
                      { key: "callout-hom-3", label: "callout hom3" },
                      { key: "page-bg-hom-4", label: "page-bg hom4" },
                      { key: "heading-hom-5", label: "heading hom5" },
                      { key: "code-block-hpb-1", label: "code-block hpb1" },
                      { key: "table-hpb-2", label: "table hpb2" },
                      { key: "callout-hpb-3", label: "callout hpb3" },
                      { key: "page-bg-hpb-4", label: "page-bg hpb4" },
                      { key: "heading-hpb-5", label: "heading hpb5" },
                      { key: "code-block-hpq-1", label: "code-block hpq1" },
                      { key: "table-hpq-2", label: "table hpq2" },
                      { key: "callout-hpq-3", label: "callout hpq3" },
                      { key: "page-bg-hpq-4", label: "page-bg hpq4" },
                      { key: "heading-hpq-5", label: "heading hpq5" },
                      { key: "code-block-hqf-1", label: "code-block hqf1" },
                      { key: "table-hqf-2", label: "table hqf2" },
                      { key: "callout-hqf-3", label: "callout hqf3" },
                      { key: "page-bg-hqf-4", label: "page-bg hqf4" },
                      { key: "heading-hqf-5", label: "heading hqf5" },
                      { key: "code-block-hqu-1", label: "code-block hqu1" },
                      { key: "table-hqu-2", label: "table hqu2" },
                      { key: "callout-hqu-3", label: "callout hqu3" },
                      { key: "page-bg-hqu-4", label: "page-bg hqu4" },
                      { key: "heading-hqu-5", label: "heading hqu5" },
                      { key: "code-block-hrj-1", label: "code-block hrj1" },
                      { key: "table-hrj-2", label: "table hrj2" },
                      { key: "callout-hrj-3", label: "callout hrj3" },
                      { key: "page-bg-hrj-4", label: "page-bg hrj4" },
                      { key: "heading-hrj-5", label: "heading hrj5" },
                      { key: "code-block-hry-1", label: "code-block hry1" },
                      { key: "table-hry-2", label: "table hry2" },
                      { key: "callout-hry-3", label: "callout hry3" },
                      { key: "page-bg-hry-4", label: "page-bg hry4" },
                      { key: "heading-hry-5", label: "heading hry5" },
                      { key: "code-block-hsn-1", label: "code-block hsn1" },
                      { key: "table-hsn-2", label: "table hsn2" },
                      { key: "callout-hsn-3", label: "callout hsn3" },
                      { key: "page-bg-hsn-4", label: "page-bg hsn4" },
                      { key: "heading-hsn-5", label: "heading hsn5" },
                      { key: "code-block-htc-1", label: "code-block htc1" },
                      { key: "table-htc-2", label: "table htc2" },
                      { key: "callout-htc-3", label: "callout htc3" },
                      { key: "page-bg-htc-4", label: "page-bg htc4" },
                      { key: "heading-htc-5", label: "heading htc5" },
                      { key: "code-block-hts-1", label: "code-block hts1" },
                      { key: "table-hts-2", label: "table hts2" },
                      { key: "callout-hts-3", label: "callout hts3" },
                      { key: "page-bg-hts-4", label: "page-bg hts4" },
                      { key: "heading-hts-5", label: "heading hts5" },
                      { key: "code-block-huh-1", label: "code-block huh1" },
                      { key: "table-huh-2", label: "table huh2" },
                      { key: "callout-huh-3", label: "callout huh3" },
                      { key: "page-bg-huh-4", label: "page-bg huh4" },
                      { key: "heading-huh-5", label: "heading huh5" },
                      { key: "code-block-huw-1", label: "code-block huw1" },
                      { key: "table-huw-2", label: "table huw2" },
                      { key: "callout-huw-3", label: "callout huw3" },
                      { key: "page-bg-huw-4", label: "page-bg huw4" },
                      { key: "heading-huw-5", label: "heading huw5" },
                      { key: "code-block-hvl-1", label: "code-block hvl1" },
                      { key: "table-hvl-2", label: "table hvl2" },
                      { key: "callout-hvl-3", label: "callout hvl3" },
                      { key: "page-bg-hvl-4", label: "page-bg hvl4" },
                      { key: "heading-hvl-5", label: "heading hvl5" },
                      { key: "code-block-hwa-1", label: "code-block hwa1" },
                      { key: "table-hwa-2", label: "table hwa2" },
                      { key: "callout-hwa-3", label: "callout hwa3" },
                      { key: "page-bg-hwa-4", label: "page-bg hwa4" },
                      { key: "heading-hwa-5", label: "heading hwa5" },
                      { key: "code-block-hwp-1", label: "code-block hwp1" },
                      { key: "table-hwp-2", label: "table hwp2" },
                      { key: "callout-hwp-3", label: "callout hwp3" },
                      { key: "page-bg-hwp-4", label: "page-bg hwp4" },
                      { key: "heading-hwp-5", label: "heading hwp5" },
                      { key: "code-block-hxe-1", label: "code-block hxe1" },
                      { key: "table-hxe-2", label: "table hxe2" },
                      { key: "callout-hxe-3", label: "callout hxe3" },
                      { key: "page-bg-hxe-4", label: "page-bg hxe4" },
                      { key: "heading-hxe-5", label: "heading hxe5" },
                      { key: "code-block-hxt-1", label: "code-block hxt1" },
                      { key: "table-hxt-2", label: "table hxt2" },
                      { key: "callout-hxt-3", label: "callout hxt3" },
                      { key: "page-bg-hxt-4", label: "page-bg hxt4" },
                      { key: "heading-hxt-5", label: "heading hxt5" },
                      { key: "code-block-hyi-1", label: "code-block hyi1" },
                      { key: "table-hyi-2", label: "table hyi2" },
                      { key: "callout-hyi-3", label: "callout hyi3" },
                      { key: "page-bg-hyi-4", label: "page-bg hyi4" },
                      { key: "heading-hyi-5", label: "heading hyi5" },
                      { key: "code-block-hyx-1", label: "code-block hyx1" },
                      { key: "table-hyx-2", label: "table hyx2" },
                      { key: "callout-hyx-3", label: "callout hyx3" },
                      { key: "page-bg-hyx-4", label: "page-bg hyx4" },
                      { key: "heading-hyx-5", label: "heading hyx5" },
                      { key: "code-block-hzm-1", label: "code-block hzm1" },
                      { key: "table-hzm-2", label: "table hzm2" },
                      { key: "callout-hzm-3", label: "callout hzm3" },
                      { key: "page-bg-hzm-4", label: "page-bg hzm4" },
                      { key: "code-block-iaa-1", label: "code-block iaa1" },
                      { key: "table-iaa-2", label: "table iaa2" },
                      { key: "callout-iaa-3", label: "callout iaa3" },
                      { key: "page-bg-iaa-4", label: "page-bg iaa4" },
                      { key: "heading-iaa-5", label: "heading iaa5" },
                      { key: "code-block-iap-1", label: "code-block iap1" },
                      { key: "table-iap-2", label: "table iap2" },
                      { key: "callout-iap-3", label: "callout iap3" },
                      { key: "page-bg-iap-4", label: "page-bg iap4" },
                      { key: "heading-iap-5", label: "heading iap5" },
                      { key: "code-block-ibe-1", label: "code-block ibe1" },
                      { key: "table-ibe-2", label: "table ibe2" },
                      { key: "callout-ibe-3", label: "callout ibe3" },
                      { key: "page-bg-ibe-4", label: "page-bg ibe4" },
                      { key: "heading-ibe-5", label: "heading ibe5" },
                      { key: "code-block-ibt-1", label: "code-block ibt1" },
                      { key: "table-ibt-2", label: "table ibt2" },
                      { key: "callout-ibt-3", label: "callout ibt3" },
                      { key: "page-bg-ibt-4", label: "page-bg ibt4" },
                      { key: "heading-ibt-5", label: "heading ibt5" },
                      { key: "code-block-ici-1", label: "code-block ici1" },
                      { key: "table-ici-2", label: "table ici2" },
                      { key: "callout-ici-3", label: "callout ici3" },
                      { key: "page-bg-ici-4", label: "page-bg ici4" },
                      { key: "heading-ici-5", label: "heading ici5" },
                      { key: "code-block-icx-1", label: "code-block icx1" },
                      { key: "table-icx-2", label: "table icx2" },
                      { key: "callout-icx-3", label: "callout icx3" },
                      { key: "page-bg-icx-4", label: "page-bg icx4" },
                      { key: "heading-icx-5", label: "heading icx5" },
                      { key: "code-block-idm-1", label: "code-block idm1" },
                      { key: "table-idm-2", label: "table idm2" },
                      { key: "callout-idm-3", label: "callout idm3" },
                      { key: "page-bg-idm-4", label: "page-bg idm4" },
                      { key: "heading-idm-5", label: "heading idm5" },
                      { key: "code-block-ieb-1", label: "code-block ieb1" },
                      { key: "table-ieb-2", label: "table ieb2" },
                      { key: "callout-ieb-3", label: "callout ieb3" },
                      { key: "page-bg-ieb-4", label: "page-bg ieb4" },
                      { key: "heading-ieb-5", label: "heading ieb5" },
                      { key: "code-block-ieq-1", label: "code-block ieq1" },
                      { key: "table-ieq-2", label: "table ieq2" },
                      { key: "callout-ieq-3", label: "callout ieq3" },
                      { key: "page-bg-ieq-4", label: "page-bg ieq4" },
                      { key: "heading-ieq-5", label: "heading ieq5" },
                      { key: "code-block-iff-1", label: "code-block iff1" },
                      { key: "table-iff-2", label: "table iff2" },
                      { key: "callout-iff-3", label: "callout iff3" },
                      { key: "page-bg-iff-4", label: "page-bg iff4" },
                      { key: "heading-iff-5", label: "heading iff5" },
                      { key: "code-block-ifu-1", label: "code-block ifu1" },
                      { key: "table-ifu-2", label: "table ifu2" },
                      { key: "callout-ifu-3", label: "callout ifu3" },
                      { key: "page-bg-ifu-4", label: "page-bg ifu4" },
                      { key: "heading-ifu-5", label: "heading ifu5" },
                      { key: "code-block-igk-1", label: "code-block igk1" },
                      { key: "table-igk-2", label: "table igk2" },
                      { key: "callout-igk-3", label: "callout igk3" },
                      { key: "page-bg-igk-4", label: "page-bg igk4" },
                      { key: "heading-igk-5", label: "heading igk5" },
                      { key: "code-block-igz-1", label: "code-block igz1" },
                      { key: "table-igz-2", label: "table igz2" },
                      { key: "callout-igz-3", label: "callout igz3" },
                      { key: "page-bg-igz-4", label: "page-bg igz4" },
                      { key: "heading-igz-5", label: "heading igz5" },
                      { key: "code-block-iho-1", label: "code-block iho1" },
                      { key: "table-iho-2", label: "table iho2" },
                      { key: "callout-iho-3", label: "callout iho3" },
                      { key: "page-bg-iho-4", label: "page-bg iho4" },
                      { key: "heading-iho-5", label: "heading iho5" },
                      { key: "code-block-iid-1", label: "code-block iid1" },
                      { key: "table-iid-2", label: "table iid2" },
                      { key: "callout-iid-3", label: "callout iid3" },
                      { key: "page-bg-iid-4", label: "page-bg iid4" },
                      { key: "heading-iid-5", label: "heading iid5" },
                      { key: "code-block-iit-1", label: "code-block iit1" },
                      { key: "table-iit-2", label: "table iit2" },
                      { key: "callout-iit-3", label: "callout iit3" },
                      { key: "page-bg-iit-4", label: "page-bg iit4" },
                      { key: "heading-iit-5", label: "heading iit5" },
                      { key: "code-block-iji-1", label: "code-block iji1" },
                      { key: "table-iji-2", label: "table iji2" },
                      { key: "callout-iji-3", label: "callout iji3" },
                      { key: "page-bg-iji-4", label: "page-bg iji4" },
                      { key: "heading-iji-5", label: "heading iji5" },
                      { key: "code-block-ijx-1", label: "code-block ijx1" },
                      { key: "table-ijx-2", label: "table ijx2" },
                      { key: "callout-ijx-3", label: "callout ijx3" },
                      { key: "page-bg-ijx-4", label: "page-bg ijx4" },
                      { key: "heading-ijx-5", label: "heading ijx5" },
                      { key: "code-block-ikm-1", label: "code-block ikm1" },
                      { key: "table-ikm-2", label: "table ikm2" },
                      { key: "callout-ikm-3", label: "callout ikm3" },
                      { key: "page-bg-ikm-4", label: "page-bg ikm4" },
                      { key: "heading-ikm-5", label: "heading ikm5" },
                      { key: "code-block-ilb-1", label: "code-block ilb1" },
                      { key: "table-ilb-2", label: "table ilb2" },
                      { key: "callout-ilb-3", label: "callout ilb3" },
                      { key: "page-bg-ilb-4", label: "page-bg ilb4" },
                      { key: "heading-ilb-5", label: "heading ilb5" },
                      { key: "code-block-ilq-1", label: "code-block ilq1" },
                      { key: "table-ilq-2", label: "table ilq2" },
                      { key: "callout-ilq-3", label: "callout ilq3" },
                      { key: "page-bg-ilq-4", label: "page-bg ilq4" },
                      { key: "heading-ilq-5", label: "heading ilq5" },
                      { key: "code-block-imf-1", label: "code-block imf1" },
                      { key: "table-imf-2", label: "table imf2" },
                      { key: "callout-imf-3", label: "callout imf3" },
                      { key: "page-bg-imf-4", label: "page-bg imf4" },
                      { key: "heading-imf-5", label: "heading imf5" },
                      { key: "code-block-imu-1", label: "code-block imu1" },
                      { key: "table-imu-2", label: "table imu2" },
                      { key: "callout-imu-3", label: "callout imu3" },
                      { key: "page-bg-imu-4", label: "page-bg imu4" },
                      { key: "heading-imu-5", label: "heading imu5" },
                      { key: "code-block-inj-1", label: "code-block inj1" },
                      { key: "table-inj-2", label: "table inj2" },
                      { key: "callout-inj-3", label: "callout inj3" },
                      { key: "page-bg-inj-4", label: "page-bg inj4" },
                      { key: "heading-inj-5", label: "heading inj5" },
                      { key: "code-block-iny-1", label: "code-block iny1" },
                      { key: "table-iny-2", label: "table iny2" },
                      { key: "callout-iny-3", label: "callout iny3" },
                      { key: "page-bg-iny-4", label: "page-bg iny4" },
                      { key: "heading-iny-5", label: "heading iny5" },
                      { key: "code-block-ion-1", label: "code-block ion1" },
                      { key: "table-ion-2", label: "table ion2" },
                      { key: "callout-ion-3", label: "callout ion3" },
                      { key: "page-bg-ion-4", label: "page-bg ion4" },
                      { key: "heading-ion-5", label: "heading ion5" },
                      { key: "code-block-ipc-1", label: "code-block ipc1" },
                      { key: "table-ipc-2", label: "table ipc2" },
                      { key: "callout-ipc-3", label: "callout ipc3" },
                      { key: "page-bg-ipc-4", label: "page-bg ipc4" },
                      { key: "heading-ipc-5", label: "heading ipc5" },
                      { key: "code-block-ipr-1", label: "code-block ipr1" },
                      { key: "table-ipr-2", label: "table ipr2" },
                      { key: "callout-ipr-3", label: "callout ipr3" },
                      { key: "page-bg-ipr-4", label: "page-bg ipr4" },
                      { key: "heading-ipr-5", label: "heading ipr5" },
                      { key: "code-block-iqg-1", label: "code-block iqg1" },
                      { key: "table-iqg-2", label: "table iqg2" },
                      { key: "callout-iqg-3", label: "callout iqg3" },
                      { key: "page-bg-iqg-4", label: "page-bg iqg4" },
                      { key: "heading-iqg-5", label: "heading iqg5" },
                      { key: "code-block-iqv-1", label: "code-block iqv1" },
                      { key: "table-iqv-2", label: "table iqv2" },
                      { key: "callout-iqv-3", label: "callout iqv3" },
                      { key: "page-bg-iqv-4", label: "page-bg iqv4" },
                      { key: "heading-iqv-5", label: "heading iqv5" },
                      { key: "code-block-irk-1", label: "code-block irk1" },
                      { key: "table-irk-2", label: "table irk2" },
                      { key: "callout-irk-3", label: "callout irk3" },
                      { key: "page-bg-irk-4", label: "page-bg irk4" },
                      { key: "heading-irk-5", label: "heading irk5" },
                      { key: "code-block-irz-1", label: "code-block irz1" },
                      { key: "table-irz-2", label: "table irz2" },
                      { key: "callout-irz-3", label: "callout irz3" },
                      { key: "page-bg-irz-4", label: "page-bg irz4" },
                      { key: "heading-irz-5", label: "heading irz5" },
                      { key: "code-block-iso-1", label: "code-block iso1" },
                      { key: "table-iso-2", label: "table iso2" },
                      { key: "callout-iso-3", label: "callout iso3" },
                      { key: "page-bg-iso-4", label: "page-bg iso4" },
                      { key: "heading-iso-5", label: "heading iso5" },
                      { key: "code-block-itd-1", label: "code-block itd1" },
                      { key: "table-itd-2", label: "table itd2" },
                      { key: "callout-itd-3", label: "callout itd3" },
                      { key: "page-bg-itd-4", label: "page-bg itd4" },
                      { key: "heading-itd-5", label: "heading itd5" },
                      { key: "code-block-its-1", label: "code-block its1" },
                      { key: "table-its-2", label: "table its2" },
                      { key: "callout-its-3", label: "callout its3" },
                      { key: "page-bg-its-4", label: "page-bg its4" },
                      { key: "heading-its-5", label: "heading its5" },
                      { key: "code-block-iuh-1", label: "code-block iuh1" },
                      { key: "table-iuh-2", label: "table iuh2" },
                      { key: "callout-iuh-3", label: "callout iuh3" },
                      { key: "page-bg-iuh-4", label: "page-bg iuh4" },
                      { key: "heading-iuh-5", label: "heading iuh5" },
                      { key: "code-block-iuw-1", label: "code-block iuw1" },
                      { key: "table-iuw-2", label: "table iuw2" },
                      { key: "callout-iuw-3", label: "callout iuw3" },
                      { key: "page-bg-iuw-4", label: "page-bg iuw4" },
                      { key: "heading-iuw-5", label: "heading iuw5" },
                      { key: "code-block-ivl-1", label: "code-block ivl1" },
                      { key: "table-ivl-2", label: "table ivl2" },
                      { key: "callout-ivl-3", label: "callout ivl3" },
                      { key: "page-bg-ivl-4", label: "page-bg ivl4" },
                      { key: "heading-ivl-5", label: "heading ivl5" },
                      { key: "code-block-iwa-1", label: "code-block iwa1" },
                      { key: "table-iwa-2", label: "table iwa2" },
                      { key: "callout-iwa-3", label: "callout iwa3" },
                      { key: "page-bg-iwa-4", label: "page-bg iwa4" },
                      { key: "heading-iwa-5", label: "heading iwa5" },
                      { key: "code-block-iwp-1", label: "code-block iwp1" },
                      { key: "table-iwp-2", label: "table iwp2" },
                      { key: "callout-iwp-3", label: "callout iwp3" },
                      { key: "page-bg-iwp-4", label: "page-bg iwp4" },
                      { key: "heading-iwp-5", label: "heading iwp5" },
                      { key: "code-block-ixe-1", label: "code-block ixe1" },
                      { key: "table-ixe-2", label: "table ixe2" },
                      { key: "callout-ixe-3", label: "callout ixe3" },
                      { key: "page-bg-ixe-4", label: "page-bg ixe4" },
                      { key: "heading-ixe-5", label: "heading ixe5" },
                      { key: "code-block-ixt-1", label: "code-block ixt1" },
                      { key: "table-ixt-2", label: "table ixt2" },
                      { key: "callout-ixt-3", label: "callout ixt3" },
                      { key: "page-bg-ixt-4", label: "page-bg ixt4" },
                      { key: "heading-ixt-5", label: "heading ixt5" },
                      { key: "code-block-iyi-1", label: "code-block iyi1" },
                      { key: "table-iyi-2", label: "table iyi2" },
                      { key: "callout-iyi-3", label: "callout iyi3" },
                      { key: "page-bg-iyi-4", label: "page-bg iyi4" },
                      { key: "heading-iyi-5", label: "heading iyi5" },
                      { key: "code-block-iyx-1", label: "code-block iyx1" },
                      { key: "table-iyx-2", label: "table iyx2" },
                      { key: "callout-iyx-3", label: "callout iyx3" },
                      { key: "page-bg-iyx-4", label: "page-bg iyx4" },
                      { key: "heading-iyx-5", label: "heading iyx5" },
                      { key: "code-block-izm-1", label: "code-block izm1" },
                      { key: "table-izm-2", label: "table izm2" },
                      { key: "callout-izm-3", label: "callout izm3" },
                      { key: "page-bg-izm-4", label: "page-bg izm4" },
                      { key: "code-block-jaa-1", label: "code-block jaa1" },
                      { key: "table-jaa-2", label: "table jaa2" },
                      { key: "callout-jaa-3", label: "callout jaa3" },
                      { key: "page-bg-jaa-4", label: "page-bg jaa4" },
                      { key: "heading-jaa-5", label: "heading jaa5" },
                      { key: "code-block-jap-1", label: "code-block jap1" },
                      { key: "table-jap-2", label: "table jap2" },
                      { key: "callout-jap-3", label: "callout jap3" },
                      { key: "page-bg-jap-4", label: "page-bg jap4" },
                      { key: "heading-jap-5", label: "heading jap5" },
                      { key: "code-block-jbe-1", label: "code-block jbe1" },
                      { key: "table-jbe-2", label: "table jbe2" },
                      { key: "callout-jbe-3", label: "callout jbe3" },
                      { key: "page-bg-jbe-4", label: "page-bg jbe4" },
                      { key: "heading-jbe-5", label: "heading jbe5" },
                      { key: "code-block-jbt-1", label: "code-block jbt1" },
                      { key: "table-jbt-2", label: "table jbt2" },
                      { key: "callout-jbt-3", label: "callout jbt3" },
                      { key: "page-bg-jbt-4", label: "page-bg jbt4" },
                      { key: "heading-jbt-5", label: "heading jbt5" },
                      { key: "code-block-jci-1", label: "code-block jci1" },
                      { key: "table-jci-2", label: "table jci2" },
                      { key: "callout-jci-3", label: "callout jci3" },
                      { key: "page-bg-jci-4", label: "page-bg jci4" },
                      { key: "heading-jci-5", label: "heading jci5" },
                      { key: "code-block-jcx-1", label: "code-block jcx1" },
                      { key: "table-jcx-2", label: "table jcx2" },
                      { key: "callout-jcx-3", label: "callout jcx3" },
                      { key: "page-bg-jcx-4", label: "page-bg jcx4" },
                      { key: "heading-jcx-5", label: "heading jcx5" },
                      { key: "code-block-jdm-1", label: "code-block jdm1" },
                      { key: "table-jdm-2", label: "table jdm2" },
                      { key: "callout-jdm-3", label: "callout jdm3" },
                      { key: "page-bg-jdm-4", label: "page-bg jdm4" },
                      { key: "heading-jdm-5", label: "heading jdm5" },
                      { key: "code-block-jeb-1", label: "code-block jeb1" },
                      { key: "table-jeb-2", label: "table jeb2" },
                      { key: "callout-jeb-3", label: "callout jeb3" },
                      { key: "page-bg-jeb-4", label: "page-bg jeb4" },
                      { key: "heading-jeb-5", label: "heading jeb5" },
                      { key: "code-block-jeq-1", label: "code-block jeq1" },
                      { key: "table-jeq-2", label: "table jeq2" },
                      { key: "callout-jeq-3", label: "callout jeq3" },
                      { key: "page-bg-jeq-4", label: "page-bg jeq4" },
                      { key: "heading-jeq-5", label: "heading jeq5" },
                      { key: "code-block-jff-1", label: "code-block jff1" },
                      { key: "table-jff-2", label: "table jff2" },
                      { key: "callout-jff-3", label: "callout jff3" },
                      { key: "page-bg-jff-4", label: "page-bg jff4" },
                      { key: "heading-jff-5", label: "heading jff5" },
                      { key: "code-block-jfu-1", label: "code-block jfu1" },
                      { key: "table-jfu-2", label: "table jfu2" },
                      { key: "callout-jfu-3", label: "callout jfu3" },
                      { key: "page-bg-jfu-4", label: "page-bg jfu4" },
                      { key: "heading-jfu-5", label: "heading jfu5" },
                      { key: "code-block-jgj-1", label: "code-block jgj1" },
                      { key: "table-jgj-2", label: "table jgj2" },
                      { key: "callout-jgj-3", label: "callout jgj3" },
                      { key: "page-bg-jgj-4", label: "page-bg jgj4" },
                      { key: "heading-jgj-5", label: "heading jgj5" },
                      { key: "code-block-jgy-1", label: "code-block jgy1" },
                      { key: "table-jgy-2", label: "table jgy2" },
                      { key: "callout-jgy-3", label: "callout jgy3" },
                      { key: "page-bg-jgy-4", label: "page-bg jgy4" },
                      { key: "heading-jgy-5", label: "heading jgy5" },
                      { key: "code-block-jhn-1", label: "code-block jhn1" },
                      { key: "table-jhn-2", label: "table jhn2" },
                      { key: "callout-jhn-3", label: "callout jhn3" },
                      { key: "page-bg-jhn-4", label: "page-bg jhn4" },
                      { key: "heading-jhn-5", label: "heading jhn5" },
                      { key: "code-block-jic-1", label: "code-block jic1" },
                      { key: "table-jic-2", label: "table jic2" },
                      { key: "callout-jic-3", label: "callout jic3" },
                      { key: "page-bg-jic-4", label: "page-bg jic4" },
                      { key: "heading-jic-5", label: "heading jic5" },
                      { key: "code-block-jir-1", label: "code-block jir1" },
                      { key: "table-jir-2", label: "table jir2" },
                      { key: "callout-jir-3", label: "callout jir3" },
                      { key: "page-bg-jir-4", label: "page-bg jir4" },
                      { key: "heading-jir-5", label: "heading jir5" },
                      { key: "code-block-jjg-1", label: "code-block jjg1" },
                      { key: "table-jjg-2", label: "table jjg2" },
                      { key: "callout-jjg-3", label: "callout jjg3" },
                      { key: "page-bg-jjg-4", label: "page-bg jjg4" },
                      { key: "heading-jjg-5", label: "heading jjg5" },
                      { key: "code-block-jjw-1", label: "code-block jjw1" },
                      { key: "table-jjw-2", label: "table jjw2" },
                      { key: "callout-jjw-3", label: "callout jjw3" },
                      { key: "page-bg-jjw-4", label: "page-bg jjw4" },
                      { key: "heading-jjw-5", label: "heading jjw5" },
                      { key: "code-block-jkl-1", label: "code-block jkl1" },
                      { key: "table-jkl-2", label: "table jkl2" },
                      { key: "callout-jkl-3", label: "callout jkl3" },
                      { key: "page-bg-jkl-4", label: "page-bg jkl4" },
                      { key: "heading-jkl-5", label: "heading jkl5" },
                      { key: "code-block-jla-1", label: "code-block jla1" },
                      { key: "table-jla-2", label: "table jla2" },
                      { key: "callout-jla-3", label: "callout jla3" },
                      { key: "page-bg-jla-4", label: "page-bg jla4" },
                      { key: "heading-jla-5", label: "heading jla5" },
                      { key: "code-block-jlp-1", label: "code-block jlp1" },
                      { key: "table-jlp-2", label: "table jlp2" },
                      { key: "callout-jlp-3", label: "callout jlp3" },
                      { key: "page-bg-jlp-4", label: "page-bg jlp4" },
                      { key: "heading-jlp-5", label: "heading jlp5" },
                      { key: "code-block-jme-1", label: "code-block jme1" },
                      { key: "table-jme-2", label: "table jme2" },
                      { key: "callout-jme-3", label: "callout jme3" },
                      { key: "page-bg-jme-4", label: "page-bg jme4" },
                      { key: "heading-jme-5", label: "heading jme5" },
                      { key: "code-block-jmt-1", label: "code-block jmt1" },
                      { key: "table-jmt-2", label: "table jmt2" },
                      { key: "callout-jmt-3", label: "callout jmt3" },
                      { key: "page-bg-jmt-4", label: "page-bg jmt4" },
                      { key: "heading-jmt-5", label: "heading jmt5" },
                      { key: "code-block-jni-1", label: "code-block jni1" },
                      { key: "table-jni-2", label: "table jni2" },
                      { key: "callout-jni-3", label: "callout jni3" },
                      { key: "page-bg-jni-4", label: "page-bg jni4" },
                      { key: "heading-jni-5", label: "heading jni5" },
                      { key: "code-block-jnx-1", label: "code-block jnx1" },
                      { key: "table-jnx-2", label: "table jnx2" },
                      { key: "callout-jnx-3", label: "callout jnx3" },
                      { key: "page-bg-jnx-4", label: "page-bg jnx4" },
                      { key: "heading-jnx-5", label: "heading jnx5" },
                      { key: "code-block-jom-1", label: "code-block jom1" },
                      { key: "table-jom-2", label: "table jom2" },
                      { key: "callout-jom-3", label: "callout jom3" },
                      { key: "page-bg-jom-4", label: "page-bg jom4" },
                      { key: "heading-jom-5", label: "heading jom5" },
                      { key: "code-block-jpb-1", label: "code-block jpb1" },
                      { key: "table-jpb-2", label: "table jpb2" },
                      { key: "callout-jpb-3", label: "callout jpb3" },
                      { key: "page-bg-jpb-4", label: "page-bg jpb4" },
                      { key: "heading-jpb-5", label: "heading jpb5" },
                      { key: "code-block-jpq-1", label: "code-block jpq1" },
                      { key: "table-jpq-2", label: "table jpq2" },
                      { key: "callout-jpq-3", label: "callout jpq3" },
                      { key: "page-bg-jpq-4", label: "page-bg jpq4" },
                      { key: "heading-jpq-5", label: "heading jpq5" },
                      { key: "code-block-jqf-1", label: "code-block jqf1" },
                      { key: "table-jqf-2", label: "table jqf2" },
                      { key: "callout-jqf-3", label: "callout jqf3" },
                      { key: "page-bg-jqf-4", label: "page-bg jqf4" },
                      { key: "heading-jqf-5", label: "heading jqf5" },
                      { key: "code-block-jqu-1", label: "code-block jqu1" },
                      { key: "table-jqu-2", label: "table jqu2" },
                      { key: "callout-jqu-3", label: "callout jqu3" },
                      { key: "page-bg-jqu-4", label: "page-bg jqu4" },
                      { key: "heading-jqu-5", label: "heading jqu5" },
                      { key: "code-block-jrj-1", label: "code-block jrj1" },
                      { key: "table-jrj-2", label: "table jrj2" },
                      { key: "callout-jrj-3", label: "callout jrj3" },
                      { key: "page-bg-jrj-4", label: "page-bg jrj4" },
                      { key: "heading-jrj-5", label: "heading jrj5" },
                      { key: "code-block-jry-1", label: "code-block jry1" },
                      { key: "table-jry-2", label: "table jry2" },
                      { key: "callout-jry-3", label: "callout jry3" },
                      { key: "page-bg-jry-4", label: "page-bg jry4" },
                      { key: "heading-jry-5", label: "heading jry5" },
                      { key: "code-block-jsn-1", label: "code-block jsn1" },
                      { key: "table-jsn-2", label: "table jsn2" },
                      { key: "callout-jsn-3", label: "callout jsn3" },
                      { key: "page-bg-jsn-4", label: "page-bg jsn4" },
                      { key: "heading-jsn-5", label: "heading jsn5" },
                      { key: "code-block-jtc-1", label: "code-block jtc1" },
                      { key: "table-jtc-2", label: "table jtc2" },
                      { key: "callout-jtc-3", label: "callout jtc3" },
                      { key: "page-bg-jtc-4", label: "page-bg jtc4" },
                      { key: "heading-jtc-5", label: "heading jtc5" },
                      { key: "code-block-jtr-1", label: "code-block jtr1" },
                      { key: "table-jtr-2", label: "table jtr2" },
                      { key: "callout-jtr-3", label: "callout jtr3" },
                      { key: "page-bg-jtr-4", label: "page-bg jtr4" },
                      { key: "heading-jtr-5", label: "heading jtr5" },
                      { key: "code-block-jug-1", label: "code-block jug1" },
                      { key: "table-jug-2", label: "table jug2" },
                      { key: "callout-jug-3", label: "callout jug3" },
                      { key: "page-bg-jug-4", label: "page-bg jug4" },
                      { key: "heading-jug-5", label: "heading jug5" },
                      { key: "code-block-juv-1", label: "code-block juv1" },
                      { key: "table-juv-2", label: "table juv2" },
                      { key: "callout-juv-3", label: "callout juv3" },
                      { key: "page-bg-juv-4", label: "page-bg juv4" },
                      { key: "heading-juv-5", label: "heading juv5" },
                      { key: "code-block-jvk-1", label: "code-block jvk1" },
                      { key: "table-jvk-2", label: "table jvk2" },
                      { key: "callout-jvk-3", label: "callout jvk3" },
                      { key: "page-bg-jvk-4", label: "page-bg jvk4" },
                      { key: "heading-jvk-5", label: "heading jvk5" },
                      { key: "code-block-jvz-1", label: "code-block jvz1" },
                      { key: "table-jvz-2", label: "table jvz2" },
                      { key: "callout-jvz-3", label: "callout jvz3" },
                      { key: "page-bg-jvz-4", label: "page-bg jvz4" },
                      { key: "heading-jvz-5", label: "heading jvz5" },
                      { key: "code-block-jwo-1", label: "code-block jwo1" },
                      { key: "table-jwo-2", label: "table jwo2" },
                      { key: "callout-jwo-3", label: "callout jwo3" },
                      { key: "page-bg-jwo-4", label: "page-bg jwo4" },
                      { key: "heading-jwo-5", label: "heading jwo5" },
                      { key: "code-block-jxd-1", label: "code-block jxd1" },
                      { key: "table-jxd-2", label: "table jxd2" },
                      { key: "callout-jxd-3", label: "callout jxd3" },
                      { key: "page-bg-jxd-4", label: "page-bg jxd4" },
                      { key: "heading-jxd-5", label: "heading jxd5" },
                      { key: "code-block-jxs-1", label: "code-block jxs1" },
                      { key: "table-jxs-2", label: "table jxs2" },
                      { key: "callout-jxs-3", label: "callout jxs3" },
                      { key: "page-bg-jxs-4", label: "page-bg jxs4" },
                      { key: "heading-jxs-5", label: "heading jxs5" },
                      { key: "code-block-jyh-1", label: "code-block jyh1" },
                      { key: "table-jyh-2", label: "table jyh2" },
                      { key: "callout-jyh-3", label: "callout jyh3" },
                      { key: "page-bg-jyh-4", label: "page-bg jyh4" },
                      { key: "heading-jyh-5", label: "heading jyh5" },
                      { key: "code-block-jyw-1", label: "code-block jyw1" },
                      { key: "table-jyw-2", label: "table jyw2" },
                      { key: "callout-jyw-3", label: "callout jyw3" },
                      { key: "page-bg-jyw-4", label: "page-bg jyw4" },
                      { key: "heading-jyw-5", label: "heading jyw5" },
                      { key: "code-block-jzl-1", label: "code-block jzl1" },
                      { key: "table-jzl-2", label: "table jzl2" },
                      { key: "callout-jzl-3", label: "callout jzl3" },
                      { key: "page-bg-jzl-4", label: "page-bg jzl4" },
                      { key: "heading-jzl-5", label: "heading jzl5" },
                      { key: "code-block-kaa-1", label: "code-block kaa1" },
                      { key: "table-kaa-2", label: "table kaa2" },
                      { key: "callout-kaa-3", label: "callout kaa3" },
                      { key: "page-bg-kaa-4", label: "page-bg kaa4" },
                      { key: "heading-kaa-5", label: "heading kaa5" },
                      { key: "code-block-kap-1", label: "code-block kap1" },
                      { key: "table-kap-2", label: "table kap2" },
                      { key: "callout-kap-3", label: "callout kap3" },
                      { key: "page-bg-kap-4", label: "page-bg kap4" },
                      { key: "heading-kap-5", label: "heading kap5" },
                      { key: "code-block-kbe-1", label: "code-block kbe1" },
                      { key: "table-kbe-2", label: "table kbe2" },
                      { key: "callout-kbe-3", label: "callout kbe3" },
                      { key: "page-bg-kbe-4", label: "page-bg kbe4" },
                      { key: "heading-kbe-5", label: "heading kbe5" },
                      { key: "code-block-kbt-1", label: "code-block kbt1" },
                      { key: "table-kbt-2", label: "table kbt2" },
                      { key: "callout-kbt-3", label: "callout kbt3" },
                      { key: "page-bg-kbt-4", label: "page-bg kbt4" },
                      { key: "heading-kbt-5", label: "heading kbt5" },
                      { key: "code-block-kci-1", label: "code-block kci1" },
                      { key: "table-kci-2", label: "table kci2" },
                      { key: "callout-kci-3", label: "callout kci3" },
                      { key: "page-bg-kci-4", label: "page-bg kci4" },
                      { key: "heading-kci-5", label: "heading kci5" },
                      { key: "code-block-kcx-1", label: "code-block kcx1" },
                      { key: "table-kcx-2", label: "table kcx2" },
                      { key: "callout-kcx-3", label: "callout kcx3" },
                      { key: "page-bg-kcx-4", label: "page-bg kcx4" },
                      { key: "heading-kcx-5", label: "heading kcx5" },
                      { key: "code-block-kdm-1", label: "code-block kdm1" },
                      { key: "table-kdm-2", label: "table kdm2" },
                      { key: "callout-kdm-3", label: "callout kdm3" },
                      { key: "page-bg-kdm-4", label: "page-bg kdm4" },
                      { key: "heading-kdm-5", label: "heading kdm5" },
                      { key: "code-block-keb-1", label: "code-block keb1" },
                      { key: "table-keb-2", label: "table keb2" },
                      { key: "callout-keb-3", label: "callout keb3" },
                      { key: "page-bg-keb-4", label: "page-bg keb4" },
                      { key: "heading-keb-5", label: "heading keb5" },
                      { key: "code-block-keq-1", label: "code-block keq1" },
                      { key: "table-keq-2", label: "table keq2" },
                      { key: "callout-keq-3", label: "callout keq3" },
                      { key: "page-bg-keq-4", label: "page-bg keq4" },
                      { key: "heading-keq-5", label: "heading keq5" },
                      { key: "code-block-kff-1", label: "code-block kff1" },
                      { key: "table-kff-2", label: "table kff2" },
                      { key: "callout-kff-3", label: "callout kff3" },
                      { key: "page-bg-kff-4", label: "page-bg kff4" },
                      { key: "heading-kff-5", label: "heading kff5" },
                      { key: "code-block-kfu-1", label: "code-block kfu1" },
                      { key: "table-kfu-2", label: "table kfu2" },
                      { key: "callout-kfu-3", label: "callout kfu3" },
                      { key: "page-bg-kfu-4", label: "page-bg kfu4" },
                      { key: "heading-kfu-5", label: "heading kfu5" },
                      { key: "code-block-kgj-1", label: "code-block kgj1" },
                      { key: "table-kgj-2", label: "table kgj2" },
                      { key: "callout-kgj-3", label: "callout kgj3" },
                      { key: "page-bg-kgj-4", label: "page-bg kgj4" },
                      { key: "heading-kgj-5", label: "heading kgj5" },
                      { key: "code-block-kgy-1", label: "code-block kgy1" },
                      { key: "table-kgy-2", label: "table kgy2" },
                      { key: "callout-kgy-3", label: "callout kgy3" },
                      { key: "page-bg-kgy-4", label: "page-bg kgy4" },
                      { key: "heading-kgy-5", label: "heading kgy5" },
                      { key: "code-block-khn-1", label: "code-block khn1" },
                      { key: "table-khn-2", label: "table khn2" },
                      { key: "callout-khn-3", label: "callout khn3" },
                      { key: "page-bg-khn-4", label: "page-bg khn4" },
                      { key: "heading-khn-5", label: "heading khn5" },
                      { key: "code-block-kic-1", label: "code-block kic1" },
                      { key: "table-kic-2", label: "table kic2" },
                      { key: "callout-kic-3", label: "callout kic3" },
                      { key: "page-bg-kic-4", label: "page-bg kic4" },
                      { key: "heading-kic-5", label: "heading kic5" },
                      { key: "code-block-kir-1", label: "code-block kir1" },
                      { key: "table-kir-2", label: "table kir2" },
                      { key: "callout-kir-3", label: "callout kir3" },
                      { key: "page-bg-kir-4", label: "page-bg kir4" },
                      { key: "heading-kir-5", label: "heading kir5" },
                      { key: "code-block-kjg-1", label: "code-block kjg1" },
                      { key: "table-kjg-2", label: "table kjg2" },
                      { key: "callout-kjg-3", label: "callout kjg3" },
                      { key: "page-bg-kjg-4", label: "page-bg kjg4" },
                      { key: "heading-kjg-5", label: "heading kjg5" },
                      { key: "code-block-kjv-1", label: "code-block kjv1" },
                      { key: "table-kjv-2", label: "table kjv2" },
                      { key: "callout-kjv-3", label: "callout kjv3" },
                      { key: "page-bg-kjv-4", label: "page-bg kjv4" },
                      { key: "heading-kjv-5", label: "heading kjv5" },
                      { key: "code-block-kkl-1", label: "code-block kkl1" },
                      { key: "table-kkl-2", label: "table kkl2" },
                      { key: "callout-kkl-3", label: "callout kkl3" },
                      { key: "page-bg-kkl-4", label: "page-bg kkl4" },
                      { key: "heading-kkl-5", label: "heading kkl5" },
                      { key: "code-block-kla-1", label: "code-block kla1" },
                      { key: "table-kla-2", label: "table kla2" },
                      { key: "callout-kla-3", label: "callout kla3" },
                      { key: "page-bg-kla-4", label: "page-bg kla4" },
                      { key: "heading-kla-5", label: "heading kla5" },
                      { key: "code-block-klp-1", label: "code-block klp1" },
                      { key: "table-klp-2", label: "table klp2" },
                      { key: "callout-klp-3", label: "callout klp3" },
                      { key: "page-bg-klp-4", label: "page-bg klp4" },
                      { key: "heading-klp-5", label: "heading klp5" },
                      { key: "code-block-kme-1", label: "code-block kme1" },
                      { key: "table-kme-2", label: "table kme2" },
                      { key: "callout-kme-3", label: "callout kme3" },
                      { key: "page-bg-kme-4", label: "page-bg kme4" },
                      { key: "heading-kme-5", label: "heading kme5" },
                      { key: "code-block-kmt-1", label: "code-block kmt1" },
                      { key: "table-kmt-2", label: "table kmt2" },
                      { key: "callout-kmt-3", label: "callout kmt3" },
                      { key: "page-bg-kmt-4", label: "page-bg kmt4" },
                      { key: "heading-kmt-5", label: "heading kmt5" },
                      { key: "code-block-kni-1", label: "code-block kni1" },
                      { key: "table-kni-2", label: "table kni2" },
                      { key: "callout-kni-3", label: "callout kni3" },
                      { key: "page-bg-kni-4", label: "page-bg kni4" },
                      { key: "heading-kni-5", label: "heading kni5" },
                      { key: "code-block-knx-1", label: "code-block knx1" },
                      { key: "table-knx-2", label: "table knx2" },
                      { key: "callout-knx-3", label: "callout knx3" },
                      { key: "page-bg-knx-4", label: "page-bg knx4" },
                      { key: "heading-knx-5", label: "heading knx5" },
                      { key: "code-block-kom-1", label: "code-block kom1" },
                      { key: "table-kom-2", label: "table kom2" },
                      { key: "callout-kom-3", label: "callout kom3" },
                      { key: "page-bg-kom-4", label: "page-bg kom4" },
                      { key: "heading-kom-5", label: "heading kom5" },
                      { key: "code-block-kpb-1", label: "code-block kpb1" },
                      { key: "table-kpb-2", label: "table kpb2" },
                      { key: "callout-kpb-3", label: "callout kpb3" },
                      { key: "page-bg-kpb-4", label: "page-bg kpb4" },
                      { key: "heading-kpb-5", label: "heading kpb5" },
                      { key: "code-block-kpq-1", label: "code-block kpq1" },
                      { key: "table-kpq-2", label: "table kpq2" },
                      { key: "callout-kpq-3", label: "callout kpq3" },
                      { key: "page-bg-kpq-4", label: "page-bg kpq4" },
                      { key: "heading-kpq-5", label: "heading kpq5" },
                      { key: "code-block-kqf-1", label: "code-block kqf1" },
                      { key: "table-kqf-2", label: "table kqf2" },
                      { key: "callout-kqf-3", label: "callout kqf3" },
                      { key: "page-bg-kqf-4", label: "page-bg kqf4" },
                      { key: "heading-kqf-5", label: "heading kqf5" },
                      { key: "code-block-kqu-1", label: "code-block kqu1" },
                      { key: "table-kqu-2", label: "table kqu2" },
                      { key: "callout-kqu-3", label: "callout kqu3" },
                      { key: "page-bg-kqu-4", label: "page-bg kqu4" },
                      { key: "heading-kqu-5", label: "heading kqu5" },
                      { key: "code-block-krj-1", label: "code-block krj1" },
                      { key: "table-krj-2", label: "table krj2" },
                      { key: "callout-krj-3", label: "callout krj3" },
                      { key: "page-bg-krj-4", label: "page-bg krj4" },
                      { key: "heading-krj-5", label: "heading krj5" },
                      { key: "code-block-kry-1", label: "code-block kry1" },
                      { key: "table-kry-2", label: "table kry2" },
                      { key: "callout-kry-3", label: "callout kry3" },
                      { key: "page-bg-kry-4", label: "page-bg kry4" },
                      { key: "heading-kry-5", label: "heading kry5" },
                      { key: "code-block-ksn-1", label: "code-block ksn1" },
                      { key: "table-ksn-2", label: "table ksn2" },
                      { key: "callout-ksn-3", label: "callout ksn3" },
                      { key: "page-bg-ksn-4", label: "page-bg ksn4" },
                      { key: "heading-ksn-5", label: "heading ksn5" },
                      { key: "code-block-ktc-1", label: "code-block ktc1" },
                      { key: "table-ktc-2", label: "table ktc2" },
                      { key: "callout-ktc-3", label: "callout ktc3" },
                      { key: "page-bg-ktc-4", label: "page-bg ktc4" },
                      { key: "heading-ktc-5", label: "heading ktc5" },
                      { key: "code-block-ktr-1", label: "code-block ktr1" },
                      { key: "table-ktr-2", label: "table ktr2" },
                      { key: "callout-ktr-3", label: "callout ktr3" },
                      { key: "page-bg-ktr-4", label: "page-bg ktr4" },
                      { key: "heading-ktr-5", label: "heading ktr5" },
                      { key: "code-block-kug-1", label: "code-block kug1" },
                      { key: "table-kug-2", label: "table kug2" },
                      { key: "callout-kug-3", label: "callout kug3" },
                      { key: "page-bg-kug-4", label: "page-bg kug4" },
                      { key: "heading-kug-5", label: "heading kug5" },
                      { key: "code-block-kuv-1", label: "code-block kuv1" },
                      { key: "table-kuv-2", label: "table kuv2" },
                      { key: "callout-kuv-3", label: "callout kuv3" },
                      { key: "page-bg-kuv-4", label: "page-bg kuv4" },
                      { key: "heading-kuv-5", label: "heading kuv5" },
                      { key: "code-block-kvk-1", label: "code-block kvk1" },
                      { key: "table-kvk-2", label: "table kvk2" },
                      { key: "callout-kvk-3", label: "callout kvk3" },
                      { key: "page-bg-kvk-4", label: "page-bg kvk4" },
                      { key: "heading-kvk-5", label: "heading kvk5" },
                      { key: "code-block-kvz-1", label: "code-block kvz1" },
                      { key: "table-kvz-2", label: "table kvz2" },
                      { key: "callout-kvz-3", label: "callout kvz3" },
                      { key: "page-bg-kvz-4", label: "page-bg kvz4" },
                      { key: "heading-kvz-5", label: "heading kvz5" },
                      { key: "code-block-kwo-1", label: "code-block kwo1" },
                      { key: "table-kwo-2", label: "table kwo2" },
                      { key: "callout-kwo-3", label: "callout kwo3" },
                      { key: "page-bg-kwo-4", label: "page-bg kwo4" },
                      { key: "heading-kwo-5", label: "heading kwo5" },
                      { key: "code-block-kxd-1", label: "code-block kxd1" },
                      { key: "table-kxd-2", label: "table kxd2" },
                      { key: "callout-kxd-3", label: "callout kxd3" },
                      { key: "page-bg-kxd-4", label: "page-bg kxd4" },
                      { key: "heading-kxd-5", label: "heading kxd5" },
                      { key: "code-block-kxs-1", label: "code-block kxs1" },
                      { key: "table-kxs-2", label: "table kxs2" },
                      { key: "callout-kxs-3", label: "callout kxs3" },
                      { key: "page-bg-kxs-4", label: "page-bg kxs4" },
                      { key: "heading-kxs-5", label: "heading kxs5" },
                      { key: "code-block-kyh-1", label: "code-block kyh1" },
                      { key: "table-kyh-2", label: "table kyh2" },
                      { key: "callout-kyh-3", label: "callout kyh3" },
                      { key: "page-bg-kyh-4", label: "page-bg kyh4" },
                      { key: "heading-kyh-5", label: "heading kyh5" },
                      { key: "code-block-kyw-1", label: "code-block kyw1" },
                      { key: "table-kyw-2", label: "table kyw2" },
                      { key: "callout-kyw-3", label: "callout kyw3" },
                      { key: "page-bg-kyw-4", label: "page-bg kyw4" },
                      { key: "heading-kyw-5", label: "heading kyw5" },
                      { key: "code-block-kzl-1", label: "code-block kzl1" },
                      { key: "table-kzl-2", label: "table kzl2" },
                      { key: "callout-kzl-3", label: "callout kzl3" },
                      { key: "page-bg-kzl-4", label: "page-bg kzl4" },
                      { key: "heading-kzl-5", label: "heading kzl5" },
                      { key: "code-block-laa-1", label: "code-block laa1" },
                      { key: "table-laa-2", label: "table laa2" },
                      { key: "callout-laa-3", label: "callout laa3" },
                      { key: "page-bg-laa-4", label: "page-bg laa4" },
                      { key: "heading-laa-5", label: "heading laa5" },
                      { key: "code-block-lap-1", label: "code-block lap1" },
                      { key: "table-lap-2", label: "table lap2" },
                      { key: "callout-lap-3", label: "callout lap3" },
                      { key: "page-bg-lap-4", label: "page-bg lap4" },
                      { key: "heading-lap-5", label: "heading lap5" },
                      { key: "code-block-lbe-1", label: "code-block lbe1" },
                      { key: "table-lbe-2", label: "table lbe2" },
                      { key: "callout-lbe-3", label: "callout lbe3" },
                      { key: "page-bg-lbe-4", label: "page-bg lbe4" },
                      { key: "heading-lbe-5", label: "heading lbe5" },
                      { key: "code-block-lbt-1", label: "code-block lbt1" },
                      { key: "table-lbt-2", label: "table lbt2" },
                      { key: "callout-lbt-3", label: "callout lbt3" },
                      { key: "page-bg-lbt-4", label: "page-bg lbt4" },
                      { key: "heading-lbt-5", label: "heading lbt5" },
                      { key: "code-block-lci-1", label: "code-block lci1" },
                      { key: "table-lci-2", label: "table lci2" },
                      { key: "callout-lci-3", label: "callout lci3" },
                      { key: "page-bg-lci-4", label: "page-bg lci4" },
                      { key: "heading-lci-5", label: "heading lci5" },
                      { key: "code-block-lcx-1", label: "code-block lcx1" },
                      { key: "table-lcx-2", label: "table lcx2" },
                      { key: "callout-lcx-3", label: "callout lcx3" },
                      { key: "page-bg-lcx-4", label: "page-bg lcx4" },
                      { key: "heading-lcx-5", label: "heading lcx5" },
                      { key: "code-block-ldm-1", label: "code-block ldm1" },
                      { key: "table-ldm-2", label: "table ldm2" },
                      { key: "callout-ldm-3", label: "callout ldm3" },
                      { key: "page-bg-ldm-4", label: "page-bg ldm4" },
                      { key: "heading-ldm-5", label: "heading ldm5" },
                      { key: "code-block-leb-1", label: "code-block leb1" },
                      { key: "table-leb-2", label: "table leb2" },
                      { key: "callout-leb-3", label: "callout leb3" },
                      { key: "page-bg-leb-4", label: "page-bg leb4" },
                      { key: "heading-leb-5", label: "heading leb5" },
                      { key: "code-block-leq-1", label: "code-block leq1" },
                      { key: "table-leq-2", label: "table leq2" },
                      { key: "callout-leq-3", label: "callout leq3" },
                      { key: "page-bg-leq-4", label: "page-bg leq4" },
                      { key: "heading-leq-5", label: "heading leq5" },
                      { key: "code-block-lff-1", label: "code-block lff1" },
                      { key: "table-lff-2", label: "table lff2" },
                      { key: "callout-lff-3", label: "callout lff3" },
                      { key: "page-bg-lff-4", label: "page-bg lff4" },
                      { key: "heading-lff-5", label: "heading lff5" },
                      { key: "code-block-lfu-1", label: "code-block lfu1" },
                      { key: "table-lfu-2", label: "table lfu2" },
                      { key: "callout-lfu-3", label: "callout lfu3" },
                      { key: "page-bg-lfu-4", label: "page-bg lfu4" },
                      { key: "heading-lfu-5", label: "heading lfu5" },
                      { key: "code-block-lgj-1", label: "code-block lgj1" },
                      { key: "table-lgj-2", label: "table lgj2" },
                      { key: "callout-lgj-3", label: "callout lgj3" },
                      { key: "page-bg-lgj-4", label: "page-bg lgj4" },
                      { key: "heading-lgj-5", label: "heading lgj5" },
                      { key: "code-block-lgy-1", label: "code-block lgy1" },
                      { key: "table-lgy-2", label: "table lgy2" },
                      { key: "callout-lgy-3", label: "callout lgy3" },
                      { key: "page-bg-lgy-4", label: "page-bg lgy4" },
                      { key: "heading-lgy-5", label: "heading lgy5" },
                      { key: "code-block-lhn-1", label: "code-block lhn1" },
                      { key: "table-lhn-2", label: "table lhn2" },
                      { key: "callout-lhn-3", label: "callout lhn3" },
                      { key: "page-bg-lhn-4", label: "page-bg lhn4" },
                      { key: "heading-lhn-5", label: "heading lhn5" },
                      { key: "code-block-lic-1", label: "code-block lic1" },
                      { key: "table-lic-2", label: "table lic2" },
                      { key: "callout-lic-3", label: "callout lic3" },
                      { key: "page-bg-lic-4", label: "page-bg lic4" },
                      { key: "heading-lic-5", label: "heading lic5" },
                      { key: "code-block-lir-1", label: "code-block lir1" },
                      { key: "table-lir-2", label: "table lir2" },
                      { key: "callout-lir-3", label: "callout lir3" },
                      { key: "page-bg-lir-4", label: "page-bg lir4" },
                      { key: "heading-lir-5", label: "heading lir5" },
                      { key: "code-block-ljg-1", label: "code-block ljg1" },
                      { key: "table-ljg-2", label: "table ljg2" },
                      { key: "callout-ljg-3", label: "callout ljg3" },
                      { key: "page-bg-ljg-4", label: "page-bg ljg4" },
                      { key: "heading-ljg-5", label: "heading ljg5" },
                      { key: "code-block-ljv-1", label: "code-block ljv1" },
                      { key: "table-ljv-2", label: "table ljv2" },
                      { key: "callout-ljv-3", label: "callout ljv3" },
                      { key: "page-bg-ljv-4", label: "page-bg ljv4" },
                      { key: "heading-ljv-5", label: "heading ljv5" },
                      { key: "code-block-lkk-1", label: "code-block lkk1" },
                      { key: "table-lkk-2", label: "table lkk2" },
                      { key: "callout-lkk-3", label: "callout lkk3" },
                      { key: "page-bg-lkk-4", label: "page-bg lkk4" },
                      { key: "heading-lkk-5", label: "heading lkk5" },
                      { key: "code-block-lkz-1", label: "code-block lkz1" },
                      { key: "table-lkz-2", label: "table lkz2" },
                      { key: "callout-lkz-3", label: "callout lkz3" },
                      { key: "page-bg-lkz-4", label: "page-bg lkz4" },
                      { key: "heading-lkz-5", label: "heading lkz5" },
                      { key: "code-block-llp-1", label: "code-block llp1" },
                      { key: "table-llp-2", label: "table llp2" },
                      { key: "callout-llp-3", label: "callout llp3" },
                      { key: "page-bg-llp-4", label: "page-bg llp4" },
                      { key: "heading-llp-5", label: "heading llp5" },
                      { key: "code-block-lme-1", label: "code-block lme1" },
                      { key: "table-lme-2", label: "table lme2" },
                      { key: "callout-lme-3", label: "callout lme3" },
                      { key: "page-bg-lme-4", label: "page-bg lme4" },
                      { key: "heading-lme-5", label: "heading lme5" },
                      { key: "code-block-lmt-1", label: "code-block lmt1" },
                      { key: "table-lmt-2", label: "table lmt2" },
                      { key: "callout-lmt-3", label: "callout lmt3" },
                      { key: "page-bg-lmt-4", label: "page-bg lmt4" },
                      { key: "heading-lmt-5", label: "heading lmt5" },
                      { key: "code-block-lni-1", label: "code-block lni1" },
                      { key: "table-lni-2", label: "table lni2" },
                      { key: "callout-lni-3", label: "callout lni3" },
                      { key: "page-bg-lni-4", label: "page-bg lni4" },
                      { key: "heading-lni-5", label: "heading lni5" },
                      { key: "code-block-lnx-1", label: "code-block lnx1" },
                      { key: "table-lnx-2", label: "table lnx2" },
                      { key: "callout-lnx-3", label: "callout lnx3" },
                      { key: "page-bg-lnx-4", label: "page-bg lnx4" },
                      { key: "heading-lnx-5", label: "heading lnx5" },
                      { key: "code-block-lom-1", label: "code-block lom1" },
                      { key: "table-lom-2", label: "table lom2" },
                      { key: "callout-lom-3", label: "callout lom3" },
                      { key: "page-bg-lom-4", label: "page-bg lom4" },
                      { key: "heading-lom-5", label: "heading lom5" },
                      { key: "code-block-lpb-1", label: "code-block lpb1" },
                      { key: "table-lpb-2", label: "table lpb2" },
                      { key: "callout-lpb-3", label: "callout lpb3" },
                      { key: "page-bg-lpb-4", label: "page-bg lpb4" },
                      { key: "heading-lpb-5", label: "heading lpb5" },
                      { key: "code-block-lpq-1", label: "code-block lpq1" },
                      { key: "table-lpq-2", label: "table lpq2" },
                      { key: "callout-lpq-3", label: "callout lpq3" },
                      { key: "page-bg-lpq-4", label: "page-bg lpq4" },
                      { key: "heading-lpq-5", label: "heading lpq5" },
                      { key: "code-block-lqf-1", label: "code-block lqf1" },
                      { key: "table-lqf-2", label: "table lqf2" },
                      { key: "callout-lqf-3", label: "callout lqf3" },
                      { key: "page-bg-lqf-4", label: "page-bg lqf4" },
                      { key: "heading-lqf-5", label: "heading lqf5" },
                      { key: "code-block-lqu-1", label: "code-block lqu1" },
                      { key: "table-lqu-2", label: "table lqu2" },
                      { key: "callout-lqu-3", label: "callout lqu3" },
                      { key: "page-bg-lqu-4", label: "page-bg lqu4" },
                      { key: "heading-lqu-5", label: "heading lqu5" },
                      { key: "code-block-lrj-1", label: "code-block lrj1" },
                      { key: "table-lrj-2", label: "table lrj2" },
                      { key: "callout-lrj-3", label: "callout lrj3" },
                      { key: "page-bg-lrj-4", label: "page-bg lrj4" },
                      { key: "heading-lrj-5", label: "heading lrj5" },
                      { key: "code-block-lry-1", label: "code-block lry1" },
                      { key: "table-lry-2", label: "table lry2" },
                      { key: "callout-lry-3", label: "callout lry3" },
                      { key: "page-bg-lry-4", label: "page-bg lry4" },
                      { key: "heading-lry-5", label: "heading lry5" },
                      { key: "code-block-lsn-1", label: "code-block lsn1" },
                      { key: "table-lsn-2", label: "table lsn2" },
                      { key: "callout-lsn-3", label: "callout lsn3" },
                      { key: "page-bg-lsn-4", label: "page-bg lsn4" },
                      { key: "heading-lsn-5", label: "heading lsn5" },
                      { key: "code-block-ltc-1", label: "code-block ltc1" },
                      { key: "table-ltc-2", label: "table ltc2" },
                      { key: "callout-ltc-3", label: "callout ltc3" },
                      { key: "page-bg-ltc-4", label: "page-bg ltc4" },
                      { key: "heading-ltc-5", label: "heading ltc5" },
                      { key: "code-block-ltr-1", label: "code-block ltr1" },
                      { key: "table-ltr-2", label: "table ltr2" },
                      { key: "callout-ltr-3", label: "callout ltr3" },
                      { key: "page-bg-ltr-4", label: "page-bg ltr4" },
                      { key: "heading-ltr-5", label: "heading ltr5" },
                      { key: "code-block-lug-1", label: "code-block lug1" },
                      { key: "table-lug-2", label: "table lug2" },
                      { key: "callout-lug-3", label: "callout lug3" },
                      { key: "page-bg-lug-4", label: "page-bg lug4" },
                      { key: "heading-lug-5", label: "heading lug5" },
                      { key: "code-block-luv-1", label: "code-block luv1" },
                      { key: "table-luv-2", label: "table luv2" },
                      { key: "callout-luv-3", label: "callout luv3" },
                      { key: "page-bg-luv-4", label: "page-bg luv4" },
                      { key: "heading-luv-5", label: "heading luv5" },
                      { key: "code-block-lvk-1", label: "code-block lvk1" },
                      { key: "table-lvk-2", label: "table lvk2" },
                      { key: "callout-lvk-3", label: "callout lvk3" },
                      { key: "page-bg-lvk-4", label: "page-bg lvk4" },
                      { key: "heading-lvk-5", label: "heading lvk5" },
                      { key: "code-block-lvz-1", label: "code-block lvz1" },
                      { key: "table-lvz-2", label: "table lvz2" },
                      { key: "callout-lvz-3", label: "callout lvz3" },
                      { key: "page-bg-lvz-4", label: "page-bg lvz4" },
                      { key: "heading-lvz-5", label: "heading lvz5" },
                      { key: "code-block-lwo-1", label: "code-block lwo1" },
                      { key: "table-lwo-2", label: "table lwo2" },
                      { key: "callout-lwo-3", label: "callout lwo3" },
                      { key: "page-bg-lwo-4", label: "page-bg lwo4" },
                      { key: "heading-lwo-5", label: "heading lwo5" },
                      { key: "code-block-lxd-1", label: "code-block lxd1" },
                      { key: "table-lxd-2", label: "table lxd2" },
                      { key: "callout-lxd-3", label: "callout lxd3" },
                      { key: "page-bg-lxd-4", label: "page-bg lxd4" },
                      { key: "heading-lxd-5", label: "heading lxd5" },
                      { key: "code-block-lxs-1", label: "code-block lxs1" },
                      { key: "table-lxs-2", label: "table lxs2" },
                      { key: "callout-lxs-3", label: "callout lxs3" },
                      { key: "page-bg-lxs-4", label: "page-bg lxs4" },
                      { key: "heading-lxs-5", label: "heading lxs5" },
                      { key: "code-block-lyh-1", label: "code-block lyh1" },
                      { key: "table-lyh-2", label: "table lyh2" },
                      { key: "callout-lyh-3", label: "callout lyh3" },
                      { key: "page-bg-lyh-4", label: "page-bg lyh4" },
                      { key: "heading-lyh-5", label: "heading lyh5" },
                      { key: "code-block-lyw-1", label: "code-block lyw1" },
                      { key: "table-lyw-2", label: "table lyw2" },
                      { key: "callout-lyw-3", label: "callout lyw3" },
                      { key: "page-bg-lyw-4", label: "page-bg lyw4" },
                      { key: "heading-lyw-5", label: "heading lyw5" },
                      { key: "code-block-lzl-1", label: "code-block lzl1" },
                      { key: "table-lzl-2", label: "table lzl2" },
                      { key: "callout-lzl-3", label: "callout lzl3" },
                      { key: "page-bg-lzl-4", label: "page-bg lzl4" },
                      { key: "heading-lzl-5", label: "heading lzl5" },
                      { key: "code-block-maa-1", label: "code-block maa1" },
                      { key: "table-maa-2", label: "table maa2" },
                      { key: "callout-maa-3", label: "callout maa3" },
                      { key: "page-bg-maa-4", label: "page-bg maa4" },
                      { key: "heading-maa-5", label: "heading maa5" },
                      { key: "code-block-map-1", label: "code-block map1" },
                      { key: "table-map-2", label: "table map2" },
                      { key: "callout-map-3", label: "callout map3" },
                      { key: "page-bg-map-4", label: "page-bg map4" },
                      { key: "heading-map-5", label: "heading map5" },
                      { key: "code-block-mbe-1", label: "code-block mbe1" },
                      { key: "table-mbe-2", label: "table mbe2" },
                      { key: "callout-mbe-3", label: "callout mbe3" },
                      { key: "page-bg-mbe-4", label: "page-bg mbe4" },
                      { key: "heading-mbe-5", label: "heading mbe5" },
                      { key: "code-block-mbt-1", label: "code-block mbt1" },
                      { key: "table-mbt-2", label: "table mbt2" },
                      { key: "callout-mbt-3", label: "callout mbt3" },
                      { key: "page-bg-mbt-4", label: "page-bg mbt4" },
                      { key: "heading-mbt-5", label: "heading mbt5" },
                      { key: "code-block-mci-1", label: "code-block mci1" },
                      { key: "table-mci-2", label: "table mci2" },
                      { key: "callout-mci-3", label: "callout mci3" },
                      { key: "page-bg-mci-4", label: "page-bg mci4" },
                      { key: "heading-mci-5", label: "heading mci5" },
                      { key: "code-block-mcx-1", label: "code-block mcx1" },
                      { key: "table-mcx-2", label: "table mcx2" },
                      { key: "callout-mcx-3", label: "callout mcx3" },
                      { key: "page-bg-mcx-4", label: "page-bg mcx4" },
                      { key: "heading-mcx-5", label: "heading mcx5" },
                      { key: "code-block-mdm-1", label: "code-block mdm1" },
                      { key: "table-mdm-2", label: "table mdm2" },
                      { key: "callout-mdm-3", label: "callout mdm3" },
                      { key: "page-bg-mdm-4", label: "page-bg mdm4" },
                      { key: "heading-mdm-5", label: "heading mdm5" },
                      { key: "code-block-meb-1", label: "code-block meb1" },
                      { key: "table-meb-2", label: "table meb2" },
                      { key: "callout-meb-3", label: "callout meb3" },
                      { key: "page-bg-meb-4", label: "page-bg meb4" },
                      { key: "heading-meb-5", label: "heading meb5" },
                      { key: "code-block-meq-1", label: "code-block meq1" },
                      { key: "table-meq-2", label: "table meq2" },
                      { key: "callout-meq-3", label: "callout meq3" },
                      { key: "page-bg-meq-4", label: "page-bg meq4" },
                      { key: "heading-meq-5", label: "heading meq5" },
                      { key: "code-block-mff-1", label: "code-block mff1" },
                      { key: "table-mff-2", label: "table mff2" },
                      { key: "callout-mff-3", label: "callout mff3" },
                      { key: "page-bg-mff-4", label: "page-bg mff4" },
                      { key: "heading-mff-5", label: "heading mff5" },
                      { key: "code-block-mfu-1", label: "code-block mfu1" },
                      { key: "table-mfu-2", label: "table mfu2" },
                      { key: "callout-mfu-3", label: "callout mfu3" },
                      { key: "page-bg-mfu-4", label: "page-bg mfu4" },
                      { key: "heading-mfu-5", label: "heading mfu5" },
                      { key: "code-block-mgj-1", label: "code-block mgj1" },
                      { key: "table-mgj-2", label: "table mgj2" },
                      { key: "callout-mgj-3", label: "callout mgj3" },
                      { key: "page-bg-mgj-4", label: "page-bg mgj4" },
                      { key: "heading-mgj-5", label: "heading mgj5" },
                      { key: "code-block-mgy-1", label: "code-block mgy1" },
                      { key: "table-mgy-2", label: "table mgy2" },
                      { key: "callout-mgy-3", label: "callout mgy3" },
                      { key: "page-bg-mgy-4", label: "page-bg mgy4" },
                      { key: "heading-mgy-5", label: "heading mgy5" },
                      { key: "code-block-mhn-1", label: "code-block mhn1" },
                      { key: "table-mhn-2", label: "table mhn2" },
                      { key: "callout-mhn-3", label: "callout mhn3" },
                      { key: "page-bg-mhn-4", label: "page-bg mhn4" },
                      { key: "heading-mhn-5", label: "heading mhn5" },
                      { key: "code-block-mic-1", label: "code-block mic1" },
                      { key: "table-mic-2", label: "table mic2" },
                      { key: "callout-mic-3", label: "callout mic3" },
                      { key: "page-bg-mic-4", label: "page-bg mic4" },
                      { key: "heading-mic-5", label: "heading mic5" },
                      { key: "code-block-mir-1", label: "code-block mir1" },
                      { key: "table-mir-2", label: "table mir2" },
                      { key: "callout-mir-3", label: "callout mir3" },
                      { key: "page-bg-mir-4", label: "page-bg mir4" },
                      { key: "heading-mir-5", label: "heading mir5" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.key}
                      onClick={() => {
                        try {
                          const lsKey = `noteforge:${t.key}`;
                          const cur = localStorage.getItem(lsKey) === "1";
                          if (cur) localStorage.removeItem(lsKey);
                          else localStorage.setItem(lsKey, "1");
                          document.body.classList.toggle(t.key, !cur);
                        } catch {}
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 hover:bg-black/5 text-left"
                    >
                      {document.body.classList.contains(t.key) ? "✓ " : ""}
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() => {
                  const editor =
                    document.querySelector(".bn-container") ||
                    document.querySelector(".bn-editor");
                  const text = (editor?.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim();
                  const words = text ? text.split(/\s+/).length : 0;
                  const chars = text.length;
                  const sentences = text
                    ? (text.match(/[.!?]+(?=\s|$)/g) || []).length
                    : 0;
                  const paragraphs = editor
                    ? editor.querySelectorAll(".bn-block").length
                    : 0;
                  const h2 = editor
                    ? editor.querySelectorAll("h2").length
                    : 0;
                  const minRead = Math.max(1, Math.round(words / 200));
                  let sections = "";
                  if (editor && h2 > 0) {
                    const all = Array.from(
                      editor.querySelectorAll("h1, h2, h3, p, li, blockquote"),
                    );
                    let cur: { name: string; words: number } | null = null;
                    const out: { name: string; words: number }[] = [];
                    for (const el of all) {
                      if (el.tagName === "H2") {
                        if (cur) out.push(cur);
                        cur = {
                          name: (el.textContent ?? "").trim() || "(untitled)",
                          words: 0,
                        };
                      } else if (cur && (el.tagName === "P" || el.tagName === "LI" || el.tagName === "H3" || el.tagName === "BLOCKQUOTE")) {
                        const t = (el.textContent ?? "").trim();
                        if (t) cur.words += t.split(/\s+/).length;
                      }
                    }
                    if (cur) out.push(cur);
                    if (out.length > 0) {
                      sections =
                        "\n\nBy section:\n" +
                        out
                          .slice(0, 12)
                          .map((s) => `· ${s.name.slice(0, 40)} — ${s.words}`)
                          .join("\n");
                    }
                  }
                  alert(
                    `📊 Quick stats\n\nWords: ${words.toLocaleString()}\nChars: ${chars.toLocaleString()}\nSentences: ${sentences}\nBlocks: ${paragraphs}\nH2 sections: ${h2}\nEst. read: ${minRead} min${sections}`,
                  );
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                📊 Quick stats
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(pageId).then(() => {
                    const tip = document.createElement("div");
                    tip.textContent = "Page ID copied";
                    tip.className =
                      "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                    document.body.appendChild(tip);
                    setTimeout(() => tip.remove(), 1200);
                  });
                  setOpen(false);
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title={`Page ID: ${pageId}`}
              >
                🆔 Copy page ID
              </button>
              {status !== "published" && (
                <button
                  onClick={() => start(() => setPageStatus(slug, pageId, "published"))}
                  className="w-full text-xs px-2 py-1 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 flex items-center gap-1 justify-center mb-1"
                >
                  ✅ Mark as published
                </button>
              )}
              <div className="mb-1">
                <label className="text-[10px] uppercase text-gray-500 px-1">
                  Status
                </label>
                <div className="flex gap-1 mt-0.5">
                  {(
                    [
                      { v: null, l: "—" },
                      { v: "draft", l: "Draft" },
                      { v: "in_review", l: "Review" },
                      { v: "published", l: "Published" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.l}
                      onClick={() => start(() => setPageStatus(slug, pageId, opt.v))}
                      className={
                        "flex-1 text-[10px] px-1 py-0.5 rounded border " +
                        ((status ?? null) === opt.v
                          ? "bg-gray-900 text-white border-gray-900"
                          : "border-gray-200 hover:bg-black/5")
                      }
                    >
                      {opt.l}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() =>
                  start(async () => {
                    await setPageAsTemplate(slug, pageId, !isTemplate);
                  })
                }
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title={
                  isTemplate
                    ? "Remove from Templates section"
                    : "Move this page into the Templates section so it can be used as a starting point"
                }
              >
                {isTemplate ? "✕ Remove as template" : "📋 Save as template"}
              </button>
              <button
                onClick={() => {
                  start(async () => {
                    await archivePage(slug, pageId);
                    // Show an undo toast for 6 seconds, then navigate home.
                    showArchiveUndoToast(slug, pageId);
                    router.push(`/w/${slug}`);
                  });
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mt-1"
              >
                📦 Archive
              </button>
              <ExpiryRow slug={slug} pageId={pageId} initial={expiresAt} />
              <WordGoalRow slug={slug} pageId={pageId} initial={wordGoal} />
              <SlugRow slug={slug} pageId={pageId} initial={customSlug} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function fontClass(font: PageFont): string {
  if (font === "serif") return "font-serif";
  if (font === "mono") return "font-mono";
  return "font-sans";
}

export function widthClass(width: PageWidth): string {
  if (width === "wide") return "max-w-5xl";
  if (width === "full") return "max-w-none";
  return "max-w-3xl";
}

function showArchiveUndoToast(slug: string, pageId: string) {
  if (typeof document === "undefined") return;
  const tip = document.createElement("div");
  tip.className =
    "fixed bottom-5 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-4 py-1.5 shadow-lg flex items-center gap-3";
  const span = document.createElement("span");
  span.textContent = "📦 Page archived";
  const btn = document.createElement("button");
  btn.textContent = "Restore";
  btn.className = "underline hover:opacity-80";
  btn.addEventListener("click", () => {
    unarchivePage(slug, pageId)
      .then(() => {
        tip.textContent = "Restored";
        setTimeout(() => tip.remove(), 800);
        // Navigate back to the page
        window.location.href = `/w/${slug}/p/${pageId}`;
      })
      .catch(() => {
        tip.textContent = "Restore failed";
      });
  });
  tip.appendChild(span);
  tip.appendChild(btn);
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 6000);
}

function LockRow({ slug, pageId }: { slug: string; pageId: string }) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const lockFor = (hours?: number) =>
    start(() => togglePageLock(slug, pageId, hours));
  return (
    <div className="relative mb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center justify-center gap-1"
      >
        🔒 Lock page {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-white border border-gray-200 rounded shadow-md py-1 text-xs">
          {[
            { label: "Lock for 1 hour", hours: 1 },
            { label: "Lock for 24 hours", hours: 24 },
            { label: "Lock for 1 week", hours: 24 * 7 },
            { label: "Lock until unlocked", hours: undefined },
          ].map((opt) => (
            <button
              key={opt.label}
              onClick={() => {
                setOpen(false);
                lockFor(opt.hours);
              }}
              className="w-full text-left px-3 py-1 hover:bg-black/5"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ExpiryRow({
  slug,
  pageId,
  initial,
}: {
  slug: string;
  pageId: string;
  initial: string | null;
}) {
  const [value, setValue] = useState(
    initial ? new Date(initial).toISOString().slice(0, 16) : "",
  );
  const [, start] = useTransition();
  return (
    <div className="mt-2 pt-2 border-t border-gray-100">
      <label className="text-[10px] uppercase text-gray-500 px-1">
        Auto-archive on
      </label>
      <div className="flex items-center gap-1 mt-1">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-gray-400"
        />
        <button
          onClick={() =>
            start(async () => {
              await setPageExpiry(
                slug,
                pageId,
                value ? new Date(value).toISOString() : null,
              );
            })
          }
          className="text-[10px] px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
        >
          Save
        </button>
        {initial && (
          <button
            onClick={() => {
              setValue("");
              start(() => setPageExpiry(slug, pageId, null));
            }}
            className="text-[10px] text-gray-500 hover:text-red-600 px-1"
            title="Cancel auto-archive"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function WordGoalRow({
  slug,
  pageId,
  initial,
}: {
  slug: string;
  pageId: string;
  initial: number | null;
}) {
  const [value, setValue] = useState<string>(initial ? String(initial) : "");
  const [, start] = useTransition();
  return (
    <div className="mt-2 pt-2 border-t border-gray-100">
      <label className="text-[10px] uppercase text-gray-500 px-1">
        Word goal
      </label>
      <div className="flex items-center gap-1 mt-1">
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="500"
          className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-gray-400"
        />
        <button
          onClick={() =>
            start(() =>
              setPageWordGoal(
                slug,
                pageId,
                value && Number(value) > 0 ? Math.round(Number(value)) : null,
              ),
            )
          }
          className="text-[10px] px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
        >
          Save
        </button>
      </div>
      <div className="flex gap-1 mt-1">
        {[250, 500, 1000, 2000].map((n) => (
          <button
            key={n}
            onClick={() => {
              setValue(String(n));
              start(() => setPageWordGoal(slug, pageId, n));
            }}
            className="flex-1 text-[10px] px-1 py-0.5 rounded border border-gray-200 hover:bg-black/5"
          >
            {n}
          </button>
        ))}
        <button
          onClick={() => {
            setValue("");
            start(() => setPageWordGoal(slug, pageId, null));
          }}
          className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 hover:bg-black/5 text-gray-500"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function SlugRow({
  slug,
  pageId,
  initial,
}: {
  slug: string;
  pageId: string;
  initial: string | null;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [avail, setAvail] = useState<null | "ok" | "taken" | "invalid">(null);
  useEffect(() => {
    const v = value.trim();
    if (!v || v === (initial ?? "")) {
      setAvail(null);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/workspace/slug-check?slug=${encodeURIComponent(slug)}&page=${encodeURIComponent(pageId)}&candidate=${encodeURIComponent(v)}`,
        );
        if (!res.ok) {
          setAvail(null);
          return;
        }
        const data = (await res.json()) as { available?: boolean; reason?: string };
        if (data.reason === "invalid") setAvail("invalid");
        else setAvail(data.available ? "ok" : "taken");
      } catch {
        setAvail(null);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [value, initial, slug, pageId]);
  return (
    <div className="mt-2 pt-2 border-t border-gray-100">
      <label className="text-[10px] uppercase text-gray-500 px-1">
        Custom URL
      </label>
      <div className="flex items-center gap-1 mt-1">
        <span className="text-[10px] text-gray-400">/s/</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="my-page"
          className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:border-gray-400"
        />
        <button
          onClick={() =>
            start(async () => {
              try {
                setError(null);
                await setPageSlug(slug, pageId, value || null);
              } catch (e) {
                setError((e as Error).message);
              }
            })
          }
          className="text-[10px] px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
        >
          Save
        </button>
      </div>
      {avail === "ok" && (
        <p className="text-[10px] text-emerald-600 mt-1">✓ available</p>
      )}
      {avail === "taken" && (
        <p className="text-[10px] text-red-600 mt-1">⚠ already in use</p>
      )}
      {avail === "invalid" && (
        <p className="text-[10px] text-amber-600 mt-1">
          ⚠ only a-z, 0-9, and dashes
        </p>
      )}
      {error && <p className="text-[10px] text-red-600 mt-1">{error}</p>}
    </div>
  );
}
