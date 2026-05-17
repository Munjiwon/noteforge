"use client";

import dynamic from "next/dynamic";

const StaticEditor = dynamic(
  () => import("./static-editor").then((m) => m.StaticEditor),
  { ssr: false, loading: () => <div className="text-gray-400">Loading…</div> },
);

export function PublicPageView({
  title,
  icon,
  cover,
  content,
}: {
  title: string;
  icon: string | null;
  cover: string | null;
  content: string;
}) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 px-6 py-2 flex items-center justify-between">
        <span className="text-sm text-gray-500">📄 Shared page · read-only</span>
        <a href="/login" className="text-xs text-gray-500 hover:text-gray-900">
          Sign in
        </a>
      </header>
      {cover && (
        <img
          src={cover}
          alt=""
          className="w-full h-[200px] md:h-[260px] object-cover"
        />
      )}
      <div className="max-w-3xl mx-auto px-12 md:px-24 py-10">
        <div className="text-4xl leading-none mb-2">{icon ?? "📄"}</div>
        <h1 className="text-4xl font-bold mb-6">{title || "Untitled"}</h1>
        <StaticEditor content={content} />
      </div>
    </div>
  );
}
