"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const StaticEditor = dynamic(
  () => import("./static-editor").then((m) => m.StaticEditor),
  { ssr: false, loading: () => <div className="text-gray-400 text-sm">Loading…</div> },
);

type Activity = {
  id: string;
  action: string;
  meta: string | null;
  createdAt: string;
  user: { name: string; color: string } | null;
};
type RowProp = {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string; color: string }[];
};
type ParentDb = {
  id: string;
  title: string;
  icon: string | null;
  schema: string | null;
  prevRowId?: string | null;
  nextRowId?: string | null;
  rowIndex?: number;
  rowTotal?: number;
};
type PageData = {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  kind: string;
  content: string;
  dataValues?: string | null;
  slug: string;
  author: { name: string; color: string } | null;
  createdAt: string;
  updatedAt: string;
  activities?: Activity[];
  parentDatabase?: ParentDb | null;
};

function parseSchemaJson(s: string | null | undefined): { props: RowProp[] } | null {
  if (!s) return null;
  try {
    const p = JSON.parse(s) as { props?: RowProp[] };
    return Array.isArray(p.props) ? { props: p.props } : null;
  } catch {
    return null;
  }
}
function parseValuesJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function describeActivity(a: Activity): string {
  if (a.action === "cell_changed" && a.meta) {
    try {
      const m = JSON.parse(a.meta) as {
        propId?: string;
        oldValue?: unknown;
        newValue?: unknown;
      };
      const old = formatVal(m.oldValue);
      const next = formatVal(m.newValue);
      const label = m.propId === "p_title" ? "Title" : m.propId ?? "Property";
      return `${label}: ${old || "(empty)"} → ${next || "(empty)"}`;
    } catch {
      return "Cell changed";
    }
  }
  return a.action.replace(/_/g, " ");
}
function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 60);
}

