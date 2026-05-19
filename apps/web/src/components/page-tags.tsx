"use client";

import { useEffect, useState, useTransition } from "react";
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
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [, start] = useTransition();

  // Fetch existing workspace tags once the input gets focus.
  async function loadSuggestions() {
    if (suggestions.length > 0) return;
    try {
      const res = await fetch(`/api/tags?ws=${encodeURIComponent(slug)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { tags: string[] };
      setSuggestions(data.tags ?? []);
    } catch {}
  }
  useEffect(() => {
    // no-op: we trigger on focus
  }, []);
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
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("search-open", { detail: { tag: t } }),
              )
            }
            title="Find pages with this tag"
            className="hover:underline"
          >
            #{t}
          </button>
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
        <>
          <input
            value={input}
            onFocus={loadSuggestions}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag();
              } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
                commit(tags.slice(0, -1));
              }
            }}
            list="pt-suggestions"
            placeholder={tags.length === 0 ? "+ Add tag" : "+ tag"}
            className="text-[11px] bg-transparent outline-none w-24 placeholder-gray-400"
          />
          <datalist id="pt-suggestions">
            {suggestions
              .filter((s) => !tags.includes(s))
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
        </>
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
