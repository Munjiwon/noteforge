"use client";

import { useState, useTransition, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { evalFormula } from "@/lib/formula";
import {
  addColumn,
  addRow,
  addRowBefore,
  addSelectOption,
  bulkDeleteRows,
  bulkSetCheckboxColumn,
  changeColumnType,
  configureFormula,
  configureRelation,
  configureRollup,
  deleteColumn,
  deleteRow,
  recreateRow,
  renameColumn,
  setColumnDescription,
  setColumnOrder,
  setColumnWidth,
  setDateFormat,
  setNumberFormat,
  setSelectOptionColor,
  setSort,
  updateCell,
} from "@/app/w/[slug]/database-actions";
import { effectiveSort, effectiveTableGroupBy, SELECT_COLORS } from "@/lib/database";
import { duplicatePage, moveRowToEdge, reorderPage } from "@/app/w/[slug]/actions";
import type { DbProp, DbPropType, DbSchema } from "@/lib/database";
import {
  STATUS_GROUP_LABEL,
  formatDate,
  formatDuration,
  formatNumber,
  orderedVisibleProps,
  parseDuration,
  type StatusGroup,
} from "@/lib/database";

type Row = {
  id: string;
  parentId: string;
  title: string;
  icon?: string | null;
  dataValues: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  author?: { id: string; name: string; color: string } | null;
};

const TYPE_LABELS: Record<DbPropType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  multi_select: "Multi-select",
  status: "Status",
  date: "Date",
  checkbox: "Checkbox",
  url: "URL",
  email: "Email",
  phone: "Phone",
  person: "Person",
  files: "Files",
  relation: "Relation",
  rollup: "Rollup",
  formula: "Formula",
  created_at: "Created at",
  updated_at: "Updated at",
  created_by: "Created by",
  duration: "Duration",
};
const TYPE_ICONS: Record<DbPropType, string> = {
  text: "A",
  number: "#",
  select: "▼",
  multi_select: "≣",
  status: "◉",
  date: "📅",
  checkbox: "☑",
  url: "🔗",
  email: "✉",
  phone: "☎",
  person: "👤",
  files: "📎",
  relation: "↔",
  rollup: "Σ",
  formula: "ƒ",
  created_at: "🕐",
  updated_at: "🕑",
  created_by: "👤",
  duration: "⏱",
};
function columnStat(prop: DbProp, rows: Row[]): string {
  const total = rows.length;
  const values = rows.map((r) =>
    prop.id === "p_title" ? r.title : r.dataValues[prop.id],
  );
  const nonEmpty = values.filter(
    (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
  );
  if (prop.type === "number") {
    const nums = nonEmpty.map(Number).filter((n) => !Number.isNaN(n));
    if (nums.length === 0) return `${total} rows`;
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    return `Σ ${sum.toLocaleString()} · avg ${avg.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
  }
  if (prop.type === "checkbox") {
    const checked = values.filter((v) => v === true).length;
    return `☑ ${checked}/${total}`;
  }
  if (prop.type === "select" || prop.type === "status") {
    const distinct = new Set(values.filter((v) => v !== null && v !== undefined && v !== "")).size;
    return `${distinct} value${distinct === 1 ? "" : "s"}`;
  }
  return `${nonEmpty.length}/${total}`;
}

const TYPE_GROUP: Record<DbPropType, "Basic" | "Advanced" | "Computed"> = {
  text: "Basic",
  number: "Basic",
  select: "Basic",
  multi_select: "Basic",
  status: "Basic",
  date: "Basic",
  checkbox: "Basic",
  url: "Advanced",
  email: "Advanced",
  phone: "Advanced",
  person: "Advanced",
  files: "Advanced",
  relation: "Computed",
  rollup: "Computed",
  formula: "Computed",
  created_at: "Computed",
  updated_at: "Computed",
  created_by: "Computed",
  duration: "Basic",
};

export function DatabaseView({
  slug,
  dbId,
  schema,
  rows,
  readOnly,
}: {
  slug: string;
  dbId: string;
  schema: DbSchema;
  rows: Row[];
  readOnly: boolean;
}) {
  const [, start] = useTransition();
  const [addingType, setAddingType] = useState<DbPropType | null>(null);
  const [openMenuPropId, setOpenMenuPropId] = useState<string | null>(null);
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const collapseKey = `noteforge:db-collapsed:${dbId}`;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = localStorage.getItem(collapseKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(collapseKey, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  const treeCollapseKey = `noteforge:db-tree-collapsed:${dbId}`;
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = localStorage.getItem(treeCollapseKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const toggleTree = (id: string) =>
    setTreeCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(treeCollapseKey, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });

  const [lastDeleted, setLastDeleted] = useState<
    { title: string; dataValues: Record<string, unknown> } | null
  >(null);
  useEffect(() => {
    if (!lastDeleted) return;
    const t = setTimeout(() => setLastDeleted(null), 5000);
    return () => clearTimeout(t);
  }, [lastDeleted]);

  // When the table is grouped by a relation, fetch the target rows so group
  // headers can show the related entity's title (e.g. group tasks by Sprint).
  const tableGroupProp = (() => {
    const gid = effectiveTableGroupBy(schema);
    return gid ? schema.props.find((p) => p.id === gid) ?? null : null;
  })();
  const groupRelTargetDbId =
    tableGroupProp?.type === "relation" ? tableGroupProp.targetDbId : null;
  const [relGroupTitles, setRelGroupTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!groupRelTargetDbId) {
      setRelGroupTitles({});
      return;
    }
    let cancelled = false;
    fetch(`/api/db/${encodeURIComponent(groupRelTargetDbId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const m: Record<string, string> = {};
        for (const r of d.rows as { id: string; title: string }[]) m[r.id] = r.title;
        setRelGroupTitles(m);
      });
    return () => {
      cancelled = true;
    };
  }, [groupRelTargetDbId]);
  const toggleRowSelected = (id: string) =>
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onDropOnRow = (targetIdx: number) => {
    if (!dragRowId) return;
    const draggedIdx = rows.findIndex((r) => r.id === dragRowId);
    if (draggedIdx === -1 || draggedIdx === targetIdx) return;
    // simple position: targetIdx+1 (1-based positions in DB)
    const newPos =
      draggedIdx < targetIdx ? targetIdx + 1.5 : targetIdx + 0.5;
    start(() => reorderPage(slug, dragRowId, dbId, newPos));
    setDragRowId(null);
    setDragOverRowId(null);
  };

  const callAddColumn = (type: DbPropType) =>
    start(() => addColumn(slug, dbId, type));

  const visibleProps = orderedVisibleProps(schema);

  return (
    <div className="w-full">
      {lastDeleted && !readOnly && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-xs rounded-lg shadow-lg px-3 py-2 flex items-center gap-2">
          <span>Row deleted — "{lastDeleted.title || "Untitled"}"</span>
          <button
            onClick={() => {
              const d = lastDeleted;
              setLastDeleted(null);
              start(async () => {
                await recreateRow(slug, dbId, d.title, d.dataValues);
              });
            }}
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30"
          >
            Undo
          </button>
        </div>
      )}
      {selectedRows.size > 0 && !readOnly && (
        <div className="mb-2 flex items-center gap-2 text-xs bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
          <span className="text-blue-700">{selectedRows.size} selected</span>
          <button
            onClick={() => {
              if (!confirm(`Delete ${selectedRows.size} row(s)?`)) return;
              const ids = Array.from(selectedRows);
              start(async () => {
                await bulkDeleteRows(slug, dbId, ids);
                setSelectedRows(new Set());
              });
            }}
            className="px-1.5 py-0.5 rounded bg-white border border-gray-200 hover:bg-red-50 text-red-600"
          >
            🗑 Delete
          </button>
          <button
            onClick={() => setSelectedRows(new Set())}
            className="ml-auto text-gray-500 hover:text-gray-900"
          >
            Clear
          </button>
        </div>
      )}
      <div className="overflow-x-auto border border-gray-200 rounded-md">
        <table className="border-collapse w-max min-w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {visibleProps.map((p) => {
                const draggable = !readOnly && p.id !== "p_title";
                const isDragOver = dragOverColId === p.id && dragColId !== p.id;
                return (
                  <th
                    key={p.id}
                    draggable={draggable}
                    onDragStart={
                      draggable
                        ? (e) => {
                            setDragColId(p.id);
                            e.dataTransfer.effectAllowed = "move";
                          }
                        : undefined
                    }
                    onDragOver={
                      draggable
                        ? (e) => {
                            if (!dragColId || dragColId === p.id) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (dragOverColId !== p.id) setDragOverColId(p.id);
                          }
                        : undefined
                    }
                    onDragLeave={
                      draggable
                        ? () => {
                            if (dragOverColId === p.id) setDragOverColId(null);
                          }
                        : undefined
                    }
                    onDrop={
                      draggable
                        ? (e) => {
                            e.preventDefault();
                            if (!dragColId || dragColId === p.id) return;
                            const ids = visibleProps.map((vp) => vp.id);
                            const from = ids.indexOf(dragColId);
                            const to = ids.indexOf(p.id);
                            if (from < 0 || to < 0) return;
                            const next = ids.slice();
                            const [moved] = next.splice(from, 1);
                            next.splice(to, 0, moved);
                            // Preserve any non-visible props in original positions at the end.
                            const allIds = schema.props.map((sp) => sp.id);
                            const hidden = allIds.filter((id) => !next.includes(id));
                            start(() => setColumnOrder(slug, dbId, [...next, ...hidden]));
                            setDragColId(null);
                            setDragOverColId(null);
                          }
                        : undefined
                    }
                    onDragEnd={() => {
                      setDragColId(null);
                      setDragOverColId(null);
                    }}
                    className={
                      "text-left text-xs font-medium text-gray-600 border-r border-gray-200 last:border-r-0 align-top relative " +
                      (isDragOver ? "outline outline-2 outline-blue-400 -outline-offset-2" : "")
                    }
                    style={{
                      width: schema.columnWidths?.[p.id] ?? undefined,
                      minWidth: schema.columnWidths?.[p.id] ?? 160,
                      cursor: draggable ? "grab" : undefined,
                      opacity: dragColId === p.id ? 0.4 : undefined,
                    }}
                  >
                    <ColumnHeader
                      prop={p}
                      slug={slug}
                      dbId={dbId}
                      schema={schema}
                      open={openMenuPropId === p.id}
                      onOpen={(v) => setOpenMenuPropId(v ? p.id : null)}
                      readOnly={readOnly}
                    />
                    {!readOnly && (
                      <ColumnResizer
                        slug={slug}
                        dbId={dbId}
                        propId={p.id}
                        initialWidth={schema.columnWidths?.[p.id] ?? 160}
                      />
                    )}
                  </th>
                );
              })}
              {!readOnly && (
                <th className="border-r-0 bg-gray-50 align-top" style={{ minWidth: 100 }}>
                  <div className="relative">
                    <button
                      className="text-xs text-gray-600 hover:text-gray-900 px-3 py-2 w-full text-left"
                      onClick={() => setAddingType("text")}
                    >
                      + Add column
                    </button>
                    {addingType && (
                      <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-1 min-w-[180px] max-h-80 overflow-y-auto">
                        {(["Basic", "Advanced", "Computed"] as const).map((group) => {
                          const types = (Object.keys(TYPE_LABELS) as DbPropType[]).filter(
                            (t) => TYPE_GROUP[t] === group,
                          );
                          if (types.length === 0) return null;
                          return (
                            <div key={group} className="mb-1 last:mb-0">
                              <div className="text-[10px] uppercase text-gray-500 px-2 py-0.5">
                                {group}
                              </div>
                              {types.map((t) => (
                                <button
                                  key={t}
                                  className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                                  onClick={() => {
                                    callAddColumn(t);
                                    setAddingType(null);
                                  }}
                                >
                                  <span className="inline-block w-5 text-gray-500">
                                    {TYPE_ICONS[t]}
                                  </span>
                                  {TYPE_LABELS[t]}
                                </button>
                              ))}
                            </div>
                          );
                        })}
                        <button
                          className="block w-full text-left px-2 py-1 text-xs text-gray-500 hover:bg-black/5 rounded border-t mt-1 pt-1"
                          onClick={() => setAddingType(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const groupId = effectiveTableGroupBy(schema);
              const groupBy = groupId
                ? schema.props.find((p) => p.id === groupId)
                : null;
              const rowProps = (row: Row, idx: number) => ({
                key: row.id,
                row,
                schema,
                slug,
                readOnly,
                draggable: !readOnly,
                isDragging: dragRowId === row.id,
                isDropOver: dragOverRowId === row.id,
                isSelected: selectedRows.has(row.id),
                onToggleSelected: () => toggleRowSelected(row.id),
                onBeforeDelete: (r: Row) =>
                  setLastDeleted({ title: r.title, dataValues: r.dataValues }),
                onDragStart: () => setDragRowId(row.id),
                onDragOver: () => setDragOverRowId(row.id),
                onDragEnd: () => {
                  setDragRowId(null);
                  setDragOverRowId(null);
                },
                onDrop: () => onDropOnRow(idx),
              });
              if (!groupBy) {
                // Ungrouped. If a tree parent relation is configured, render the
                // rows as an indented sub-task tree (sub-items).
                const parentProp = schema.treeParentProp;
                if (parentProp && schema.props.some((p) => p.id === parentProp)) {
                  const byId = new Map(rows.map((r) => [r.id, r]));
                  const childrenOf = new Map<string, Row[]>();
                  const roots: Row[] = [];
                  for (const row of rows) {
                    const pv = row.dataValues[parentProp];
                    const pid = Array.isArray(pv) && pv.length ? (pv[0] as string) : null;
                    if (pid && pid !== row.id && byId.has(pid)) {
                      const arr = childrenOf.get(pid) ?? [];
                      arr.push(row);
                      childrenOf.set(pid, arr);
                    } else {
                      roots.push(row);
                    }
                  }
                  const out: React.ReactNode[] = [];
                  const seen = new Set<string>();
                  const walk = (r: Row, depth: number) => {
                    if (seen.has(r.id)) return; // guard against relation cycles
                    seen.add(r.id);
                    const kids = childrenOf.get(r.id) ?? [];
                    out.push(
                      <RowRow
                        {...rowProps(r, rows.indexOf(r))}
                        depth={depth}
                        hasChildren={kids.length > 0}
                        collapsed={treeCollapsed.has(r.id)}
                        onToggleCollapse={() => toggleTree(r.id)}
                      />,
                    );
                    if (treeCollapsed.has(r.id)) return;
                    for (const k of kids) walk(k, depth + 1);
                  };
                  for (const r of roots) walk(r, 0);
                  return out;
                }
                return rows.map((row, idx) => (
                  <RowRow {...rowProps(row, idx)} />
                ));
              }
              if (
                groupBy.type !== "select" &&
                groupBy.type !== "status" &&
                groupBy.type !== "date" &&
                groupBy.type !== "relation"
              ) {
                return rows.map((row, idx) => (
                  <RowRow {...rowProps(row, idx)} />
                ));
              }
              type Bucket = { key: string; label: string; color: string; list: Row[] };
              const buckets: Bucket[] = [];
              const bucketIndex = new Map<string, number>();
              const addToBucket = (key: string, label: string, color: string, row: Row) => {
                let idx = bucketIndex.get(key);
                if (idx === undefined) {
                  idx = buckets.length;
                  bucketIndex.set(key, idx);
                  buckets.push({ key, label, color, list: [] });
                }
                buckets[idx].list.push(row);
              };
              if (groupBy.type === "date") {
                const now = new Date();
                const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const dayMs = 86400000;
                for (const row of rows) {
                  const v = row.dataValues[groupBy.id];
                  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) {
                    addToBucket("__none__", "No " + groupBy.name, "#f3f4f6", row);
                    continue;
                  }
                  const d = new Date(v.slice(0, 10) + "T00:00:00");
                  const diffDays = Math.round((today.getTime() - d.getTime()) / dayMs);
                  if (diffDays >= -7 && diffDays <= 0) {
                    addToBucket("__upcoming7__", "다음 7일 이내", "#dbeafe", row);
                  } else if (diffDays > 0 && diffDays <= 7) {
                    addToBucket("__past7__", "지난 7일", "#dcfce7", row);
                  } else if (diffDays > 7 && diffDays <= 30) {
                    addToBucket("__past30__", "지난 30일", "#fef9c3", row);
                  } else {
                    const y = d.getFullYear();
                    const m = d.getMonth() + 1;
                    addToBucket(`__ym__${y}-${String(m).padStart(2, "0")}`, `${y}년 ${m}월`, "#f3f4f6", row);
                  }
                }
                // Order: upcoming → past7 → past30 → year-month (newest first) → none
                const orderKey = (b: Bucket) => {
                  if (b.key === "__upcoming7__") return [0, 0];
                  if (b.key === "__past7__") return [1, 0];
                  if (b.key === "__past30__") return [2, 0];
                  if (b.key.startsWith("__ym__")) {
                    return [3, -Date.parse(b.key.slice(6) + "-01")];
                  }
                  return [4, 0];
                };
                buckets.sort((a, b) => {
                  const [oa, sa] = orderKey(a);
                  const [ob, sb] = orderKey(b);
                  return oa - ob || sa - sb;
                });
              } else if (groupBy.type === "relation") {
                // One bucket per related entity; a row appears under each entity
                // it links to. Labels come from the fetched target titles.
                for (const row of rows) {
                  const v = row.dataValues[groupBy.id];
                  const idsArr = Array.isArray(v) ? (v as string[]) : [];
                  if (idsArr.length === 0) {
                    addToBucket("__none__", "No " + groupBy.name, "#f3f4f6", row);
                    continue;
                  }
                  for (const rid of idsArr) {
                    addToBucket(rid, relGroupTitles[rid] ?? "…", "#eef2ff", row);
                  }
                }
                // Stable order: named buckets alphabetically, "No X" last.
                buckets.sort((a, b) => {
                  if (a.key === "__none__") return 1;
                  if (b.key === "__none__") return -1;
                  return a.label.localeCompare(b.label);
                });
              } else {
                for (const opt of groupBy.options) buckets.push({ key: opt.id, label: opt.name, color: opt.color, list: [] });
                buckets.push({ key: "__none__", label: "No " + groupBy.name, color: "#f3f4f6", list: [] });
                for (let i = 0; i < buckets.length; i++) bucketIndex.set(buckets[i].key, i);
                for (const row of rows) {
                  const v = row.dataValues[groupBy.id];
                  const key = typeof v === "string" && bucketIndex.has(v) ? v : "__none__";
                  addToBucket(key, buckets[bucketIndex.get(key)!].label, buckets[bucketIndex.get(key)!].color, row);
                }
              }
              const out: React.ReactNode[] = [];
              const seedForBucket = (b: { key: string }): Record<string, unknown> => {
                if (!groupBy) return {};
                if (b.key === "__none__") return {};
                if (groupBy.type === "select" || groupBy.type === "status") {
                  return { [groupBy.id]: b.key };
                }
                if (groupBy.type === "relation") {
                  return { [groupBy.id]: [b.key] };
                }
                if (groupBy.type === "date") {
                  const today = new Date();
                  const ymd = (d: Date) =>
                    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                  if (b.key === "__upcoming7__") {
                    const d = new Date(today);
                    d.setDate(d.getDate() + 1);
                    return { [groupBy.id]: ymd(d) };
                  }
                  if (b.key === "__past7__") return { [groupBy.id]: ymd(today) };
                  if (b.key === "__past30__") {
                    const d = new Date(today);
                    d.setDate(d.getDate() - 14);
                    return { [groupBy.id]: ymd(d) };
                  }
                  if (b.key.startsWith("__ym__")) {
                    const ym = b.key.slice(6); // "YYYY-MM"
                    return { [groupBy.id]: `${ym}-15` };
                  }
                }
                return {};
              };
              for (const b of buckets) {
                if (b.list.length === 0) continue;
                const collapsed = collapsedGroups.has(b.key);
                out.push(
                  <tr key={`g-${b.key}`} className="bg-gray-50">
                    <td
                      colSpan={visibleProps.length + (readOnly ? 0 : 1)}
                      className="px-3 py-1 text-xs select-none"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(b.key)}
                        className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-900"
                        title={collapsed ? "Expand group" : "Collapse group"}
                      >
                        <span className="w-3 text-[10px]">{collapsed ? "▶" : "▼"}</span>
                        <span
                          className="inline-block px-2 py-0.5 rounded"
                          style={{ background: b.color }}
                        >
                          {b.label}
                        </span>
                        <span className="text-gray-400">{b.list.length}</span>
                      </button>
                    </td>
                  </tr>,
                );
                if (collapsed) continue;
                for (const row of b.list) {
                  const idx = rows.indexOf(row);
                  out.push(<RowRow {...rowProps(row, idx)} />);
                }
                if (!readOnly) {
                  const seed = seedForBucket(b);
                  out.push(
                    <tr key={`g-add-${b.key}`}>
                      <td
                        colSpan={visibleProps.length + 1}
                        className="px-3 py-1 text-xs"
                      >
                        <button
                          onClick={() => start(async () => { await addRow(slug, dbId, seed); })}
                          className="text-gray-400 hover:text-gray-900"
                        >
                          + 새 항목
                        </button>
                      </td>
                    </tr>,
                  );
                }
              }
              return out;
            })()}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={visibleProps.length + (readOnly ? 0 : 1)}
                  className="text-center text-sm text-gray-400 py-8"
                >
                  {readOnly ? (
                    "No rows yet"
                  ) : (
                    <button
                      onClick={() => start(async () => { await addRow(slug, dbId); })}
                      className="text-blue-600 hover:underline"
                    >
                      + Add your first row
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="bg-gray-50/70 border-t border-gray-200 text-[11px] text-gray-500">
                {visibleProps.map((p) => (
                  <td
                    key={p.id}
                    className="px-3 py-1 border-r border-gray-100 text-right"
                  >
                    {columnStat(p, rows)}
                  </td>
                ))}
                {!readOnly && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {!readOnly && (
        <button
          onClick={() => start(async () => { await addRow(slug, dbId); })}
          className="mt-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-black/5 rounded px-2 py-1"
        >
          + New row
        </button>
      )}
      <div className="mt-2 text-xs text-gray-400">
        {rows.length} row{rows.length === 1 ? "" : "s"} · {schema.props.length} column{schema.props.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function ColumnHeader({
  prop,
  slug,
  dbId,
  schema,
  open,
  onOpen,
  readOnly,
}: {
  prop: DbProp;
  slug: string;
  dbId: string;
  schema: DbSchema;
  open: boolean;
  onOpen: (open: boolean) => void;
  readOnly: boolean;
}) {
  const [name, setName] = useState(prop.name);
  const [configuring, setConfiguring] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState(prop.description ?? "");
  const [, start] = useTransition();
  useEffect(() => setName(prop.name), [prop.name]);
  useEffect(() => setDesc(prop.description ?? ""), [prop.description]);

  return (
    <div className="relative px-3 py-2 flex items-center gap-1">
      <span
        className="text-gray-400 w-4"
        title={prop.description || undefined}
      >
        {TYPE_ICONS[prop.type]}
      </span>
      <input
        className="bg-transparent outline-none flex-1 text-sm font-medium"
        value={name}
        disabled={readOnly}
        title={prop.description || undefined}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name !== prop.name) {
            start(() => renameColumn(slug, dbId, prop.id, name));
          }
        }}
      />
      {!readOnly && prop.type === "checkbox" && prop.id !== "p_title" && (
        <button
          className="text-gray-400 hover:text-gray-900 px-1 text-[11px]"
          title="Toggle all rows in this column"
          onClick={() => {
            const setAll = confirm("Check all rows? (Cancel = uncheck all)");
            start(() => bulkSetCheckboxColumn(slug, dbId, prop.id, setAll));
          }}
        >
          ☑/☐
        </button>
      )}
      {!readOnly && prop.id !== "p_title" && (
        <button
          className="text-gray-400 hover:text-gray-900 px-1"
          onClick={() => onOpen(!open)}
          aria-label="column menu"
        >
          ⋯
        </button>
      )}
      {open && (
        <div className="absolute top-full right-0 z-30 bg-white shadow-lg border rounded p-1 min-w-[160px]">
          {(prop.type === "relation" ||
            prop.type === "rollup" ||
            prop.type === "formula" ||
            prop.type === "number" ||
            prop.type === "date") && (
            <button
              className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
              onClick={() => {
                setConfiguring(true);
                onOpen(false);
              }}
            >
              ⚙ Configure
            </button>
          )}
          <button
            className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
            onClick={() => {
              setEditingDesc(true);
              onOpen(false);
            }}
          >
            ✎ Edit description
          </button>
          {prop.id !== "p_title" && (
            <>
              <button
                className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                onClick={() => {
                  const next = effectiveSort(schema).filter((s) => s.propId !== prop.id);
                  next.unshift({ propId: prop.id, dir: "asc" });
                  start(() => setSort(slug, dbId, next));
                  onOpen(false);
                }}
              >
                ↑ Sort ascending
              </button>
              <button
                className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                onClick={() => {
                  const next = effectiveSort(schema).filter((s) => s.propId !== prop.id);
                  next.unshift({ propId: prop.id, dir: "desc" });
                  start(() => setSort(slug, dbId, next));
                  onOpen(false);
                }}
              >
                ↓ Sort descending
              </button>
            </>
          )}
          {(() => {
            const textFamily: DbPropType[] = ["text", "url", "email", "phone"];
            let options: DbPropType[] = [];
            if (textFamily.includes(prop.type)) options = [...textFamily, "number"];
            else if (prop.type === "number") options = ["number", ...textFamily];
            else if (prop.type === "select") options = ["select", "multi_select"];
            else if (prop.type === "multi_select") options = ["multi_select", "select"];
            if (options.length === 0) return null;
            return (
              <div className="px-2 py-1 text-xs text-gray-500">
                Change type:
                <div className="flex flex-wrap gap-1 mt-1">
                  {options.map((t) =>
                    t === prop.type ? null : (
                      <button
                        key={t}
                        onClick={() => {
                          start(() => changeColumnType(slug, dbId, prop.id, t));
                          onOpen(false);
                        }}
                        className="text-[10px] px-1 py-0.5 rounded border border-gray-200 hover:bg-black/5"
                      >
                        {t.replace("_", " ")}
                      </button>
                    ),
                  )}
                </div>
              </div>
            );
          })()}
          <button
            className="block w-full text-left px-2 py-1 text-sm text-red-600 hover:bg-red-50 rounded"
            onClick={() => {
              if (confirm(`Delete column "${prop.name}"?`)) {
                start(() => deleteColumn(slug, dbId, prop.id));
              }
              onOpen(false);
            }}
          >
            Delete column
          </button>
        </div>
      )}
      {configuring && (
        <ColumnConfigure
          prop={prop}
          slug={slug}
          dbId={dbId}
          schema={schema}
          onClose={() => setConfiguring(false)}
        />
      )}
      {editingDesc && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditingDesc(false);
          }}
        >
          <div className="bg-white rounded-lg shadow-2xl w-[360px] max-w-[92vw] p-4">
            <h3 className="text-sm font-medium mb-2">
              Description for “{prop.name}”
            </h3>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="What is this column for?"
              className="w-full border border-gray-200 rounded px-2 py-1 text-sm outline-none min-h-[60px] mb-2"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setDesc(prop.description ?? "");
                  setEditingDesc(false);
                }}
                className="text-xs text-gray-500 hover:text-gray-900 px-2 py-1"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setEditingDesc(false);
                  start(async () => {
                    await setColumnDescription(slug, dbId, prop.id, desc);
                  });
                }}
                className="text-xs px-2 py-1 rounded bg-gray-900 text-white"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RowRow({
  row,
  schema,
  slug,
  readOnly,
  draggable,
  isDragging,
  isDropOver,
  isSelected,
  onToggleSelected,
  onBeforeDelete,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  row: Row;
  schema: DbSchema;
  slug: string;
  readOnly: boolean;
  draggable?: boolean;
  isDragging?: boolean;
  isDropOver?: boolean;
  isSelected?: boolean;
  onToggleSelected?: () => void;
  onBeforeDelete?: (row: Row) => void;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [, start] = useTransition();
  const visibleProps = orderedVisibleProps(schema);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
    };
  }, [ctxMenu]);
  return (
    <tr
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragOver={(e) => {
        if (!draggable) return;
        e.preventDefault();
        onDragOver?.();
      }}
      onDragEnd={onDragEnd}
      onDrop={(e) => {
        if (!draggable) return;
        e.preventDefault();
        onDrop?.();
      }}
      onContextMenu={
        readOnly
          ? undefined
          : (e) => {
              const target = e.target as HTMLElement | null;
              if (target && target.closest("input, textarea, select, [contenteditable=true], a, button")) {
                return;
              }
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY });
            }
      }
      className={
        "border-b border-gray-100 hover:bg-gray-50 " +
        (isDragging ? "opacity-40 " : "") +
        (isDropOver ? "bg-blue-50 " : "")
      }
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {visibleProps.map((p, idx) => (
        <td
          key={p.id}
          className="border-r border-gray-100 last:border-r-0 align-top relative"
        >
          <div className="flex items-center">
            {p.id === "p_title" && depth > 0 && (
              <span
                className="shrink-0"
                style={{ width: depth * 16 }}
                aria-hidden
              />
            )}
            {p.id === "p_title" && (onToggleCollapse !== undefined || depth > 0) && (
              <button
                type="button"
                onClick={onToggleCollapse}
                disabled={!hasChildren}
                className={
                  "shrink-0 w-4 text-[10px] " +
                  (hasChildren
                    ? "text-gray-500 hover:text-gray-900"
                    : "text-transparent")
                }
                title={hasChildren ? (collapsed ? "Expand sub-tasks" : "Collapse sub-tasks") : undefined}
              >
                {hasChildren ? (collapsed ? "▶" : "▼") : "·"}
              </button>
            )}
            {p.id === "p_title" && row.icon && (
              <span className="pl-1 pr-1 text-sm leading-none shrink-0">
                {row.icon}
              </span>
            )}
            <div className="flex-1 min-w-0">
              <Cell
                prop={p}
                slug={slug}
                dbId={row.parentId}
                rowId={row.id}
                value={p.id === "p_title" ? row.title : row.dataValues[p.id]}
                readOnly={readOnly}
                row={row}
                schema={schema}
              />
            </div>
            {idx === 0 && !readOnly && onToggleSelected && (
              <input
                type="checkbox"
                checked={!!isSelected}
                onChange={onToggleSelected}
                className={
                  "mr-2 w-3 h-3 shrink-0 transition-opacity " +
                  (hover || isSelected ? "opacity-100" : "opacity-0")
                }
                aria-label="select row"
              />
            )}
            {idx === 0 && slug && (
              <span
                className={
                  "shrink-0 mr-2 flex items-center gap-1 text-[10px] transition-opacity " +
                  (hover ? "opacity-100" : "opacity-0")
                }
              >
                <button
                  className="text-gray-400 hover:text-blue-600"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("db-row-peek", { detail: { pageId: row.id } }),
                    )
                  }
                  title="Peek (read-only preview)"
                >
                  👁 Peek
                </button>
                <a
                  href={`/w/${slug}/p/${row.id}`}
                  className="text-gray-400 hover:text-blue-600"
                  title="Open as page"
                >
                  ↗ Open
                </a>
              </span>
            )}
          </div>
        </td>
      ))}
      {!readOnly && (
        <td className="relative" style={{ minWidth: 100 }}>
          {hover && (
            <>
              <button
                className="text-xs text-gray-400 hover:text-gray-900 px-1"
                title="Move to top"
                onClick={() => start(() => moveRowToEdge(slug, row.id, "top"))}
              >
                ⤒
              </button>
              <button
                className="text-xs text-gray-400 hover:text-gray-900 px-1"
                title="Move to bottom"
                onClick={() => start(() => moveRowToEdge(slug, row.id, "bottom"))}
              >
                ⤓
              </button>
              <button
                className="text-xs text-gray-400 hover:text-gray-900 px-1"
                title="Duplicate row"
                onClick={() =>
                  start(async () => {
                    await duplicatePage(slug, row.id);
                  })
                }
              >
                ⎘
              </button>
              <button
                className="text-xs text-gray-400 hover:text-red-600 px-2"
                onClick={() => {
                  if (!confirm("Delete this row?")) return;
                  onBeforeDelete?.(row);
                  start(() => deleteRow(slug, row.id));
                }}
              >
                ✕
              </button>
            </>
          )}
          {ctxMenu && typeof document !== "undefined" &&
            createPortal(
              <div
                className="fixed z-50 bg-white border border-gray-200 rounded shadow-lg text-xs min-w-[160px] py-1"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setCtxMenu(null);
                    window.location.href = `/w/${slug}/p/${row.id}`;
                  }}
                >
                  ↗ Open as page
                </button>
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setCtxMenu(null);
                    window.dispatchEvent(
                      new CustomEvent("db-row-peek", { detail: { pageId: row.id } }),
                    );
                  }}
                >
                  👁 Open in side peek
                </button>
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setCtxMenu(null);
                    const url = `${window.location.origin}/w/${slug}/p/${row.id}`;
                    void navigator.clipboard?.writeText(url);
                  }}
                >
                  🔗 Copy link
                </button>
                <div className="border-t border-gray-100 my-1" />
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setCtxMenu(null);
                    start(() => moveRowToEdge(slug, row.id, "top"));
                  }}
                >
                  ⤒ Move to top
                </button>
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setCtxMenu(null);
                    start(() => moveRowToEdge(slug, row.id, "bottom"));
                  }}
                >
                  ⤓ Move to bottom
                </button>
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setCtxMenu(null);
                    start(async () => {
                      await duplicatePage(slug, row.id);
                    });
                  }}
                >
                  ⎘ Duplicate
                </button>
                <div className="border-t border-gray-100 my-1" />
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5 text-red-600"
                  onClick={() => {
                    setCtxMenu(null);
                    if (!confirm("Delete this row?")) return;
                    onBeforeDelete?.(row);
                    start(() => deleteRow(slug, row.id));
                  }}
                >
                  🗑 Delete
                </button>
              </div>,
              document.body,
            )}
        </td>
      )}
    </tr>
  );
}

