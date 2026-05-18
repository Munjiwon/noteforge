"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function WorkspaceSwitcher({
  workspaces,
  currentSlug,
}: {
  workspaces: { slug: string; name: string }[];
  currentSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inForm =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        if (workspaces.length > 1) setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % workspaces.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + workspaces.length) % workspaces.length);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const ws = workspaces[highlight];
        if (ws && ws.slug !== currentSlug) {
          router.push(`/w/${ws.slug}`);
        }
        setOpen(false);
      }
      // suppress unused var warning
      void inForm;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, highlight, workspaces, router, currentSlug]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[360px] max-w-[92vw] overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100 text-sm font-medium">
          Switch workspace
        </div>
        <ul>
          {workspaces.map((w, i) => (
            <li key={w.slug}>
              <button
                onClick={() => {
                  setOpen(false);
                  router.push(`/w/${w.slug}`);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={
                  "w-full text-left px-3 py-2 text-sm flex items-center gap-2 " +
                  (i === highlight ? "bg-gray-100" : "hover:bg-black/5")
                }
              >
                <span className="flex-1 truncate">{w.name}</span>
                {w.slug === currentSlug && (
                  <span className="text-[10px] text-gray-400">current</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-gray-100 px-3 py-1.5 text-[10px] text-gray-400">
          ⌘⇧L to toggle · ↑↓ to navigate
        </div>
      </div>
    </div>
  );
}
