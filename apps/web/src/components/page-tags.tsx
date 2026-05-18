"use client";

import { useState, useTransition } from "react";
import { setPageTags } from "@/app/w/[slug]/actions";

export function PageTags({
  slug,
  pageId,
  initial,
  readOnly,
}: {
  slug: string;
  pageId: string;
  initial: string[];
  readOnly: boolean;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  const [input, setInput] = useState("");
  const [, start] = useTransition();
  const commit = (next: string[]) => {
    setTags(next);
    start(() => setPageTags(slug, pageId, next));
  };
  const addTag = () => {
    const t = input.trim();
    if (!t) return;
    if (tags.includes(t)) {
      setInput("");
      return;
    }
    commit([...tags, t]);
    setInput("");
  };
  if (readOnly && tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 mb-3 no-print">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 text-[11px] bg-gray-100 text-gray-700 rounded px-2 py-0.5"
        >
          #{t}
          {!readOnly && (
            <button
              onClick={() => commit(tags.filter((x) => x !== t))}
              className="text-gray-400 hover:text-red-600"
            >
              ✕
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag();
            } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
              commit(tags.slice(0, -1));
            }
          }}
          placeholder={tags.length === 0 ? "+ Add tag" : "+ tag"}
          className="text-[11px] bg-transparent outline-none w-20 placeholder-gray-400"
        />
      )}
    </div>
  );
}

export function parseTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
