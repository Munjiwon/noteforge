"use client";

import { useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import Link from "next/link";
import { addRow, updateCell } from "@/app/w/[slug]/database-actions";
import { effectiveCalendarDateBy, type DbSchema } from "@/lib/database";

type Row = {
  id: string;
  parentId: string;
  title: string;
  dataValues: Record<string, unknown>;
};

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function CalendarView({
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
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [mode, setMode] = useState<"month" | "week">("month");

  const dateProp = useMemo(() => {
    const dateId = effectiveCalendarDateBy(schema);
    if (!dateId) return null;
    const p = schema.props.find((x) => x.id === dateId);
    return p && p.type === "date" ? p : null;
  }, [schema]);

  if (!dateProp) {
    return (
      <div className="text-sm text-gray-500 border border-dashed rounded p-6 text-center">
        Calendar view needs a Date column. Add one in Table view, then choose it
        as the calendar date.
      </div>
    );
  }

  // Build the visible grid. Month: 6-row grid from the Sunday of the
  // first week. Week: 7 days starting at the Sunday of the cursor.
  const monthStart = cursor;
  const days: Date[] = [];
  if (mode === "month") {
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      days.push(d);
    }
  } else {
    const weekStart = new Date(cursor);
    weekStart.setDate(cursor.getDate() - cursor.getDay());
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      days.push(d);
    }
  }

  // Bucket rows by their date string.
  const byDate = new Map<string, Row[]>();
  for (const r of rows) {
    const v = r.dataValues[dateProp.id];
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
    const key = v.slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(r);
  }

  const moveTo = (rowId: string, dateStr: string) =>
    start(() => updateCell(slug, rowId, dateProp.id, dateStr));

  const monthLabel = monthStart.toLocaleString("default", {
    month: "long",
    year: "numeric",
  });

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => {
            if (mode === "month") {
              setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
            } else {
              const d = new Date(cursor);
              d.setDate(cursor.getDate() - 7);
              setCursor(d);
            }
          }}
          className="px-2 py-0.5 text-sm rounded hover:bg-black/5"
        >
          ‹
        </button>
        <button
          onClick={() => {
            const d = new Date();
            setCursor(
              mode === "month"
                ? new Date(d.getFullYear(), d.getMonth(), 1)
                : d,
            );
          }}
          className="px-2 py-0.5 text-xs rounded border border-gray-200 hover:bg-black/5"
        >
          Today
        </button>
        <button
          onClick={() => {
            if (mode === "month") {
              setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
            } else {
              const d = new Date(cursor);
              d.setDate(cursor.getDate() + 7);
              setCursor(d);
            }
          }}
          className="px-2 py-0.5 text-sm rounded hover:bg-black/5"
        >
          ›
        </button>
        <span className="font-medium text-sm">{monthLabel}</span>
        <div className="ml-auto inline-flex border border-gray-200 rounded overflow-hidden text-xs">
          <button
            onClick={() => setMode("month")}
            className={"px-2 py-0.5 " + (mode === "month" ? "bg-gray-900 text-white" : "hover:bg-black/5")}
          >
            Month
          </button>
          <button
            onClick={() => setMode("week")}
            className={"px-2 py-0.5 " + (mode === "week" ? "bg-gray-900 text-white" : "hover:bg-black/5")}
          >
            Week
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 border border-gray-200 rounded overflow-hidden">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => (
          <div
            key={w}
            className="bg-gray-50 text-xs text-gray-500 px-2 py-1 border-b border-gray-200 border-r last:border-r-0"
          >
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const inMonth = mode === "week" ? true : d.getMonth() === monthStart.getMonth();
          const isToday = key === ymd(new Date());
          const items = byDate.get(key) ?? [];
          return (
            <div
              key={key}
              onDragOver={(e) => {
                if (!dragRow || readOnly) return;
                e.preventDefault();
              }}
              onDrop={(e) => {
                if (!dragRow || readOnly) return;
                e.preventDefault();
                moveTo(dragRow, key);
                setDragRow(null);
              }}
              className={clsx(
                "min-h-[96px] p-1 border-r border-b border-gray-100 last:border-r-0 text-xs",
                !inMonth && "bg-gray-50/50 text-gray-400",
                isToday && "bg-blue-50",
              )}
            >
              <div className="flex items-center justify-between">
                <span className={isToday ? "font-bold text-blue-600" : ""}>
                  {d.getDate()}
                </span>
                {!readOnly && inMonth && (
                  <button
                    onClick={() =>
                      start(async () => {
                        const id = await addRow(slug, dbId);
                        if (id) await updateCell(slug, id, dateProp.id, key);
                      })
                    }
                    className="opacity-0 hover:opacity-100 text-gray-400 hover:text-gray-700"
                    title="Add card on this day"
                  >
                    +
                  </button>
                )}
              </div>
              <div className="mt-1 space-y-0.5">
                {(expandedDay === key ? items : items.slice(0, 3)).map((r) => (
                  <Link
                    key={r.id}
                    href={`/w/${slug}/p/${r.id}`}
                    draggable={!readOnly}
                    onDragStart={() => setDragRow(r.id)}
                    onDragEnd={() => setDragRow(null)}
                    className="block bg-white border border-gray-200 rounded px-1 py-0.5 truncate hover:bg-blue-50 text-gray-800"
                    title={r.title || "Untitled"}
                  >
                    {r.title || "Untitled"}
                  </Link>
                ))}
                {items.length > 3 && expandedDay !== key && (
                  <button
                    onClick={() => setExpandedDay(key)}
                    className="text-[10px] text-blue-600 hover:underline"
                  >
                    + {items.length - 3} more
                  </button>
                )}
                {expandedDay === key && items.length > 3 && (
                  <button
                    onClick={() => setExpandedDay(null)}
                    className="text-[10px] text-gray-500 hover:text-gray-900"
                  >
                    Collapse
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