function PeekSelect({
  prop,
  value,
  onChange,
}: {
  prop: RowProp;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const opt = prop.options?.find((o) => o.id === value);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-block px-1.5 py-0.5 rounded text-[10px] hover:ring-1 hover:ring-gray-300"
        style={opt ? { background: opt.color } : { background: "#f3f4f6", color: "#9ca3af" }}
      >
        {opt ? opt.name : "Empty"}
      </button>
      {open && (
        <span
          className="absolute z-50 left-0 top-full mt-1 bg-white border border-gray-200 rounded shadow text-xs min-w-[140px] max-h-48 overflow-y-auto"
          onMouseLeave={() => setOpen(false)}
        >
          <button
            type="button"
            className="block w-full text-left px-2 py-1 hover:bg-black/5 text-gray-400"
            onClick={() => {
              setOpen(false);
              onChange("");
            }}
          >
            ✕ Clear
          </button>
          {prop.options?.map((o) => (
            <button
              key={o.id}
              type="button"
              className="block w-full text-left px-2 py-1 hover:bg-black/5"
              onClick={() => {
                setOpen(false);
                onChange(o.id);
              }}
            >
              <span
                className="inline-block px-1.5 py-0.5 rounded text-[10px] mr-1"
                style={{ background: o.color }}
              >
                {o.name}
              </span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function renderPeekValue(
  prop: RowProp,
  v: unknown,
  onChange?: (next: unknown) => void,
): React.ReactNode {
  const empty =
    v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  if (prop.type === "checkbox") {
    const checked = !!v;
    if (!onChange) return <span>{checked ? "☑" : "☐"}</span>;
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="text-base leading-none hover:text-blue-600"
        title="Toggle"
      >
        {checked ? "☑" : "☐"}
      </button>
    );
  }
  if (prop.type === "select" || prop.type === "status") {
    if (!onChange) {
      const opt = prop.options?.find((o) => o.id === v);
      return opt ? (
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px]" style={{ background: opt.color }}>
          {opt.name}
        </span>
      ) : (
        <span className="text-gray-300">Empty</span>
      );
    }
    return <PeekSelect prop={prop} value={v} onChange={onChange} />;
  }
  if (empty) return <span className="text-gray-300">Empty</span>;
  if (prop.type === "multi_select" && Array.isArray(v)) {
    return (
      <span className="flex flex-wrap gap-0.5">
        {(v as string[]).map((id) => {
          const opt = prop.options?.find((o) => o.id === id);
          return opt ? (
            <span key={id} className="inline-block px-1.5 py-0.5 rounded text-[10px]" style={{ background: opt.color }}>
              {opt.name}
            </span>
          ) : null;
        })}
      </span>
    );
  }
  if (prop.type === "url" && typeof v === "string") {
    return (
      <a href={v} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate">
        {v.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  if (prop.type === "email" && typeof v === "string") {
    return (
      <a href={`mailto:${v}`} className="text-blue-600 hover:underline">
        {v}
      </a>
    );
  }
  return <span className="truncate">{String(v)}</span>;
}

export function PeekModal({
  pageId: initialPageId,
  onClose,
}: {
  pageId: string | null;
  onClose: () => void;
}) {
  const [pageId, setPageId] = useState<string | null>(initialPageId);
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPageId(initialPageId);
  }, [initialPageId]);

  useEffect(() => {
    if (!pageId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/page/${encodeURIComponent(pageId)}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(`${r.status}`)))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  useEffect(() => {
    if (!pageId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && data?.parentDatabase) {
        if (e.key === "ArrowUp" && data.parentDatabase.prevRowId) {
          e.preventDefault();
          setPageId(data.parentDatabase.prevRowId);
        } else if (e.key === "ArrowDown" && data.parentDatabase.nextRowId) {
          e.preventDefault();
          setPageId(data.parentDatabase.nextRowId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageId, onClose, data]);

  if (!pageId) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex justify-end"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="bg-white w-[640px] max-w-[95vw] h-full overflow-y-auto shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Peek</span>
            {data?.parentDatabase && (data.parentDatabase.prevRowId || data.parentDatabase.nextRowId) && (
              <span className="inline-flex items-center gap-1 text-xs">
                <button
                  onClick={() => data.parentDatabase!.prevRowId && setPageId(data.parentDatabase!.prevRowId)}
                  disabled={!data.parentDatabase.prevRowId}
                  className="px-1.5 py-0.5 rounded border border-gray-200 hover:bg-gray-100 text-gray-700 disabled:text-gray-300 disabled:hover:bg-transparent"
                  title="Previous row (⌘↑)"
                >
                  ↑
                </button>
                <button
                  onClick={() => data.parentDatabase!.nextRowId && setPageId(data.parentDatabase!.nextRowId)}
                  disabled={!data.parentDatabase.nextRowId}
                  className="px-1.5 py-0.5 rounded border border-gray-200 hover:bg-gray-100 text-gray-700 disabled:text-gray-300 disabled:hover:bg-transparent"
                  title="Next row (⌘↓)"
                >
                  ↓
                </button>
                {typeof data.parentDatabase.rowIndex === "number" && typeof data.parentDatabase.rowTotal === "number" && data.parentDatabase.rowIndex >= 0 && (
                  <span className="text-[10px] text-gray-400">
                    {data.parentDatabase.rowIndex + 1} / {data.parentDatabase.rowTotal}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {data && (
              <Link
                href={`/w/${data.slug}/p/${data.id}`}
                className="text-xs text-gray-500 hover:text-gray-900"
                onClick={onClose}
              >
                ↗ Open full page
              </Link>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-900">
              ✕
            </button>
          </div>
        </div>
        {error && (
          <div className="p-4 text-sm text-red-600">Failed to load: {error}</div>
        )}
        {data && (
          <div>
            {data.cover && (
              data.cover.startsWith("gradient:") ? (
                <div
                  className="w-full h-[160px]"
                  style={{ background: data.cover.slice("gradient:".length) }}
                />
              ) : (
                <img src={data.cover} alt="" className="w-full h-[160px] object-cover" />
              )
            )}
            <div className="px-6 py-6">
              <div className="text-4xl leading-none mb-2">{data.icon ?? (data.kind === "database" ? "📊" : "📄")}</div>
              <h1 className="text-3xl font-bold mb-4">{data.title || "Untitled"}</h1>
              <div className="text-xs text-gray-400 mb-4">
                {data.author?.name ?? "Unknown"} · last edited{" "}
                {new Date(data.updatedAt).toLocaleString()}
              </div>
              {data.parentDatabase &&
                (() => {
                  const schema = parseSchemaJson(data.parentDatabase.schema);
                  const values = parseValuesJson(data.dataValues);
                  if (!schema) return null;
                  const writeCell = (propId: string, next: unknown) => {
                    setData((prev) => {
                      if (!prev) return prev;
                      const cur = parseValuesJson(prev.dataValues);
                      const upd: Record<string, unknown> = { ...cur, [propId]: next };
                      return { ...prev, dataValues: JSON.stringify(upd) };
                    });
                    void fetch(`/api/page/${encodeURIComponent(data.id)}/cell`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ propId, value: next }),
                    });
                  };
                  return (
                    <div className="mb-4">
                      <Link
                        href={`/w/${data.slug}/p/${data.parentDatabase.id}`}
                        className="text-xs text-gray-500 inline-flex items-center gap-1 hover:text-gray-900 mb-2"
                      >
                        <span>{data.parentDatabase.icon ?? "📊"}</span>
                        <span>{data.parentDatabase.title || "Untitled database"}</span>
                      </Link>
                      <div className="grid grid-cols-[minmax(120px,180px)_1fr] gap-x-3 gap-y-1 text-xs">
                        {schema.props
                          .filter((p) => p.id !== "p_title")
                          .map((p) => (
                            <div key={p.id} className="contents">
                              <div className="text-gray-500 truncate">{p.name}</div>
                              <div className="text-gray-800 truncate">
                                {renderPeekValue(p, values[p.id], (next) =>
                                  writeCell(p.id, next),
                                )}
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  );
                })()}
              <StaticEditor content={data.content} />
              {data.activities && data.activities.length > 0 && (
                <section className="mt-6 border-t border-gray-100 pt-4">
                  <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                    Recent changes
                  </h2>
                  <ul className="space-y-1.5">
                    {data.activities.map((a) => (
                      <li key={a.id} className="flex items-start gap-2 text-xs">
                        {a.user ? (
                          <span
                            className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[9px] font-medium shrink-0 mt-0.5"
                            style={{ background: a.user.color }}
                          >
                            {a.user.name.slice(0, 1).toUpperCase()}
                          </span>
                        ) : (
                          <span className="w-5" />
                        )}
                        <span className="flex-1 min-w-0">
                          <span className="text-gray-700">
                            {a.user?.name ?? "Unknown"}
                          </span>
                          <span className="text-gray-500"> · {describeActivity(a)}</span>
                          <span className="text-gray-400 ml-1">
                            {new Date(a.createdAt).toLocaleString()}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
