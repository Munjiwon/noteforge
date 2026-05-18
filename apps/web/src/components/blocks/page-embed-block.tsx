"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const StaticEditor = dynamic(
  () => import("../static-editor").then((m) => m.StaticEditor),
  { ssr: false, loading: () => <div className="text-gray-400 text-xs">Loading…</div> },
);

type SearchHit = {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
};

type PageData = {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  content: string;
  slug: string;
};

export const PageEmbedBlock = createReactBlockSpec(
  {
    type: "pageEmbed",
    propSchema: {
      pageId: { default: "" },
      title: { default: "" },
      icon: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const pageId = (block.props.pageId as string) ?? "";
      const cachedTitle = (block.props.title as string) ?? "";
      const cachedIcon = (block.props.icon as string) ?? "";
      const [editing, setEditing] = useState(!pageId);
      const [query, setQuery] = useState("");
      const [results, setResults] = useState<SearchHit[]>([]);
      const [data, setData] = useState<PageData | null>(null);
      const [loading, setLoading] = useState(false);
      const inputRef = useRef<HTMLInputElement>(null);

      useEffect(() => {
        if (editing) {
          setTimeout(() => inputRef.current?.focus(), 0);
        }
      }, [editing]);

      // Search-as-you-type for the picker.
      useEffect(() => {
        if (!editing) return;
        if (!query.trim()) {
          setResults([]);
          return;
        }
        const slug = window.location.pathname.split("/")[2];
        const ctrl = new AbortController();
        const t = setTimeout(() => {
          fetch(
            `/api/search?ws=${encodeURIComponent(slug)}&q=${encodeURIComponent(query.trim())}`,
            { signal: ctrl.signal },
          )
            .then((r) => (r.ok ? r.json() : { hits: [] }))
            .then((d: { hits: SearchHit[] }) => setResults(d.hits.slice(0, 8)))
            .catch(() => {});
        }, 150);
        return () => {
          ctrl.abort();
          clearTimeout(t);
        };
      }, [query, editing]);

      // Fetch embedded page content.
      useEffect(() => {
        if (!pageId) return;
        setLoading(true);
        fetch(`/api/page/${encodeURIComponent(pageId)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d: PageData | null) => setData(d))
          .finally(() => setLoading(false));
      }, [pageId]);

      function pick(hit: SearchHit) {
        editor.updateBlock(block, {
          props: {
            ...(block.props as Record<string, unknown>),
            pageId: hit.id,
            title: hit.title,
            icon: hit.icon ?? "",
          },
        } as never);
        setEditing(false);
      }

      if (editing) {
        return (
          <div className="w-full border border-gray-200 rounded-md p-3 my-1 bg-gray-50">
            <div className="text-[10px] uppercase text-gray-500 mb-1">Page embed</div>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a page to embed…"
              className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-gray-400"
            />
            {results.length > 0 && (
              <ul className="mt-1 bg-white border border-gray-200 rounded shadow-sm max-h-56 overflow-y-auto">
                {results.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(h);
                      }}
                      className="w-full text-left text-sm px-3 py-1.5 hover:bg-black/5 flex items-center gap-2"
                    >
                      <span>{h.icon ?? (h.kind === "database" ? "📊" : "📄")}</span>
                      <span className="flex-1 truncate">{h.title || "Untitled"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }

      const slug = data?.slug ?? window.location.pathname.split("/")[2];
      const title = data?.title ?? cachedTitle ?? "Untitled";
      const icon =
        data?.icon ??
        (cachedIcon || (data?.kind === "database" ? "📊" : "📄"));

      return (
        <div className="w-full border border-gray-200 rounded-md my-2 bg-white overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 bg-gray-50">
            <span>{icon}</span>
            <a
              href={`/w/${slug}/p/${pageId}`}
              className="text-sm font-medium text-gray-800 hover:underline flex-1 truncate"
            >
              {title}
            </a>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setEditing(true);
                setQuery("");
                setResults([]);
              }}
              className="text-[11px] text-gray-500 hover:text-gray-900"
            >
              Change
            </button>
          </div>
          <div className="px-4 py-3 max-h-[420px] overflow-y-auto">
            {loading ? (
              <div className="text-xs text-gray-400">Loading…</div>
            ) : data ? (
              <StaticEditor content={data.content} />
            ) : (
              <div className="text-xs text-gray-400">
                Page no longer exists.
              </div>
            )}
          </div>
        </div>
      );
    },
  },
);
