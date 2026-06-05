"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createReactBlockSpec } from "@blocknote/react";
import { orderedVisibleProps, type DbSchema } from "@/lib/database";
import { applyQuery } from "@/lib/db-query";

const ROW_LIMIT = 25;

function openPeek(pageId: string) {
  window.dispatchEvent(new CustomEvent("db-row-peek", { detail: { pageId } }));
}

type Hit = {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
};

type DbPayload = {
  id: string;
  slug: string;
  title: string;
  icon: string | null;
  schema: DbSchema;
  rows: { id: string; title: string; cover: string | null; dataValues: Record<string, unknown> }[];
};

export const DbViewBlock = createReactBlockSpec(
  {
    type: "dbView",
    propSchema: {
      dbPageId: { default: "" },
      viewId: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const dbId = block.props.dbPageId;
      const linkedViewId = block.props.viewId;
      const editable = (editor as { isEditable: boolean }).isEditable;
      const [data, setData] = useState<DbPayload | null>(null);
      const [error, setError] = useState<string | null>(null);
      const [showPicker, setShowPicker] = useState(false);

      useEffect(() => {
        if (!dbId) return;
        let cancelled = false;
        fetch(`/api/db/${encodeURIComponent(dbId)}`)
          .then(async (r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            return r.json();
          })
          .then((d) => {
            if (!cancelled) {
              setData(d);
              setError(null);
            }
          })
          .catch((e) => {
            if (!cancelled) setError(String(e));
          });
        return () => {
          cancelled = true;
        };
      }, [dbId]);

      if (!dbId) {
        return (
          <div className="border border-dashed border-gray-300 rounded p-3 my-2 text-sm" contentEditable={false}>
            <div className="text-gray-500 mb-2">No database linked.</div>
            {editable && (
              <>
                <button
                  className="text-xs text-blue-600 hover:underline"
                  onClick={() => setShowPicker((v) => !v)}
                >
                  {showPicker ? "Cancel" : "Pick a database"}
                </button>
                {showPicker && (
                  <DbPicker
                    onPick={(id) => {
                      editor.updateBlock(block, {
                        props: { dbPageId: id } as Record<string, unknown>,
                      });
                      setShowPicker(false);
                    }}
                  />
                )}
              </>
            )}
          </div>
        );
      }

      if (error) {
        return (
          <div className="border border-red-200 bg-red-50 rounded p-3 my-2 text-xs text-red-700" contentEditable={false}>
            Failed to load database: {error}
          </div>
        );
      }
      if (!data) {
        return (
          <div className="border border-gray-200 rounded p-3 my-2 text-xs text-gray-400" contentEditable={false}>
            Loading database…
          </div>
        );
      }

      const savedViews = data.schema.views ?? [];
      const effSchema = linkedViewId
        ? { ...data.schema, activeViewId: linkedViewId }
        : data.schema;
      const visibleCols = orderedVisibleProps(effSchema);
      const filteredRows = applyQuery(effSchema, data.rows);
      const activeName =
        savedViews.find((v) => v.id === linkedViewId)?.name ?? "All";

      return (
        <div className="border border-gray-200 rounded my-2 overflow-hidden" contentEditable={false}>
          <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 bg-gray-50 text-sm">
            <span>{data.icon ?? "📊"}</span>
            <Link
              href={`/w/${data.slug}/p/${data.id}`}
              className="font-medium text-gray-900 hover:underline"
            >
              {data.title || "Untitled"}
            </Link>
            {savedViews.length > 0 && editable && (
              <select
                className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white"
                value={linkedViewId}
                onChange={(e) =>
                  editor.updateBlock(block, {
                    props: { dbPageId: dbId, viewId: e.target.value } as Record<string, unknown>,
                  })
                }
                title="Source view"
              >
                <option value="">All rows</option>
                {savedViews.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}
            {savedViews.length > 0 && !editable && linkedViewId && (
              <span className="text-xs text-gray-500">· {activeName}</span>
            )}
            <span className="ml-auto text-xs text-gray-500">
              {filteredRows.length} row{filteredRows.length === 1 ? "" : "s"}
              {filteredRows.length !== data.rows.length && (
                <span className="text-gray-400"> of {data.rows.length}</span>
              )}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50/50 text-gray-500">
                <tr>
                  {visibleCols.map((p) => (
                    <th key={p.id} className="text-left px-2 py-1 border-b border-gray-100 font-normal whitespace-nowrap">
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, ROW_LIMIT).map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-gray-50 last:border-b-0 hover:bg-gray-50 cursor-pointer"
                    onClick={(e) => {
                      // Don't intercept link clicks inside cells (url props etc).
                      const t = e.target as HTMLElement;
                      if (t.closest("a")) return;
                      openPeek(r.id);
                    }}
                  >
                    {visibleCols.map((p, i) => (
                      <td key={p.id} className="px-2 py-1 truncate max-w-[240px]">
                        {i === 0 ? (
                          <span className="text-gray-800">{r.title || "Untitled"}</span>
                        ) : p.id === "p_title" ? (
                          <span className="text-gray-800">{r.title || "Untitled"}</span>
                        ) : (
                          renderValue(p, r.dataValues[p.id])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={visibleCols.length} className="text-center text-gray-400 py-3">
                      Empty
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {filteredRows.length > ROW_LIMIT && (
            <div className="px-3 py-1 text-[11px] text-gray-400 border-t border-gray-100">
              showing {ROW_LIMIT} of {filteredRows.length} —{" "}
              <Link href={`/w/${data.slug}/p/${data.id}`} className="text-blue-600 hover:underline">
                open full database
              </Link>
            </div>
          )}
        </div>
      );
    },
  },
);

function renderValue(prop: DbSchema["props"][number], v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-gray-300">—</span>;
  if (prop.type === "select") {
    const opt = prop.options.find((o) => o.id === v);
    if (!opt) return null;
    return (
      <span className="inline-block px-1.5 py-0.5 rounded text-[10px]" style={{ background: opt.color }}>
        {opt.name}
      </span>
    );
  }
  if (prop.type === "multi_select") {
    const ids = Array.isArray(v) ? v : [];
    return (
      <span className="flex flex-wrap gap-0.5">
        {ids.map((id: string) => {
          const o = prop.options.find((x) => x.id === id);
          if (!o) return null;
          return (
            <span key={id} className="inline-block px-1 rounded text-[10px]" style={{ background: o.color }}>
              {o.name}
            </span>
          );
        })}
      </span>
    );
  }
  if (prop.type === "checkbox") return v ? "☑" : "";
  if (prop.type === "url" && typeof v === "string") {
    return (
      <a href={v} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline truncate">
        {v.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  return String(v);
}

function DbPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  useEffect(() => {
    const m = /^\/w\/([^/]+)/.exec(window.location.pathname);
    const slug = m ? m[1] : "";
    if (!slug) return;
    fetch(
      `/api/search?ws=${encodeURIComponent(slug)}&q=${encodeURIComponent(q || "")}`,
    )
      .then((r) => r.json())
      .then((d) => {
        const all = (d.hits ?? []) as Hit[];
        setHits(all.filter((h) => h.kind === "database").slice(0, 8));
      });
  }, [q]);
  return (
    <div className="mt-2 border border-gray-200 rounded p-2 bg-white">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search databases…"
        className="w-full border border-gray-200 rounded px-2 py-1 text-sm outline-none mb-2"
      />
      <ul className="max-h-40 overflow-y-auto space-y-0.5">
        {hits.map((h) => (
          <li key={h.id}>
            <button
              onClick={() => onPick(h.id)}
              className="w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded flex items-center gap-2"
            >
              <span>{h.icon ?? "📊"}</span>
              <span className="truncate">{h.title || "Untitled"}</span>
            </button>
          </li>
        ))}
        {hits.length === 0 && (
          <li className="text-xs text-gray-400 px-2 py-1">No databases found.</li>
        )}
      </ul>
    </div>
  );
}
