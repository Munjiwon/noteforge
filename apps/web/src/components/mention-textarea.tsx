"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { mentionMarker } from "@/lib/mentions";

type Suggestion =
  | { kind: "user"; id: string; name: string; color: string }
  | { kind: "page"; id: string; title: string; icon: string | null }
  | { kind: "date"; id: string; label: string };

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateSuggestions(query: string): Suggestion[] {
  const out: Suggestion[] = [];
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);
  const candidates: { keys: string[]; label: string; iso: string }[] = [
    { keys: ["today", "now", "오늘"], label: "Today", iso: ymd(today) },
    { keys: ["tomorrow", "tmr", "내일"], label: "Tomorrow", iso: ymd(tomorrow) },
    { keys: ["next week", "nextweek", "다음주"], label: "Next week", iso: ymd(nextWeek) },
  ];
  const q = query.toLowerCase();
  for (const c of candidates) {
    if (!q || c.keys.some((k) => k.startsWith(q) || q.startsWith(k.slice(0, 2)))) {
      out.push({ kind: "date", id: c.iso, label: c.label });
    }
  }
  // ISO date pattern like 2026-05-20
  const isoMatch = /^(\d{4}-\d{1,2}-\d{1,2})$/.exec(query.trim());
  if (isoMatch) {
    out.push({ kind: "date", id: isoMatch[1], label: isoMatch[1] });
  }
  return out;
}

export function MentionTextarea({
  slug,
  value,
  onChange,
  onSubmit,
  placeholder,
  className,
  autoFocus,
  minHeight,
}: {
  slug: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  minHeight?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null); // index of `@`
  const [results, setResults] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (query === null) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/mentions?ws=${encodeURIComponent(slug)}&q=${encodeURIComponent(query)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          users: { id: string; name: string; color: string }[];
          pages: { id: string; title: string; icon: string | null }[];
        };
        const merged: Suggestion[] = [
          ...data.users.map((u) => ({ kind: "user" as const, ...u })),
          ...data.pages.map((p) => ({ kind: "page" as const, ...p })),
          ...dateSuggestions(query ?? ""),
        ];
        setResults(merged);
        setHighlight(0);
      } catch {
        // aborted
      }
    }, 120);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [query, slug]);

  const onValueChange = (newVal: string, caret: number) => {
    onChange(newVal);
    // Find @ trigger preceding the caret with no spaces in between
    let i = caret - 1;
    while (i >= 0) {
      const ch = newVal[i];
      if (ch === "@") {
        const before = i === 0 ? " " : newVal[i - 1];
        if (/\s|^/.test(before) || i === 0) {
          setAnchor(i);
          setQuery(newVal.slice(i + 1, caret));
          return;
        }
        break;
      }
      if (ch === "\n" || ch === " ") break;
      i--;
    }
    setAnchor(null);
    setQuery(null);
  };

  const insertMention = (s: Suggestion) => {
    const ta = ref.current;
    if (anchor === null || !ta) return;
    const label =
      s.kind === "user" ? s.name : s.kind === "date" ? s.label : s.title || "Untitled";
    const marker = mentionMarker({
      type: s.kind,
      id: s.id,
      label,
    });
    const caret = ta.selectionStart ?? value.length;
    const next = value.slice(0, anchor) + marker + " " + value.slice(caret);
    onChange(next);
    setAnchor(null);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = anchor + marker.length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        style={minHeight ? { minHeight } : undefined}
        className={clsx(
          "w-full border border-gray-200 rounded px-3 py-2 text-sm outline-none focus:border-gray-400 resize-y",
          className,
        )}
        onChange={(e) => onValueChange(e.target.value, e.target.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (query !== null && results.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % results.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + results.length) % results.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              insertMention(results[highlight]);
              return;
            }
            if (e.key === "Escape") {
              setAnchor(null);
              setQuery(null);
              return;
            }
          }
          if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {query !== null && results.length > 0 && (
        <div className="absolute z-30 left-3 top-full mt-1 bg-white border border-gray-200 rounded shadow-lg min-w-[220px] max-w-[280px] py-1">
          {results.map((s, i) => (
            <button
              key={s.kind + ":" + s.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={clsx(
                "w-full text-left px-2 py-1 text-sm flex items-center gap-2",
                i === highlight && "bg-gray-100",
              )}
            >
              {s.kind === "user" ? (
                <>
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium"
                    style={{ background: s.color }}
                  >
                    {s.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate">{s.name}</span>
                  <span className="text-xs text-gray-400 ml-auto">person</span>
                </>
              ) : s.kind === "page" ? (
                <>
                  <span className="w-5 text-center">{s.icon ?? "📄"}</span>
                  <span className="truncate">{s.title || "Untitled"}</span>
                  <span className="text-xs text-gray-400 ml-auto">page</span>
                </>
              ) : (
                <>
                  <span className="w-5 text-center">📅</span>
                  <span className="truncate">{s.label}</span>
                  <span className="text-xs text-gray-400 ml-auto">{s.id}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
