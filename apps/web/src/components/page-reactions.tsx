"use client";

import { useState, useTransition } from "react";
import { togglePageReaction } from "@/app/w/[slug]/actions";

export type PageReactionGroup = {
  emoji: string;
  reactedByMe: boolean;
  users: { id: string; name: string }[];
};

const QUICK_EMOJIS = ["👍", "❤️", "🎉", "👀", "🚀", "🤔", "🔥", "✅"];

export function PageReactions({
  slug,
  pageId,
  groups,
  readOnly = false,
}: {
  slug: string;
  pageId: string;
  groups: PageReactionGroup[];
  readOnly?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, start] = useTransition();
  const toggle = (emoji: string) =>
    start(() => togglePageReaction(slug, pageId, emoji));
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1 mb-3">
      {groups.map((g) => (
        <button
          key={g.emoji}
          disabled={readOnly}
          onClick={() => toggle(g.emoji)}
          title={g.users.map((u) => u.name).join(", ")}
          className={
            "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border " +
            (g.reactedByMe
              ? "bg-blue-50 border-blue-200 text-blue-700"
              : "bg-gray-50 border-gray-200 text-gray-700 hover:bg-black/5")
          }
        >
          <span className="text-sm leading-none">{g.emoji}</span>
          <span>{g.users.length}</span>
        </button>
      ))}
      {!readOnly && (
        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="text-xs px-2 py-0.5 rounded-full border border-dashed border-gray-300 text-gray-500 hover:bg-black/5"
            title="React"
          >
            + 😀
          </button>
          {pickerOpen && (
            <div className="absolute top-7 left-0 z-20 bg-white border border-gray-200 rounded-md shadow-lg p-1.5 flex gap-1">
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    toggle(e);
                    setPickerOpen(false);
                  }}
                  className="text-lg hover:bg-black/5 rounded px-1"
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
