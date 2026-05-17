"use client";

import { useEffect, useState, useTransition } from "react";
import { reorderPage } from "@/app/w/[slug]/actions";

type SidebarPage = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  kind: string;
};

export function PageMovePicker({
  slug,
  pages,
  movingId,
  onClose,
}: {
  slug: string;
  pages: SidebarPage[];
  movingId: string | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [, start] = useTransition();

  useEffect(() => {
    if (!movingId) return;
    setQ("");
  }, [movingId]);

  if (!movingId) return null;

  // Block moving under self or descendants
  const descendants = new Set<string>();
  const queue = [movingId];
  while (queue.length) {
    const cur = queue.shift()!;
    descendants.add(cur);
    for (const p of pages) {
      if (p.parentId === cur) queue.push(p.id);
    }
  }
  const candidates = pages.filter(
    (p) =>
      !descendants.has(p.id) &&
      p.kind !== "database" && // can't move into a database (db children are rows)
      (q
        ? (p.title || "Untitled").toLowerCase().includes(q.toLowerCase())
        : true),
  );

  const move = (newParentId: string | null) => {
    start(() => reorderPage(slug, movingId, newParentId, 0));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[420px] max-w-[92vw] p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Move page</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900">
            ✕
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search pages…"
          className="w-full border border-gray-200 rounded px-2 py-1 text-sm outline-none mb-2"
          autoFocus
        />
        <ul className="max-h-72 overflow-y-auto border border-gray-100 rounded">
          <li>
            <button
              onClick={() => move(null)}
              className="w-full text-left text-sm px-3 py-1.5 hover:bg-black/5 text-gray-700 italic"
            >
              ↑ Root (top-level)
            </button>
          </li>
          {candidates.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => move(p.id)}
                className="w-full text-left text-sm px-3 py-1.5 hover:bg-black/5 flex items-center gap-2"
              >
                <span>{p.icon ?? "📄"}</span>
                <span className="truncate">{p.title || "Untitled"}</span>
              </button>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="text-xs text-gray-400 px-3 py-2 text-center">No matching pages.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
