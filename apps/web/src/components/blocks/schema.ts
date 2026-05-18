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
import { BookmarkBlock } from "./bookmark-block";
import { AudioBlock } from "./audio-block";
import { PageEmbedBlock } from "./page-embed-block";
import { SyncedBlock } from "./synced-block";

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
    bookmark: BookmarkBlock,
    audio: AudioBlock,
    pageEmbed: PageEmbedBlock,
    synced: SyncedBlock,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: MentionInline,
  },
});

export type EditorSchema = typeof editorSchema;
