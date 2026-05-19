"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";

type Hit = {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  snippet: string | null;
  parentTitle: string | null;
};

function markMatch(text: string, q: string): React.ReactNode {
  const needle = q.trim();
  if (!needle) return text;
  const re = new RegExp(`(${escapeReg(needle)})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) =>
    p.toLowerCase() === needle.toLowerCase() ? (
      <mark key={i} className="bg-yellow-100 rounded px-0.5">{p}</mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}
function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function SearchPalette({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<"all" | "doc" | "database">("all");
  const [since, setSince] = useState<"any" | "7d" | "30d" | "90d">("any");
  const [tag, setTag] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "relevance">("recent");
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (k === "k" || k === "p")) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    const onTrigger = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("search-open", onTrigger as EventListener);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("search-open", onTrigger as EventListener);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
      setQ("");
      setHits([]);
      setHighlight(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!q.trim()) {
      setHits([]);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          ws: slug,
          q: q.trim(),
        });
        if (since !== "any") params.set("since", since);
        if (tag.trim()) params.set("tag", tag.trim());
        if (sortBy !== "recent") params.set("sort", sortBy);
        const res = await fetch(`/api/search?${params.toString()}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { hits: Hit[] };
        setHits(data.hits);
        setHighlight(0);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [q, open, slug, since, tag, sortBy]);

  const choose = (hit: Hit) => {
    setOpen(false);
    router.push(`/w/${slug}/p/${hit.id}`);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[560px] max-w-[92vw] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
          <span className="text-gray-400 text-sm">🔎</span>
          <div className="flex gap-1 text-[10px]">
            {(["all", "doc", "database"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={
                  "px-1.5 py-0.5 rounded " +
                  (kindFilter === k
                    ? "bg-gray-900 text-white"
                    : "hover:bg-black/5 text-gray-500")
                }
              >
                {k === "all" ? "All" : k === "doc" ? "Pages" : "Databases"}
              </button>
            ))}
          </div>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages and contents…"
            className="flex-1 outline-none text-sm py-1"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => (hits.length === 0 ? 0 : (h + 1) % hits.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => (hits.length === 0 ? 0 : (h - 1 + hits.length) % hits.length));
              } else if (e.key === "Enter" && hits[highlight]) {
                e.preventDefault();
                choose(hits[highlight]);
              }
            }}
          />
          <kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1">esc</kbd>
        </div>
        <div className="border-b border-gray-100 px-3 py-1.5 flex items-center gap-2 text-[10px] text-gray-500">
          <span>Updated</span>
          {(["any", "7d", "30d", "90d"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSince(s)}
              className={
                "px-1.5 py-0.5 rounded " +
                (since === s
                  ? "bg-gray-900 text-white"
                  : "hover:bg-black/5 text-gray-500")
              }
            >
              {s === "any" ? "Any time" : "Last " + s}
            </button>
          ))}
          <span className="ml-2">Sort</span>
          {(["recent", "relevance"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={
                "px-1.5 py-0.5 rounded " +
                (sortBy === s
                  ? "bg-gray-900 text-white"
                  : "hover:bg-black/5 text-gray-500")
              }
            >
              {s === "recent" ? "Recent" : "Relevance"}
            </button>
          ))}
          <span className="ml-2">Tag</span>
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="e.g. design"
            className="border rounded px-1.5 py-0.5 text-[11px] outline-none focus:border-gray-400 w-28"
          />
          {(since !== "any" || tag) && (
            <button
              onClick={() => {
                setSince("any");
                setTag("");
              }}
              className="ml-auto text-gray-400 hover:text-gray-700"
            >
              Clear
            </button>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {q.trim() === "" ? (
            <div className="text-xs text-gray-400 text-center py-8">
              Type to search pages and their contents.
            </div>
          ) : loading && hits.length === 0 ? (
            <div className="text-xs text-gray-400 text-center py-8">Searching…</div>
          ) : (() => {
            const filtered = hits.filter((h) =>
              kindFilter === "all" ? true : h.kind === kindFilter,
            );
            return filtered.length === 0 ? (
              <div className="text-xs text-gray-400 text-center py-8">No results.</div>
            ) : (
              <ul>
              {filtered.map((h, i) => (
                <li key={h.id}>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(h);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={clsx(
                      "w-full text-left px-3 py-2 flex items-start gap-2",
                      i === highlight && "bg-gray-100",
                    )}
                  >
                    <span className="text-base w-5 text-center pt-0.5">
                      {h.icon ?? (h.kind === "database" ? "📊" : "📄")}
                    </span>
                    <span className="flex-1 min-w-0">
                      {h.parentTitle && (
                        <span className="text-[10px] text-gray-400 truncate block">
                          {h.parentTitle} /
                        </span>
                      )}
                      <span className="text-sm text-gray-900 truncate block">
                        {markMatch(h.title || "Untitled", q)}
                      </span>
                      {h.snippet && (
                        <span className="text-xs text-gray-500 truncate block">
                          {markMatch(h.snippet, q)}
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] text-gray-400 uppercase">
                      {h.kind}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            );
          })()}
        </div>
        <div className="border-t border-gray-100 px-3 py-1.5 text-[10px] text-gray-400 flex justify-between">
          <span>↑↓ navigate · Enter to open</span>
          <span>⌘K to toggle</span>
        </div>
      </div>
    </div>
  );
}
