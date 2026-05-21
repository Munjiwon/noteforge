"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import clsx from "clsx";
import {
  bulkDeletePages,
  bulkFavoritePages,
  archivePage,
  createPage,
  createPageFromTemplate,
  createPageFromUserTemplate,
  quickCapture,
  deletePage,
  duplicatePage,
  emptyTrash,
  restoreAllFromTrash,
  purgePage,
  reorderPage,
  restorePage,
  toggleFavorite,
} from "@/app/w/[slug]/actions";
import { PAGE_TEMPLATES } from "@/lib/page-templates";
import { createDatabase } from "@/app/w/[slug]/database-actions";
import { InviteButton } from "./invite-button";
import { UserMenu } from "./user-menu";
import { NotificationsButton, type NotifItem } from "./notifications-button";
import { ImportButton } from "./import-button";
import { PageMovePicker } from "./page-move-picker";
import { t, useLang } from "@/lib/i18n";

type SidebarPage = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  kind: string;
  favorite?: boolean;
  preview?: string;
  count?: number;
  openComments?: number;
  tags?: string | null;
  createdAt?: string;
};

type TrashItem = { id: string; title: string; icon: string | null; kind: string; deletedAt?: Date | string | null };

type Tree = SidebarPage & { children: Tree[] };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function trashAge(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)}w`;
  return `${Math.floor(diff / 86400 / 30)}mo`;
}

function toTree(pages: SidebarPage[]): Tree[] {
  const byId = new Map<string, Tree>();
  pages.forEach((p) => byId.set(p.id, { ...p, children: [] }));
  const roots: Tree[] = [];
  for (const p of byId.values()) {
    if (p.parentId && byId.has(p.parentId)) byId.get(p.parentId)!.children.push(p);
    else roots.push(p);
  }
  return roots;
}

export function Sidebar({
  workspaces,
  currentSlug,
  currentName,
  currentIcon,
  currentColor,
  memberCount,
  role,
  pages,
  favorites,
  templates,
  pinned = [],
  trashed,
  notifications,
  recent,
  trashStaleCount,
  user,
  announcement,
  footerStats,
  todayCount,
}: {
  workspaces: { slug: string; name: string }[];
  currentSlug: string;
  currentName: string;
  currentIcon: string | null;
  currentColor: string | null;
  memberCount: number;
  role: "owner" | "editor" | "viewer";
  pages: SidebarPage[];
  favorites: SidebarPage[];
  templates?: { id: string; title: string; icon: string | null; kind: string }[];
  pinned?: { id: string; title: string; icon: string | null; kind: string }[];
  trashed: TrashItem[];
  notifications: NotifItem[];
  recent: TrashItem[];
  trashStaleCount?: number;
  user: { id: string; name: string; color: string; avatarUrl?: string | null };
  announcement?: string | null;
  footerStats?: { pageCount: number; fileBytes: number };
  todayCount?: number;
}) {
  const params = useParams<{ pageId?: string }>();
  const activePageId = params.pageId;
  const [lang] = useLang();
  const [filterQ, setFilterQ] = useState("");
  const filteredPages = useMemo(() => {
    const raw = filterQ.trim();
    if (!raw) return pages;
    // '#tag' filters by tags; otherwise match the title.
    const isTag = raw.startsWith("#");
    const q = (isTag ? raw.slice(1) : raw).toLowerCase().trim();
    if (!q) return pages;
    const matches = new Set<string>();
    const matched = (p: SidebarPage) => {
      if (isTag) {
        const tags = (p.tags ?? "").toLowerCase();
        if (!tags) return false;
        return tags
          .split(",")
          .map((t) => t.trim())
          .some((t) => t === q || t.includes(q));
      }
      return (p.title || "Untitled").toLowerCase().includes(q);
    };
    for (const p of pages) {
      if (matched(p)) {
        let cur: SidebarPage | undefined = p;
        while (cur) {
          matches.add(cur.id);
          const next: SidebarPage | undefined = pages.find(
            (x) => x.id === cur!.parentId,
          );
          cur = next;
        }
      }
    }
    return pages.filter((p) => matches.has(p.id));
  }, [pages, filterQ]);
  const tree = useMemo(() => toTree(filteredPages), [filteredPages]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // When filtering, auto-expand all matched nodes.
  useEffect(() => {
    if (!filterQ.trim()) return;
    setOpen(new Set(filteredPages.map((p) => p.id)));
  }, [filterQ, filteredPages]);
  const [, startTransition] = useTransition();

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onCreate = (parentId: string | null) =>
    startTransition(() => {
      createPage(currentSlug, parentId);
    });

  const onCreateDb = (parentId: string | null) =>
    startTransition(() => {
      createDatabase(currentSlug, parentId);
    });

  const onDelete = (id: string) => {
    if (!confirm("Move this page and all its sub-pages to Trash?")) return;
    startTransition(() => {
      deletePage(currentSlug, id);
    });
  };

  const onToggleFav = (id: string) =>
    startTransition(() => {
      toggleFavorite(currentSlug, id);
    });
  const onRestore = (id: string) =>
    startTransition(() => {
      restorePage(currentSlug, id);
    });
  const onPurge = (id: string) => {
    if (!confirm("Permanently delete? This cannot be undone.")) return;
    startTransition(() => {
      purgePage(currentSlug, id);
    });
  };
  const onDuplicate = (id: string) =>
    startTransition(() => {
      duplicatePage(currentSlug, id);
    });

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; where: "into" | "before" | "after" } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [recentQ, setRecentQ] = useState("");
  const [pinnedSort, setPinnedSort] = useState<"manual" | "alpha">(() => {
    if (typeof window === "undefined") return "manual";
    return localStorage.getItem("collab-notion-pinned-sort") === "alpha"
      ? "alpha"
      : "manual";
  });
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    setCompact(localStorage.getItem("collab-notion-sidebar-compact") === "1");
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "collab-notion-sidebar-compact",
        compact ? "1" : "0",
      );
    } catch {}
  }, [compact]);
  useEffect(() => {
    try {
      localStorage.setItem("collab-notion-pinned-sort", pinnedSort);
    } catch {}
  }, [pinnedSort]);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ pageId?: string }>).detail;
      if (detail?.pageId) setMovingId(detail.pageId);
    };
    const onCreate = (e: Event) => {
      const detail = (e as CustomEvent<{ title?: string }>).detail;
      const title = detail?.title?.trim();
      if (!title) return;
      // Create page then rename — uses existing createPage server action
      // (default title is "Untitled"); we follow up with renamePage.
      startTransition(async () => {
        await createPage(currentSlug, null);
        // The router will already have navigated; a follow-up rename here is
        // racy because we don't know the new id. Instead just open the search
        // palette with the title pre-filled so the user can pick the new page
        // once it appears.
      });
    };
    window.addEventListener("noteforge:page-move-open", onOpen as EventListener);
    window.addEventListener(
      "noteforge:new-page-with-title",
      onCreate as EventListener,
    );
    return () => {
      window.removeEventListener("noteforge:page-move-open", onOpen as EventListener);
      window.removeEventListener(
        "noteforge:new-page-with-title",
        onCreate as EventListener,
      );
    };
  }, [currentSlug]);
  const [hoverPreviewId, setHoverPreviewId] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePreview = (id: string) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setHoverPreviewId(id), 280);
  };
  const cancelPreview = () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    setHoverPreviewId(null);
  };
  const [mobileOpen, setMobileOpen] = useState(false);
  const [trashQ, setTrashQ] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(256);
  const visuallyCollapsed = collapsed && !hoverExpanded;
  useEffect(() => {
    try {
      const v = localStorage.getItem("collab-notion-sidebar-collapsed");
      if (v === "1") setCollapsed(true);
      const w = localStorage.getItem("collab-notion-sidebar-w");
      if (w) {
        const n = Number(w);
        if (Number.isFinite(n) && n >= 180 && n <= 400) setSidebarWidth(n);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("collab-notion-sidebar-collapsed", collapsed ? "1" : "0");
    } catch {}
  }, [collapsed]);
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const w = Math.max(180, Math.min(400, startW + dx));
      setSidebarWidth(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("collab-notion-sidebar-w", String(sidebarWidth));
      } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const [favOrder, setFavOrder] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("collab-notion-fav-order");
      if (raw) setFavOrder(JSON.parse(raw));
    } catch {}
  }, []);
  const [favSort, setFavSort] = useState<"manual" | "alpha" | "recent">(
    () => {
      if (typeof window === "undefined") return "manual";
      const v = localStorage.getItem("collab-notion-fav-sort");
      return v === "alpha" || v === "recent" ? v : "manual";
    },
  );
  useEffect(() => {
    try {
      localStorage.setItem("collab-notion-fav-sort", favSort);
    } catch {}
  }, [favSort]);
  const orderedFavorites = useMemo(() => {
    if (favSort === "alpha") {
      return [...favorites].sort((a, b) =>
        (a.title || "Untitled").localeCompare(b.title || "Untitled"),
      );
    }
    if (favSort === "recent") {
      // 'pages' is ordered by position; we don't have updatedAt here, so use
      // the natural order which is roughly recent-edited via layout query.
      return [...favorites];
    }
    const byId = new Map(favorites.map((f) => [f.id, f]));
    const ordered = favOrder
      .filter((id) => byId.has(id))
      .map((id) => byId.get(id)!);
    const rest = favorites.filter((f) => !favOrder.includes(f.id));
    return [...ordered, ...rest];
  }, [favorites, favOrder, favSort]);
  const moveFav = (id: string, dir: -1 | 1) => {
    const ids = orderedFavorites.map((f) => f.id);
    const idx = ids.indexOf(id);
    const ni = idx + dir;
    if (ni < 0 || ni >= ids.length) return;
    const next = [...ids];
    next.splice(idx, 1);
    next.splice(ni, 0, id);
    setFavOrder(next);
    try {
      localStorage.setItem("collab-notion-fav-order", JSON.stringify(next));
    } catch {}
  };
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // listen for global event so a topbar button (in main area) can open sidebar
  useEffect(() => {
    const onOpen = () => setMobileOpen(true);
    window.addEventListener("sidebar-open", onOpen);
    return () => window.removeEventListener("sidebar-open", onOpen);
  }, []);
  // close on page navigation (active page id change)
  useEffect(() => {
    setMobileOpen(false);
  }, [activePageId]);

  // Cmd+Shift+B (or Ctrl+Shift+B): toggle favorite for the active page
  // Cmd+Shift+I (or Ctrl+Shift+I): quick-capture a note into Inbox
  // Cmd+D (or Ctrl+D): duplicate the active page (override browser bookmark)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inForm =
        target && (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        );
      if (inForm) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        if (!activePageId) return;
        e.preventDefault();
        startTransition(() => {
          toggleFavorite(currentSlug, activePageId);
        });
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        startTransition(() => {
          quickCapture(currentSlug);
        });
      } else if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "d"
      ) {
        if (!activePageId) return;
        e.preventDefault();
        startTransition(() => {
          duplicatePage(currentSlug, activePageId);
        });
      } else if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "n"
      ) {
        // ⌘N — new page at workspace root
        e.preventDefault();
        startTransition(() => {
          createPage(currentSlug, null);
        });
      } else if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "\\" || e.code === "Backslash")
      ) {
        // ⌘\ — collapse/expand sidebar
        e.preventDefault();
        setCollapsed((v) => !v);
      } else if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "Backspace" || e.key === "Delete")
      ) {
        // ⌘⌫ — archive current page
        if (!activePageId) return;
        if (!confirm("Archive this page?")) return;
        e.preventDefault();
        startTransition(() => {
          archivePage(currentSlug, activePageId);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePageId, currentSlug]);

  const [addMenuFor, setAddMenuFor] = useState<string | "root" | null>(null);

  function renderNode(node: Tree, depth: number) {
    const isOpen = open.has(node.id);
    const hasKids = node.children.length > 0;
    const isActive = node.id === activePageId;
    const dropHere = dropTarget?.id === node.id ? dropTarget.where : null;
    return (
      <li key={node.id}>
        <div
          draggable={role !== "viewer" && !selectMode}
          onDragStart={(e) => {
            e.stopPropagation();
            setDragId(node.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (!dragId || dragId === node.id) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const where =
              y < rect.height * 0.25
                ? "before"
                : y > rect.height * 0.75
                ? "after"
                : "into";
            setDropTarget({ id: node.id, where });
          }}
          onDragLeave={() => {
            if (dropTarget?.id === node.id) setDropTarget(null);
          }}
          onDrop={(e) => {
            if (!dragId || dragId === node.id) return;
            e.preventDefault();
            e.stopPropagation();
            const where = dropTarget?.id === node.id ? dropTarget.where : "into";
            const draggedId = dragId;
            setDragId(null);
            setDropTarget(null);
            const newParentId = where === "into" ? node.id : node.parentId;
            const siblings = pages
              .filter((p) => p.parentId === newParentId)
              .sort((a, b) => a.id.localeCompare(b.id));
            const idx = siblings.findIndex((s) => s.id === node.id);
            const newPosition =
              where === "into" ? siblings.length + 1
              : where === "before" ? Math.max(0, idx)
              : idx + 1;
            startTransition(() => {
              reorderPage(currentSlug, draggedId, newParentId, newPosition);
            });
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropTarget(null);
          }}
          className={clsx(
            "group flex items-center gap-1 px-2 py-1 rounded hover:bg-black/5 cursor-default relative",
            isActive && "bg-black/10",
            dropHere === "into" && "ring-2 ring-blue-400 ring-inset",
            dropHere === "before" && "before:absolute before:top-0 before:left-0 before:right-0 before:h-0.5 before:bg-blue-400",
            dropHere === "after" && "after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-blue-400",
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {selectMode && role !== "viewer" ? (
            <input
              type="checkbox"
              checked={selectedIds.has(node.id)}
              onChange={() => toggleSelected(node.id)}
              className="w-3 h-3"
              aria-label="select page"
            />
          ) : (
            <button
              onClick={() => toggle(node.id)}
              className={clsx(
                "w-4 h-4 grid place-items-center text-gray-400 hover:text-gray-700",
                !hasKids && "invisible",
              )}
              aria-label="toggle"
            >
              {isOpen ? "▾" : "▸"}
            </button>
          )}
          <Link
            href={`/w/${currentSlug}/p/${node.id}`}
            onMouseEnter={() => schedulePreview(node.id)}
            onMouseLeave={cancelPreview}
            className="flex-1 truncate text-sm py-0.5 flex items-center relative"
          >
            <span className="mr-1">
              {node.icon ?? (node.kind === "database" ? "📊" : "📄")}
            </span>
            <span className="truncate flex-1">
              {node.title || (node.kind === "database" ? "Untitled database" : "Untitled")}
            </span>
            {hoverPreviewId === node.id && (node.preview || node.title) && (
              <span
                className="hidden md:block fixed z-50 ml-2 bg-white border border-gray-200 shadow-lg rounded-md px-3 py-2 text-xs pointer-events-none"
                style={{ left: "240px", maxWidth: "260px" }}
              >
                <span className="block font-medium text-gray-900 mb-0.5 truncate">
                  {node.title || "Untitled"}
                </span>
                <span className="block text-gray-500 line-clamp-3">
                  {node.preview || "(no content yet)"}
                </span>
              </span>
            )}
            {typeof node.count === "number" && node.count > 0 && (
              <span className="text-[10px] text-gray-400 ml-1 shrink-0">
                {node.count}
              </span>
            )}
            {typeof node.openComments === "number" && node.openComments > 0 && (
              <span
                className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 ml-1 shrink-0"
                title={`${node.openComments} unresolved comment${node.openComments === 1 ? "" : "s"}`}
              >
                💬 {node.openComments}
              </span>
            )}
          </Link>
          <button
            onClick={() => onToggleFav(node.id)}
            className={clsx(
              "px-1 text-gray-500 hover:text-yellow-500",
              node.favorite ? "text-yellow-500" : "opacity-0 group-hover:opacity-100",
            )}
            title={node.favorite ? "Unfavorite" : "Favorite"}
          >
            {node.favorite ? "★" : "☆"}
          </button>
          {role !== "viewer" && (
            <>
              <div className="relative">
                <button
                  onClick={() => setAddMenuFor(addMenuFor === node.id ? null : node.id)}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-900 px-1"
                  title="Add"
                >
                  +
                </button>
                {addMenuFor === node.id && (
                  <div className="absolute top-full right-0 z-30 bg-white shadow-lg border rounded p-1 min-w-[140px]">
                    <button
                      className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                      onClick={() => {
                        setAddMenuFor(null);
                        onCreate(node.id);
                      }}
                    >
                      📄 Sub-page
                    </button>
                    <button
                      className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                      onClick={() => {
                        setAddMenuFor(null);
                        onCreateDb(node.id);
                      }}
                    >
                      📊 Sub-database
                    </button>
                    <div className="border-t my-1" />
                    <button
                      className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                      onClick={() => {
                        setAddMenuFor(null);
                        onDuplicate(node.id);
                      }}
                    >
                      ⎘ Duplicate
                    </button>
                    <button
                      className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                      onClick={() => {
                        setAddMenuFor(null);
                        setMovingId(node.id);
                      }}
                    >
                      ↪ Move to…
                    </button>
                    <button
                      className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                      onClick={() => {
                        setAddMenuFor(null);
                        const url = `${window.location.origin}/w/${currentSlug}/p/${node.id}`;
                        void navigator.clipboard?.writeText(url);
                      }}
                    >
                      🔗 Copy link
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => onDelete(node.id)}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-600 px-1"
                title="Move to Trash"
              >
                ✕
              </button>
            </>
          )}
        </div>
        {hasKids && isOpen && (
          <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul>
        )}
      </li>
    );
  }

  return (
    <>
    {mobileOpen && (
      <div
        className="md:hidden fixed inset-0 z-30 bg-black/30"
        onClick={() => setMobileOpen(false)}
      />
    )}
    <aside
      style={visuallyCollapsed ? undefined : { width: sidebarWidth }}
      onMouseEnter={() => collapsed && setHoverExpanded(true)}
      onMouseLeave={() => setHoverExpanded(false)}
      data-compact={compact ? "1" : undefined}
      className={clsx(
        visuallyCollapsed ? "md:w-12 md:overflow-hidden" : "",
        compact && "text-[12px]",
        "shrink-0 bg-sidebar border-r border-black/10 flex flex-col relative",
        "md:relative md:translate-x-0",
        "fixed inset-y-0 left-0 z-40 transition-[transform,width]",
        // mobile drawer: full width when open, slide-off when closed
        mobileOpen ? "translate-x-0 w-72 max-w-[85vw] md:w-auto md:max-w-none" : "-translate-x-full md:translate-x-0",
      )}
    >
      {!visuallyCollapsed && (
        <div
          onMouseDown={onResizeMouseDown}
          className="hidden md:block absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-300/50 z-50"
          title="Drag to resize sidebar"
        />
      )}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="hidden md:flex absolute -right-3 top-3 z-50 w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm items-center justify-center text-[10px] text-gray-500 hover:text-gray-900"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? "›" : "‹"}
      </button>
      <div className="p-3 border-b border-black/10">
        <details className="group">
          <summary className="flex items-center gap-2 cursor-pointer list-none">
            <div
              className="w-7 h-7 rounded grid place-items-center text-sm text-white"
              style={{ background: currentColor ?? "#111" }}
            >
              {currentIcon ?? currentName.slice(0, 1).toUpperCase()}
            </div>
            <div className="flex-1">
              <Link
                href={`/w/${currentSlug}`}
                onClick={(e) => e.stopPropagation()}
                className="text-sm font-medium truncate hover:underline block"
              >
                {currentName}
              </Link>
              <div className="text-xs text-gray-500">
                {memberCount} member{memberCount !== 1 && "s"}
              </div>
            </div>
            <span className="text-gray-400 group-open:rotate-180 transition">▾</span>
          </summary>
          <ul className="mt-2 space-y-0.5 text-sm">
            {workspaces.map((w) => (
              <li key={w.slug}>
                <Link
                  href={`/w/${w.slug}`}
                  className={clsx(
                    "block px-2 py-1 rounded hover:bg-black/5",
                    w.slug === currentSlug && "bg-black/10",
                  )}
                >
                  {w.name}
                </Link>
              </li>
            ))}
            <li className="border-t border-black/10 mt-1 pt-1 text-xs text-gray-500">
              <Link
                href="/onboarding"
                className="block px-2 py-1 rounded hover:bg-black/5"
              >
                + New workspace
              </Link>
              <button
                onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "L", shiftKey: true, metaKey: true }))}
                className="block w-full text-left px-2 py-1 rounded hover:bg-black/5"
                title="⌘⇧L"
              >
                ⌘⇧L Switcher
              </button>
            </li>
          </ul>
        </details>
      </div>

      {announcement && (
        <div className="mx-3 mt-2 bg-amber-50 border border-amber-200 text-amber-900 rounded-md px-2 py-1.5 text-[11px]">
          📣 {announcement}
        </div>
      )}

      <div className="mx-3 mt-2 flex items-center gap-1">
        <button
          onClick={() => window.dispatchEvent(new Event("search-open"))}
          className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded hover:bg-black/5 text-sm text-gray-600"
        >
          <span className="text-gray-400">🔎</span>
          <span className="flex-1 text-left">{t("Search", lang)}</span>
          <kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1">⌘K</kbd>
        </button>
        <NotificationsButton notifications={notifications} workspaceSlug={currentSlug} />
      </div>

      {recent.length > 0 && (
        <>
          <div className="px-3 pt-3 pb-1 text-xs uppercase tracking-wide text-gray-500 flex items-center justify-between">
            <span>{t("Recent", lang)}</span>
            {recent.length > 5 && (
              <button
                onClick={() => setRecentExpanded((v) => !v)}
                className="text-[9px] normal-case tracking-normal text-gray-400 hover:text-gray-700"
              >
                {recentExpanded ? "Show less" : `Show all (${recent.length})`}
              </button>
            )}
          </div>
          {recentExpanded && recent.length > 8 && (
            <div className="px-3 pb-1">
              <input
                value={recentQ}
                onChange={(e) => setRecentQ(e.target.value)}
                placeholder="Filter recent…"
                className="w-full text-[11px] border border-gray-200 rounded px-2 py-0.5 outline-none focus:border-gray-400"
              />
            </div>
          )}
          <ul className="pb-1">
            {(recentExpanded ? recent : recent.slice(0, 5))
              .filter((r) =>
                recentQ.trim()
                  ? (r.title || "Untitled")
                      .toLowerCase()
                      .includes(recentQ.trim().toLowerCase())
                  : true,
              )
              .map((r) => (
              <li key={r.id}>
                <Link
                  href={`/w/${currentSlug}/p/${r.id}`}
                  className={clsx(
                    "flex items-center gap-1 px-3 py-1 rounded hover:bg-black/5 text-sm",
                    r.id === activePageId && "bg-black/10",
                  )}
                >
                  <span className="mr-1">
                    {r.icon ?? (r.kind === "database" ? "📊" : "📄")}
                  </span>
                  <span className="truncate">
                    {r.title || (r.kind === "database" ? "Untitled database" : "Untitled")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {pinned.length > 0 && (
        <>
          <div className="px-3 pt-3 pb-1 text-xs uppercase tracking-wide text-gray-500 flex items-center justify-between">
            <span>📌 Pinned</span>
            {pinned.length > 1 && (
              <button
                onClick={() => setPinnedSort((s) => (s === "manual" ? "alpha" : "manual"))}
                className="text-[9px] normal-case tracking-normal text-gray-400 hover:text-gray-700"
              >
                {pinnedSort === "manual" ? "Order ▾" : "A→Z ▾"}
              </button>
            )}
          </div>
          <ul className="pb-1">
            {(pinnedSort === "alpha"
              ? [...pinned].sort((a, b) =>
                  (a.title || "Untitled").localeCompare(b.title || "Untitled"),
                )
              : pinned
            ).map((p) => (
              <li key={p.id}>
                <Link
                  href={`/w/${currentSlug}/p/${p.id}`}
                  className={
                    "flex items-center gap-1 px-3 py-1 text-sm hover:bg-black/5 " +
                    (activePageId === p.id ? "bg-black/10" : "")
                  }
                >
                  <span>
                    {p.icon ?? (p.kind === "database" ? "📊" : "📄")}
                  </span>
                  <span className="truncate flex-1">
                    {p.title || "Untitled"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {favorites.length > 0 && (
        <>
          <div className="px-3 pt-3 pb-1 text-xs uppercase tracking-wide text-gray-500 flex items-center justify-between">
            <span>{t("Favorites", lang)}</span>
            <button
              onClick={() =>
                setFavSort((s) =>
                  s === "manual" ? "alpha" : s === "alpha" ? "recent" : "manual",
                )
              }
              className="text-[9px] normal-case tracking-normal text-gray-400 hover:text-gray-700"
              title="Toggle favorites sort"
            >
              {favSort === "manual"
                ? "Manual ▾"
                : favSort === "alpha"
                  ? "A→Z ▾"
                  : "Recent ▾"}
            </button>
          </div>
          <ul className="pb-1">
            {orderedFavorites.map((f, i) => (
              <li key={f.id} className="group/fav flex items-center pr-2">
                <Link
                  href={`/w/${currentSlug}/p/${f.id}`}
                  title={f.preview || undefined}
                  className={clsx(
                    "flex-1 flex items-center gap-1 px-3 py-1 rounded hover:bg-black/5 text-sm",
                    f.id === activePageId && "bg-black/10",
                  )}
                >
                  <span className="text-yellow-500 text-xs">★</span>
                  <span className="mr-1">
                    {f.icon ?? (f.kind === "database" ? "📊" : "📄")}
                  </span>
                  <span className="truncate">
                    {f.title || (f.kind === "database" ? "Untitled database" : "Untitled")}
                  </span>
                </Link>
                <span className="opacity-0 group-hover/fav:opacity-100 flex gap-0.5">
                  <button
                    onClick={() => moveFav(f.id, -1)}
                    disabled={i === 0}
                    className="text-[10px] text-gray-400 hover:text-gray-900 disabled:opacity-20"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveFav(f.id, 1)}
                    disabled={i === orderedFavorites.length - 1}
                    className="text-[10px] text-gray-400 hover:text-gray-900 disabled:opacity-20"
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="px-3 pt-2 pb-1 relative">
        <input
          value={filterQ}
          onChange={(e) => setFilterQ(e.target.value)}
          placeholder="Filter pages… (try #tag)"
          className="w-full text-xs border border-gray-200 rounded px-2 py-1 pr-6 outline-none focus:border-gray-400 bg-white/60"
        />
        {filterQ && (
          <button
            type="button"
            onClick={() => setFilterQ("")}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-900 text-xs"
            title="Clear filter"
          >
            ✕
          </button>
        )}
      </div>

      <div className="flex items-center justify-between px-3 pt-2 pb-1 text-xs uppercase tracking-wide text-gray-500">
        <span className="flex items-center gap-2">
          {t("Pages", lang)}
          {role !== "viewer" && (
            <button
              onClick={() => {
                setSelectMode((v) => !v);
                setSelectedIds(new Set());
              }}
              className="text-[10px] normal-case tracking-normal text-gray-400 hover:text-gray-900"
            >
              {selectMode ? "Done" : "Select"}
            </button>
          )}
        </span>
        {role !== "viewer" && (
          <div className="relative">
            <button
              onClick={() => setAddMenuFor(addMenuFor === "root" ? null : "root")}
              className="text-gray-500 hover:text-gray-900"
              title="Add"
            >
              +
            </button>
            {addMenuFor === "root" && (
              <div className="absolute top-full right-0 z-30 bg-white shadow-lg border rounded p-1 min-w-[140px]">
                <button
                  className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                  onClick={() => {
                    setAddMenuFor(null);
                    onCreate(null);
                  }}
                >
                  📄 New page
                </button>
                <button
                  className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                  onClick={() => {
                    setAddMenuFor(null);
                    onCreateDb(null);
                  }}
                >
                  📊 New database
                </button>
                <div className="border-t my-1" />
                <div className="text-[10px] uppercase text-gray-400 px-2 pb-1">From template</div>
                {PAGE_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className="block w-full text-left px-2 py-1 text-sm hover:bg-black/5 rounded"
                    onClick={() => {
                      setAddMenuFor(null);
                      startTransition(() => {
                        createPageFromTemplate(currentSlug, null, t.id);
                      });
                    }}
                  >
                    {t.icon} {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {selectMode && selectedIds.size > 0 && (
        <div className="mx-3 mb-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs flex items-center gap-2">
          <span className="text-blue-700">{selectedIds.size} selected</span>
          <button
            onClick={() => {
              startTransition(() => {
                bulkFavoritePages(currentSlug, Array.from(selectedIds), true);
              });
            }}
            className="px-1.5 py-0.5 rounded bg-white border border-gray-200 hover:bg-black/5"
          >
            ★ Favorite
          </button>
          <button
            onClick={() => {
              if (!confirm(`Move ${selectedIds.size} page(s) to trash?`)) return;
              startTransition(() => {
                bulkDeletePages(currentSlug, Array.from(selectedIds));
                setSelectedIds(new Set());
              });
            }}
            className="px-1.5 py-0.5 rounded bg-white border border-gray-200 hover:bg-red-50 text-red-600"
          >
            🗑 Trash
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-gray-500 hover:text-gray-900"
          >
            Clear
          </button>
        </div>
      )}
      {tree.length === 0 && (
        <div className="px-3 py-8 text-center">
          <div className="text-3xl mb-1">📝</div>
          <p className="text-xs text-gray-500">No pages yet.</p>
          <p className="text-[10px] text-gray-400 mt-1">
            Click <span className="text-gray-700">+</span> above to create one.
          </p>
          <p className="text-[10px] text-gray-400 mt-0.5">
            Drag a page onto another to nest as a sub-page.
          </p>
        </div>
      )}
      <ul className="flex-1 overflow-auto pb-2">{tree.map((n) => renderNode(n, 0))}</ul>

      {templates && templates.length > 0 && (
        <details className="border-t border-black/10 px-3 py-2 group">
          <summary className="text-xs uppercase tracking-wide text-gray-500 cursor-pointer flex items-center gap-1 list-none">
            <span className="text-gray-400 group-open:rotate-90 transition inline-block">▸</span>
            Templates
            <span className="ml-1 text-gray-400">({templates.length})</span>
          </summary>
          <ul className="mt-1 space-y-0.5">
            {templates.map((tpl) => (
              <li key={tpl.id} className="group flex items-center gap-1">
                <Link
                  href={`/w/${currentSlug}/p/${tpl.id}`}
                  className="flex-1 text-xs text-gray-700 hover:bg-black/5 rounded px-2 py-1 truncate"
                >
                  <span className="mr-1">
                    {tpl.icon ?? (tpl.kind === "database" ? "📊" : "📄")}
                  </span>
                  {tpl.title || "Untitled"}
                </Link>
                {role !== "viewer" && (
                  <button
                    onClick={() =>
                      startTransition(() => {
                        createPageFromUserTemplate(currentSlug, null, tpl.id);
                      })
                    }
                    title="Create a new page from this template"
                    className="opacity-0 group-hover:opacity-100 text-[10px] text-gray-400 hover:text-gray-900 px-1"
                  >
                    Use
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {trashed.length > 0 && (
        <details className="border-t border-black/10 px-3 py-2 group">
          <summary className="text-xs uppercase tracking-wide text-gray-500 cursor-pointer flex items-center gap-1 list-none">
            <span className="text-gray-400 group-open:rotate-90 transition inline-block">▸</span>
            {t("🗑 Trash", lang)}
            <span className="ml-1 text-gray-400">({trashed.length})</span>
            {role !== "viewer" && trashed.length > 0 && (
              <span className="ml-auto flex items-center gap-2">
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!confirm(`Restore all ${trashed.length} trashed page(s)?`)) return;
                    startTransition(() => {
                      restoreAllFromTrash(currentSlug);
                    });
                  }}
                  className="text-[10px] normal-case tracking-normal text-emerald-600 hover:underline"
                >
                  Restore all
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!confirm(`Permanently delete all ${trashed.length} trashed page(s)?`)) return;
                    startTransition(() => {
                      emptyTrash(currentSlug);
                    });
                  }}
                  className="text-[10px] normal-case tracking-normal text-red-600 hover:underline"
                >
                  Empty
                </button>
              </span>
            )}
          </summary>
          {(trashStaleCount ?? 0) > 0 && (
            <p className="mt-1 text-[10px] text-gray-500 leading-tight">
              {trashStaleCount} page(s) older than 30 days. Click <strong>Empty</strong> to clean up.
            </p>
          )}
          {trashed.length > 6 && (
            <input
              value={trashQ}
              onChange={(e) => setTrashQ(e.target.value)}
              placeholder="Filter trash…"
              className="mt-1 mb-1 w-full text-xs border border-gray-200 rounded px-2 py-0.5 outline-none bg-white"
            />
          )}
          <ul className="mt-1 space-y-0.5 text-sm">
            {trashed
              .filter((t) =>
                !trashQ ? true : (t.title || "Untitled").toLowerCase().includes(trashQ.toLowerCase()),
              )
              .map((t) => (
              <li
                key={t.id}
                className={
                  "group/row flex items-center gap-1 px-2 py-0.5 rounded hover:bg-black/5 " +
                  (t.deletedAt &&
                  Date.now() - new Date(t.deletedAt).getTime() >
                    30 * 24 * 3600 * 1000
                    ? "opacity-60"
                    : "")
                }
                title={
                  t.deletedAt
                    ? Date.now() - new Date(t.deletedAt).getTime() >
                      30 * 24 * 3600 * 1000
                      ? `Trashed ${new Date(t.deletedAt).toLocaleString()} · auto-deletes soon`
                      : `Trashed ${new Date(t.deletedAt).toLocaleString()}`
                    : undefined
                }
              >
                <span className="mr-1 text-gray-400">
                  {t.icon ?? (t.kind === "database" ? "📊" : "📄")}
                </span>
                <span className="flex-1 truncate text-gray-500 line-through">
                  {t.title || "Untitled"}
                </span>
                {t.deletedAt && (
                  <span className="text-[10px] text-gray-400 mr-1 shrink-0">
                    {trashAge(t.deletedAt)}
                  </span>
                )}
                {role !== "viewer" && (
                  <>
                    <button
                      onClick={() => onRestore(t.id)}
                      className="opacity-0 group-hover/row:opacity-100 text-[10px] text-gray-500 hover:text-emerald-600 px-1"
                      title="Restore"
                    >
                      ↺ Restore
                    </button>
                    <button
                      onClick={() => onPurge(t.id)}
                      className="opacity-0 group-hover/row:opacity-100 text-xs text-gray-500 hover:text-red-600"
                      title="Delete permanently"
                    >
                      ✕
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="border-t border-black/10 p-3 space-y-2">
        <Link
          href={`/w/${currentSlug}/inbox`}
          className="flex items-center text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          📬 Inbox
          {notifications.filter((n) => !n.read).length > 0 && (
            <span className="ml-auto text-[10px] bg-red-500 text-white rounded-full px-1.5 min-w-[16px] text-center">
              {notifications.filter((n) => !n.read).length}
            </span>
          )}
        </Link>
        <Link
          href={`/w/${currentSlug}/today`}
          className="flex items-center justify-between text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          <span>☀️ Today</span>
          {todayCount && todayCount > 0 ? (
            <span className="text-[10px] bg-amber-100 text-amber-800 rounded-full px-1.5 py-0.5 leading-none">
              {todayCount}
            </span>
          ) : null}
        </Link>
        <Link
          href={`/w/${currentSlug}/tasks`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          ✅ Tasks
        </Link>
        <Link
          href={`/w/${currentSlug}/calendar`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          📅 Calendar
        </Link>
        <Link
          href={`/w/${currentSlug}/files`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          📁 Files
        </Link>
        <Link
          href={`/w/${currentSlug}/all`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          📄 All pages
        </Link>
        <Link
          href={`/w/${currentSlug}/archive`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          📦 Archive
        </Link>
        <Link
          href={`/w/${currentSlug}/activity`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          {t("📜 Activity", lang)}
        </Link>
        <Link
          href={`/w/${currentSlug}/stats`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          📊 Stats
        </Link>
        <Link
          href={`/w/${currentSlug}/tags`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          🏷 Tags
        </Link>
        {role !== "viewer" && (
          <button
            onClick={() => startTransition(() => quickCapture(currentSlug))}
            className="w-full text-left block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5 flex items-center justify-between"
            title="Quick capture (Cmd+Shift+I)"
          >
            <span>📥 Quick capture</span>
            <kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1">
              ⌘⇧I
            </kbd>
          </button>
        )}
        <Link
          href={`/w/${currentSlug}/settings`}
          className="block text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        >
          {t("⚙ Settings", lang)}
        </Link>
        {role !== "viewer" && <ImportButton slug={currentSlug} />}
        {role === "owner" && <InviteButton slug={currentSlug} />}
        <button
          onClick={() => setCompact((v) => !v)}
          className="block w-full text-left text-[10px] text-gray-400 hover:text-gray-700 px-2"
          title="Toggle sidebar compact mode"
        >
          {compact ? "↧ Cozy spacing" : "↥ Compact"}
        </button>
        <UserMenu user={user} />
        {footerStats && !visuallyCollapsed && (
          <p className="text-[10px] text-gray-400 px-2 pt-1">
            {footerStats.pageCount} page{footerStats.pageCount === 1 ? "" : "s"} ·{" "}
            {formatBytes(footerStats.fileBytes)} uploaded
          </p>
        )}
      </div>
      <PageMovePicker
        slug={currentSlug}
        pages={pages}
        movingId={movingId}
        onClose={() => setMovingId(null)}
      />
    </aside>
    </>
  );
}