function Cell({
  prop,
  slug,
  dbId,
  rowId,
  value,
  readOnly,
  row,
  schema,
}: {
  prop: DbProp;
  slug: string;
  dbId: string;
  rowId: string;
  value: unknown;
  readOnly: boolean;
  row: Row;
  schema: DbSchema;
}) {
  const [, start] = useTransition();

  if (prop.type === "checkbox") {
    return (
      <div className="px-3 py-2">
        <input
          type="checkbox"
          checked={!!value}
          disabled={readOnly}
          onChange={(e) =>
            start(() => updateCell(slug, rowId, prop.id, e.target.checked))
          }
        />
      </div>
    );
  }

  if (prop.type === "select") {
    return (
      <SelectCell
        prop={prop}
        slug={slug}
        dbId={dbId}
        rowId={rowId}
        value={value as string | undefined}
        readOnly={readOnly}
      />
    );
  }

  if (prop.type === "status") {
    return (
      <StatusCell
        prop={prop}
        slug={slug}
        rowId={rowId}
        value={value as string | undefined}
        readOnly={readOnly}
      />
    );
  }

  if (prop.type === "multi_select") {
    return (
      <MultiSelectCell
        prop={prop}
        slug={slug}
        dbId={dbId}
        rowId={rowId}
        value={Array.isArray(value) ? (value as string[]) : []}
        readOnly={readOnly}
      />
    );
  }

  if (prop.type === "person") {
    return (
      <PersonCell
        slug={slug}
        rowId={rowId}
        propId={prop.id}
        value={typeof value === "string" ? value : null}
        readOnly={readOnly}
      />
    );
  }

  if (prop.type === "files") {
    return (
      <FilesCell
        slug={slug}
        rowId={rowId}
        propId={prop.id}
        value={Array.isArray(value) ? (value as string[]) : []}
        readOnly={readOnly}
      />
    );
  }

  if (prop.type === "relation") {
    return (
      <RelationCell
        slug={slug}
        rowId={rowId}
        prop={prop}
        value={Array.isArray(value) ? (value as string[]) : []}
        readOnly={readOnly}
      />
    );
  }

  if (prop.type === "rollup") {
    return <RollupCell prop={prop} schema={schema} row={row} />;
  }

  if (prop.type === "formula") {
    return <FormulaCell expr={prop.expr} row={row} props={schema.props} />;
  }

  if (prop.type === "created_at" || prop.type === "updated_at") {
    const iso = prop.type === "created_at" ? row.createdAt : row.updatedAt;
    return (
      <div className="px-3 py-2 text-sm text-gray-500" title={iso}>
        {iso ? formatDate(iso, prop.format) : ""}
      </div>
    );
  }

  if (prop.type === "duration") {
    const n = typeof value === "number" ? value : null;
    if (readOnly) {
      return (
        <div className="px-3 py-2 text-sm text-gray-800">
          {n !== null ? formatDuration(n) : ""}
        </div>
      );
    }
    return (
      <input
        type="text"
        defaultValue={n !== null ? formatDuration(n) : ""}
        placeholder="e.g. 1h 30m"
        disabled={readOnly}
        className="px-3 py-2 text-sm bg-transparent outline-none w-full"
        onBlur={(e) => {
          const txt = e.target.value;
          const parsed = parseDuration(txt);
          // No-op if unparseable; reset display to last value
          if (parsed === null && txt.trim() !== "") {
            e.target.value = n !== null ? formatDuration(n) : "";
            return;
          }
          if (parsed !== n) {
            start(() => updateCell(slug, rowId, prop.id, parsed));
          } else {
            e.target.value = n !== null ? formatDuration(n) : "";
          }
        }}
      />
    );
  }

  if (prop.type === "created_by") {
    if (!row.author) {
      return <div className="px-3 py-2 text-sm text-gray-400">—</div>;
    }
    return (
      <div className="px-3 py-2 text-sm text-gray-700 flex items-center gap-2">
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[9px] font-medium"
          style={{ background: row.author.color }}
        >
          {row.author.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate">{row.author.name}</span>
      </div>
    );
  }

  if (prop.type === "date") {
    if (readOnly) {
      return (
        <div className="px-3 py-2 text-sm text-gray-800">
          {typeof value === "string" ? formatDate(value, prop.format) : ""}
        </div>
      );
    }
    return (
      <input
        type="date"
        defaultValue={typeof value === "string" ? value : ""}
        disabled={readOnly}
        title={typeof value === "string" ? formatDate(value, prop.format) : undefined}
        className="px-3 py-2 text-sm bg-transparent outline-none w-full"
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== (value ?? "")) {
            start(() => updateCell(slug, rowId, prop.id, v || null));
          }
        }}
      />
    );
  }

  if (prop.type === "url") {
    const str = typeof value === "string" ? value : "";
    return (
      <div className="relative group/url">
        <input
          type="url"
          defaultValue={str}
          disabled={readOnly}
          placeholder="https://…"
          className="px-3 py-2 text-sm bg-transparent outline-none w-full text-blue-600 underline placeholder-gray-300"
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (value ?? "")) {
              start(() => updateCell(slug, rowId, prop.id, v || null));
            }
          }}
        />
        {str && (
          <a
            href={str}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute right-1 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-blue-600 opacity-0 group-hover/url:opacity-100"
            title="Open"
          >
            ↗
          </a>
        )}
      </div>
    );
  }

  if (prop.type === "email") {
    const str = typeof value === "string" ? value : "";
    return (
      <input
        type="email"
        defaultValue={str}
        disabled={readOnly}
        placeholder="name@example.com"
        className="px-3 py-2 text-sm bg-transparent outline-none w-full"
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== (value ?? "")) {
            start(() => updateCell(slug, rowId, prop.id, v || null));
          }
        }}
      />
    );
  }

  if (prop.type === "phone") {
    const str = typeof value === "string" ? value : "";
    return (
      <input
        type="tel"
        defaultValue={str}
        disabled={readOnly}
        placeholder="+1 555-0100"
        className="px-3 py-2 text-sm bg-transparent outline-none w-full tabular-nums"
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== (value ?? "")) {
            start(() => updateCell(slug, rowId, prop.id, v || null));
          }
        }}
      />
    );
  }

  if (prop.type === "number") {
    if (prop.format === "progress") {
      const n = typeof value === "number" ? value : 0;
      const pct = Math.max(0, Math.min(1, n)) * 100;
      return (
        <div className="px-3 py-2 flex items-center gap-2">
          <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
            <div className="h-full bg-blue-500" style={{ width: pct + "%" }} />
          </div>
          {!readOnly ? (
            <input
              type="number"
              step="0.01"
              defaultValue={n}
              className="w-14 text-xs bg-transparent outline-none text-right tabular-nums"
              onBlur={(e) => {
                const raw = e.target.value;
                const num = raw === "" ? null : Number(raw);
                if (num !== value) start(() => updateCell(slug, rowId, prop.id, num));
              }}
            />
          ) : (
            <span className="text-xs text-gray-500 tabular-nums">{Math.round(pct)}%</span>
          )}
        </div>
      );
    }
    if (prop.format === "rating") {
      const n = typeof value === "number" ? value : 0;
      const stars = Math.max(0, Math.min(5, Math.round(n)));
      return (
        <div className="px-3 py-2 flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              disabled={readOnly}
              onClick={() => {
                if (readOnly) return;
                const next = stars === s ? 0 : s;
                start(() => updateCell(slug, rowId, prop.id, next));
              }}
              className={s <= stars ? "text-yellow-500" : "text-gray-300"}
              title={`${s} of 5`}
            >
              ★
            </button>
          ))}
        </div>
      );
    }
    if (readOnly) {
      return (
        <div className="px-3 py-2 text-sm text-right tabular-nums text-gray-800">
          {typeof value === "number" ? formatNumber(value, prop.format) : ""}
        </div>
      );
    }
    return (
      <input
        type="number"
        defaultValue={value as number | undefined}
        disabled={readOnly}
        title={typeof value === "number" ? formatNumber(value, prop.format) : undefined}
        className="px-3 py-2 text-sm bg-transparent outline-none w-full text-right tabular-nums"
        onBlur={(e) => {
          const raw = e.target.value;
          const num = raw === "" ? null : Number(raw);
          if (num !== value) {
            start(() => updateCell(slug, rowId, prop.id, num));
          }
        }}
      />
    );
  }

  // text (default)
  return (
    <input
      type="text"
      defaultValue={typeof value === "string" ? value : ""}
      disabled={readOnly}
      placeholder={prop.id === "p_title" ? "Untitled" : ""}
      className="px-3 py-2 text-sm bg-transparent outline-none w-full"
      onKeyDown={(e) => {
        if (prop.id === "p_title" && e.shiftKey && e.key === "Enter") {
          e.preventDefault();
          start(async () => {
            await addRowBefore(slug, dbId, rowId);
          });
        }
      }}
      onBlur={(e) => {
        const v = e.target.value;
        const cur = value ?? "";
        if (v !== cur) {
          start(() => updateCell(slug, rowId, prop.id, v));
        }
      }}
    />
  );
}

