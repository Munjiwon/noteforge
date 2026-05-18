"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPage, quickCapture } from "@/app/w/[slug]/actions";

export function QuickAddFab({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="fixed bottom-5 left-5 z-30 no-print" ref={ref}>
      {open && (
        <div className="mb-2 bg-white border border-gray-200 rounded-md shadow-xl py-1 w-52">
          <Item
            label="📝 New page"
            sub="Untitled at workspace root"
            onClick={() =>
              start(async () => {
                await createPage(slug, null);
              })
            }
          />
          <Item
            label="📥 Quick capture"
            sub="⌘⇧I · note into Inbox"
            onClick={() => start(() => quickCapture(slug))}
          />
          <Item
            label="🧩 From template"
            sub="Pick a starter"
            onClick={() => router.push(`/w/${slug}`)}
          />
          <Item
            label="📅 Calendar"
            sub="All due dates"
            onClick={() => router.push(`/w/${slug}/calendar`)}
          />
          <Item
            label="🔎 Search"
            sub="⌘K"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("search-open"))
            }
          />
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-12 h-12 rounded-full bg-gray-900 text-white shadow-lg hover:opacity-90 flex items-center justify-center text-xl"
        title="Quick add"
      >
        {open ? "✕" : "+"}
      </button>
    </div>
  );
}

function Item({
  label,
  sub,
  onClick,
}: {
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 text-xs hover:bg-black/5 flex flex-col"
    >
      <span className="text-gray-900 text-sm">{label}</span>
      <span className="text-gray-400">{sub}</span>
    </button>
  );
}
