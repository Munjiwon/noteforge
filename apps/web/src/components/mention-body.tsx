"use client";

import Link from "next/link";
import { parseMentions } from "@/lib/mentions";
import type { ReactNode } from "react";

function renderMd(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: image -> link -> bold -> italic -> code
  const re = /(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let lastIdx = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) out.push(<span key={i++}>{text.slice(lastIdx, idx)}</span>);
    const token = m[0];
    if (token.startsWith("![")) {
      out.push(
        <img
          key={i++}
          src={m[3]}
          alt={m[2] ?? ""}
          className="max-h-40 inline-block rounded my-1"
        />,
      );
    } else if (token.startsWith("[")) {
      out.push(
        <a
          key={i++}
          href={m[5]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 underline"
        >
          {m[4]}
        </a>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={i++}>{m[6]}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={i++}>{m[7]}</em>);
    } else if (token.startsWith("`")) {
      out.push(
        <code key={i++} className="bg-gray-100 rounded px-1 text-[12px]">
          {m[8]}
        </code>,
      );
    }
    lastIdx = idx + token.length;
  }
  if (lastIdx < text.length) out.push(<span key={i++}>{text.slice(lastIdx)}</span>);
  return out;
}

export function MentionBody({
  body,
  slug,
}: {
  body: string;
  slug: string;
}) {
  const segments = parseMentions(body);
  return (
    <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{renderMd(seg.text)}</span>
        ) : seg.token.type === "user" ? (
          <span
            key={i}
            className="inline-block bg-blue-50 text-blue-700 rounded px-1 mx-0.5 text-[13px]"
          >
            @{seg.token.label}
          </span>
        ) : seg.token.type === "date" ? (
          <span
            key={i}
            className="inline-block bg-amber-50 text-amber-800 rounded px-1 mx-0.5 text-[13px]"
            title={seg.token.id}
          >
            📅 {seg.token.label}
          </span>
        ) : (
          <Link
            key={i}
            href={`/w/${slug}/p/${seg.token.id}`}
            className="inline-block bg-gray-100 hover:bg-gray-200 text-gray-800 rounded px-1 mx-0.5 text-[13px]"
          >
            ↗ {seg.token.label}
          </Link>
        ),
      )}
    </p>
  );
}
