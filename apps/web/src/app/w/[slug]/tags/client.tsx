"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  deleteTagAcrossWorkspace,
  renameTagAcrossWorkspace,
} from "@/app/w/[slug]/actions";

type Hit = {
  pageId: string;
  title: string;
  icon: string | null;
  kind: string;
};

export function TagsClient({
  slug,
  tags,
  canEdit,
}: {
  slug: string;
  tags: { name: string; pages: Hit[] }[];
  canEdit: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [, start] = useTransition();
  const filtered = tags.filter((t) =>
    filter.trim() ? t.name.toLowerCase().includes(filter.trim().toLowerCase()) : true,
  );
  return (
    <div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter tags…"
        className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm outline-none focus:border-gray-400 mb-3"
      />
      <ul className="space-y-1">
        {filtered.map((t) => {
          const open = expanded === t.name;
          return (
            <li key={t.name} className="border border-gray-100 rounded">
              <div className="flex items-center px-3 py-2 hover:bg-black/5 cursor-pointer">
                <button
                  onClick={() => setExpanded(open ? null : t.name)}
                  className="flex-1 text-left flex items-center gap-2"
                >
                  <span className="text-gray-400">{open ? "▾" : "▸"}</span>
                  <span className="inline-block bg-gray-100 text-gray-700 text-xs rounded px-2 py-0.5">
                    {t.name}
                  </span>
                  <span className="text-[11px] text-gray-400">
                    {t.pages.length} page{t.pages.length === 1 ? "" : "s"}
                  </span>
                </button>
                {canEdit && (
                  <>
                    <button
                      onClick={() => {
                        const nxt = prompt(`Rename "${t.name}" to:`, t.name);
                        if (!nxt || nxt.trim() === t.name) return;
                        start(async () => {
                          await renameTagAcrossWorkspace(slug, t.name, nxt.trim());
                        });
                      }}
                      className="text-xs text-gray-500 hover:text-gray-900 px-2"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => {
                        if (
                          !confirm(
                            `Remove tag "${t.name}" from all ${t.pages.length} page(s)?`,
                          )
                        )
                          return;
                        start(async () => {
                          await deleteTagAcrossWorkspace(slug, t.name);
                        });
                      }}
                      className="text-xs text-red-500 hover:text-red-700 px-2"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              {open && (
                <ul className="border-t border-gray-100 px-3 py-2 space-y-1">
                  {t.pages.map((p) => (
                    <li key={p.pageId}>
                      <Link
                        href={`/w/${slug}/p/${p.pageId}`}
                        className="text-sm text-gray-800 hover:underline flex items-center gap-2"
                      >
                        <span className="text-base">
                          {p.icon ?? (p.kind === "database" ? "📊" : "📄")}
                        </span>
                        <span>{p.title || "Untitled"}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
