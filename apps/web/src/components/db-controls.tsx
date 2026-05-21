"use client";

import { useState, useTransition } from "react";
import {
  setColumnOrder,
  setFilters,
  setHiddenColumns,
  setSort,
  setTableGroup,
} from "@/app/w/[slug]/database-actions";
import type {
  DbFilter,
  DbFilterOp,
  DbProp,
  DbSchema,
  DbSort,
} from "@/lib/database";

const newId = () => "f_" + Math.random().toString(36).slice(2, 10);

const OPS_BY_TYPE: Record<DbProp["type"], DbFilterOp[]> = {
  text: ["contains", "eq", "ne", "empty", "not_empty"],
  url: ["contains", "eq", "ne", "empty", "not_empty"],
  email: ["contains", "eq", "ne", "empty", "not_empty"],
  number: ["eq", "ne", "empty", "not_empty"],
  select: ["eq", "ne", "empty", "not_empty"],
  multi_select: ["contains", "empty", "not_empty"],
  status: ["eq", "ne", "empty", "not_empty"],
  date: ["eq", "before", "after", "empty", "not_empty"],
  checkbox: ["checked", "unchecked"],
  person: ["eq", "ne", "empty", "not_empty"],
  phone: ["contains", "eq", "ne", "empty", "not_empty"],
  files: ["empty", "not_empty"],
  relation: ["empty", "not_empty"],
  rollup: ["eq", "ne", "empty", "not_empty"],
  formula: ["contains", "eq", "ne", "empty", "not_empty"],
};

const OP_LABEL: Record<DbFilterOp, string> = {
  eq: "is",
  ne: "is not",
  contains: "contains",
  empty: "is empty",
  not_empty: "is not empty",
  checked: "is checked",
  unchecked: "is unchecked",
  before: "is before",
  after: "is after",
};

const opNeedsValue = (op: DbFilterOp) =>
  !["empty", "not_empty", "checked", "unchecked"].includes(op);

export function DbControls({
  slug,
  dbId,
  schema,
  readOnly,
}: {
  slug: string;
  dbId: string;
  schema: DbSchema;
  readOnly: boolean;
}) {
  const [openFilter, setOpenFilter] = useState(false);
  const [openSort, setOpenSort] = useState(false);
  const [openColumns, setOpenColumns] = useState(false);
  const [, start] = useTransition();

  const filters = schema.filters ?? [];
  const sort = schema.sort ?? [];
  const filterableProps = schema.props;
  const sortableProps = schema.props;
  const view = schema.view ?? "table";
  // Group + Columns only make sense in Table view; hide in list/calendar/timeline.
  const showGroupAndColumns = view === "table";

  const updateFilters = (next: DbFilter[]) =>
    start(() => setFilters(slug, dbId, next));
  const updateSort = (next: DbSort[]) => start(() => setSort(slug, dbId, next));

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <div className="relative">
        <button
          onClick={() => setOpenFilter((v) => !v)}
          disabled={readOnly}
          className={
            "px-2 py-1 rounded hover:bg-black/5 " +
            (filters.length > 0 ? "text-blue-600" : "")
          }
        >
          ⚲ Filter{filters.length > 0 ? ` (${filters.length})` : ""}
        </button>
        {openFilter && (
          <FilterPanel
            schema={schema}
            filters={filters}
            props={filterableProps}
            onChange={updateFilters}
            onClose={() => setOpenFilter(false)}
            readOnly={readOnly}
          />
        )}
      </div>

      <div className="relative">
        <button
          onClick={() => setOpenSort((v) => !v)}
          disabled={readOnly}
          className={
            "px-2 py-1 rounded hover:bg-black/5 " +
            (sort.length > 0 ? "text-blue-600" : "")
          }
        >
          ↕ Sort{sort.length > 0 ? ` (${sort.length})` : ""}
        </button>
        {openSort && (
          <SortPanel
            sort={sort}
            props={sortableProps}
            onChange={updateSort}
            onClose={() => setOpenSort(false)}
            readOnly={readOnly}
          />
        )}
      </div>

      {showGroupAndColumns && (
        <label className="inline-flex items-center gap-1">
          <span className="text-gray-400">Group:</span>
          <select
            disabled={readOnly}
            value={schema.tableGroupBy ?? ""}
            onChange={(e) =>
              start(() =>
                setTableGroup(slug, dbId, e.target.value || null),
              )
            }
            className="border border-gray-200 rounded px-1 py-0.5 text-xs bg-white"
          >
            <option value="">None</option>
            {schema.props
              .filter((p) => p.type === "select" || p.type === "status")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      )}

      {showGroupAndColumns && (
      <div className="relative">
        <button
          onClick={() => setOpenColumns((v) => !v)}
          disabled={readOnly}
          className="px-2 py-1 rounded hover:bg-black/5"
        >
          ☱ Columns
        </button>
        {openColumns && (
          <ColumnsPanel
            schema={schema}
            slug={slug}
            dbId={dbId}
            onClose={() => setOpenColumns(false)}
            readOnly={readOnly}
          />
        )}
      </div>
      )}
      {showGroupAndColumns && (
        <button
          onClick={() => {
            try {
              const k = "noteforge:db-compact";
              const cur = localStorage.getItem(k) === "1";
              if (cur) localStorage.removeItem(k);
              else localStorage.setItem(k, "1");
              document.body.classList.toggle("db-compact", !cur);
            } catch {}
          }}
          className="px-2 py-1 rounded hover:bg-black/5"
          title="Toggle compact row spacing in tables"
        >
          ⥯ Density
        </button>
      )}
    </div>
  );
}

