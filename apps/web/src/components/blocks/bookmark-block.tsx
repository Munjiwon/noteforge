"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useState } from "react";

type Meta = {
  title: string | null;
  description: string | null;
  image: string | null;
  domain: string | null;
};

export const BookmarkBlock = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: {
      url: { default: "" },
      title: { default: "" },
      description: { default: "" },
      image: { default: "" },
      domain: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const url = (block.props.url as string) ?? "";
      const cached: Meta = {
        title: (block.props.title as string) || null,
        description: (block.props.description as string) || null,
        image: (block.props.image as string) || null,
        domain: (block.props.domain as string) || null,
      };
      const [editing, setEditing] = useState(!url);
      const [draft, setDraft] = useState(url);
      const [loading, setLoading] = useState(false);
      const [meta, setMeta] = useState<Meta>(cached);

      useEffect(() => {
        if (!url) return;
        if (cached.title || cached.description) {
          setMeta(cached);
          return;
        }
        setLoading(true);
        fetch(`/api/og?url=${encodeURIComponent(url)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data: Meta | null) => {
            if (!data) return;
            setMeta(data);
            // Persist into block props so we don't refetch every render.
            editor.updateBlock(block, {
              props: {
                ...(block.props as Record<string, unknown>),
                title: data.title ?? "",
                description: data.description ?? "",
                image: data.image ?? "",
                domain: data.domain ?? "",
              },
            } as never);
          })
          .finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [url]);

      if (editing) {
        return (
          <div className="w-full border border-gray-200 rounded-md p-3 my-1 bg-gray-50">
            <div className="text-[10px] uppercase text-gray-500 mb-1">Bookmark</div>
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-gray-400"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    editor.updateBlock(block, {
                      props: {
                        ...(block.props as Record<string, unknown>),
                        url: draft,
                        title: "",
                        description: "",
                        image: "",
                        domain: "",
                      },
                    } as never);
                    setEditing(false);
                  }
                }}
              />
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  editor.updateBlock(block, {
                    props: {
                      ...(block.props as Record<string, unknown>),
                      url: draft,
                      title: "",
                      description: "",
                      image: "",
                      domain: "",
                    },
                  } as never);
                  setEditing(false);
                }}
                className="text-xs px-3 py-1 rounded bg-gray-900 text-white hover:opacity-90"
              >
                Embed
              </button>
            </div>
          </div>
        );
      }

      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="w-full block border border-gray-200 rounded-md my-1 overflow-hidden hover:bg-black/5"
        >
          <div className="flex">
            <div className="flex-1 p-3 min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">
                {loading
                  ? "Loading…"
                  : meta.title ?? cached.title ?? url}
              </div>
              {(meta.description ?? cached.description) && (
                <div className="text-xs text-gray-500 line-clamp-2 mt-0.5">
                  {meta.description ?? cached.description}
                </div>
              )}
              <div className="text-[11px] text-gray-400 truncate mt-1">
                {meta.domain ?? cached.domain ?? safeHost(url)}
              </div>
            </div>
            {(meta.image ?? cached.image) ? (
              <div
                className="w-32 h-24 shrink-0 bg-center bg-cover"
                style={{ backgroundImage: `url("${meta.image ?? cached.image}")` }}
              />
            ) : (
              <div className="w-32 h-24 shrink-0 bg-gray-50 grid place-items-center">
                <img
                  src={`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(meta.domain ?? cached.domain ?? safeHost(url))}`}
                  alt=""
                  className="w-8 h-8 opacity-80"
                />
              </div>
            )}
          </div>
          <div className="text-[10px] text-gray-400 px-3 py-1 border-t border-gray-100 flex justify-between gap-2">
            <span className="truncate">{url}</span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onMouseDown={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMeta({ title: null, description: null, image: null, domain: null });
                  try {
                    const res = await fetch(
                      `/api/og?url=${encodeURIComponent(url)}`,
                    );
                    if (!res.ok) return;
                    const data = (await res.json()) as Meta;
                    setMeta(data);
                    editor.updateBlock(block, {
                      props: {
                        ...(block.props as Record<string, unknown>),
                        title: data.title ?? "",
                        description: data.description ?? "",
                        image: data.image ?? "",
                        domain: data.domain ?? "",
                      },
                    } as never);
                  } catch {}
                }}
                className="hover:text-gray-700"
                title="Refresh metadata from the URL"
              >
                ↻ Refresh
              </button>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDraft(url);
                  setEditing(true);
                }}
                className="hover:text-gray-700"
              >
                Edit
              </button>
            </span>
          </div>
        </a>
      );
    },
  },
);

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
