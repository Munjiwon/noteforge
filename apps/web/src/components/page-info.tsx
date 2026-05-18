"use client";

import { useEffect, useRef, useState } from "react";

export function PageInfo({
  info,
}: {
  info: {
    author: { name: string; color: string } | null;
    createdAt: string;
    updatedAt: string;
    wordCount: number;
    commentCount: number;
    backlinkCount: number;
    childrenCount: number;
    viewCount?: number;
    activity?: {
      id: string;
      action: string;
      createdAt: string;
      user: { name: string; color: string } | null;
    }[];
  };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
        title="Page info"
      >
        ⓘ
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded-md shadow-lg w-[260px] p-3 text-sm space-y-2">
          <Row label="Created">
            {new Date(info.createdAt).toLocaleString()}
          </Row>
          <Row label="Last edited">
            {new Date(info.updatedAt).toLocaleString()}
          </Row>
          {info.author && (
            <Row label="Author">
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium"
                  style={{ background: info.author.color }}
                >
                  {info.author.name.slice(0, 1).toUpperCase()}
                </span>
                <span>{info.author.name}</span>
              </span>
            </Row>
          )}
          <div className="border-t border-gray-100 pt-2 grid grid-cols-2 gap-y-1 text-xs">
            <span className="text-gray-500">Words</span>
            <span className="text-right">{info.wordCount.toLocaleString()}</span>
            <span className="text-gray-500">Sub-pages</span>
            <span className="text-right">{info.childrenCount}</span>
            <span className="text-gray-500">Comments</span>
            <span className="text-right">{info.commentCount}</span>
            <span className="text-gray-500">Backlinks</span>
            <span className="text-right">{info.backlinkCount}</span>
            {typeof info.viewCount === "number" && (
              <>
                <span className="text-gray-500">Views</span>
                <span className="text-right">{info.viewCount.toLocaleString()}</span>
              </>
            )}
          </div>
          {info.activity && info.activity.length > 0 && (
            <div className="border-t border-gray-100 pt-2">
              <div className="text-xs text-gray-500 mb-1">Recent activity</div>
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {info.activity.map((a) => (
                  <li key={a.id} className="text-[11px] flex items-center gap-1 text-gray-600">
                    {a.user ? (
                      <span
                        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-[8px] font-medium shrink-0"
                        style={{ background: a.user.color }}
                      >
                        {a.user.name.slice(0, 1).toUpperCase()}
                      </span>
                    ) : (
                      <span className="w-4" />
                    )}
                    <span className="truncate">
                      <span className="font-medium">{a.user?.name ?? "Someone"}</span>{" "}
                      {actionLabel(a.action)}
                    </span>
                    <span className="ml-auto text-gray-400 shrink-0">
                      {relative(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function actionLabel(a: string): string {
  switch (a) {
    case "created": return "created the page";
    case "renamed": return "renamed";
    case "deleted": return "moved to trash";
    case "restored": return "restored";
    case "shared": return "enabled sharing";
    case "unshared": return "stopped sharing";
    case "snapshot": return "saved a snapshot";
    default: return a;
  }
}

function relative(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className="text-xs text-gray-700 text-right">{children}</span>
    </div>
  );
}
