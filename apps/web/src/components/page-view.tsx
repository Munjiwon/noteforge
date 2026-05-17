"use client";

import dynamic from "next/dynamic";
import { useState, useTransition } from "react";
import { renamePage, setPageIcon } from "@/app/w/[slug]/actions";
import { CommentsPanel, type CommentItem } from "./comments-panel";
import { ShareButton } from "./share-button";
import { PageCover } from "./page-cover";
import { HistoryButton, type SnapshotItem } from "./history-button";
import { ExportButton } from "./export-button";
import { PageInfo } from "./page-info";
import type { PermItem } from "./share-button";

const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="px-24 py-10 text-gray-400">Loading editor…</div>,
});

const EMOJI_CHOICES = ["📄", "📝", "📌", "✅", "🚀", "💡", "📊", "🐛", "🎯", "🗂️", "🔥", "👋"];

export function PageView({
  slug,
  page,
  user,
  role,
  comments,
  snapshots,
  backlinks,
  info,
  permissions,
}: {
  slug: string;
  page: {
    id: string;
    title: string;
    icon: string | null;
    content: string;
    cover?: string | null;
    publicAccess?: "none" | "view";
    publicSlug?: string | null;
  };
  user: { id: string; name: string; color: string };
  role: "owner" | "editor" | "viewer";
  comments: CommentItem[];
  snapshots: SnapshotItem[];
  backlinks: { id: string; title: string; icon: string | null; kind: string }[];
  info: {
    author: { name: string; color: string } | null;
    createdAt: string;
    updatedAt: string;
    wordCount: number;
    commentCount: number;
    backlinkCount: number;
    childrenCount: number;
  };
  permissions: PermItem[];
}) {
  const [title, setTitle] = useState(page.title);
  const [icon, setIcon] = useState(page.icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, start] = useTransition();
  const readOnly = role === "viewer";

  return (
    <div>
      <PageCover
        slug={slug}
        pageId={page.id}
        cover={page.cover ?? null}
        readOnly={readOnly}
      />
      <div className="max-w-3xl mx-auto px-24 py-10">
        <div className="flex justify-end gap-2 mb-2">
          <PageInfo info={info} />
          <ExportButton slug={slug} pageId={page.id} title={page.title} />
          <HistoryButton
            slug={slug}
            pageId={page.id}
            snapshots={snapshots}
            canEdit={!readOnly}
          />
          <ShareButton
            slug={slug}
            pageId={page.id}
            initialAccess={page.publicAccess ?? "none"}
            initialPublicSlug={page.publicSlug ?? null}
            initialPermissions={permissions}
            canEdit={!readOnly}
          />
        </div>
      <div className="relative flex items-center gap-2 mb-2">
        <button
          className="text-4xl leading-none hover:bg-black/5 rounded px-1"
          onClick={() => setPickerOpen((o) => !o)}
          disabled={readOnly}
          aria-label="change icon"
        >
          {icon ?? "📄"}
        </button>
        {pickerOpen && (
          <div className="absolute top-12 left-0 z-10 bg-white shadow-lg border rounded p-2 grid grid-cols-6 gap-1">
            {EMOJI_CHOICES.map((e) => (
              <button
                key={e}
                className="text-xl hover:bg-black/5 rounded p-1"
                onClick={() => {
                  setIcon(e);
                  setPickerOpen(false);
                  start(() => setPageIcon(slug, page.id, e));
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title !== page.title) start(() => renamePage(slug, page.id, title));
        }}
        disabled={readOnly}
        placeholder="Untitled"
        className="w-full text-4xl font-bold outline-none bg-transparent placeholder-gray-300 mb-4"
      />
      <Editor
        pageId={page.id}
        slug={slug}
        initialContent={page.content}
        user={user}
        readOnly={readOnly}
      />
        {backlinks.length > 0 && (
          <section className="mt-10 border-t border-gray-200 pt-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              Backlinks
              <span className="ml-2 text-xs text-gray-400">{backlinks.length}</span>
            </h2>
            <ul className="space-y-1">
              {backlinks.map((b) => (
                <li key={b.id}>
                  <a
                    href={`/w/${slug}/p/${b.id}`}
                    className="flex items-center gap-2 text-sm text-gray-700 hover:bg-black/5 rounded px-2 py-1"
                  >
                    <span>{b.icon ?? (b.kind === "database" ? "📊" : "📄")}</span>
                    <span className="truncate">{b.title || "Untitled"}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        <CommentsPanel
          slug={slug}
          pageId={page.id}
          comments={comments}
          currentUserId={user.id}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
