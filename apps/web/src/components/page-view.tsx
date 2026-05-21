"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  createPage,
  incrementPageView,
  renamePage,
  setPageIcon,
  setPageStatus,
  togglePageLock,
  togglePagePinned,
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
import { Avatar } from "./avatar";
import { ReadModeButton } from "./read-mode-button";
import { ReadAloudButton } from "./read-aloud-button";
import { ReadingProgress } from "./reading-progress";
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
  workspaceDefaultWidth = "normal",
  aiEnabled = true,
  subPages = [],
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
    pinned?: boolean;
    slug?: string | null;
    expiresAt?: string | null;
    coverCaption?: string | null;
    coverDim?: boolean;
    status?: "draft" | "in_review" | "published" | null;
    lockedUntil?: string | null;
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
    wordGoal?: number | null;
    commentCount: number;
    backlinkCount: number;
    childrenCount: number;
    subscriberCount?: number;
    lastEditor?: { name: string; color: string; avatarUrl?: string | null } | null;
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
  workspaceDefaultWidth?: "normal" | "wide" | "full";
  aiEnabled?: boolean;
  subPages?: { id: string; title: string; icon: string | null; kind: string }[];
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

  // ?focus=1 enables distraction-free reading mode automatically.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("focus") === "1") {
      document.body.classList.add("read-mode");
      return () => document.body.classList.remove("read-mode");
    }
  }, []);

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

  // Word goal celebration — fire once per page per session when the count
  // crosses the goal.
  useEffect(() => {
    if (!info.wordGoal) return;
    if (info.wordCount < info.wordGoal) return;
    const key = `wordGoal:hit:${page.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    const tip = document.createElement("div");
    tip.innerHTML = `🎉 <strong>${info.wordCount}</strong> words — goal reached!`;
    tip.className =
      "fixed bottom-20 left-1/2 -translate-x-1/2 z-50 text-sm bg-emerald-600 text-white rounded-full px-4 py-1.5 shadow-lg";
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 3000);
  }, [page.id, info.wordCount, info.wordGoal]);

  // Word-count chip toggle — persists per page on this device.
  const [wordChipHidden, setWordChipHidden] = useState(false);
  useEffect(() => {
    try {
      setWordChipHidden(
        localStorage.getItem(`hide-wordchip:${page.id}`) === "1",
      );
    } catch {}
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ pageId?: string }>;
      if (!ce.detail || ce.detail.pageId === page.id) {
        try {
          setWordChipHidden(
            localStorage.getItem(`hide-wordchip:${page.id}`) === "1",
          );
        } catch {}
      }
    };
    window.addEventListener("noteforge:wordchip-changed", handler as EventListener);
    return () =>
      window.removeEventListener(
        "noteforge:wordchip-changed",
        handler as EventListener,
      );
  }, [page.id]);

  // ⌘⇧J — jump to the workspace Inbox (the page slugged 'inbox').
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "J" && e.key !== "j") return;
      const t = e.target as HTMLElement | null;
      const inForm =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (inForm) return;
      const link = document.querySelector<HTMLAnchorElement>(
        'aside a[href$="/p/inbox"], aside a[title="Inbox"]',
      );
      if (link) {
        e.preventDefault();
        link.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Scroll-to-top floating button on long pages.
  const [showTop, setShowTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 600);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Apply device-wide style toggles (comments-compact / print-no-comments).
  useEffect(() => {
    try {
      if (localStorage.getItem("noteforge:comments-compact") === "1")
        document.body.classList.add("comments-compact");
      if (localStorage.getItem("noteforge:print-no-comments") === "1")
        document.body.classList.add("print-no-comments");
    } catch {}
  }, []);

  // Resume reading — remember scroll position per page, restore on next visit.
  useEffect(() => {
    const key = `scroll:${page.id}`;
    try {
      const v = localStorage.getItem(key);
      if (v && !window.location.hash) {
        const y = parseInt(v, 10);
        if (Number.isFinite(y) && y > 50) {
          requestAnimationFrame(() => window.scrollTo({ top: y }));
        }
      }
    } catch {}
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          localStorage.setItem(key, String(Math.round(window.scrollY)));
        } catch {}
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, [page.id]);

  // "Last viewed" tooltip — store first time the user opens this page on this
  // device and show it on the title hover.
  const [lastViewed, setLastViewed] = useState<string | null>(null);
  useEffect(() => {
    const key = `lastViewed:${page.id}`;
    try {
      const prev = localStorage.getItem(key);
      if (prev) setLastViewed(prev);
      localStorage.setItem(key, new Date().toISOString());
    } catch {}
  }, [page.id]);

  // ⌘⇧. — wrap the current selection in an Editor-style blockquote prefix.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "." && e.key !== ">") return;
      const sel = window.getSelection?.();
      const text = sel?.toString().trim();
      if (!text) return;
      e.preventDefault();
      try {
        document.execCommand("insertText", false, `> ${text}\n`);
      } catch {}
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const width =
    page.width && page.width !== "normal"
      ? page.width
      : workspaceDefaultWidth ?? "normal";
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
        caption={page.coverCaption ?? null}
        dim={page.coverDim ?? false}
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
          (() => {
            const until = page.lockedUntil ? new Date(page.lockedUntil) : null;
            const remainingMs = until ? until.getTime() - Date.now() : null;
            let chip: string | null = null;
            if (remainingMs !== null && remainingMs > 0) {
              const totalMin = Math.floor(remainingMs / 60_000);
              if (totalMin < 60) chip = `${totalMin}m 남음`;
              else if (totalMin < 60 * 24) chip = `${Math.floor(totalMin / 60)}h ${totalMin % 60}m 남음`;
              else chip = `${Math.floor(totalMin / (60 * 24))}d 남음`;
            }
            const tip = until ? `Locked until ${until.toLocaleString()}` : "Page is locked";
            return (
              <div
                className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1 inline-flex items-center gap-2"
                title={tip}
              >
                <span>🔒 Page locked — read-only</span>
                {chip ? (
                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                    {chip}
                  </span>
                ) : null}
                {canChangeSettings && (
                  <button
                    onClick={() => start(() => togglePageLock(slug, page.id))}
                    className="text-amber-900 hover:underline"
                  >
                    Unlock
                  </button>
                )}
              </div>
            );
          })()
        ) : readOnly ? (
          <div className="mb-3 text-xs text-gray-600 bg-gray-100 border border-gray-200 rounded px-3 py-1 inline-flex items-center gap-1">
            👁 Read-only view
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-1.5 mb-2 no-print">
          <ReadModeButton />
          <ReadAloudButton getText={() => extractText(page.content, title)} />
          <button
            onClick={() => window.print()}
            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
            title="Print or save as PDF (⌘P → 'Save as PDF' destination)"
          >
            🖨 Print / PDF
          </button>
          <PageInfo info={info} workspaceSlug={slug} />
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
            expiresAt={page.expiresAt ?? null}
            pinned={page.pinned ?? false}
            status={page.status ?? null}
            wordGoal={info.wordGoal}
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
            customSlug={page.slug ?? null}
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
          title={
            lastViewed
              ? `Last viewed ${new Date(lastViewed).toLocaleString()}`
              : "First time viewing on this device"
          }
          className="flex-1 text-4xl font-bold outline-none bg-transparent placeholder-gray-300"
        />
        {page.status && (
          <button
            onClick={() => {
              if (readOnly) return;
              const next =
                page.status === "draft"
                  ? "in_review"
                  : page.status === "in_review"
                    ? "published"
                    : null;
              start(() => setPageStatus(slug, page.id, next));
            }}
            disabled={readOnly}
            title={readOnly ? undefined : "Click to advance status"}
            className={
              "text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border " +
              (page.status === "published"
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : page.status === "in_review"
                  ? "bg-amber-50 border-amber-200 text-amber-700"
                  : "bg-gray-100 border-gray-200 text-gray-600") +
              (readOnly ? "" : " hover:opacity-80")
            }
          >
            {page.status === "in_review"
              ? "In review"
              : page.status === "published"
                ? "Published"
                : "Draft"}
          </button>
        )}
        {info.viewCount && info.viewCount >= 50 && (
          <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border bg-orange-50 border-orange-200 text-orange-700">
            🔥 Popular · {info.viewCount}
          </span>
        )}
        {info.childrenCount > 0 && (
          <span
            className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border bg-gray-50 border-gray-200 text-gray-600"
            title={`${info.childrenCount} sub-pages`}
          >
            📁 {info.childrenCount}
          </span>
        )}
        {!readOnly && (
          <button
            onClick={() => start(() => toggleFavorite(slug, page.id))}
            className="text-2xl text-gray-300 hover:text-yellow-500 transition leading-none"
            title={page.favorite ? "Unfavorite" : "Favorite (Cmd+Shift+B)"}
          >
            {page.favorite ? "★" : "☆"}
          </button>
        )}
        {!readOnly && canChangeSettings && (
          <button
            onClick={() => start(() => togglePagePinned(slug, page.id))}
            className={
              "text-lg leading-none transition " +
              (page.pinned
                ? "text-blue-600 hover:opacity-80"
                : "text-gray-300 hover:text-blue-500")
            }
            title={page.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
          >
            📌
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-400 mb-1">
        {info.author && <span>by {info.author.name}</span>}
        <span>· Last edited {relTime(info.updatedAt)}</span>
        {info.lastEditor &&
          info.lastEditor.name !== info.author?.name && (
            <span className="inline-flex items-center gap-1">
              · by{" "}
              <Avatar user={info.lastEditor} size="xs" />
              {info.lastEditor.name}
            </span>
          )}
        {!wordChipHidden && (
          <span className="nf-word-chip" data-page-id={page.id}>
            ⏱ {Math.max(1, Math.round(info.wordCount / 200))} min read · {info.wordCount.toLocaleString()} words
          </span>
        )}
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
      {subPages.length > 0 && (
        <SubPagesSection slug={slug} pageId={page.id} subPages={subPages} readOnly={readOnly} />
      )}
      <Editor
        pageId={page.id}
        slug={slug}
        initialContent={page.content}
        user={user}
        readOnly={readOnly}
        aiEnabled={aiEnabled}
      />
        {backlinks.length > 0 && (
          <BacklinksSection slug={slug} backlinks={backlinks} />
        )}
        <CommentsPanel
          slug={slug}
          pageId={page.id}
          comments={comments}
          currentUserId={user.id}
          readOnly={readOnly}
        />
        <footer className="mt-12 pt-4 border-t border-gray-100 text-[10px] text-gray-400 flex flex-wrap gap-3 no-print">
          <span>Created {new Date(info.createdAt).toLocaleString()}</span>
          <span>· Updated {new Date(info.updatedAt).toLocaleString()}</span>
          <span>· {info.wordCount.toLocaleString()} words</span>
          <span>· {page.content.length.toLocaleString()} chars</span>
          <button
            onClick={() => {
              const url = window.location.href.split("?")[0];
              void navigator.clipboard?.writeText(url).then(() => {
                const tip = document.createElement("div");
                tip.textContent = "Link copied";
                tip.className =
                  "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                document.body.appendChild(tip);
                setTimeout(() => tip.remove(), 1200);
              });
            }}
            className="ml-auto text-gray-500 hover:text-gray-900"
          >
            🔗 Copy link
          </button>
        </footer>
      </div>
      <ReadingProgress />
      {showTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-20 right-5 z-30 text-xs bg-gray-900 text-white rounded-full px-3 py-1.5 shadow-lg hover:opacity-90 no-print"
          title="Scroll to top"
        >
          ↑ Top
        </button>
      )}
      {aiEnabled && (
        <AskAiPanel slug={slug} getPageText={() => extractText(page.content, title)} />
      )}
    </div>
  );
}

function BacklinksSection({
  slug,
  backlinks,
}: {
  slug: string;
  backlinks: { id: string; title: string; icon: string | null; kind: string }[];
}) {
  const [sort, setSort] = useState<"original" | "alpha">("original");
  const sorted =
    sort === "alpha"
      ? [...backlinks].sort((a, b) =>
          (a.title || "Untitled").localeCompare(b.title || "Untitled"),
        )
      : backlinks;
  return (
    <section className="mt-10 border-t border-gray-200 pt-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center">
        Backlinks
        <span className="ml-2 text-xs text-gray-400">{backlinks.length}</span>
        <button
          onClick={() => setSort((s) => (s === "original" ? "alpha" : "original"))}
          className="ml-auto text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-700"
        >
          {sort === "alpha" ? "A → Z ▾" : "Original ▾"}
        </button>
      </h2>
      <ul className="space-y-1">
        {sorted.map((b) => (
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
  );
}

function SubPagesSection({
  slug,
  pageId,
  subPages,
  readOnly,
}: {
  slug: string;
  pageId: string;
  subPages: { id: string; title: string; icon: string | null; kind: string }[];
  readOnly: boolean;
}) {
  const [sort, setSort] = useState<"original" | "alpha">("original");
  const [, startTx] = useTransition();
  const sorted =
    sort === "alpha"
      ? [...subPages].sort((a, b) =>
          (a.title || "Untitled").localeCompare(b.title || "Untitled"),
        )
      : subPages;
  return (
    <details className="mb-3 border border-gray-100 rounded-md">
      <summary className="cursor-pointer px-3 py-1.5 text-xs uppercase tracking-wide text-gray-500 list-none flex items-center gap-1">
        <span className="text-gray-400">▸</span>
        Sub-pages
        <span className="text-gray-400 ml-1">({subPages.length})</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSort(sort === "original" ? "alpha" : "original");
          }}
          className="ml-auto text-[10px] normal-case tracking-normal text-gray-400 hover:text-gray-700"
        >
          {sort === "original" ? "Order ▾" : "A → Z ▾"}
        </button>
      </summary>
      <ul className="px-2 pb-2 grid sm:grid-cols-2 gap-1">
        {sorted.map((sp) => (
          <li key={sp.id}>
            <a
              href={`/w/${slug}/p/${sp.id}`}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm text-gray-800 hover:bg-black/5"
            >
              <span>{sp.icon ?? (sp.kind === "database" ? "📊" : "📄")}</span>
              <span className="truncate flex-1">{sp.title || "Untitled"}</span>
            </a>
          </li>
        ))}
        {!readOnly && (
          <li>
            <button
              onClick={() => startTx(() => createPage(slug, pageId))}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm text-gray-500 hover:bg-black/5 w-full text-left"
            >
              <span>+</span>
              <span>Add sub-page</span>
            </button>
          </li>
        )}
      </ul>
    </details>
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
