"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { priorityMeta, categoryMeta } from "@/lib/work";
import { QuickCreateIssue } from "./quick-create-issue";
import {
  createSprint,
  startSprint,
  completeSprint,
  deleteSprint,
  moveIssueToSprint,
  updateSprint,
} from "@/app/w/[slug]/work/work-sprint-actions";

export type BacklogItem = {
  id: string;
  number: number;
  summary: string;
  typeIcon: string | null;
  priority: string;
  statusName: string;
  statusCategory: string;
  assigneeName: string | null;
  assigneeColor: string | null;
  storyPoints: number | null;
  rank: number;
};

export type SprintSection = {
  id: string;
  name: string;
  goal: string | null;
  state: string;
  startDate: string | null;
  endDate: string | null;
  items: BacklogItem[];
};

export function BacklogView({
  slug,
  projectKey,
  projectId,
  sprints,
  backlog,
  types,
  readOnly,
}: {
  slug: string;
  projectKey: string;
  projectId: string;
  sprints: SprintSection[];
  backlog: BacklogItem[];
  types: { id: string; name: string; icon: string | null }[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const points = (items: BacklogItem[]) =>
    items.reduce((s, i) => s + (i.storyPoints ?? 0), 0);

  // Append to the end of a section (drop on empty area / section body).
  const drop = (sprintId: string | null, key: string) => {
    setOver(null);
    const id = dragId;
    setDragId(null);
    if (!id || readOnly) return;
    start(async () => {
      await moveIssueToSprint(slug, id, sprintId);
      router.refresh();
    });
  };

  // Insert the dragged issue before `target` within `items`, computing a
  // midpoint rank between the target and its predecessor.
  const dropBefore = (sprintId: string | null, items: BacklogItem[], index: number) => {
    setOver(null);
    const id = dragId;
    setDragId(null);
    if (!id || readOnly) return;
    const neighbors = items.filter((x) => x.id !== id);
    // Recompute the insertion index within the dragged-item-excluded list.
    const target = items[index];
    const pos = target ? neighbors.findIndex((x) => x.id === target.id) : neighbors.length;
    const before = pos > 0 ? neighbors[pos - 1].rank : null;
    const at = pos >= 0 && pos < neighbors.length ? neighbors[pos].rank : null;
    let rank: number;
    if (before == null && at == null) rank = 0;
    else if (before == null) rank = at! - 1;
    else if (at == null) rank = before + 1;
    else rank = (before + at) / 2;
    start(async () => {
      await moveIssueToSprint(slug, id, sprintId, rank);
      router.refresh();
    });
  };

  const Row = ({ i, items, index, sprintId }: { i: BacklogItem; items: BacklogItem[]; index: number; sprintId: string | null }) => (
    <a
      href={`/w/${slug}/work/${projectKey}/issue/${i.number}`}
      draggable={!readOnly}
      onDragStart={(e) => { e.stopPropagation(); setDragId(i.id); }}
      onDragEnd={() => setDragId(null)}
      onDragOver={(e) => { if (!readOnly && dragId) { e.preventDefault(); e.stopPropagation(); } }}
      onDrop={(e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); dropBefore(sprintId, items, index); } }}
      className={`flex items-center gap-2 border-b border-gray-100 bg-white px-3 py-1.5 text-sm last:border-0 hover:bg-black/[0.02] ${
        dragId === i.id ? "opacity-40" : ""
      }`}
    >
      <span>{i.typeIcon}</span>
      <span className="font-mono text-xs text-gray-400">{projectKey}-{i.number}</span>
      <span className="min-w-0 flex-1 truncate">{i.summary || "Untitled"}</span>
      <span style={{ color: priorityMeta(i.priority).color }}>{priorityMeta(i.priority).icon}</span>
      {i.storyPoints != null && (
        <span className="rounded-full bg-gray-100 px-1.5 text-xs">{i.storyPoints}</span>
      )}
      <span
        className="rounded px-1.5 py-0.5 text-[11px]"
        style={{
          background: `${categoryMeta(i.statusCategory).color}22`,
          color: categoryMeta(i.statusCategory).color,
        }}
      >
        {i.statusName}
      </span>
      {i.assigneeName && (
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-white"
          style={{ background: i.assigneeColor ?? "#888" }}
          title={i.assigneeName}
        >
          {i.assigneeName.slice(0, 1).toUpperCase()}
        </span>
      )}
    </a>
  );

  const Section = ({
    title,
    subtitle,
    sprintId,
    keyId,
    items,
    actions,
    headerExtra,
  }: {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    sprintId: string | null;
    keyId: string;
    items: BacklogItem[];
    actions?: React.ReactNode;
    headerExtra?: React.ReactNode;
  }) => (
    <div
      onDragOver={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setOver(keyId);
      }}
      onDragLeave={() => setOver((o) => (o === keyId ? null : o))}
      onDrop={() => drop(sprintId, keyId)}
      className={`mb-4 rounded-lg border ${over === keyId ? "border-[rgb(var(--accent,99_102_241))]" : "border-gray-200"}`}
    >
      <div className="flex items-center gap-2 rounded-t-lg bg-gray-50 px-3 py-2">
        <div className="font-medium">{title}</div>
        {subtitle}
        <span className="ml-2 text-xs text-gray-400">
          {items.length} issue{items.length === 1 ? "" : "s"} · {points(items)} pts
        </span>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      {headerExtra}
      <div>
        {items.map((i, idx) => (
          <Row key={i.id} i={i} items={items} index={idx} sprintId={sprintId} />
        ))}
        {items.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-gray-300">
            {readOnly ? "No issues" : "Drag issues here"}
          </div>
        )}
      </div>
      {!readOnly && (
        <div className="border-t border-gray-100 px-2 py-1">
          <QuickCreateIssue
            slug={slug}
            projectId={projectId}
            types={types}
            sprintId={sprintId ?? undefined}
          />
        </div>
      )}
    </div>
  );

  const SprintGoal = ({ sprintId, goal }: { sprintId: string; goal: string | null }) => {
    if (readOnly) {
      return goal ? (
        <div className="border-t border-gray-100 px-3 py-1.5 text-xs text-gray-500">🎯 {goal}</div>
      ) : null;
    }
    return (
      <div className="border-t border-gray-100 px-3 py-1">
        <input
          defaultValue={goal ?? ""}
          placeholder="🎯 Add a sprint goal…"
          onBlur={(e) => {
            if (e.target.value !== (goal ?? "")) {
              const fd = new FormData();
              fd.set("slug", slug);
              fd.set("sprintId", sprintId);
              fd.set("goal", e.target.value);
              start(async () => {
                await updateSprint(fd);
                router.refresh();
              });
            }
          }}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-gray-600 hover:border-gray-200 focus:border-gray-300 focus:outline-none"
        />
      </div>
    );
  };

  return (
    <div className="px-4 py-4">
      {sprints.map((s) => (
        <Section
          key={s.id}
          keyId={s.id}
          sprintId={s.id}
          title={
            <span>
              {s.name}{" "}
              {s.state === "active" && (
                <span className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700">
                  ACTIVE
                </span>
              )}
            </span>
          }
          subtitle={
            s.startDate && s.endDate ? (
              <span className="text-xs text-gray-400">
                {s.startDate.slice(0, 10)} → {s.endDate.slice(0, 10)}
              </span>
            ) : undefined
          }
          headerExtra={<SprintGoal sprintId={s.id} goal={s.goal} />}
          items={s.items}
          actions={
            readOnly ? null : (
              <>
                {s.state === "future" && (
                  <button
                    onClick={() => start(async () => { await startSprint(slug, s.id); router.refresh(); })}
                    className="rounded bg-gray-800 px-2 py-1 text-xs text-white"
                  >
                    Start sprint
                  </button>
                )}
                {s.state === "active" && (
                  <button
                    onClick={() => {
                      if (!confirm("Complete sprint? Incomplete issues move to the backlog.")) return;
                      start(async () => { await completeSprint(slug, s.id, null); router.refresh(); });
                    }}
                    className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-black/5"
                  >
                    Complete sprint
                  </button>
                )}
                <button
                  onClick={() => {
                    if (!confirm("Delete sprint? Its issues return to the backlog.")) return;
                    start(async () => { await deleteSprint(slug, s.id); router.refresh(); });
                  }}
                  className="text-xs text-gray-400 hover:text-red-600"
                >
                  ✕
                </button>
              </>
            )
          }
        />
      ))}

      {!readOnly && (
        <button
          onClick={() => start(async () => { await createSprint(slug, projectId); router.refresh(); })}
          className="mb-4 rounded border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-500 hover:bg-black/5"
        >
          + Create sprint
        </button>
      )}

      <Section keyId="backlog" sprintId={null} title="Backlog" items={backlog} />
    </div>
  );
}
