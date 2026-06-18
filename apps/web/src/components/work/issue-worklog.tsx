"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDuration } from "@/lib/work";
import {
  logWork,
  deleteWorklog,
  setOriginalEstimate,
} from "@/app/w/[slug]/work/work-extra-actions";

export function IssueWorklog({
  slug,
  issueId,
  originalEstimate,
  worklogs,
  currentUserId,
  readOnly,
}: {
  slug: string;
  issueId: string;
  originalEstimate: number | null;
  worklogs: { id: string; seconds: number; comment: string | null; startedAt: string; authorId: string; authorName: string }[];
  currentUserId: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [estimate, setEstimate] = useState(originalEstimate ? formatDuration(originalEstimate) : "");
  const totalLogged = worklogs.reduce((s, w) => s + w.seconds, 0);
  const remaining = originalEstimate != null ? Math.max(0, originalEstimate - totalLogged) : null;
  const pct = originalEstimate ? Math.min(100, Math.round((totalLogged / originalEstimate) * 100)) : 0;

  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-3">
      <div className="mb-2 text-xs font-medium text-gray-500">Time tracking</div>

      <div className="mb-2 flex items-center gap-3 text-xs text-gray-600">
        <span>Logged <b>{formatDuration(totalLogged)}</b></span>
        {originalEstimate != null && <span>Estimate <b>{formatDuration(originalEstimate)}</b></span>}
        {remaining != null && <span>Remaining <b>{formatDuration(remaining)}</b></span>}
      </div>
      {originalEstimate != null && (
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
        </div>
      )}

      {!readOnly && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-[11px] text-gray-500">Original estimate</label>
            <input
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => start(async () => { await setOriginalEstimate(slug, issueId, estimate); router.refresh(); })}
              placeholder="2d 4h"
              className="w-24 rounded border border-gray-300 px-2 py-1 text-xs"
            />
          </div>
          <form
            action={(fd) => start(async () => { await logWork(fd); router.refresh(); })}
            className="flex items-end gap-2"
          >
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="issueId" value={issueId} />
            <div>
              <label className="block text-[11px] text-gray-500">Log time</label>
              <input name="duration" required placeholder="1h 30m" className="w-24 rounded border border-gray-300 px-2 py-1 text-xs" />
            </div>
            <div>
              <label className="block text-[11px] text-gray-500">When</label>
              <input name="startedAt" type="date" className="rounded border border-gray-300 px-2 py-1 text-xs" />
            </div>
            <input name="comment" placeholder="Comment (optional)" className="w-40 rounded border border-gray-300 px-2 py-1 text-xs" />
            <button className="rounded bg-gray-800 px-2 py-1 text-xs text-white">Log</button>
          </form>
        </div>
      )}

      <div className="space-y-1">
        {worklogs.map((w) => (
          <div key={w.id} className="flex items-center gap-2 text-xs text-gray-600">
            <b>{formatDuration(w.seconds)}</b>
            <span className="text-gray-400">{w.authorName}</span>
            <span className="text-gray-400">{w.startedAt.slice(0, 10)}</span>
            {w.comment && <span className="truncate">— {w.comment}</span>}
            {!readOnly && w.authorId === currentUserId && (
              <button
                onClick={() => start(async () => { await deleteWorklog(slug, w.id); router.refresh(); })}
                className="ml-auto text-gray-400 hover:text-red-600"
              >
                ×
              </button>
            )}
          </div>
        ))}
        {worklogs.length === 0 && <span className="text-xs text-gray-400">No work logged yet.</span>}
      </div>
    </div>
  );
}
