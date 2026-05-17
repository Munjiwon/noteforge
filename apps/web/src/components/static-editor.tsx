"use client";

import { useEffect } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { editorSchema } from "./blocks/schema";

export function StaticEditor({ content }: { content: string }) {
  const editor = useCreateBlockNote({ schema: editorSchema });

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

  return <BlockNoteView editor={editor} editable={false} />;
}
