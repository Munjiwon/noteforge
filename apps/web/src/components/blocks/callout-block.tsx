"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useState } from "react";

const COLORS: Record<string, { bg: string; border: string }> = {
  gray:   { bg: "#f3f4f6", border: "#d1d5db" },
  yellow: { bg: "#fef9c3", border: "#facc15" },
  blue:   { bg: "#dbeafe", border: "#60a5fa" },
  green:  { bg: "#dcfce7", border: "#4ade80" },
  red:    { bg: "#fee2e2", border: "#f87171" },
};

const EMOJI_CHOICES = ["💡", "📌", "⚠️", "✅", "🔥", "📝", "❓", "🚀", "💬", "❤️"];

export const CalloutBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      emoji: { default: "💡" },
      color: { default: "yellow", values: Object.keys(COLORS) },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const emoji = (block.props.emoji as string) ?? "💡";
      const color = (block.props.color as string) ?? "yellow";
      const palette = COLORS[color] ?? COLORS.yellow;
      const [pickerOpen, setPickerOpen] = useState(false);
      return (
        <div
          className="w-full rounded-md border-l-4 my-1 px-3 py-2 flex gap-2 items-start"
          style={{ background: palette.bg, borderColor: palette.border }}
        >
          <div className="relative">
            <button
              type="button"
              className="text-xl leading-none mt-0.5 hover:bg-black/5 rounded px-1"
              onClick={() => setPickerOpen((o) => !o)}
              title="Change icon"
            >
              {emoji}
            </button>
            {pickerOpen && (
              <div className="absolute top-7 left-0 z-20 bg-white shadow-lg border rounded p-2 grid grid-cols-5 gap-1">
                {EMOJI_CHOICES.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className="text-lg hover:bg-black/5 rounded p-1"
                    onClick={(ev) => {
                      ev.preventDefault();
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      editor.updateBlock(block, { props: { ...(block.props as any), emoji: e } });
                      setPickerOpen(false);
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div ref={contentRef} className="flex-1 outline-none" />
        </div>
      );
    },
  },
);

export const QuoteBlock = createReactBlockSpec(
  {
    type: "quote",
    propSchema: {},
    content: "inline",
  },
  {
    render: ({ contentRef }) => (
      <blockquote
        className="w-full border-l-4 border-gray-400 pl-4 italic text-gray-700 my-1"
      >
        <div ref={contentRef} className="outline-none" />
      </blockquote>
    ),
  },
);

function embedUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, "");
    // YouTube
    if (host === "youtube.com" || host === "m.youtube.com") {
      const v = url.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${v}`;
    }
    if (host === "youtu.be") {
      return `https://www.youtube.com/embed/${url.pathname.slice(1)}`;
    }
    // Vimeo
    if (host === "vimeo.com") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    // Loom
    if (host === "loom.com" && url.pathname.startsWith("/share/")) {
      return raw.replace("/share/", "/embed/");
    }
    // Figma
    if (host === "figma.com") {
      return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(raw)}`;
    }
    // CodeSandbox
    if (host === "codesandbox.io") {
      return raw.includes("/embed/") ? raw : raw.replace("/s/", "/embed/");
    }
    // Generic: allow https iframes
    if (url.protocol === "https:") return raw;
    return null;
  } catch {
    return null;
  }
}

export const EmbedBlock = createReactBlockSpec(
  {
    type: "embed",
    propSchema: {
      url: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const url = (block.props.url as string) ?? "";
      const [editing, setEditing] = useState(url.length === 0);
      const [draft, setDraft] = useState(url);

      const commit = () => {
        editor.updateBlock(block, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          props: { ...(block.props as any), url: draft.trim() },
        });
        setEditing(false);
      };

      if (editing) {
        return (
          <div className="w-full py-2 px-3 bg-gray-50 border border-dashed border-gray-300 rounded">
            <input
              autoFocus
              type="url"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                }
              }}
              onBlur={commit}
              placeholder="Paste a YouTube / Vimeo / Loom / Figma URL…"
              className="w-full bg-transparent outline-none text-sm"
            />
          </div>
        );
      }

      const embed = embedUrl(url);
      if (!embed) {
        return (
          <div
            className="w-full py-2 px-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 cursor-pointer"
            onClick={() => {
              setDraft(url);
              setEditing(true);
            }}
          >
            Could not embed: <code className="font-mono">{url || "(empty)"}</code>
          </div>
        );
      }
      return (
        <div className="w-full my-1 relative group">
          <iframe
            src={embed}
            className="w-full aspect-video rounded border"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-forms"
          />
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 absolute top-2 right-2 bg-white/90 border rounded px-2 py-0.5 text-xs"
            onClick={() => {
              setDraft(url);
              setEditing(true);
            }}
          >
            Edit URL
          </button>
        </div>
      );
    },
  },
);

export const ToggleBlock = createReactBlockSpec(
  {
    type: "toggle",
    propSchema: {
      open: { default: true },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const open = (block.props.open as boolean) ?? true;
      return (
        <div className="w-full my-1">
          <div className="flex items-start gap-1">
            <button
              type="button"
              className="mt-1 text-gray-500 hover:text-gray-900"
              onClick={() => {
                editor.updateBlock(block, {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  props: { ...(block.props as any), open: !open },
                });
              }}
              aria-label={open ? "collapse" : "expand"}
            >
              {open ? "▾" : "▸"}
            </button>
            <div ref={contentRef} className="flex-1 outline-none" />
          </div>
          {!open && (
            <div className="ml-6 mt-1 text-xs text-gray-400 italic">
              (children hidden — expand to view)
            </div>
          )}
        </div>
      );
    },
  },
);
