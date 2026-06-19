"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { STATUS_CATEGORIES, categoryMeta } from "@/lib/work";
import {
  addStatus,
  updateStatus,
  deleteStatus,
  setTransitionsFor,
  updateBoardColumn,
} from "@/app/w/[slug]/work/work-workflow-actions";

export type WfStatus = { id: string; name: string; category: string; issueCount: number };
export type WfColumn = { id: string; name: string; wipLimit: number | null; statusIds: string[] };
// transitions: toStatusId -> { any: boolean, from: string[] }
export type WfTransitions = Record<string, { any: boolean; from: string[] }>;

export function WorkflowEditor({
  slug,
  projectId,
  statuses,
  transitions,
  columns,
  canEdit,
}: {
  slug: string;
  projectId: string;
  statuses: WfStatus[];
  transitions: WfTransitions;
  columns: WfColumn[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const refresh = (fn: () => Promise<unknown>) =>
    start(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Action failed");
      }
    });

  // Local editable copies for transitions and columns.
  const [tr, setTr] = useState<WfTransitions>(transitions);
  const [cols, setCols] = useState<WfColumn[]>(columns);

  const statusName = (id: string) => statuses.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="space-y-8">
      {/* Statuses */}
      <section>
        <h3 className="mb-1 font-semibold">Workflow statuses</h3>
        <p className="mb-3 text-xs text-gray-400">
          Statuses map to a category (To Do / In Progress / Done) that drives the board and reports.
        </p>
        <div className="space-y-1">
          {statuses.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1.5">
              <input
                defaultValue={s.name}
                disabled={!canEdit}
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value !== s.name) {
                    const fd = new FormData();
                    fd.set("slug", slug);
                    fd.set("statusId", s.id);
                    fd.set("name", e.target.value.trim());
                    refresh(() => updateStatus(fd));
                  }
                }}
                className="w-44 rounded border border-transparent px-1.5 py-1 text-sm hover:border-gray-300"
              />
              <select
                defaultValue={s.category}
                disabled={!canEdit}
                onChange={(e) => {
                  const fd = new FormData();
                  fd.set("slug", slug);
                  fd.set("statusId", s.id);
                  fd.set("category", e.target.value);
                  refresh(() => updateStatus(fd));
                }}
                className="rounded border border-gray-300 px-1.5 py-1 text-xs"
                style={{ color: categoryMeta(s.category).color }}
              >
                {STATUS_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <span className="text-xs text-gray-400">{s.issueCount} issue{s.issueCount === 1 ? "" : "s"}</span>
              {canEdit && (
                <button
                  onClick={() => {
                    if (confirm(`Delete status "${s.name}"?`)) refresh(() => deleteStatus(slug, s.id));
                  }}
                  className="ml-auto text-xs text-gray-400 hover:text-red-600"
                  title={s.issueCount > 0 ? "Reassign its issues first" : "Delete"}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <form
            action={addStatus}
            className="mt-2 flex items-center gap-2"
          >
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="projectId" value={projectId} />
            <input name="name" placeholder="New status name" required className="w-44 rounded border border-gray-300 px-2 py-1 text-sm" />
            <select name="category" defaultValue="todo" className="rounded border border-gray-300 px-1.5 py-1 text-xs">
              {STATUS_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button className="rounded bg-gray-800 px-3 py-1 text-sm text-white">Add status</button>
          </form>
        )}
      </section>

      {/* Transitions */}
      <section>
        <h3 className="mb-1 font-semibold">Transitions</h3>
        <p className="mb-3 text-xs text-gray-400">
          Which statuses an issue may move <em>from</em> to reach each status. "Any" allows it from anywhere.
        </p>
        <div className="space-y-2">
          {statuses.map((target) => {
            const cur = tr[target.id] ?? { any: true, from: [] };
            const setCur = (next: { any: boolean; from: string[] }) =>
              setTr((p) => ({ ...p, [target.id]: next }));
            return (
              <div key={target.id} className="rounded border border-gray-200 p-2">
                <div className="mb-1 text-sm font-medium">→ {target.name}</div>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={cur.any}
                      onChange={(e) => setCur({ any: e.target.checked, from: cur.from })}
                    />
                    Any
                  </label>
                  {!cur.any &&
                    statuses
                      .filter((s) => s.id !== target.id)
                      .map((s) => (
                        <label key={s.id} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            disabled={!canEdit}
                            checked={cur.from.includes(s.id)}
                            onChange={(e) =>
                              setCur({
                                any: false,
                                from: e.target.checked
                                  ? [...cur.from, s.id]
                                  : cur.from.filter((x) => x !== s.id),
                              })
                            }
                          />
                          {s.name}
                        </label>
                      ))}
                  {canEdit && (
                    <button
                      onClick={() =>
                        refresh(() =>
                          setTransitionsFor(slug, projectId, target.id, cur.any ? ["__any__"] : cur.from),
                        )
                      }
                      className="ml-auto rounded border border-gray-300 px-2 py-0.5 hover:bg-black/5"
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Board columns */}
      <section>
        <h3 className="mb-1 font-semibold">Board columns</h3>
        <p className="mb-3 text-xs text-gray-400">
          Configure column names, WIP limits, and which statuses each column shows.
        </p>
        <div className="space-y-2">
          {cols.map((c, idx) => (
            <div key={c.id} className="rounded border border-gray-200 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={c.name}
                  disabled={!canEdit}
                  onChange={(e) => setCols((p) => p.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
                  className="w-40 rounded border border-gray-300 px-2 py-1 text-sm"
                />
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  WIP
                  <input
                    type="number"
                    min={0}
                    disabled={!canEdit}
                    value={c.wipLimit ?? ""}
                    onChange={(e) =>
                      setCols((p) =>
                        p.map((x, i) =>
                          i === idx ? { ...x, wipLimit: e.target.value ? Number(e.target.value) : null } : x,
                        ),
                      )
                    }
                    className="w-16 rounded border border-gray-300 px-1 py-1 text-xs"
                  />
                </label>
                {canEdit && (
                  <button
                    onClick={() => {
                      const fd = new FormData();
                      fd.set("slug", slug);
                      fd.set("columnId", c.id);
                      fd.set("name", c.name);
                      fd.set("wipLimit", c.wipLimit == null ? "" : String(c.wipLimit));
                      fd.set("statusIds", c.statusIds.join(","));
                      refresh(() => updateBoardColumn(fd));
                    }}
                    className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-black/5"
                  >
                    Save
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
                {statuses.map((s) => (
                  <label key={s.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={c.statusIds.includes(s.id)}
                      onChange={(e) =>
                        setCols((p) =>
                          p.map((x, i) =>
                            i === idx
                              ? {
                                  ...x,
                                  statusIds: e.target.checked
                                    ? [...x.statusIds, s.id]
                                    : x.statusIds.filter((y) => y !== s.id),
                                }
                              : x,
                          ),
                        )
                      }
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-400">
          A status not mapped to any column won't appear on the board — keep them covered.
        </p>
      </section>
    </div>
  );
}
