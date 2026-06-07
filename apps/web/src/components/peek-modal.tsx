"use client";

import { useEffect, useRef, useState } from "react";
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

const PEEK_ICON_PRESETS = [
  "📄", "📊", "📝", "📌", "✅", "💡", "🎯", "🔥",
  "⭐", "📅", "📚", "🏷️", "💬", "🚀", "🧩", "🎨",
];

function PeekIcon({
  pageId,
  icon,
  fallback,
  onChange,
}: {
  pageId: string;
  icon: string | null;
  fallback: string;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const apply = (next: string | null) => {
    setOpen(false);
    onChange(next);
    void fetch(`/api/page/${encodeURIComponent(pageId)}/icon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ icon: next }),
    });
  };
  return (
    <div className="relative mb-2" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-4xl leading-none hover:bg-gray-100 rounded px-1 -mx-1"
        title="Change icon"
      >
        {icon ?? fallback}
      </button>
      {open && (
        <div className="absolute z-50 left-0 top-full mt-1 bg-white border border-gray-200 rounded shadow p-2 w-[260px]">
          <div className="grid grid-cols-8 gap-1 mb-2">
            {PEEK_ICON_PRESETS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => apply(e)}
                className="text-xl leading-none hover:bg-gray-100 rounded p-1"
              >
                {e}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Custom emoji…"
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = (e.currentTarget.value || "").trim();
                if (v) apply(v);
              }
            }}
          />
          <button
            type="button"
            onClick={() => apply(null)}
            className="block w-full text-left text-xs text-gray-500 hover:text-red-600 mt-2 px-1"
          >
            ✕ Remove
          </button>
        </div>
      )}
    </div>
  );
}

function PeekTitle({
  pageId,
  initial,
  onChange,
}: {
  pageId: string;
  initial: string;
  onChange: (t: string) => void;
}) {
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial]);
  const commit = () => {
    const trimmed = v.trim();
    if (trimmed === initial.trim()) return;
    onChange(trimmed);
    void fetch(`/api/page/${encodeURIComponent(pageId)}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
  };
  return (
    <input
      type="text"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setV(initial);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      placeholder="Untitled"
      className="w-full text-3xl font-bold mb-4 bg-transparent outline-none placeholder-gray-300"
    />
  );
}

function PeekMultiSelect({
  prop,
  value,
  onChange,
}: {
  prop: RowProp;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const ids: string[] = Array.isArray(value)
    ? (value as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    onChange(next);
  };
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex flex-wrap gap-0.5 items-center min-h-[18px] hover:ring-1 hover:ring-gray-300 rounded px-1 -mx-1"
      >
        {ids.length === 0 ? (
          <span className="text-gray-300 text-[10px]">Empty</span>
        ) : (
          ids.map((id) => {
            const opt = prop.options?.find((o) => o.id === id);
            return opt ? (
              <span
                key={id}
                className="inline-block px-1.5 py-0.5 rounded text-[10px]"
                style={{ background: opt.color }}
              >
                {opt.name}
              </span>
            ) : null;
          })
        )}
      </button>
      {open && (
        <span
          className="absolute z-50 left-0 top-full mt-1 bg-white border border-gray-200 rounded shadow text-xs min-w-[160px] max-h-48 overflow-y-auto"
          onMouseLeave={() => setOpen(false)}
        >
          {prop.options?.map((o) => {
            const on = ids.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                className="flex w-full items-center gap-2 px-2 py-1 hover:bg-black/5 text-left"
                onClick={() => toggle(o.id)}
              >
                <span className="w-3 text-[10px]">{on ? "✓" : ""}</span>
                <span
                  className="inline-block px-1.5 py-0.5 rounded text-[10px]"
                  style={{ background: o.color }}
                >
                  {o.name}
                </span>
              </button>
            );
          })}
          {prop.options && prop.options.length === 0 && (
            <span className="block px-2 py-1 text-gray-400">No options</span>
          )}
        </span>
      )}
    </span>
  );
}

function PeekText({
  prop,
  value,
  onChange,
}: {
  prop: RowProp;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const initial = value === null || value === undefined ? "" : String(value);
  const [v, setV] = useState(initial);
  const [editing, setEditing] = useState(false);
  useEffect(() => setV(initial), [initial]);
  const commit = () => {
    setEditing(false);
    const trimmed = v;
    if (trimmed === initial) return;
    if (prop.type === "number") {
      const n = trimmed === "" ? null : Number(trimmed);
      onChange(n === null || Number.isNaN(n) ? null : n);
    } else {
      onChange(trimmed === "" ? null : trimmed);
    }
  };
  if (!editing) {
    const empty = initial === "" || initial === "null";
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-left w-full truncate hover:bg-gray-50 rounded px-1 -mx-1"
      >
        {empty ? (
          <span className="text-gray-300">Empty</span>
        ) : prop.type === "url" ? (
          <span className="text-blue-600">{initial.replace(/^https?:\/\//, "")}</span>
        ) : prop.type === "email" ? (
          <span className="text-blue-600">{initial}</span>
        ) : (
          <span>{initial}</span>
        )}
      </button>
    );
  }
  const inputType =
    prop.type === "number"
      ? "number"
      : prop.type === "url"
        ? "url"
        : prop.type === "email"
          ? "email"
          : prop.type === "phone"
            ? "tel"
            : prop.type === "date"
              ? "date"
              : "text";
  return (
    <input
      autoFocus
      type={inputType}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setV(initial);
          setEditing(false);
        }
      }}
      className="w-full bg-white border border-blue-400 rounded px-1 text-xs outline-none"
    />
  );
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
  const editableSimple =
    prop.type === "text" ||
    prop.type === "number" ||
    prop.type === "url" ||
    prop.type === "email" ||
    prop.type === "phone" ||
    prop.type === "date";
  if (editableSimple && onChange) {
    return <PeekText prop={prop} value={v} onChange={onChange} />;
  }
  if (prop.type === "multi_select") {
    if (!onChange) {
      if (!Array.isArray(v) || v.length === 0) {
        return <span className="text-gray-300">Empty</span>;
      }
    } else {
      return <PeekMultiSelect prop={prop} value={v} onChange={onChange} />;
    }
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
              <PeekIcon
                key={`icon-${data.id}`}
                pageId={data.id}
                icon={data.icon}
                fallback={data.kind === "database" ? "📊" : "📄"}
                onChange={(next) =>
                  setData((prev) => (prev ? { ...prev, icon: next } : prev))
                }
              />
              <PeekTitle
                key={data.id}
                pageId={data.id}
                initial={data.title}
                onChange={(t) =>
                  setData((prev) => (prev ? { ...prev, title: t } : prev))
                }
              />
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
