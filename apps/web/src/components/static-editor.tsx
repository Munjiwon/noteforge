"use client";

import { useEffect, useRef } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { editorSchema } from "./blocks/schema";
import { highlightAll } from "./blocks/code-highlight";

export function StaticEditor({ content }: { content: string }) {
  const editor = useCreateBlockNote({ schema: editorSchema });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    try {
      const blocks = JSON.parse(content);
      if (Array.isArray(blocks) && blocks.length > 0) {
        editor.replaceBlocks(editor.document, blocks);
      }
    } catch {
      // ignore parse error — show empty editor
    }
  }, [editor, content]);

  // Apply Shiki syntax highlighting after the read-only editor renders.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      highlightAll(root).catch(() => {});
    };
    // Wait one frame for BlockNote to attach <pre><code> nodes.
    const raf = requestAnimationFrame(() => setTimeout(tick, 50));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [content]);

  return (
    <div ref={rootRef}>
      <BlockNoteView editor={editor} editable={false} />
    </div>
  );
}
