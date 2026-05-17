"use client";

import { useState, useTransition, useRef, useEffect, useMemo } from "react";
import clsx from "clsx";
import { evalFormula } from "@/lib/formula";
import {
  addColumn,
  addRow,
  addSelectOption,
  deleteColumn,
  deleteRow,
  renameColumn,
  updateCell,
} from "@/app/w/[slug]/database-actions";
import type { DbProp, DbPropType, DbSchema } from "@/lib/database";
import { STATUS_GROUP_LABEL, type StatusGroup } from "@/lib/database";

type Row = {
  id: string;
  parentId: string;
  title: string;
  dataValues: Record<string, unknown>;
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
  person: "Person",
  files: "Files",
  relation: "Relation",
  rollup: "Rollup",
  formula: "Formula",
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
  person: "👤",
  files: "📎",
  relation: "↔",
  rollup: "Σ",
  formula: "ƒ",
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

  const callAddColumn = (type: DbPropType) =>
    start(() => addColumn(slug, dbId, type));

  return (
    <div className="w-full">
      <div className="overflow-x-auto border border-gray-200 rounded-md">
        <table className="border-collapse w-max min-w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {schema.props.map((p) => (
                <th
                  key={p.id}
                  className="text-left text-xs font-medium text-gray-600 border-r border-gray-200 last:border-r-0 align-top"
                  style={{ minWidth: 160 }}
                >
                  <ColumnHeader
                    prop={p}
                    slug={slug}
                    dbId={dbId}
                    open={openMenuPropId === p.id}
                    onOpen={(v) => setOpenMenuPropId(v ? p.id : null)}
                    readOnly={readOnly}
                  />
                </th>
              ))}
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
                      <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-1 min-w-[150px]">
                        {(Object.keys(TYPE_LABELS) as DbPropType[]).map((t) => (
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
                        <button
                          className="block w-full text-left px-2 py-1 text-xs text-gray-500 hover:bg-black/5 rounded"
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
            {rows.map((row) => (
              <RowRow
                key={row.id}
                row={row}
                schema={schema}
                slug={slug}
                readOnly={readOnly}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={schema.props.length + (readOnly ? 0 : 1)}
                  className="text-center text-sm text-gray-400 py-6"
                >
                  No rows yet
                </td>
              </tr>
            )}
          </tbody>
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
  open,
  onOpen,
  readOnly,
}: {
  prop: DbProp;
  slug: string;
  dbId: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  readOnly: boolean;
}) {
  const [name, setName] = useState(prop.name);
  const [, start] = useTransition();
  useEffect(() => setName(prop.name), [prop.name]);

  return (
    <div className="relative px-3 py-2 flex items-center gap-1">
      <span className="text-gray-400 w-4">{TYPE_ICONS[prop.type]}</span>
      <input
        className="bg-transparent outline-none flex-1 text-sm font-medium"
        value={name}
        disabled={readOnly}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name !== prop.name) {
            start(() => renameColumn(slug, dbId, prop.id, name));
          }
        }}
      />
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
        <div className="absolute top-full right-0 z-30 bg-white shadow-lg border rounded p-1 min-w-[140px]">
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
    </div>
  );
}

function RowRow({
  row,
  schema,
  slug,
  readOnly,
}: {
  row: Row;
  schema: DbSchema;
  slug: string;
  readOnly: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [, start] = useTransition();
  return (
    <tr
      className="border-b border-gray-100 hover:bg-gray-50"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {schema.props.map((p, idx) => (
        <td
          key={p.id}
          className="border-r border-gray-100 last:border-r-0 align-top relative"
        >
          <div className="flex items-center">
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
            <button
              className="text-xs text-gray-400 hover:text-red-600 px-2"
              onClick={() => {
                if (confirm("Delete this row?")) {
                  start(() => deleteRow(slug, row.id));
                }
              }}
            >
              ✕
            </button>
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

  if (prop.type === "date") {
    return (
      <input
        type="date"
        defaultValue={typeof value === "string" ? value : ""}
        disabled={readOnly}
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

  if (prop.type === "number") {
    return (
      <input
        type="number"
        defaultValue={value as number | undefined}
        disabled={readOnly}
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
        <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-2 min-w-[180px]">
          {prop.options.map((o) => (
            <button
              key={o.id}
              className="block w-full text-left px-2 py-1 hover:bg-black/5 rounded"
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
        <div className="absolute top-full left-0 z-30 bg-white shadow-lg border rounded p-2 min-w-[200px]">
          {prop.options.map((o) => (
            <button
              key={o.id}
              className="block w-full text-left px-2 py-1 hover:bg-black/5 rounded text-sm flex items-center gap-2"
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
