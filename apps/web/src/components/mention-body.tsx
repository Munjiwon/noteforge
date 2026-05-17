"use client";

import Link from "next/link";
import { parseMentions } from "@/lib/mentions";

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
          <span key={i}>{seg.text}</span>
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
