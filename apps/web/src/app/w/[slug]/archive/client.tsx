"use client";

import Link from "next/link";
import { useTransition } from "react";
import { deletePage, unarchivePage } from "@/app/w/[slug]/actions";

export function ArchiveList({
  slug,
  rows,
  canEdit,
}: {
  slug: string;
  rows: {
    id: string;
    title: string;
    icon: string | null;
    kind: string;
    archivedAt: string;
  }[];
  canEdit: boolean;
}) {
  const [, start] = useTransition();
  return (
    <ul className="border border-gray-200 rounded divide-y divide-gray-100">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-3 py-2 group">
          <span>{r.icon ?? (r.kind === "database" ? "📊" : "📄")}</span>
          <div className="flex-1 min-w-0">
            <Link
              href={`/w/${slug}/p/${r.id}`}
              className="text-sm text-gray-800 hover:underline truncate block"
            >
              {r.title || "Untitled"}
            </Link>
            <span className="text-[11px] text-gray-400">
              archived {new Date(r.archivedAt).toLocaleString()}
            </span>
          </div>
          {canEdit && (
            <>
              <button
                onClick={() => start(() => unarchivePage(slug, r.id))}
                className="text-xs text-gray-500 hover:text-gray-900 opacity-0 group-hover:opacity-100"
              >
                Restore
              </button>
              <button
                onClick={() => {
                  if (!confirm("Move to Trash?")) return;
                  start(() => deletePage(slug, r.id));
                }}
                className="text-xs text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100"
              >
                Trash
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
