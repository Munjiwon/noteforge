"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  archivePage,
  setPageAsTemplate,
  setPageFont,
  setPageSlug,
  setPageWidth,
  togglePageLock,
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
  canEdit,
}: {
  slug: string;
  pageId: string;
  width: PageWidth;
  font: PageFont;
  locked: boolean;
  isTemplate?: boolean;
  customSlug?: string | null;
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
              <button
                onClick={() => start(() => togglePageLock(slug, pageId))}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center mb-1"
              >
                {locked ? "🔓 Unlock page" : "🔒 Lock page"}
              </button>
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
                  if (
                    !confirm(
                      "Archive this page? It stays available under Archive but is hidden from the sidebar.",
                    )
                  )
                    return;
                  start(async () => {
                    await archivePage(slug, pageId);
                    router.push(`/w/${slug}`);
                  });
                }}
                className="w-full text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 flex items-center gap-1 justify-center"
              >
                📦 Archive
              </button>
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
