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
