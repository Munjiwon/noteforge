"use client";

import { createReactInlineContentSpec } from "@blocknote/react";

export const MentionInline = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: {
      kind: { default: "user", values: ["user", "page", "date"] },
      id: { default: "" },
      label: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const { kind, id, label } = inlineContent.props as {
        kind: "user" | "page" | "date";
        id: string;
        label: string;
      };
      if (kind === "page") {
        return (
          <a
            href={`/w/${getSlugFromUrl()}/p/${id}`}
            className="inline-block bg-gray-100 hover:bg-gray-200 text-gray-800 rounded px-1 mx-0.5 text-[13px] no-underline"
            contentEditable={false}
          >
            ↗ {label || "Untitled"}
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

function getSlugFromUrl(): string {
  if (typeof window === "undefined") return "";
  const m = /^\/w\/([^/]+)/.exec(window.location.pathname);
  return m ? m[1] : "";
}