function SelectCell({
  prop,
  slug,
  dbId,
  rowId,
  value,
  readOnly,
}: {
  prop: DbProp & { type: "select" };
  slug: string;
  dbId: string;
  rowId: string;
  value: string | undefined;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  const current = prop.options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="px-3 py-2 relative" ref={ref}>
      <button
        className="text-sm w-full text-left"
        disabled={readOnly}
        onClick={() => setOpen(!open)}
      >
        {current ? (
          <span
            className="inline-block px-2 py-0.5 rounded text-xs"
            style={{ background: current.color }}
          >
            {current.name}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-2 min-w-[200px]">
          {prop.options.map((o) => (
            <div
              key={o.id}
              className="group/opt flex items-center gap-1 px-2 py-1 hover:bg-black/5 rounded"
            >
              <button
                className="flex-1 text-left"
                onClick={() => {
                  start(() => updateCell(slug, rowId, prop.id, o.id));
                  setOpen(false);
                }}
              >
                <span
                  className="inline-block px-2 py-0.5 rounded text-xs"
                  style={{ background: o.color }}
                >
                  {o.name}
                </span>
              </button>
              <ColorSwatches
                current={o.color}
                onPick={(c) =>
                  start(() =>
                    setSelectOptionColor(slug, dbId, prop.id, o.id, c),
                  )
                }
              />
            </div>
          ))}
          {current && (
            <button
              className="block w-full text-left px-2 py-1 text-xs text-gray-500 hover:bg-black/5 rounded"
              onClick={() => {
                start(() => updateCell(slug, rowId, prop.id, null));
                setOpen(false);
              }}
            >
              Clear
            </button>
          )}
          <div className="border-t mt-1 pt-1">
            <input
              type="text"
              placeholder="New option…"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && adding.trim()) {
                  const name = adding.trim();
                  e.preventDefault();
                  setAdding("");
                  start(async () => {
                    const opt = await addSelectOption(slug, dbId, prop.id, name);
                    if (opt) await updateCell(slug, rowId, prop.id, opt.id);
                  });
                }
              }}
              className="w-full text-sm border rounded px-2 py-1 outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function StatusCell({
  prop,
  slug,
  rowId,
  value,
  readOnly,
}: {
  prop: DbProp & { type: "status" };
  slug: string;
  rowId: string;
  value: string | undefined;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  const current = prop.options.find((o) => o.id === value);
  const groups: StatusGroup[] = ["todo", "in_progress", "complete"];
  return (
    <div className="px-3 py-2 relative" ref={ref}>
      <button
        className="text-sm w-full text-left"
        disabled={readOnly}
        onClick={() => setOpen(!open)}
      >
        {current ? (
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: current.color }}
            />
            <span>{current.name}</span>
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-2 min-w-[220px] max-h-80 overflow-y-auto">
          {groups.map((g) => {
            const opts = prop.options.filter((o) => o.group === g);
            if (opts.length === 0) return null;
            return (
              <div key={g} className="mb-2 last:mb-0">
                <div className="text-[10px] uppercase text-gray-500 px-2 py-0.5">
                  {STATUS_GROUP_LABEL[g]}
                </div>
                {opts.map((o) => (
                  <button
                    key={o.id}
                    className="flex items-center gap-2 w-full text-left px-2 py-1 hover:bg-black/5 rounded text-sm"
                    onClick={() => {
                      start(() => updateCell(slug, rowId, prop.id, o.id));
                      setOpen(false);
                    }}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: o.color }}
                    />
                    <span>{o.name}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {current && (
            <button
              className="block w-full text-left px-2 py-1 text-xs text-gray-500 hover:bg-black/5 rounded border-t mt-1 pt-1"
              onClick={() => {
                start(() => updateCell(slug, rowId, prop.id, null));
                setOpen(false);
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MultiSelectCell({
  prop,
  slug,
  dbId,
  rowId,
  value,
  readOnly,
}: {
  prop: DbProp & { type: "multi_select" };
  slug: string;
  dbId: string;
  rowId: string;
  value: string[];
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  const selected = new Set(value);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    start(() => updateCell(slug, rowId, prop.id, Array.from(next)));
  };
  return (
    <div className="px-3 py-2 relative" ref={ref}>
      <button
        className="text-sm w-full text-left flex flex-wrap gap-1"
        disabled={readOnly}
        onClick={() => setOpen(!open)}
      >
        {value.length === 0 ? (
          <span className="text-gray-400">—</span>
        ) : (
          value.map((id) => {
            const o = prop.options.find((x) => x.id === id);
            if (!o) return null;
            return (
              <span
                key={id}
                className="inline-block px-2 py-0.5 rounded text-xs"
                style={{ background: o.color }}
              >
                {o.name}
              </span>
            );
          })
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-2 min-w-[220px]">
          {prop.options.map((o) => (
            <div
              key={o.id}
              className="flex items-center gap-1 px-2 py-1 hover:bg-black/5 rounded"
            >
              <button
                className="flex-1 text-left text-sm flex items-center gap-2"
                onClick={() => toggle(o.id)}
              >
                <input type="checkbox" readOnly checked={selected.has(o.id)} />
                <span
                  className="inline-block px-2 py-0.5 rounded text-xs"
                  style={{ background: o.color }}
                >
                  {o.name}
                </span>
              </button>
              <ColorSwatches
                current={o.color}
                onPick={(c) =>
                  start(() =>
                    setSelectOptionColor(slug, dbId, prop.id, o.id, c),
                  )
                }
              />
            </div>
          ))}
          <div className="border-t mt-1 pt-1">
            <input
              type="text"
              placeholder="New option…"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && adding.trim()) {
                  const name = adding.trim();
                  e.preventDefault();
                  setAdding("");
                  start(async () => {
                    const opt = await addSelectOption(slug, dbId, prop.id, name);
                    if (opt) {
                      await updateCell(slug, rowId, prop.id, [...value, opt.id]);
                    }
                  });
                }
              }}
              className="w-full text-sm border rounded px-2 py-1 outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

type Member = { id: string; name: string; color: string };

function PersonCell({
  slug,
  rowId,
  propId,
  value,
  readOnly,
}: {
  slug: string;
  rowId: string;
  propId: string;
  value: string | null;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    fetch(`/api/mentions?ws=${encodeURIComponent(slug)}&q=`)
      .then((r) => r.json())
      .then((d) => setMembers(d.users ?? []));
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, slug]);
  const current = members.find((m) => m.id === value);
  return (
    <div className="px-3 py-2 relative" ref={ref}>
      <button
        className="text-sm w-full text-left"
        disabled={readOnly}
        onClick={() => setOpen(!open)}
      >
        {value ? (
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium"
              style={{ background: current?.color ?? "#999" }}
            >
              {(current?.name ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span>{current?.name ?? "Unknown"}</span>
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-1 min-w-[200px]">
          {members.map((m) => (
            <button
              key={m.id}
              className="flex items-center gap-2 w-full text-left px-2 py-1 hover:bg-black/5 rounded text-sm"
              onClick={() => {
                start(() => updateCell(slug, rowId, propId, m.id));
                setOpen(false);
              }}
            >
              <span
                className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium"
                style={{ background: m.color }}
              >
                {m.name.slice(0, 1).toUpperCase()}
              </span>
              <span>{m.name}</span>
            </button>
          ))}
          {value && (
            <button
              className="block w-full text-left px-2 py-1 text-xs text-gray-500 hover:bg-black/5 rounded"
              onClick={() => {
                start(() => updateCell(slug, rowId, propId, null));
                setOpen(false);
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnResizer({
  slug,
  dbId,
  propId,
  initialWidth,
}: {
  slug: string;
  dbId: string;
  propId: string;
  initialWidth: number;
}) {
  const startX = useRef<number | null>(null);
  const startW = useRef(initialWidth);
  const widthRef = useRef(initialWidth);
  const [, start] = useTransition();
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    startW.current = initialWidth;
    const onMove = (ev: MouseEvent) => {
      if (startX.current === null) return;
      const dx = ev.clientX - startX.current;
      widthRef.current = Math.max(60, Math.min(800, startW.current + dx));
      // live-update the parent th width
      const th = (ev.target as HTMLElement)?.closest?.("th");
      // we set on the originating th via its parentElement traversal
      const trigger = document.querySelector(
        `[data-resizer-prop="${propId}"]`,
      ) as HTMLElement | null;
      const parentTh = trigger?.parentElement as HTMLElement | null;
      if (parentTh) {
        parentTh.style.minWidth = `${widthRef.current}px`;
        parentTh.style.width = `${widthRef.current}px`;
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (widthRef.current !== startW.current) {
        const w = widthRef.current;
        start(() => setColumnWidth(slug, dbId, propId, w));
      }
      startX.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  return (
    <div
      data-resizer-prop={propId}
      onMouseDown={onDown}
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-300/50"
      title="Drag to resize column"
    />
  );
}

function ColumnConfigure({
  prop,
  slug,
  dbId,
  schema,
  onClose,
}: {
  prop: DbProp;
  slug: string;
  dbId: string;
  schema: DbSchema;
  onClose: () => void;
}) {
  const [, start] = useTransition();
  const [dbHits, setDbHits] = useState<{ id: string; title: string; icon: string | null }[]>([]);
  const [targetDb, setTargetDb] = useState<{
    schema: DbSchema;
  } | null>(null);
  const isRelation = prop.type === "relation";
  const isRollup = prop.type === "rollup";
  const isFormula = prop.type === "formula";
  const isNumber = prop.type === "number";
  const isDate = prop.type === "date";

  const [targetDbId, setTargetDbId] = useState(
    isRelation ? prop.targetDbId : "",
  );
  const [relationPropId, setRelationPropId] = useState(
    isRollup ? prop.relationPropId : "",
  );
  const [targetPropId, setTargetPropId] = useState(
    isRollup ? prop.targetPropId : "",
  );
  const [aggregate, setAggregate] = useState<
    "count" | "sum" | "min" | "max" | "unique" | "percent_complete" | "percent_checked"
  >(isRollup ? prop.aggregate : "count");
  const [expr, setExpr] = useState(isFormula ? prop.expr : "");
  const [numFormat, setNumFormat] = useState<"integer" | "decimal" | "percent" | "currency" | "progress" | "rating">(
    isNumber ? (prop.format ?? "decimal") : "decimal",
  );
  const [dateFormat, setDateFmt] = useState<"short" | "long" | "relative">(
    isDate ? (prop.format ?? "short") : "short",
  );

  useEffect(() => {
    if (!isRelation && !isRollup) return;
    const m = /^\/w\/([^/]+)/.exec(window.location.pathname);
    const wsSlug = m ? m[1] : slug;
    fetch(`/api/search?ws=${encodeURIComponent(wsSlug)}&q=`)
      .then((r) => r.json())
      .then((d) => {
        const dbs = (d.hits ?? []).filter((h: { kind: string }) => h.kind === "database");
        setDbHits(dbs);
      });
  }, [isRelation, isRollup, slug]);

  // For rollup: load the target DB (via relation prop) so we can pick its target prop
  useEffect(() => {
    if (!isRollup) return;
    const relProp = schema.props.find((p) => p.id === relationPropId);
    if (!relProp || relProp.type !== "relation" || !relProp.targetDbId) {
      setTargetDb(null);
      return;
    }
    fetch(`/api/db/${encodeURIComponent(relProp.targetDbId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setTargetDb({ schema: d.schema });
      });
  }, [isRollup, relationPropId, schema.props]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[420px] max-w-[92vw] p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">Configure “{prop.name}”</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900">✕</button>
        </div>

        {isRelation && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Target database</label>
            <select
              value={targetDbId}
              onChange={(e) => setTargetDbId(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none mb-3"
            >
              <option value="">— pick a database —</option>
              {dbHits.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.icon ?? "📊"} {h.title || "Untitled"}
                </option>
              ))}
            </select>
            <button
              disabled={!targetDbId}
              onClick={() =>
                start(async () => {
                  await configureRelation(slug, dbId, prop.id, targetDbId);
                  onClose();
                })
              }
              className="text-xs px-3 py-1 rounded bg-gray-900 text-white disabled:opacity-30"
            >
              Save
            </button>
          </div>
        )}

        {isRollup && (
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Relation column</label>
              <select
                value={relationPropId}
                onChange={(e) => setRelationPropId(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none"
              >
                <option value="">— pick a relation —</option>
                {schema.props
                  .filter((p) => p.type === "relation")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
            {targetDb && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">Target property</label>
                <select
                  value={targetPropId}
                  onChange={(e) => setTargetPropId(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none"
                >
                  <option value="">—</option>
                  {targetDb.schema.props.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Aggregate</label>
              <select
                value={aggregate}
                onChange={(e) =>
                  setAggregate(e.target.value as typeof aggregate)
                }
                className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none"
              >
                <option value="count">Count</option>
                <option value="sum">Sum</option>
                <option value="min">Min</option>
                <option value="max">Max</option>
                <option value="unique">Unique values</option>
                <option value="percent_complete">Percent complete (status)</option>
                <option value="percent_checked">Percent checked</option>
              </select>
            </div>
            <button
              disabled={!relationPropId || (aggregate !== "count" && !targetPropId)}
              onClick={() =>
                start(async () => {
                  await configureRollup(
                    slug,
                    dbId,
                    prop.id,
                    relationPropId,
                    targetPropId,
                    aggregate,
                  );
                  onClose();
                })
              }
              className="text-xs px-3 py-1 rounded bg-gray-900 text-white disabled:opacity-30"
            >
              Save
            </button>
          </div>
        )}

        {isNumber && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Number format</label>
            <select
              value={numFormat}
              onChange={(e) => setNumFormat(e.target.value as typeof numFormat)}
              className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none mb-2"
            >
              <option value="integer">Integer (1,234)</option>
              <option value="decimal">Decimal (1,234.56)</option>
              <option value="percent">Percent (1.23 → 123%)</option>
              <option value="currency">Currency (USD)</option>
              <option value="progress">Progress bar (0–1 → ▰▰▱▱▱)</option>
              <option value="rating">Rating (0–5 → ★★★☆☆)</option>
            </select>
            <button
              onClick={() =>
                start(async () => {
                  await setNumberFormat(slug, dbId, prop.id, numFormat);
                  onClose();
                })
              }
              className="text-xs px-3 py-1 rounded bg-gray-900 text-white"
            >
              Save
            </button>
          </div>
        )}

        {isDate && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Date format</label>
            <select
              value={dateFormat}
              onChange={(e) => setDateFmt(e.target.value as typeof dateFormat)}
              className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none mb-2"
            >
              <option value="short">Short (2026-05-17)</option>
              <option value="long">Long (May 17, 2026)</option>
              <option value="relative">Relative (3 days ago)</option>
            </select>
            <button
              onClick={() =>
                start(async () => {
                  await setDateFormat(slug, dbId, prop.id, dateFormat);
                  onClose();
                })
              }
              className="text-xs px-3 py-1 rounded bg-gray-900 text-white"
            >
              Save
            </button>
          </div>
        )}

        {isFormula && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Expression
            </label>
            <textarea
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder='e.g. prop("Score") * 2 + 1, concat("Hi ", prop("Name"))'
              className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none font-mono min-h-[80px] mb-2"
            />
            <p className="text-[10px] text-gray-500 mb-2">
              Supports: prop("Name"), +, -, *, /, %, concat(a,b), if(cond,a,b),
              length(x), number(x), string(x), sum/min/max.
            </p>
            <button
              onClick={() =>
                start(async () => {
                  await configureFormula(slug, dbId, prop.id, expr);
                  onClose();
                })
              }
              className="text-xs px-3 py-1 rounded bg-gray-900 text-white"
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RelationCell({
  slug,
  rowId,
  prop,
  value,
  readOnly,
}: {
  slug: string;
  rowId: string;
  prop: DbProp & { type: "relation" };
  value: string[];
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<{
    rows: { id: string; title: string }[];
  } | null>(null);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prop.targetDbId) return;
    fetch(`/api/db/${encodeURIComponent(prop.targetDbId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setTarget({ rows: d.rows.map((r: { id: string; title: string }) => ({ id: r.id, title: r.title })) });
      });
  }, [prop.targetDbId]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  if (!prop.targetDbId) {
    return (
      <div className="px-3 py-2 text-xs text-gray-400 italic">
        Configure target DB in column menu.
      </div>
    );
  }

  const selected = new Set(value);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    start(() => updateCell(slug, rowId, prop.id, Array.from(next)));
  };
  const visible = (target?.rows ?? []).filter((r) =>
    !q ? true : r.title.toLowerCase().includes(q.toLowerCase()),
  );
  const selectedRows = (target?.rows ?? []).filter((r) => selected.has(r.id));

  return (
    <div className="px-3 py-2 relative" ref={ref}>
      <button
        className="text-sm w-full text-left flex flex-wrap gap-1"
        disabled={readOnly}
        onClick={() => setOpen(!open)}
      >
        {selectedRows.length === 0 ? (
          <span className="text-gray-400">—</span>
        ) : (
          selectedRows.map((r) => (
            <span
              key={r.id}
              className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100"
            >
              {r.title || "Untitled"}
            </span>
          ))
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-2 min-w-[240px]">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search rows…"
            className="w-full text-sm border rounded px-2 py-1 outline-none mb-2"
          />
          <ul className="max-h-48 overflow-y-auto">
            {visible.map((r) => (
              <li key={r.id}>
                <button
                  className="flex items-center gap-2 w-full text-left px-2 py-1 hover:bg-black/5 rounded text-sm"
                  onClick={() => toggle(r.id)}
                >
                  <input type="checkbox" readOnly checked={selected.has(r.id)} />
                  <span className="truncate">{r.title || "Untitled"}</span>
                </button>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="text-xs text-gray-400 px-2 py-1">No rows match.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function RollupCell({
  prop,
  schema,
  row,
}: {
  prop: DbProp & { type: "rollup" };
  schema: DbSchema;
  row: Row;
}) {
  const relationProp = schema.props.find(
    (p) => p.id === prop.relationPropId && p.type === "relation",
  ) as (DbProp & { type: "relation" }) | undefined;
  const value = useRollup(relationProp, prop, row);
  if (!relationProp) {
    return (
      <div className="px-3 py-2 text-xs text-gray-400 italic">
        Configure rollup in column menu.
      </div>
    );
  }
  const isPercent =
    prop.aggregate === "percent_complete" || prop.aggregate === "percent_checked";
  if (isPercent) {
    const pct = typeof value === "number" ? Math.round(value * 100) : null;
    return (
      <div className="px-3 py-2">
        {pct === null ? (
          <span className="text-gray-300 text-sm">—</span>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden min-w-[40px]">
              <div
                className="h-full rounded-full bg-emerald-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs tabular-nums text-gray-600 w-9 text-right">
              {pct}%
            </span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="px-3 py-2 text-sm tabular-nums">
      {value === null ? <span className="text-gray-300">—</span> : String(value)}
    </div>
  );
}

function useRollup(
  relProp: (DbProp & { type: "relation" }) | undefined,
  rollup: DbProp & { type: "rollup" },
  row: Row,
): string | number | null {
  const [result, setResult] = useState<string | number | null>(null);
  useEffect(() => {
    if (!relProp?.targetDbId) {
      setResult(null);
      return;
    }
    const ids = Array.isArray(row.dataValues[relProp.id])
      ? (row.dataValues[relProp.id] as string[])
      : [];
    if (rollup.aggregate === "count") {
      setResult(ids.length);
      return;
    }
    if (ids.length === 0) {
      setResult(0);
      return;
    }
    fetch(`/api/db/${encodeURIComponent(relProp.targetDbId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const rows = d.rows as { id: string; title: string; dataValues: Record<string, unknown> }[];
        const props = (d.schema?.props ?? []) as DbProp[];
        const targetProp = props.find((p) => p.id === rollup.targetPropId);
        if (!targetProp) {
          setResult(null);
          return;
        }
        const related = ids
          .map((id) => rows.find((r) => r.id === id))
          .filter((r): r is { id: string; title: string; dataValues: Record<string, unknown> } => !!r);
        if (rollup.aggregate === "percent_complete") {
          // Fraction of related rows whose status sits in the complete group.
          if (targetProp.type !== "status") {
            setResult(null);
            return;
          }
          const total = related.length;
          if (total === 0) {
            setResult(0);
            return;
          }
          const done = related.filter((r) => {
            const opt = targetProp.options.find((o) => o.id === r.dataValues[targetProp.id]);
            return opt?.group === "complete";
          }).length;
          setResult(done / total);
          return;
        }
        if (rollup.aggregate === "percent_checked") {
          const total = related.length;
          if (total === 0) {
            setResult(0);
            return;
          }
          const checked = related.filter((r) => Boolean(r.dataValues[targetProp.id])).length;
          setResult(checked / total);
          return;
        }
        const vals = ids
          .map((id) => rows.find((r) => r.id === id))
          .filter((r): r is { id: string; title: string; dataValues: Record<string, unknown> } => !!r)
          .map((r) =>
            targetProp.id === "p_title" ? r.title : r.dataValues[targetProp.id],
          );
        if (rollup.aggregate === "sum") {
          setResult(vals.map(Number).filter((n) => !Number.isNaN(n)).reduce((a, b) => a + b, 0));
        } else if (rollup.aggregate === "min") {
          const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
          setResult(nums.length ? Math.min(...nums) : null);
        } else if (rollup.aggregate === "max") {
          const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
          setResult(nums.length ? Math.max(...nums) : null);
        } else if (rollup.aggregate === "unique") {
          setResult(new Set(vals.map((v) => JSON.stringify(v))).size);
        } else {
          setResult(ids.length);
        }
      });
  }, [relProp, rollup, row]);
  return result;
}

function FormulaCell({
  expr,
  row,
  props,
}: {
  expr: string;
  row: Row;
  props: DbProp[];
}) {
  const result = useMemo(() => {
    if (!expr.trim()) return null;
    return evalFormula(expr, row, props);
  }, [expr, row, props]);
  return (
    <div className="px-3 py-2 text-sm">
      {result === null || result === undefined ? (
        <span className="text-gray-300">—</span>
      ) : (
        String(result)
      )}
    </div>
  );
}

function ColorSwatches({
  current,
  onPick,
}: {
  current: string;
  onPick: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-3 h-3 rounded-full border border-gray-300"
        style={{ background: current }}
        title="Change color"
      />
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded p-1 shadow-lg flex gap-1">
          {SELECT_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                onPick(c);
                setOpen(false);
              }}
              className="w-4 h-4 rounded-full border border-gray-300 hover:scale-110 transition-transform"
              style={{ background: c }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilesCell({
  slug,
  rowId,
  propId,
  value,
  readOnly,
}: {
  slug: string;
  rowId: string;
  propId: string;
  value: string[];
  readOnly: boolean;
}) {
  const [, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    const form = new FormData();
    form.append("file", f);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) return;
    const data = (await res.json()) as { url: string };
    start(() => updateCell(slug, rowId, propId, [...value, data.url]));
  };
  return (
    <div className="px-3 py-2 flex flex-wrap items-center gap-1">
      {value.map((url, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-0.5 text-xs bg-gray-100 rounded px-1 py-0.5"
        >
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline truncate max-w-[120px]"
          >
            {url.split("/").pop() || "file"}
          </a>
          {!readOnly && (
            <button
              className="text-gray-400 hover:text-red-600"
              onClick={() =>
                start(() =>
                  updateCell(
                    slug,
                    rowId,
                    propId,
                    value.filter((_, j) => j !== i),
                  ),
                )
              }
            >
              ✕
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <>
          <button
            className="text-xs text-gray-500 hover:text-gray-900"
            onClick={() => fileRef.current?.click()}
          >
            + Upload
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await upload(f);
              e.target.value = "";
            }}
          />
        </>
      )}
    </div>
  );
}
