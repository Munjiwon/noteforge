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
type PageData = {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  kind: string;
  content: string;
  slug: string;
  author: { name: string; color: string } | null;
  createdAt: string;
  updatedAt: string;
  activities?: Activity[];
};

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

export function PeekModal({
  pageId,
  onClose,
}: {
  pageId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageId, onClose]);

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
          <span className="text-xs text-gray-500">Peek</span>
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
