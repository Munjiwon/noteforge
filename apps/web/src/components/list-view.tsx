"use client";

import Link from "next/link";
import { useTransition } from "react";
import { addRow, deleteRow } from "@/app/w/[slug]/database-actions";
import type { DbSchema } from "@/lib/database";

type Row = {
  id: string;
  parentId: string;
  title: string;
  dataValues: Record<string, unknown>;
};

export function ListView({
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
  const secondaryProps = schema.props
    .filter((p) => p.id !== "p_title")
    .slice(0, 2);
  return (
    <div className="border border-gray-200 rounded">
      <ul className="divide-y divide-gray-100">
        {rows.map((row) => (
          <li key={row.id} className="group flex items-center gap-2 px-3 py-2 hover:bg-gray-50">
            <Link
              href={slug ? `/w/${slug}/p/${row.id}` : "#"}
              className="flex-1 text-sm text-gray-900 hover:underline truncate"
            >
              {row.title || <span className="text-gray-400">Untitled</span>}
            </Link>
            {secondaryProps.map((p) => {
              const v = row.dataValues[p.id];
              if (v === null || v === undefined || v === "") return null;
              if (p.type === "select") {
                const o = p.options.find((x) => x.id === v);
                if (!o) return null;
                return (
                  <span
                    key={p.id}
                    className="text-[11px] px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: o.color }}
                  >
                    {o.name}
                  </span>
                );
              }
              if (p.type === "status") {
                const o = p.options.find((x) => x.id === v);
                if (!o) return null;
                return (
                  <span key={p.id} className="text-[11px] text-gray-600 shrink-0 inline-flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: o.color }} />
                    {o.name}
                  </span>
                );
              }
              if (p.type === "checkbox") {
                return v ? (
                  <span key={p.id} className="text-[11px] text-gray-500 shrink-0">
                    ☑
                  </span>
                ) : null;
              }
              return (
                <span key={p.id} className="text-[11px] text-gray-500 truncate max-w-[180px] shrink-0">
                  {String(v)}
                </span>
              );
            })}
            {!readOnly && (
              <button
                onClick={() => {
                  if (!confirm("Delete this row?")) return;
                  start(() => deleteRow(slug, row.id));
                }}
                className="opacity-0 group-hover:opacity-100 text-xs text-gray-300 hover:text-red-600"
              >
                ✕
              </button>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-center text-sm text-gray-400 py-6">No rows</li>
        )}
      </ul>
      {!readOnly && (
        <button
          onClick={() => start(async () => { await addRow(slug, dbId); })}
          className="block text-sm text-gray-600 hover:text-gray-900 hover:bg-black/5 rounded px-2 py-2 mt-1 w-full text-left"
        >
          + New row
        </button>
      )}
    </div>
  );
}
