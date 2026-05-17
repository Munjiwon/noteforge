"use client";

import { useTransition } from "react";
import Link from "next/link";
import clsx from "clsx";
import { addRow, deleteRow } from "@/app/w/[slug]/database-actions";
import type { DbSchema } from "@/lib/database";

type Row = {
  id: string;
  parentId: string;
  title: string;
  cover?: string | null;
  dataValues: Record<string, unknown>;
};

export function GalleryView({
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
  const visibleProps = schema.props.filter((p) => p.id !== "p_title").slice(0, 4);

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {rows.map((row) => (
          <Card
            key={row.id}
            slug={slug}
            row={row}
            schema={schema}
            visibleProps={visibleProps}
            readOnly={readOnly}
          />
        ))}
        {rows.length === 0 && (
          <div className="col-span-full text-center text-sm text-gray-400 py-12 border border-dashed rounded">
            No cards yet
          </div>
        )}
      </div>
      {!readOnly && (
        <button
          onClick={() => start(async () => { await addRow(slug, dbId); })}
          className="mt-3 text-sm text-gray-600 hover:text-gray-900 hover:bg-black/5 rounded px-2 py-1"
        >
          + New card
        </button>
      )}
      <div className="mt-2 text-xs text-gray-400">
        {rows.length} card{rows.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function Card({
  slug,
  row,
  schema,
  visibleProps,
  readOnly,
}: {
  slug: string;
  row: Row;
  schema: DbSchema;
  visibleProps: DbSchema["props"];
  readOnly: boolean;
}) {
  const [, start] = useTransition();
  const isPublic = slug === "";
  const href = isPublic ? undefined : `/w/${slug}/p/${row.id}`;
  return (
    <div
      className={clsx(
        "group bg-white border border-gray-200 rounded-md overflow-hidden hover:shadow-md transition-shadow",
      )}
    >
      {row.cover ? (
        <img src={row.cover} alt="" className="w-full h-32 object-cover" />
      ) : (
        <div className="w-full h-32 bg-gradient-to-br from-gray-100 to-gray-200" />
      )}
      <div className="p-3">
        <div className="flex items-start gap-1">
          {href ? (
            <Link
              href={href}
              className="flex-1 text-sm font-medium text-gray-900 truncate hover:underline"
              title={row.title || "Untitled"}
            >
              {row.title || <span className="text-gray-400">Untitled</span>}
            </Link>
          ) : (
            <span className="flex-1 text-sm font-medium text-gray-900 truncate">
              {row.title || <span className="text-gray-400">Untitled</span>}
            </span>
          )}
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
          <div className="mt-2 flex flex-wrap gap-1">
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
              if (p.type === "url") {
                return (
                  <a
                    key={p.id}
                    href={String(v)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-blue-600 underline truncate max-w-[160px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    🔗 {String(v).replace(/^https?:\/\//, "")}
                  </a>
                );
              }
              return (
                <span key={p.id} className="text-[11px] text-gray-500 truncate max-w-[160px]">
                  {p.name}: {String(v)}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
