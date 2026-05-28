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
