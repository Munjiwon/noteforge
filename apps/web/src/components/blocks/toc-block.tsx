"use client";

import { useEffect, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";

type Heading = { id: string; level: number; text: string };

export const TocBlock = createReactBlockSpec(
  {
    type: "toc",
    propSchema: {},
    content: "none",
  },
  {
    render: ({ editor }) => {
      const [headings, setHeadings] = useState<Heading[]>([]);

      useEffect(() => {
        const compute = () => {
          const found: Heading[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const walk = (blocks: any[]) => {
            for (const b of blocks) {
              if (b.type === "heading" && b.props?.level) {
                const text = blocksToText(b.content ?? []);
                found.push({ id: b.id, level: b.props.level, text });
              }
              if (b.children?.length) walk(b.children);
            }
          };
          walk(editor.document);
          setHeadings(found);
        };
        compute();
        const off = editor.onChange(() => compute());
        return () => {
          if (typeof off === "function") off();
        };
      }, [editor]);

      if (headings.length === 0) {
        return (
          <div
            className="text-xs text-gray-400 border border-dashed rounded p-3 my-2"
            contentEditable={false}
          >
            Table of contents — add headings to this page to populate.
          </div>
        );
      }

      return (
        <nav
          className="text-sm border-l-2 border-gray-200 pl-3 my-2 space-y-1"
          contentEditable={false}
        >
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
              className="block text-gray-700 hover:text-blue-600 truncate"
              style={{ paddingLeft: (h.level - 1) * 12 }}
            >
              {h.text || "Untitled heading"}
            </a>
          ))}
        </nav>
      );
    },
  },
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blocksToText(content: any[]): string {
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c?.type === "text" && typeof c.text === "string") return c.text;
      return "";
    })
    .join("")
    .trim();
}
