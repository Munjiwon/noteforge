import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { MathBlock } from "./math-block";
import {
  CalloutBlock,
  QuoteBlock,
  EmbedBlock,
  ToggleBlock,
} from "./callout-block";
import { MentionInline } from "./mention-inline";
import { TocBlock } from "./toc-block";
import { ColumnsBlock } from "./columns-block";
import { DbViewBlock } from "./dbview-block";

export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    math: MathBlock,
    callout: CalloutBlock,
    quote: QuoteBlock,
    embed: EmbedBlock,
    toggle: ToggleBlock,
    toc: TocBlock,
    columns: ColumnsBlock,
    dbView: DbViewBlock,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: MentionInline,
  },
});

export type EditorSchema = typeof editorSchema;
