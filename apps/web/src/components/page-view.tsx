"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  incrementPageView,
  renamePage,
  setPageIcon,
  toggleFavorite,
} from "@/app/w/[slug]/actions";
import { CommentsPanel, type CommentItem } from "./comments-panel";
import { ShareButton } from "./share-button";
import { PageCover } from "./page-cover";
import { HistoryButton, type SnapshotItem } from "./history-button";
import { ExportButton } from "./export-button";
import { PageInfo } from "./page-info";
import { PageStyleMenu, fontClass, widthClass } from "./page-style-menu";
import { EmojiPicker } from "./emoji-picker";
import { PageOutline } from "./page-outline";
import { PageTags, parseTags } from "./page-tags";
import { PageReactions, type PageReactionGroup } from "./page-reactions";
import { SubscribeButton } from "./subscribe-button";
import { ReminderButton, type PendingReminder } from "./reminder-button";
import { ReadModeButton } from "./read-mode-button";
import { AskAiPanel } from "./ask-ai-panel";
import type { PermItem } from "./share-button";

const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="px-24 py-10 text-gray-400">Loading editor…</div>,
});


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
  ancestors,
  rowContext,
  reactions = [],
  subscribed = false,
  reminders = [],
  workspaceDefaultFont = "default",
  canChangeSettings = false,
}: {
  slug: string;
  page: {
    id: string;
    title: string;
    icon: string | null;
    content: string;
    cover?: string | null;
    coverPos?: string | null;
    tags?: string | null;
    publicAccess?: "none" | "view";
    publicSlug?: string | null;
    publicViewCount?: number;
    locked?: boolean;
    width?: "normal" | "wide" | "full";
    font?: "default" | "serif" | "mono";
    isTemplate?: boolean;
    favorite?: boolean;
    slug?: string | null;
  };
  canChangeSettings?: boolean;
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
  ancestors?: { id: string; title: string; icon: string | null }[];
  rowContext?: {
    dbId: string;
    dbTitle: string;
    dbIcon: string | null;
    schema?: { props: { id: string; name: string; type: string; options?: { id: string; name: string; color: string }[] }[] };
    dataValues?: Record<string, unknown>;
  } | null;
  reactions?: PageReactionGroup[];
  subscribed?: boolean;
  reminders?: PendingReminder[];
  workspaceDefaultFont?: "default" | "serif" | "mono";
}) {
  const [title, setTitle] = useState(page.title);
  const [icon, setIcon] = useState(page.icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, start] = useTransition();
  const readOnly = role === "viewer";
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // auto-focus title input when opening a freshly-created page (empty/Untitled)
    if (!readOnly && (page.title === "" || page.title === "Untitled")) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Set the browser tab favicon to the page icon while this page is open.
  useEffect(() => {
    if (!page.icon) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="56">${page.icon}</text></svg>`;
    const href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    const prev = link?.href ?? null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = href;
    return () => {
      if (link && prev !== null) link.href = prev;
    };
  }, [page.icon]);

  // Increment view count once per session per page.
  useEffect(() => {
    const key = `viewed:${page.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    void incrementPageView(slug, page.id);
  }, [page.id, slug]);

  // Auto-scroll to anchored block (?b) or comment (?c)
  useEffect(() => {
    const u = new URL(window.location.href);
    const b = u.searchParams.get("b");
    const c = u.searchParams.get("c");
    const targetSelector = b
      ? `[data-id="${b}"]`
      : c
      ? `[data-comment-id="${c}"]`
      : null;
    if (!targetSelector) return;
    let attempts = 0;
    const tick = () => {
      const el = document.querySelector(targetSelector) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-blue-300", "rounded");
        setTimeout(() => el.classList.remove("ring-2", "ring-blue-300", "rounded"), 2500);
        return;
      }
      attempts++;
      if (attempts < 20) setTimeout(tick, 200);
    };
    tick();
  }, [page.id]);

  const width = page.width ?? "normal";
  // page.font="default" means "follow workspace default"
  const effFont =
    page.font && page.font !== "default" ? page.font : workspaceDefaultFont;
  const font = effFont ?? "default";
  return (
    <div className={fontClass(font)}>
      <PageOutline content={page.content} />
      <PageCover
        slug={slug}
        pageId={page.id}
        cover={page.cover ?? null}
        coverPos={
          page.coverPos === "top" || page.coverPos === "bottom"
            ? page.coverPos
            : "center"
        }
        readOnly={readOnly}
      />
      <div className={`${widthClass(width)} mx-auto px-12 md:px-24 py-10`}>
        {rowContext && (
          <div className="mb-2 no-print">
            <a
              href={`/w/${slug}/p/${rowContext.dbId}`}
              className="text-xs text-gray-500 inline-flex items-center gap-1 hover:text-gray-900"
            >
              <span>{rowContext.dbIcon ?? "📊"}</span>
              <span>Row in {rowContext.dbTitle || "Untitled database"}</span>
            </a>
            {rowContext.schema && rowContext.dataValues && (
              <div className="mt-1 flex flex-wrap gap-1">
                {rowContext.schema.props
                  .filter((p) => p.id !== "p_title")
                  .slice(0, 6)
                  .map((p) => {
                    const v = rowContext.dataValues![p.id];
                    if (v === null || v === undefined || v === "") return null;
                    let display: React.ReactNode = String(v);
                    if (p.type === "select" || p.type === "status") {
                      const opt = p.options?.find((o) => o.id === v);
                      if (!opt) return null;
                      display = (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[10px]"
                          style={{ background: opt.color }}
                        >
                          {opt.name}
                        </span>
                      );
                    } else if (p.type === "checkbox") {
                      display = v ? "☑" : "☐";
                    } else if (p.type === "multi_select" && Array.isArray(v)) {
                      display = (
                        <span className="flex flex-wrap gap-0.5">
                          {(v as string[]).map((id) => {
                            const opt = p.options?.find((o) => o.id === id);
                            return opt ? (
                              <span
                                key={id}
                                className="inline-block px-1.5 py-0.5 rounded text-[10px]"
                                style={{ background: opt.color }}
                              >
                                {opt.name}
                              </span>
                            ) : null;
                          })}
                        </span>
                      );
                    }
                    return (
                      <span
                        key={p.id}
                        className="inline-flex items-center gap-1 text-[11px] text-gray-600"
                      >
                        <span className="text-gray-400">{p.name}:</span>
                        {display}
                      </span>
                    );
                  })}
              </div>
            )}
          </div>
        )}
        {ancestors && ancestors.length > 0 && (
          <nav className="mb-2 flex items-center gap-1 text-xs text-gray-500 no-print">
            {ancestors.map((a) => (
              <span key={a.id} className="inline-flex items-center gap-1">
                <a
                  href={`/w/${slug}/p/${a.id}`}
                  className="hover:text-gray-900 inline-flex items-center gap-1"
                >
                  <span>{a.icon ?? "📄"}</span>
                  <span className="truncate max-w-[160px]">{a.title || "Untitled"}</span>
                </a>
                <span className="text-gray-300">/</span>
              </span>
            ))}
          </nav>
        )}
        {page.locked ? (
          <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1 inline-flex items-center gap-1">
            🔒 Page locked — read-only
          </div>
        ) : readOnly ? (
          <div className="mb-3 text-xs text-gray-600 bg-gray-100 border border-gray-200 rounded px-3 py-1 inline-flex items-center gap-1">
            👁 Read-only view
          </div>
        ) : null}
        <div className="flex justify-end gap-2 mb-2 no-print">
          <ReadModeButton />
          <button
            onClick={() => window.print()}
            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
            title="Print or save as PDF"
          >
            🖨 Print
          </button>
          <PageInfo info={info} />
          <SubscribeButton slug={slug} pageId={page.id} subscribed={subscribed} />
          <ReminderButton slug={slug} pageId={page.id} pending={reminders} />
          <ExportButton slug={slug} pageId={page.id} title={page.title} />
          <PageStyleMenu
            slug={slug}
            pageId={page.id}
            width={width}
            font={font}
            locked={page.locked ?? false}
            isTemplate={page.isTemplate ?? false}
            customSlug={page.slug ?? null}
            canEdit={canChangeSettings}
          />
          <HistoryButton
            slug={slug}
            pageId={page.id}
            snapshots={snapshots}
            currentContent={page.content}
            canEdit={!readOnly}
          />
          <ShareButton
            slug={slug}
            pageId={page.id}
            initialAccess={page.publicAccess ?? "none"}
            initialPublicSlug={page.publicSlug ?? null}
            initialPermissions={permissions}
            publicViewCount={page.publicViewCount}
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
          <EmojiPicker
            onPick={(e) => {
              setIcon(e);
              start(() => setPageIcon(slug, page.id, e));
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      <div className="flex items-center gap-2 mb-3">
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== page.title) start(() => renamePage(slug, page.id, title));
          }}
          disabled={readOnly}
          placeholder="Untitled"
          className="flex-1 text-4xl font-bold outline-none bg-transparent placeholder-gray-300"
        />
        {!readOnly && (
          <button
            onClick={() => start(() => toggleFavorite(slug, page.id))}
            className="text-2xl text-gray-300 hover:text-yellow-500 transition leading-none"
            title={page.favorite ? "Unfavorite" : "Favorite (Cmd+Shift+B)"}
          >
            {page.favorite ? "★" : "☆"}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-400 mb-1">
        {info.author && (
          <span>
            by {info.author.name}
          </span>
        )}
        <span>· Last edited {relTime(info.updatedAt)}</span>
        <span>· {Math.max(1, Math.round(info.wordCount / 200))} min read</span>
      </div>
      <PageReactions
        slug={slug}
        pageId={page.id}
        groups={reactions}
        readOnly={readOnly}
      />
      <PageTags
        slug={slug}
        pageId={page.id}
        initial={parseTags(page.tags ?? null)}
        readOnly={readOnly}
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
      <AskAiPanel slug={slug} getPageText={() => extractText(page.content, title)} />
    </div>
  );
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

function extractText(json: string, fallbackTitle: string): string {
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return fallbackTitle;
    const parts: string[] = [fallbackTitle];
    const walk = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const node = b as { content?: unknown; children?: unknown };
      const c = node.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (
            it &&
            typeof it === "object" &&
            "text" in it &&
            typeof (it as { text: unknown }).text === "string"
          ) {
            parts.push((it as { text: string }).text);
          }
        }
      }
      if (Array.isArray(node.children)) for (const ch of node.children) walk(ch);
    };
    for (const b of blocks) walk(b);
    return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return fallbackTitle;
  }
}