function ColumnsPanel({
  schema,
  slug,
  dbId,
  onClose,
  readOnly,
}: {
  schema: DbSchema;
  slug: string;
  dbId: string;
  onClose: () => void;
  readOnly: boolean;
}) {
  const [, start] = useTransition();
  const hidden = new Set(schema.hiddenColumns ?? []);
  // build current order (existing + remaining)
  const order: string[] = (() => {
    const known = new Set(schema.props.map((p) => p.id));
    const fromSchema = (schema.columnOrder ?? []).filter((id) => known.has(id));
    const remaining = schema.props
      .map((p) => p.id)
      .filter((id) => !fromSchema.includes(id));
    return [...fromSchema, ...remaining];
  })();

  const toggleHide = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    start(() => setHiddenColumns(slug, dbId, Array.from(next)));
  };
  const move = (id: string, dir: -1 | 1) => {
    const idx = order.indexOf(id);
    const ni = idx + dir;
    if (ni < 0 || ni >= order.length) return;
    const next = [...order];
    next.splice(idx, 1);
    next.splice(ni, 0, id);
    start(() => setColumnOrder(slug, dbId, next));
  };

  return (
    <div className="absolute top-full left-0 z-30 mt-1 bg-white border border-gray-200 rounded shadow-lg p-2 min-w-[260px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-700">Columns</span>
        <div className="flex items-center gap-1">
          {!readOnly && (
            <>
              <button
                onClick={() =>
                  start(() => setHiddenColumns(slug, dbId, []))
                }
                className="text-[10px] text-gray-500 hover:text-gray-900"
              >
                Show all
              </button>
              <button
                onClick={() =>
                  start(() =>
                    setHiddenColumns(
                      slug,
                      dbId,
                      schema.props.filter((p) => p.id !== "p_title").map((p) => p.id),
                    ),
                  )
                }
                className="text-[10px] text-gray-500 hover:text-gray-900"
              >
                Hide all
              </button>
            </>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900">
            ✕
          </button>
        </div>
      </div>
      <ul className="space-y-0.5 max-h-72 overflow-y-auto">
        {order.map((id, i) => {
          const p = schema.props.find((x) => x.id === id);
          if (!p) return null;
          const isTitle = p.id === "p_title";
          return (
            <li key={id} className="flex items-center gap-1 px-1 py-0.5">
              <input
                type="checkbox"
                disabled={readOnly || isTitle}
                checked={isTitle || !hidden.has(id)}
                onChange={() => toggleHide(id)}
              />
              <span className="flex-1 text-sm truncate">{p.name}</span>
              <button
                disabled={readOnly || i === 0}
                onClick={() => move(id, -1)}
                className="text-xs text-gray-400 hover:text-gray-900 disabled:opacity-20"
              >
                ↑
              </button>
              <button
                disabled={readOnly || i === order.length - 1}
                onClick={() => move(id, 1)}
                className="text-xs text-gray-400 hover:text-gray-900 disabled:opacity-20"
              >
                ↓
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterPanel({
  schema,
  filters,
  props,
  onChange,
  onClose,
  readOnly,
}: {
  schema: DbSchema;
  filters: DbFilter[];
  props: DbProp[];
  onChange: (next: DbFilter[]) => void;
  onClose: () => void;
  readOnly: boolean;
}) {
  const addRule = () => {
    const first = props[0];
    if (!first) return;
    const ops = OPS_BY_TYPE[first.type];
    onChange([
      ...filters,
      { id: newId(), propId: first.id, op: ops[0], value: null },
    ]);
  };

  const update = (id: string, patch: Partial<DbFilter>) =>
    onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const remove = (id: string) => onChange(filters.filter((f) => f.id !== id));

  return (
    <div className="absolute top-full left-0 z-30 mt-1 bg-white border border-gray-200 rounded shadow-lg p-3 min-w-[420px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-700">Filters</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-900">
          ✕
        </button>
      </div>
      {filters.length === 0 && (
        <p className="text-xs text-gray-400 mb-2">No filters yet.</p>
      )}
      <ul className="space-y-2">
        {filters.map((f) => {
          const prop = schema.props.find((p) => p.id === f.propId) ?? props[0];
          const ops = OPS_BY_TYPE[prop.type];
          return (
            <li key={f.id} className="flex items-center gap-1">
              <select
                disabled={readOnly}
                className="border border-gray-200 rounded px-1 py-0.5 text-xs"
                value={f.propId}
                onChange={(e) => {
                  const newProp = schema.props.find((p) => p.id === e.target.value);
                  if (!newProp) return;
                  const newOps = OPS_BY_TYPE[newProp.type];
                  update(f.id, {
                    propId: newProp.id,
                    op: newOps.includes(f.op) ? f.op : newOps[0],
                    value: null,
                  });
                }}
              >
                {props.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                disabled={readOnly}
                className="border border-gray-200 rounded px-1 py-0.5 text-xs"
                value={f.op}
                onChange={(e) =>
                  update(f.id, { op: e.target.value as DbFilterOp, value: null })
                }
              >
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABEL[o]}
                  </option>
                ))}
              </select>
              {opNeedsValue(f.op) && (
                <FilterValueInput
                  prop={prop}
                  value={f.value}
                  readOnly={readOnly}
                  onChange={(v) => update(f.id, { value: v })}
                />
              )}
              <button
                disabled={readOnly}
                onClick={() => remove(f.id)}
                className="text-gray-400 hover:text-red-600 ml-auto"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      {!readOnly && (
        <button
          onClick={addRule}
          className="mt-2 text-xs text-gray-600 hover:text-gray-900"
        >
          + Add filter
        </button>
      )}
    </div>
  );
}

function FilterValueInput({
  prop,
  value,
  readOnly,
  onChange,
}: {
  prop: DbProp;
  value: DbFilter["value"];
  readOnly: boolean;
  onChange: (v: DbFilter["value"]) => void;
}) {
  if (prop.type === "select") {
    return (
      <select
        disabled={readOnly}
        className="border border-gray-200 rounded px-1 py-0.5 text-xs"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">—</option>
        {prop.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (prop.type === "number") {
    return (
      <input
        type="number"
        disabled={readOnly}
        className="border border-gray-200 rounded px-1 py-0.5 text-xs w-20"
        value={typeof value === "number" ? String(value) : String(value ?? "")}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    );
  }
  if (prop.type === "date") {
    return (
      <input
        type="date"
        disabled={readOnly}
        className="border border-gray-200 rounded px-1 py-0.5 text-xs"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  return (
    <input
      type="text"
      disabled={readOnly}
      className="border border-gray-200 rounded px-1 py-0.5 text-xs"
      value={typeof value === "string" ? value : String(value ?? "")}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

function SortPanel({
  sort,
  props,
  onChange,
  onClose,
  readOnly,
}: {
  sort: DbSort[];
  props: DbProp[];
  onChange: (next: DbSort[]) => void;
  onClose: () => void;
  readOnly: boolean;
}) {
  const addRule = () => {
    const used = new Set(sort.map((s) => s.propId));
    const next = props.find((p) => !used.has(p.id)) ?? props[0];
    if (!next) return;
    onChange([...sort, { propId: next.id, dir: "asc" }]);
  };
  const update = (i: number, patch: Partial<DbSort>) =>
    onChange(sort.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => onChange(sort.filter((_, idx) => idx !== i));

  return (
    <div className="absolute top-full left-0 z-30 mt-1 bg-white border border-gray-200 rounded shadow-lg p-3 min-w-[300px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-700">Sort</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-900">
          ✕
        </button>
      </div>
      {sort.length === 0 && (
        <p className="text-xs text-gray-400 mb-2">No sort yet.</p>
      )}
      <ul className="space-y-2">
        {sort.map((s, i) => (
          <li key={i} className="flex items-center gap-1">
            <select
              disabled={readOnly}
              className="border border-gray-200 rounded px-1 py-0.5 text-xs"
              value={s.propId}
              onChange={(e) => update(i, { propId: e.target.value })}
            >
              {props.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              disabled={readOnly}
              className="border border-gray-200 rounded px-1 py-0.5 text-xs"
              value={s.dir}
              onChange={(e) => update(i, { dir: e.target.value as "asc" | "desc" })}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button
              disabled={readOnly}
              onClick={() => remove(i)}
              className="text-gray-400 hover:text-red-600 ml-auto"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <button
          onClick={addRule}
          className="mt-2 text-xs text-gray-600 hover:text-gray-900"
        >
          + Add sort
        </button>
      )}
    </div>
  );
}
