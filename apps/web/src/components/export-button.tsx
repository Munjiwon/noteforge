"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  exportPageHtml,
  exportPageMarkdown,
} from "@/app/w/[slug]/actions";

export function ExportButton({
  slug,
  pageId,
  title,
}: {
  slug: string;
  pageId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const downloadAs = (format: "md" | "html") => {
    setOpen(false);
    start(async () => {
      const text =
        format === "md"
          ? await exportPageMarkdown(slug, pageId)
          : await exportPageHtml(slug, pageId);
      const mime = format === "md" ? "text/markdown" : "text/html";
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (title || "Untitled").replace(/[^\w\d-]+/g, "_") + "." + format;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  };
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
        title="Export this page"
      >
        ⬇ Export
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded shadow-lg p-1 min-w-[140px]">
          <button
            onClick={() => downloadAs("md")}
            className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
          >
            Markdown (.md)
          </button>
          <button
            onClick={() => downloadAs("html")}
            className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
          >
            HTML (.html)
          </button>
        </div>
      )}
    </div>
  );
}
