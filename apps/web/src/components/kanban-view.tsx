"use client";

import { useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import {
  addRow,
  addSelectOption,
  deleteRow,
  updateCell,
} from "@/app/w/[slug]/database-actions";
import type { DbSchema } from "@/lib/database";

type Row = {
  id: string;
  parentId: string;
  title: string;
  dataValues: Record<string, unknown>;
};

const NO_VALUE = "__none__";

export function KanbanView({
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
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const groupProp = useMemo(() => {
    if (!schema.kanbanGroupBy) return null;
    const p = schema.props.find((x) => x.id === schema.kanbanGroupBy);
    return p && p.type === "select" ? p : null;
  }, [schema]);

  if (!groupProp) {
    return (
      <div className="text-sm text-gray-500 border border-dashed rounded p-6 text-center">
        <div className="text-2xl mb-2">🗂</div>
        <p className="font-medium text-gray-700">Kanban needs a Select column</p>
        <p className="text-xs mt-1">
          Switch to Table view → <span className="text-gray-700">+ Add column</span> → Select.
          Then return here and pick it as <em>Group by</em>.
        </p>
      </div>
    );
  }

  const columns = [
    ...groupProp.options.map((o) => ({ key: o.id, name: o.name, color: o.color })),
    { key: NO_VALUE, name: "No " + groupProp.name, color: "#f3f4f6" },
  ];

  const byKey = new Map<string, Row[]>();
  for (const col of columns) byKey.set(col.key, []);
  for (const row of rows) {
    const v = row.dataValues[groupProp.id];
    const key = typeof v === "string" && byKey.has(v) ? v : NO_VALUE;
    byKey.get(key)!.push(row);
  }

  const moveTo = (rowId: string, key: string) => {
    const next = key === NO_VALUE ? null : key;
    start(() => updateCell(slug, rowId, groupProp.id, next));
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((col) => {
        const items = byKey.get(col.key) ?? [];
        return (
          <div
            key={col.key}
            className={clsx(
              "shrink-0 w-72 rounded-md bg-gray-50 border",
              dropTarget === col.key ? "border-blue-400" : "border-gray-200",
            )}
            onDragOver={(e) => {
              if (readOnly || !dragRow) return;
              e.preventDefault();
              setDropTarget(col.key);
            }}
            onDragLeave={() => {
              if (dropTarget === col.key) setDropTarget(null);
            }}
            onDrop={(e) => {
              if (readOnly || !dragRow) return;
              e.preventDefault();
              moveTo(dragRow, col.key);
              setDragRow(null);
              setDropTarget(null);
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
              <span
                className="inline-block px-2 py-0.5 rounded text-xs"
                style={{ background: col.color }}
              >
                {col.name}
              </span>
              <span className="text-xs text-gray-400 ml-auto">{items.length}</span>
            </div>
            <div className="p-2 space-y-2 min-h-[80px]">
              {items.map((row) => (
                <Card
                  key={row.id}
                  row={row}
                  schema={schema}
                  slug={slug}
                  readOnly={readOnly}
                  dragging={dragRow === row.id}
                  onDragStart={() => setDragRow(row.id)}
                  onDragEnd={() => {
                    setDragRow(null);
                    setDropTarget(null);
                  }}
                />
              ))}
            </div>
            {!readOnly && (
              <button
                className="block w-full text-left text-xs text-gray-500 hover:text-gray-900 hover:bg-black/5 px-3 py-2"
                onClick={() =>
                  start(async () => {
                    const id = await addRow(slug, dbId);
                    if (col.key !== NO_VALUE && id) {
                      await updateCell(slug, id, groupProp.id, col.key);
                    }
                  })
                }
              >
                + New
              </button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <button
          onClick={() => {
            const name = prompt(`New "${groupProp.name}" option`);
            if (!name || !name.trim()) return;
            start(async () => {
              await addSelectOption(slug, dbId, groupProp.id, name.trim());
            });
          }}
          className="shrink-0 w-72 rounded-md bg-gray-50 border border-dashed border-gray-300 text-xs text-gray-500 hover:bg-black/5 hover:text-gray-900 grid place-items-center"
          style={{ minHeight: 80 }}
        >
          + Add option
        </button>
      )}
    </div>
  );
}

function Card({
  row,
  schema,
  slug,
  readOnly,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  row: Row;
  schema: DbSchema;
  slug: string;
  readOnly: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [, start] = useTransition();
  const groupId = schema.kanbanGroupBy;

  const visibleProps = schema.props.filter(
    (p) => p.id !== "p_title" && p.id !== groupId,
  );

  return (
    <div
      draggable={!readOnly}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={clsx(
        "bg-white rounded border border-gray-200 px-3 py-2 shadow-sm group",
        !readOnly && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-start gap-1">
        <a
          href={`/w/${slug.replace(/^\/+/, "")}`}
          onClick={(e) => e.preventDefault()}
          className="flex-1 text-sm font-medium text-gray-900 truncate"
          title={row.title || "Untitled"}
        >
          {row.title || <span className="text-gray-400">Untitled</span>}
        </a>
        {!readOnly && (
          <button
            className="text-xs text-gray-300 hover:text-red-600 opacity-0 group-hover:opacity-100"
            onClick={() => {
              if (confirm("Delete this card?")) {
                start(() => deleteRow(slug, row.id));
              }
            }}
            aria-label="delete"
          >
            ✕
          </button>
        )}
      </div>
      {visibleProps.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {visibleProps.map((p) => {
            const v = row.dataValues[p.id];
            if (v === undefined || v === null || v === "") return null;
            if (p.type === "select") {
              const opt = p.options.find((o) => o.id === v);
              if (!opt) return null;
              return (
                <span
                  key={p.id}
                  className="inline-block px-1.5 py-0.5 rounded text-[11px]"
                  style={{ background: opt.color }}
                >
                  {opt.name}
                </span>
              );
            }
            if (p.type === "checkbox") {
              return v ? (
                <span key={p.id} className="text-[11px] text-gray-500">
                  ☑ {p.name}
                </span>
              ) : null;
            }
            return (
              <span key={p.id} className="text-[11px] text-gray-500">
                {p.name}: {String(v)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
