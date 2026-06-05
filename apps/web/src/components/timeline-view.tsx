"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import Link from "next/link";
import { effectiveTimelineRange, type DbSchema } from "@/lib/database";

type Row = {
  id: string;
  parentId: string;
  title: string;
  dataValues: Record<string, unknown>;
};

const DAY_W = 28;

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  return new Date(v.slice(0, 10) + "T00:00:00");
}

function diffDays(a: Date, b: Date) {
  return Math.round((b.getTime() - a.getTime()) / (24 * 3600 * 1000));
}

export function TimelineView({
  slug,
  schema,
  rows,
}: {
  slug: string;
  dbId: string;
  schema: DbSchema;
  rows: Row[];
  readOnly: boolean;
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const startProp = useMemo(() => {
    const id = effectiveTimelineRange(schema).startBy;
    return id ? schema.props.find((p) => p.id === id && p.type === "date") : null;
  }, [schema]);
  const endProp = useMemo(() => {
    const { startBy, endBy } = effectiveTimelineRange(schema);
    const id = endBy ?? startBy;
    return id ? schema.props.find((p) => p.id === id && p.type === "date") : null;
  }, [schema]);

  if (!startProp) {
    return (
      <div className="text-sm text-gray-500 border border-dashed rounded p-6 text-center">
        Timeline view needs a Date column. Add one in Table view, then choose it
        as the timeline range.
      </div>
    );
  }

  const monthStart = cursor;
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const days: Date[] = [];
  for (let i = 0; i < monthEnd.getDate(); i++) {
    const d = new Date(monthStart);
    d.setDate(monthStart.getDate() + i);
    days.push(d);
  }

  const items = rows
    .map((r) => {
      const s = parseDate(r.dataValues[startProp.id]);
      const e = endProp ? parseDate(r.dataValues[endProp.id]) ?? s : s;
      if (!s || !e) return null;
      return { row: r, start: s, end: e };
    })
    .filter((x): x is { row: Row; start: Date; end: Date } => !!x);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          className="px-2 py-0.5 text-sm rounded hover:bg-black/5"
        >
          ‹
        </button>
        <button
          onClick={() => {
            const d = new Date();
            setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
          }}
          className="px-2 py-0.5 text-xs rounded border border-gray-200 hover:bg-black/5"
        >
          Today
        </button>
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          className="px-2 py-0.5 text-sm rounded hover:bg-black/5"
        >
          ›
        </button>
        <span className="font-medium text-sm">
          {monthStart.toLocaleString("default", { month: "long", year: "numeric" })}
        </span>
      </div>
      <div className="overflow-x-auto border border-gray-200 rounded">
        <div style={{ minWidth: 200 + days.length * DAY_W }}>
          <div className="flex bg-gray-50 border-b border-gray-200">
            <div className="w-[200px] shrink-0 px-2 py-1 text-xs text-gray-500 border-r border-gray-200">
              Task
            </div>
            {days.map((d) => (
              <div
                key={d.getDate()}
                className={clsx(
                  "shrink-0 text-[10px] text-center text-gray-500 border-r border-gray-100",
                  d.getDay() === 0 || d.getDay() === 6 ? "bg-gray-100/50" : "",
                )}
                style={{ width: DAY_W }}
              >
                {d.getDate()}
              </div>
            ))}
          </div>
          {items.map(({ row, start, end }) => {
            // Clip to month bounds
            const leftDate = start < monthStart ? monthStart : start;
            const rightDate = end > monthEnd ? monthEnd : end;
            if (leftDate > monthEnd || rightDate < monthStart) return null;
            const leftDays = diffDays(monthStart, leftDate);
            const span = Math.max(1, diffDays(leftDate, rightDate) + 1);
            return (
              <div
                key={row.id}
                className="flex items-center border-b border-gray-100 hover:bg-gray-50 group relative"
              >
                <div className="w-[200px] shrink-0 px-2 py-1 truncate text-sm border-r border-gray-200">
                  <Link
                    href={`/w/${slug}/p/${row.id}`}
                    className="text-gray-900 hover:text-blue-600"
                  >
                    {row.title || "Untitled"}
                  </Link>
                </div>
                <div className="relative" style={{ width: days.length * DAY_W, height: 28 }}>
                  <div
                    title={`${start.toDateString()} → ${end.toDateString()}`}
                    className="absolute top-1 bg-blue-500/80 hover:bg-blue-600 text-white text-[11px] rounded px-1 py-0.5 truncate"
                    style={{
                      left: leftDays * DAY_W,
                      width: span * DAY_W - 2,
                      height: 22,
                    }}
                  >
                    {row.title || "Untitled"}
                  </div>
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-6">
              No items with dates in this range.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
