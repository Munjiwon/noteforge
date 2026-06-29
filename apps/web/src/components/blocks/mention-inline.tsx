"use client";

import { createReactInlineContentSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";

type PageData = {
  id: string;
  title: string;
  icon: string | null;
  content: string;
  author?: { name: string; color: string; avatarUrl?: string | null } | null;
};

export const MentionInline = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: {
      kind: { default: "user", values: ["user", "page", "date", "issue"] },
      id: { default: "" },
      label: { default: "" },
      // For kind="issue": project key + issue number to build a self-contained
      // link without an extra fetch. id holds the Issue cuid (used for backlinks).
      projectKey: { default: "" },
      number: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const { kind, id, label, projectKey, number } = inlineContent.props as {
        kind: "user" | "page" | "date" | "issue";
        id: string;
        label: string;
        projectKey: string;
        number: string;
      };
      if (kind === "page") {
        return <PageMention id={id} label={label} />;
      }
      if (kind === "issue") {
        const href =
          projectKey && number
            ? `/w/${getSlugFromUrl()}/work/${projectKey}/issue/${number}`
            : "#";
        return (
          <a
            href={href}
            title={label}
            className="inline-block bg-indigo-50 text-indigo-700 rounded px-1 mx-0.5 text-[13px] font-mono no-underline hover:bg-indigo-100"
            contentEditable={false}
          >
            {projectKey}-{number}
          </a>
        );
      }
      if (kind === "date") {
        return (
          <span
            className="inline-block bg-amber-50 text-amber-800 rounded px-1 mx-0.5 text-[13px]"
            title={id}
            contentEditable={false}
          >
            📅 {label || id}
          </span>
        );
      }
      return (
        <span
          className="inline-block bg-blue-50 text-blue-700 rounded px-1 mx-0.5 text-[13px]"
          contentEditable={false}
        >
          @{label || "User"}
        </span>
      );
    },
  },
);

function PageMention({ id, label }: { id: string; label: string }) {
  const [hover, setHover] = useState(false);
  const [data, setData] = useState<PageData | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hover || !id || data) return;
    fetch(`/api/page/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PageData | null) => setData(d))
      .catch(() => {});
  }, [hover, id, data]);
  return (
    <span
      className="inline-block relative"
      contentEditable={false}
      onMouseEnter={() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setHover(true), 250);
      }}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        setHover(false);
      }}
    >
      <a
        href={`/w/${getSlugFromUrl()}/p/${id}`}
        className="bg-gray-100 hover:bg-gray-200 text-gray-800 rounded px-1 mx-0.5 text-[13px] no-underline"
      >
        ↗ {label || "Untitled"}
      </a>
      {hover && data && (
        <span className="absolute z-50 left-0 top-full mt-1 bg-white border border-gray-200 shadow-lg rounded-md px-3 py-2 text-xs w-64 pointer-events-none">
          <span className="block text-sm font-medium text-gray-900 mb-0.5 truncate">
            {data.icon ?? "📄"} {data.title || "Untitled"}
          </span>
          {data.author && (
            <span className="block text-[10px] text-gray-400 mb-1">
              by {data.author.name}
            </span>
          )}
          <span className="block text-gray-500 line-clamp-3">
            {previewFrom(data.content) || "(no content)"}
          </span>
        </span>
      )}
    </span>
  );
}

function previewFrom(json: string): string {
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return "";
    const out: string[] = [];
    const walk = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const node = b as { content?: unknown; children?: unknown };
      if (Array.isArray(node.content)) {
        for (const it of node.content) {
          if (
            it &&
            typeof it === "object" &&
            "text" in it &&
            typeof (it as { text: unknown }).text === "string"
          ) {
            out.push((it as { text: string }).text);
          }
        }
      }
      if (Array.isArray(node.children)) for (const c of node.children) walk(c);
    };
    for (const b of blocks) walk(b);
    return out.join(" ").trim().slice(0, 180);
  } catch {
    return "";
  }
}

function getSlugFromUrl(): string {
  if (typeof window === "undefined") return "";
  const m = /^\/w\/([^/]+)/.exec(window.location.pathname);
  return m ? m[1] : "";
}
