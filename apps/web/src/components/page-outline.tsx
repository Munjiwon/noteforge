"use client";

import { useMemo } from "react";

type Heading = { id: string; level: number; text: string };

function extract(json: string): Heading[] {
  const out: Heading[] = [];
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return out;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (b: any) => {
      if (!b || typeof b !== "object") return;
      if (b.type === "heading" && b.props?.level) {
        let text = "";
        const c = b.content;
        if (Array.isArray(c)) {
          for (const it of c) {
            if (it?.type === "text" && typeof it.text === "string") text += it.text;
          }
        }
        out.push({ id: b.id, level: b.props.level, text: text.trim() });
      }
      if (Array.isArray(b.children)) for (const ch of b.children) walk(ch);
    };
    for (const b of blocks) walk(b);
  } catch {
    /* ignore */
  }
  return out;
}

export function PageOutline({ content }: { content: string }) {
  const headings = useMemo(() => extract(content), [content]);
  if (headings.length === 0) return null;
  return (
    <aside className="hidden xl:block fixed right-4 top-32 w-56 no-print">
      <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wide">
        Outline
      </div>
      <nav className="text-xs space-y-1 border-l-2 border-gray-200 pl-2">
        {headings.map((h) => (
          <a
            key={h.id}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              const el = document.querySelector(
                `[data-id="${h.id}"]`,
              ) as HTMLElement | null;
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className="block text-gray-600 hover:text-blue-600 truncate"
            style={{ paddingLeft: (h.level - 1) * 10 }}
          >
            {h.text || "Untitled heading"}
          </a>
        ))}
      </nav>
    </aside>
  );
}
