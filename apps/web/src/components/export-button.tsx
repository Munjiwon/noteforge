"use client";

import { useTransition } from "react";
import { exportPageMarkdown } from "@/app/w/[slug]/actions";

export function ExportButton({
  slug,
  pageId,
  title,
}: {
  slug: string;
  pageId: string;
  title: string;
}) {
  const [, start] = useTransition();
  return (
    <button
      onClick={() =>
        start(async () => {
          const md = await exportPageMarkdown(slug, pageId);
          const blob = new Blob([md], { type: "text/markdown" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = (title || "Untitled").replace(/[^\w\d-]+/g, "_") + ".md";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        })
      }
      className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
      title="Export as Markdown"
    >
      ⬇ Export
    </button>
  );
}
