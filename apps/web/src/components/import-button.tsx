"use client";

import { useRef, useTransition } from "react";
import { importPageMarkdown } from "@/app/w/[slug]/actions";

export function ImportButton({ slug }: { slug: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [, start] = useTransition();
  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        className="text-[11px] text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        title="Import a Markdown file"
      >
        ⬆ Import
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const text = await f.text();
          start(async () => {
            await importPageMarkdown(slug, null, f.name, text);
          });
          e.target.value = "";
        }}
      />
    </>
  );
}
