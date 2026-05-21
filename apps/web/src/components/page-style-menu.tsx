"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  archivePage,
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
                  window.open(`/api/page/${pageId}`, "_blank", "noopener");
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
                title="Open the raw JSON in a new tab (debugging)"
              >
                🧰 View raw JSON
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
                    const ts = document.querySelectorAll<HTMLElement>(
                      '.bn-block[data-content-type="toggle"] [aria-expanded="false"]',
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
                    const ts = document.querySelectorAll<HTMLElement>(
                      '.bn-block[data-content-type="toggle"] [aria-expanded="true"]',
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
      {error && <p className="text-[10px] text-red-600 mt-1">{error}</p>}
    </div>
  );
}
