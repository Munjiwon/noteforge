"use client";

import { useEffect, useRef, useState } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";

// Lightweight, non-collaborative BlockNote editor for issue descriptions.
// Persists via the provided onSave callback, debounced. Uses the default
// BlockNote schema (headings, lists, code, tables, etc.) — no page-coupled
// custom blocks — so it is fully self-contained.
export function DescriptionEditor({
  initialContent,
  onSave,
  readOnly = false,
}: {
  initialContent: string;
  onSave: (json: string) => void;
  readOnly?: boolean;
}) {
  const editor = useCreateBlockNote();
  const loaded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    try {
      const blocks = JSON.parse(initialContent);
      if (Array.isArray(blocks) && blocks.length > 0) {
        editor.replaceBlocks(editor.document, blocks);
      }
    } catch {
      /* keep empty doc */
    }
  }, [editor, initialContent]);

  return (
    <div className="rounded border border-gray-200">
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme="light"
        onChange={() => {
          if (readOnly || !loaded.current) return;
          setSaved(false);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            onSave(JSON.stringify(editor.document));
            setSaved(true);
          }, 800);
        }}
      />
      {!readOnly && (
        <div className="px-3 py-1 text-right text-[11px] text-gray-400">
          {saved ? "Saved" : "Saving…"}
        </div>
      )}
    </div>
  );
}
