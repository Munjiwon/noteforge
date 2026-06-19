"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { priorityMeta } from "@/lib/work";
import { transitionIssue } from "@/app/w/[slug]/work/work-issue-actions";

export type BoardCard = {
  id: string;
  number: number;
  summary: string;
  typeIcon: string | null;
  priority: string;
  statusId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeColor: string | null;
  storyPoints: number | null;
  epicId: string | null;
  epicLabel: string | null;
};

type Column = { id: string; name: string; statusIds: string[]; wipLimit: number | null };

export function BoardView({
  slug,
  projectKey,
  columns,
  cards,
  swimlaneOptions,
  readOnly,
}: {
  slug: string;
  projectKey: string;
  columns: Column[];
  cards: BoardCard[];
  swimlaneOptions: { epics: { id: string; label: string }[]; members: { id: string; name: string }[] };
  readOnly: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [swimlane, setSwimlane] = useState<"none" | "assignee" | "epic">("none");

  const statusToCol = new Map<string, string>();
  for (const c of columns) for (const sid of c.statusIds) statusToCol.set(sid, c.id);

  const drop = (colId: string) => {
    setOverCol(null);
    const id = dragId;
    setDragId(null);
    if (!id || readOnly) return;
    const col = columns.find((c) => c.id === colId);
    const target = col?.statusIds[0];
    const card = cards.find((c) => c.id === id);
    if (!target || !card || card.statusId === target) return;
    start(async () => {
      await transitionIssue(slug, id, target);
      router.refresh();
    });
  };

  // Build swimlane rows.
  const lanes: { key: string; label: string; cards: BoardCard[] }[] = [];
  if (swimlane === "none") {
    lanes.push({ key: "all", label: "", cards });
  } else if (swimlane === "assignee") {
    const groups = new Map<string, BoardCard[]>();
    for (const c of cards) {
      const k = c.assigneeId ?? "__none";
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
    }
    const seen = new Set<string>();
    for (const m of swimlaneOptions.members) {
      if (groups.has(m.id)) {
        lanes.push({ key: m.id, label: m.name, cards: groups.get(m.id)! });
        seen.add(m.id);
      }
    }
    if (groups.has("__none")) lanes.push({ key: "__none", label: "Unassigned", cards: groups.get("__none")! });
    // Don't drop cards whose assignee isn't in the options list (e.g. a former
    // member): collect them into an "Other" lane.
    const leftover = [...groups.entries()].filter(([k]) => k !== "__none" && !seen.has(k)).flatMap(([, v]) => v);
    if (leftover.length) lanes.push({ key: "__other", label: "Other", cards: leftover });
  } else {
    const groups = new Map<string, BoardCard[]>();
    for (const c of cards) {
      const k = c.epicId ?? "__none";
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
    }
    const seen = new Set<string>();
    for (const e of swimlaneOptions.epics) {
      if (groups.has(e.id)) {
        lanes.push({ key: e.id, label: e.label, cards: groups.get(e.id)! });
        seen.add(e.id);
      }
    }
    if (groups.has("__none")) lanes.push({ key: "__none", label: "No epic", cards: groups.get("__none")! });
    const leftover = [...groups.entries()].filter(([k]) => k !== "__none" && !seen.has(k)).flatMap(([, v]) => v);
    if (leftover.length) lanes.push({ key: "__other", label: "Other", cards: leftover });
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-gray-500">Group by</span>
        <select
          value={swimlane}
          onChange={(e) => setSwimlane(e.target.value as typeof swimlane)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="none">None</option>
          <option value="assignee">Assignee</option>
          <option value="epic">Epic</option>
        </select>
      </div>

      <div className="space-y-4">
        {lanes.map((lane) => (
          <div key={lane.key}>
            {lane.label && (
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {lane.label}
              </div>
            )}
            <div className="flex gap-3 overflow-x-auto pb-2">
              {columns.map((col) => {
                const colCards = lane.cards.filter((c) => statusToCol.get(c.statusId) === col.id);
                const overLimit = col.wipLimit != null && colCards.length > col.wipLimit;
                return (
                  <div
                    key={col.id}
                    onDragOver={(e) => {
                      if (readOnly) return;
                      e.preventDefault();
                      setOverCol(col.id);
                    }}
                    onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
                    onDrop={() => drop(col.id)}
                    className={`flex w-72 shrink-0 flex-col rounded-lg bg-gray-50 ${
                      overCol === col.id ? "ring-2 ring-[rgb(var(--accent,99_102_241))]" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-600">
                      <span>{col.name}</span>
                      <span className={overLimit ? "text-red-600" : "text-gray-400"}>
                        {colCards.length}
                        {col.wipLimit != null ? ` / ${col.wipLimit}` : ""}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2 px-2 pb-2">
                      {colCards.map((c) => (
                        <a
                          key={c.id}
                          href={`/w/${slug}/work/${projectKey}/issue/${c.number}`}
                          draggable={!readOnly}
                          onDragStart={() => setDragId(c.id)}
                          onDragEnd={() => setDragId(null)}
                          className={`block cursor-pointer rounded border border-gray-200 bg-white p-2 shadow-sm hover:border-gray-300 ${
                            dragId === c.id ? "opacity-40" : ""
                          }`}
                        >
                          <div className="mb-1 text-sm">{c.summary || "Untitled"}</div>
                          {c.epicLabel && (
                            <div className="mb-1 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">
                              {c.epicLabel}
                            </div>
                          )}
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            <span>{c.typeIcon}</span>
                            <span className="font-mono">{projectKey}-{c.number}</span>
                            <span style={{ color: priorityMeta(c.priority).color }}>
                              {priorityMeta(c.priority).icon}
                            </span>
                            {c.storyPoints != null && (
                              <span className="rounded-full bg-gray-100 px-1.5">{c.storyPoints}</span>
                            )}
                            {c.assigneeName && (
                              <span
                                className="ml-auto flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-white"
                                style={{ background: c.assigneeColor ?? "#888" }}
                                title={c.assigneeName}
                              >
                                {c.assigneeName.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                          </div>
                        </a>
                      ))}
                      {colCards.length === 0 && (
                        <div className="px-1 py-4 text-center text-xs text-gray-300">Drop here</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
