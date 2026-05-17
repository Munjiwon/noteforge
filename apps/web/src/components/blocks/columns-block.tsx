"use client";

import { createReactBlockSpec } from "@blocknote/react";

export const ColumnsBlock = createReactBlockSpec(
  {
    type: "columns",
    propSchema: {
      count: { default: "2", values: ["2", "3"] },
      left: { default: "" },
      middle: { default: "" },
      right: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const count = block.props.count === "3" ? 3 : 2;
      const setProp = (k: "left" | "middle" | "right", v: string) => {
        editor.updateBlock(block, { props: { [k]: v } as Record<string, unknown> });
      };
      const editable = (editor as { isEditable: boolean }).isEditable;
      return (
        <div
          className={
            "grid gap-3 my-2 " +
            (count === 3 ? "grid-cols-3" : "grid-cols-2")
          }
          contentEditable={false}
        >
          <Column value={block.props.left} editable={editable} onChange={(v) => setProp("left", v)} />
          <Column value={block.props.middle} editable={editable} onChange={(v) => setProp("middle", v)} />
          {count === 3 && (
            <Column value={block.props.right} editable={editable} onChange={(v) => setProp("right", v)} />
          )}
        </div>
      );
    },
  },
);

function Column({
  value,
  editable,
  onChange,
}: {
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      value={value}
      disabled={!editable}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Column content…"
      className="border border-gray-200 rounded p-2 text-sm bg-white outline-none focus:border-gray-400 resize-y min-h-[80px]"
    />
  );
}
