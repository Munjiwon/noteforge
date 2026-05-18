"use client";

import { useRef, useState, useTransition } from "react";
import { setPageCover, setPageCoverPos } from "@/app/w/[slug]/actions";

const PRESET_COVERS = [
  "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=1600&q=70",
  "https://images.unsplash.com/photo-1465146344425-f00d5f5c8f07?w=1600&q=70",
  "https://images.unsplash.com/photo-1431440869543-efaf3388c585?w=1600&q=70",
  "https://images.unsplash.com/photo-1518562180175-34a163b1a9a6?w=1600&q=70",
];

const PRESET_GRADIENTS = [
  "gradient:linear-gradient(135deg,#fbcfe8 0%,#a78bfa 100%)",
  "gradient:linear-gradient(135deg,#fde68a 0%,#fb7185 100%)",
  "gradient:linear-gradient(135deg,#bae6fd 0%,#6366f1 100%)",
  "gradient:linear-gradient(135deg,#bbf7d0 0%,#14b8a6 100%)",
  "gradient:linear-gradient(135deg,#fed7aa 0%,#f43f5e 100%)",
  "gradient:linear-gradient(135deg,#111827 0%,#374151 100%)",
];

export function isGradient(cover: string | null): boolean {
  return !!cover && cover.startsWith("gradient:");
}

export function gradientStyle(cover: string): React.CSSProperties {
  return { background: cover.slice("gradient:".length) };
}

export function PageCover({
  slug,
  pageId,
  cover,
  coverPos,
  readOnly,
}: {
  slug: string;
  pageId: string;
  cover: string | null;
  coverPos?: "top" | "center" | "bottom";
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const setCover = (url: string | null) =>
    start(() => setPageCover(slug, pageId, url));

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const form = new FormData();
    form.append("file", f);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) return;
    const data = (await res.json()) as { url: string };
    setCover(data.url);
    setOpen(false);
  };

  if (!cover) {
    if (readOnly) return null;
    return (
      <div className="max-w-3xl mx-auto px-24 pt-4">
        <button
          onClick={() => {
            const url = prompt("Image URL (or cancel for presets)");
            if (url === null) {
              setOpen(true);
              return;
            }
            if (url.trim()) setCover(url.trim());
          }}
          className="text-xs text-gray-400 hover:text-gray-700"
        >
          + Add cover
        </button>
        {open && (
          <CoverPickerInline
            onPick={(url) => {
              setCover(url);
              setOpen(false);
            }}
            onUpload={() => fileRef.current?.click()}
            onClose={() => setOpen(false)}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickFile}
        />
      </div>
    );
  }

  const pos = coverPos ?? "center";
  return (
    <div className="relative group">
      {isGradient(cover) ? (
        <div
          className="w-full h-[200px] md:h-[260px]"
          style={gradientStyle(cover)}
        />
      ) : (
        <img
          src={cover}
          alt=""
          className="w-full h-[200px] md:h-[260px] object-cover"
          style={{ objectPosition: pos === "top" ? "top" : pos === "bottom" ? "bottom" : "center" }}
        />
      )}
      {!readOnly && !isGradient(cover) && (
        <div className="absolute right-4 top-4 opacity-0 group-hover:opacity-100 flex gap-0.5 bg-white/80 backdrop-blur rounded text-xs border border-gray-200">
          {(["top", "center", "bottom"] as const).map((p) => (
            <button
              key={p}
              onClick={() => start(() => setPageCoverPos(slug, pageId, p))}
              className={
                "px-1.5 py-0.5 " + (pos === p ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-black/5")
              }
              title={`Align cover ${p}`}
            >
              {p === "top" ? "⬆" : p === "bottom" ? "⬇" : "⬌"}
            </button>
          ))}
        </div>
      )}
      {!readOnly && (
        <div className="absolute right-4 bottom-4 opacity-0 group-hover:opacity-100 flex gap-1">
          <button
            onClick={() => {
              const url = prompt("New cover URL", cover);
              if (url && url.trim()) setCover(url.trim());
            }}
            className="text-xs bg-white/90 border border-gray-200 rounded px-2 py-1"
          >
            Change
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="text-xs bg-white/90 border border-gray-200 rounded px-2 py-1"
          >
            Upload
          </button>
          <button
            onClick={() => setCover(null)}
            className="text-xs bg-white/90 border border-gray-200 rounded px-2 py-1 text-red-600"
          >
            Remove
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickFile}
          />
        </div>
      )}
    </div>
  );
}

function CoverPickerInline({
  onPick,
  onUpload,
  onClose,
}: {
  onPick: (url: string) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-2 border border-gray-200 rounded-md p-2 bg-white shadow-sm">
      <div className="flex items-center justify-between mb-2 text-xs text-gray-500">
        <span>Pick a cover</span>
        <button onClick={onClose} className="hover:text-gray-900">
          ✕
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {PRESET_COVERS.map((url) => (
          <button
            key={url}
            onClick={() => onPick(url)}
            className="aspect-[16/9] overflow-hidden rounded hover:ring-2 hover:ring-gray-400"
          >
            <img src={url} alt="" className="w-full h-full object-cover" />
          </button>
        ))}
      </div>
      <div className="text-[10px] uppercase text-gray-500 px-1 mt-2 mb-1">Gradients</div>
      <div className="grid grid-cols-6 gap-1">
        {PRESET_GRADIENTS.map((g) => (
          <button
            key={g}
            onClick={() => onPick(g)}
            className="aspect-[16/9] overflow-hidden rounded hover:ring-2 hover:ring-gray-400"
            style={gradientStyle(g)}
            aria-label="gradient cover"
          />
        ))}
      </div>
      <button
        onClick={onUpload}
        className="mt-2 text-xs text-gray-600 hover:text-gray-900"
      >
        Or upload an image…
      </button>
    </div>
  );
}
