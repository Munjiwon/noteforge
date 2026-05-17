"use client";

import { useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { createReactBlockSpec } from "@blocknote/react";

export const MathBlock = createReactBlockSpec(
  {
    type: "math",
    propSchema: {
      formula: { default: "" },
      display: { default: true }, // true = block style (centered), false = inline
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const formula = block.props.formula as string;
      const display = block.props.display as boolean;
      const [editing, setEditing] = useState(formula.length === 0);
      const [draft, setDraft] = useState(formula);

      const commit = () => {
        editor.updateBlock(block, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { ...(block.props as any), formula: draft },
        });
        setEditing(false);
      };

      if (editing) {
        return (
          <div className="w-full py-1">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              onBlur={commit}
              placeholder="LaTeX (e.g. \\sum_{i=1}^n i = \\frac{n(n+1)}{2})  —  ⌘/Ctrl+Enter to save"
              className="w-full font-mono text-sm border rounded px-2 py-1 bg-gray-50 outline-none focus:ring-1 focus:ring-accent min-h-[2.5rem]"
              rows={Math.max(1, draft.split("\n").length)}
            />
          </div>
        );
      }

      let html = "";
      let error: string | null = null;
      try {
        html = katex.renderToString(formula, {
          throwOnError: false,
          displayMode: display,
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      return (
        <div
          className="w-full py-1 cursor-pointer hover:bg-black/5 rounded px-1"
          onClick={() => {
            setDraft(formula);
            setEditing(true);
          }}
          title="Click to edit formula"
        >
          {error ? (
            <span className="text-red-600 text-sm font-mono">{error}</span>
          ) : formula.length === 0 ? (
            <span className="text-gray-400 italic text-sm">Empty formula — click to add LaTeX</span>
          ) : (
            <span
              className={display ? "block text-center" : "inline"}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      );
    },
    toExternalHTML: ({ block }) => {
      const formula = block.props.formula as string;
      const display = block.props.display as boolean;
      try {
        const html = katex.renderToString(formula, {
          throwOnError: false,
          displayMode: display,
        });
        return <span dangerouslySetInnerHTML={{ __html: html }} />;
      } catch {
        return <code>{formula}</code>;
      }
    },
  },
);
