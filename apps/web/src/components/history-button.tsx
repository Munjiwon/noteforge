"use client";

import { useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { deleteSnapshot, takeSnapshot } from "@/app/w/[slug]/actions";

const StaticEditor = dynamic(
  () => import("./static-editor").then((m) => m.StaticEditor),
  { ssr: false, loading: () => <div className="text-gray-400 text-sm">Loading…</div> },
);

export type SnapshotItem = {
  id: string;
  content: string;
  createdAt: string;
  author: { name: string; color: string } | null;
};

export function HistoryButton({
  slug,
  pageId,
  snapshots,
  canEdit,
}: {
  slug: string;
  pageId: string;
  snapshots: SnapshotItem[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [, start] = useTransition();

  useEffect(() => {
    if (!open) {
      setSelected(null);
      return;
    }
    if (!selected && snapshots[0]) setSelected(snapshots[0].id);
  }, [open, snapshots, selected]);

  const current = snapshots.find((s) => s.id === selected) ?? null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
      >
        🕒 History
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="bg-white rounded-lg shadow-2xl w-[960px] max-w-[95vw] h-[640px] max-h-[90vh] overflow-hidden flex">
            <aside className="w-64 shrink-0 border-r border-gray-200 flex flex-col">
              <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-medium">Versions</span>
                {canEdit && (
                  <button
                    onClick={() =>
                      start(async () => {
                        await takeSnapshot(slug, pageId);
                      })
                    }
                    className="text-xs text-gray-600 hover:text-gray-900"
                    title="Save current state as a snapshot"
                  >
                    + Save
                  </button>
                )}
              </div>
              <div className="overflow-y-auto flex-1">
                {snapshots.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-6">
                    No versions yet. Edit the page to start collecting history.
                  </p>
                ) : (
                  <ul>
                    {snapshots.map((s) => (
                      <li key={s.id}>
                        <button
                          onClick={() => setSelected(s.id)}
                          className={
                            "w-full text-left px-3 py-2 border-b border-gray-50 group flex items-start gap-2 " +
                            (s.id === selected ? "bg-blue-50" : "hover:bg-black/5")
                          }
                        >
                          {s.author ? (
                            <span
                              className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-[10px] font-medium shrink-0"
                              style={{ background: s.author.color }}
                            >
                              {s.author.name.slice(0, 1).toUpperCase()}
                            </span>
                          ) : (
                            <span className="w-6" />
                          )}
                          <span className="flex-1 min-w-0">
                            <span className="block text-xs text-gray-900">
                              {new Date(s.createdAt).toLocaleString()}
                            </span>
                            <span className="block text-[11px] text-gray-500 truncate">
                              {s.author?.name ?? "Unknown"}
                            </span>
                          </span>
                          {canEdit && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!confirm("Delete this snapshot?")) return;
                                start(async () => {
                                  await deleteSnapshot(slug, s.id);
                                });
                              }}
                              className="text-gray-300 hover:text-red-600 opacity-0 group-hover:opacity-100 text-xs"
                            >
                              ✕
                            </button>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>
            <main className="flex-1 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-medium">
                  {current
                    ? `Preview · ${new Date(current.createdAt).toLocaleString()}`
                    : "Preview"}
                </span>
                <button
                  onClick={() => setOpen(false)}
                  className="text-gray-400 hover:text-gray-900"
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6">
                {current ? (
                  <StaticEditor content={current.content} />
                ) : (
                  <p className="text-xs text-gray-400">Select a version on the left.</p>
                )}
              </div>
              <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400">
                Read-only preview. To restore, copy text from here and paste into the page.
              </div>
            </main>
          </div>
        </div>
      )}
    </>
  );
}
