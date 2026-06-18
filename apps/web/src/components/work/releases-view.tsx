"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createVersion,
  setVersionReleased,
  deleteVersion,
} from "@/app/w/[slug]/work/work-meta-actions";

export type VersionRow = {
  id: string;
  name: string;
  description: string | null;
  releaseDate: string | null;
  released: boolean;
  total: number;
  done: number;
};

export function ReleasesView({
  slug,
  projectId,
  versions,
  readOnly,
}: {
  slug: string;
  projectId: string;
  versions: VersionRow[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [open, setOpen] = useState(false);
  const refresh = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });

  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold">Releases</h2>
        {!readOnly && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="ml-auto rounded bg-gray-800 px-3 py-1 text-sm text-white"
          >
            + Create version
          </button>
        )}
      </div>

      {open && !readOnly && (
        <form action={createVersion} className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="projectId" value={projectId} />
          <div>
            <label className="block text-xs text-gray-500">Name</label>
            <input name="name" placeholder="v1.0" required className="rounded border border-gray-300 px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500">Release date</label>
            <input name="releaseDate" type="date" className="rounded border border-gray-300 px-2 py-1 text-sm" />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500">Description</label>
            <input name="description" className="w-full rounded border border-gray-300 px-2 py-1 text-sm" />
          </div>
          <button className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white">Create</button>
        </form>
      )}

      <div className="space-y-2">
        {versions.map((v) => {
          const pct = v.total ? Math.round((v.done / v.total) * 100) : 0;
          return (
            <div key={v.id} className="flex items-center gap-3 rounded-lg border border-gray-200 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{v.name}</span>
                  {v.released ? (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700">RELEASED</span>
                  ) : (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">UNRELEASED</span>
                  )}
                  {v.releaseDate && (
                    <span className="text-xs text-gray-400">{v.releaseDate.slice(0, 10)}</span>
                  )}
                </div>
                {v.description && <div className="text-xs text-gray-500">{v.description}</div>}
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 w-40 overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-400">{v.done}/{v.total} done</span>
                </div>
              </div>
              {!readOnly && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => refresh(() => setVersionReleased(slug, v.id, !v.released))}
                    className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-black/5"
                  >
                    {v.released ? "Unrelease" : "Release"}
                  </button>
                  <button
                    onClick={() => { if (confirm("Delete version?")) refresh(() => deleteVersion(slug, v.id)); }}
                    className="text-xs text-gray-400 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {versions.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-400">
            No versions yet.
          </div>
        )}
      </div>
    </div>
  );
}
