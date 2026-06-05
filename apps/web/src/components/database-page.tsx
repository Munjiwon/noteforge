"use client";

import { useEffect, useState, useTransition } from "react";
import { renamePage, setPageIcon } from "@/app/w/[slug]/actions";
import { PeekModal } from "./peek-modal";
import { PageStyleMenu, fontClass, widthClass } from "./page-style-menu";
import { EmojiPicker } from "./emoji-picker";
import { DbExportCsvButton } from "./db-export-csv";
import {
  addRow,
  addRowFromTemplate,
  addView,
  deleteView,
  duplicateView,
  renameView,
  setActiveView,
  setKanbanGroup,
  setView,
} from "@/app/w/[slug]/database-actions";
import { useRouter } from "next/navigation";
import { DatabaseView } from "./database-view";
import { KanbanView } from "./kanban-view";
import { GalleryView } from "./gallery-view";
import { CalendarView } from "./calendar-view";
import { TimelineView } from "./timeline-view";
import { ListView } from "./list-view";
import { PageCover } from "./page-cover";
import { ShareButton } from "./share-button";
import { DbControls } from "./db-controls";
import { applyQuery } from "@/lib/db-query";
import { effectiveKanbanGroupBy, effectiveViewKind, getActiveView, type DbSchema, type DbView } from "@/lib/database";
import type { PermItem } from "./share-button";


export function DatabasePage({
  slug,
  db,
  rows,
  rowTemplates = [],
  role,
  canChangeSettings = false,
}: {
  slug: string;
  db: {
    id: string;
    title: string;
    icon: string | null;
    schema: DbSchema;
    cover?: string | null;
    coverPos?: string | null;
    publicAccess?: "none" | "view";
    publicSlug?: string | null;
    publicViewCount?: number;
    permissions?: PermItem[];
    locked?: boolean;
    width?: "normal" | "wide" | "full";
    font?: "default" | "serif" | "mono";
  };
  rows: {
    id: string;
    parentId: string;
    title: string;
    cover?: string | null;
    dataValues: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
    author?: { id: string; name: string; color: string } | null;
  }[];
  rowTemplates?: { id: string; title: string; icon: string | null }[];
  role: "owner" | "editor" | "viewer";
  canChangeSettings?: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(db.title);
  const [icon, setIcon] = useState(db.icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, start] = useTransition();
  const readOnly = role === "viewer";
  const width = db.width ?? "normal";
  const font = db.font ?? "default";
  const view: DbView = effectiveViewKind(db.schema);
  const savedViews = db.schema.views ?? [];
  const activeView = getActiveView(db.schema);
  const selectProps = db.schema.props.filter((p) => p.type === "select");
  const [rowSearch, setRowSearch] = useState("");
  const queried = applyQuery(db.schema, rows);
  const visibleRows = rowSearch.trim()
    ? queried.filter((r) =>
        (r.title || "Untitled").toLowerCase().includes(rowSearch.trim().toLowerCase()),
      )
    : queried;
  const [peekId, setPeekId] = useState<string | null>(null);

  // Listen for global event so Row "Peek" button can open the modal without prop drilling.
  useEffect(() => {
    const onPeek = (e: Event) => {
      const ce = e as CustomEvent<{ pageId: string }>;
      if (ce.detail?.pageId) setPeekId(ce.detail.pageId);
    };
    window.addEventListener("db-row-peek", onPeek as EventListener);
    return () => window.removeEventListener("db-row-peek", onPeek as EventListener);
  }, []);

  // Single-letter view switch shortcuts (T/K/G/C/L/M) when not in an input.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      const map: Record<string, DbView> = {
        t: "table",
        k: "kanban",
        g: "gallery",
        c: "calendar",
        m: "timeline",
        l: "list",
      };
      const next = map[e.key.toLowerCase()];
      if (next && next !== view) {
        e.preventDefault();
        start(() => setView(slug, db.id, next));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, slug, db.id, readOnly, start]);

  return (
    <div className={fontClass(font)}>
      <PageCover
        slug={slug}
        pageId={db.id}
        cover={db.cover ?? null}
        coverPos={
          db.coverPos === "top" || db.coverPos === "bottom" ? db.coverPos : "center"
        }
        readOnly={readOnly}
      />
      <div className={`${width === "full" ? "max-w-none" : width === "wide" ? "max-w-7xl" : "max-w-6xl"} mx-auto px-12 py-10`}>
        {db.locked ? (
          <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1 inline-flex items-center gap-1">
            🔒 Database locked — read-only
          </div>
        ) : readOnly ? (
          <div className="mb-3 text-xs text-gray-600 bg-gray-100 border border-gray-200 rounded px-3 py-1 inline-flex items-center gap-1">
            👁 Read-only view
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-1.5 mb-2">
          <DbExportCsvButton title={db.title} schema={db.schema} rows={visibleRows} />
          <PageStyleMenu
            slug={slug}
            pageId={db.id}
            width={width}
            font={font}
            locked={db.locked ?? false}
            canEdit={canChangeSettings}
          />
          <ShareButton
            slug={slug}
            pageId={db.id}
            initialAccess={db.publicAccess ?? "none"}
            initialPublicSlug={db.publicSlug ?? null}
            initialPermissions={db.permissions ?? []}
            publicViewCount={db.publicViewCount}
            canEdit={!readOnly}
          />
        </div>
      <div className="relative flex items-center gap-2 mb-2">
        <button
          className="text-4xl leading-none hover:bg-black/5 rounded px-1"
          onClick={() => setPickerOpen((o) => !o)}
          disabled={readOnly}
        >
          {icon ?? "📊"}
        </button>
        {pickerOpen && (
          <EmojiPicker
            onPick={(e) => {
              setIcon(e);
              start(() => setPageIcon(slug, db.id, e));
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title !== db.title) start(() => renamePage(slug, db.id, title));
        }}
        disabled={readOnly}
        placeholder="Untitled database"
        className="w-full text-4xl font-bold outline-none bg-transparent placeholder-gray-300 mb-1"
      />
      <ViewTabs
        slug={slug}
        dbId={db.id}
        views={
          savedViews.length > 0
            ? savedViews
            : [{ id: "__legacy", name: "Default", kind: view }]
        }
        activeViewId={activeView?.id ?? (savedViews.length === 0 ? "__legacy" : null)}
        readOnly={readOnly}
      />
      <div className="flex items-center gap-3 mb-4 text-xs text-gray-500">
        <span>Database</span>
        <span className="text-gray-300">·</span>
        <div className="inline-flex rounded border border-gray-200 overflow-hidden">
          <button
            className={
              "px-2 py-1 " +
              (view === "table" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
            disabled={readOnly}
            onClick={() => {
              if (view !== "table") start(() => setView(slug, db.id, "table"));
            }}
          >
            Table
          </button>
          <button
            className={
              "px-2 py-1 " +
              (view === "kanban" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
            disabled={readOnly}
            onClick={() => {
              if (view !== "kanban") start(() => setView(slug, db.id, "kanban"));
            }}
          >
            Kanban
          </button>
          <button
            className={
              "px-2 py-1 " +
              (view === "gallery" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
            disabled={readOnly}
            onClick={() => {
              if (view !== "gallery") start(() => setView(slug, db.id, "gallery"));
            }}
          >
            Gallery
          </button>
          <button
            className={
              "px-2 py-1 " +
              (view === "calendar" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
            disabled={readOnly}
            onClick={() => {
              if (view !== "calendar") start(() => setView(slug, db.id, "calendar"));
            }}
          >
            Calendar
          </button>
          <button
            className={
              "px-2 py-1 " +
              (view === "timeline" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
            disabled={readOnly}
            onClick={() => {
              if (view !== "timeline") start(() => setView(slug, db.id, "timeline"));
            }}
          >
            Timeline
          </button>
          <button
            className={
              "px-2 py-1 " +
              (view === "list" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
            disabled={readOnly}
            onClick={() => {
              if (view !== "list") start(() => setView(slug, db.id, "list"));
            }}
          >
            List
          </button>
        </div>
        <DbControls slug={slug} dbId={db.id} schema={db.schema} readOnly={readOnly} />
        <input
          value={rowSearch}
          onChange={(e) => setRowSearch(e.target.value)}
          placeholder="Search rows…"
          className="text-xs border border-gray-200 rounded px-2 py-1 outline-none w-32"
        />
        {!readOnly && (
          <RowAddMenu
            slug={slug}
            dbId={db.id}
            templates={rowTemplates}
            onCreated={(id) => router.push(`/w/${slug}/p/${id}`)}
          />
        )}
        <span className="text-[11px] text-gray-400 ml-auto">
          {visibleRows.length === rows.length
            ? `${rows.length} row${rows.length === 1 ? "" : "s"}`
            : `${visibleRows.length} of ${rows.length} rows`}
        </span>
        {view === "kanban" && selectProps.length > 0 && (
          <label className="inline-flex items-center gap-1">
            <span>Group by:</span>
            <select
              className="bg-transparent border border-gray-200 rounded px-1 py-0.5"
              disabled={readOnly}
              value={effectiveKanbanGroupBy(db.schema) ?? selectProps[0].id}
              onChange={(e) =>
                start(() => setKanbanGroup(slug, db.id, e.target.value))
              }
            >
              {selectProps.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {rows.length === 0 && !readOnly && (
        <div className="border border-dashed border-gray-200 rounded-md p-8 text-center mb-3">
          <div className="text-3xl mb-1">📊</div>
          <p className="text-sm text-gray-700 mb-1">No rows yet</p>
          <p className="text-xs text-gray-400 mb-3">
            Get started by adding your first row or pick a template above.
          </p>
          <button
            onClick={() =>
              start(async () => {
                const id = await addRow(slug, db.id);
                if (id) router.push(`/w/${slug}/p/${id}`);
              })
            }
            className="text-xs px-3 py-1 rounded bg-gray-900 text-white hover:opacity-90"
          >
            + Add first row
          </button>
        </div>
      )}
      {view === "kanban" ? (
        <KanbanView
          slug={slug}
          dbId={db.id}
          schema={db.schema}
          rows={visibleRows}
          readOnly={readOnly}
        />
      ) : view === "gallery" ? (
        <GalleryView
          slug={slug}
          dbId={db.id}
          schema={db.schema}
          rows={visibleRows}
          readOnly={readOnly}
        />
      ) : view === "calendar" ? (
        <CalendarView
          slug={slug}
          dbId={db.id}
          schema={db.schema}
          rows={visibleRows}
          readOnly={readOnly}
        />
      ) : view === "timeline" ? (
        <TimelineView
          slug={slug}
          dbId={db.id}
          schema={db.schema}
          rows={visibleRows}
          readOnly={readOnly}
        />
      ) : view === "list" ? (
        <ListView
          slug={slug}
          dbId={db.id}
          schema={db.schema}
          rows={visibleRows}
          readOnly={readOnly}
        />
      ) : (
        <DatabaseView
          slug={slug}
          dbId={db.id}
          schema={db.schema}
          rows={visibleRows}
          readOnly={readOnly}
        />
      )}
      </div>
      <PeekModal pageId={peekId} onClose={() => setPeekId(null)} />
    </div>
  );
}

function RowAddMenu({
  slug,
  dbId,
  templates,
  onCreated,
}: {
  slug: string;
  dbId: string;
  templates: { id: string; title: string; icon: string | null }[];
  onCreated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  if (templates.length === 0) {
    return (
      <button
        onClick={() =>
          start(async () => {
            const id = await addRow(slug, dbId);
            if (id) onCreated(id);
          })
        }
        className="text-xs px-2 py-1 rounded bg-gray-900 text-white hover:opacity-90"
      >
        + New
      </button>
    );
  }
  return (
    <div className="relative">
      <div className="inline-flex">
        <button
          onClick={() =>
            start(async () => {
              const id = await addRow(slug, dbId);
              if (id) onCreated(id);
            })
          }
          className="text-xs px-2 py-1 rounded-l bg-gray-900 text-white hover:opacity-90 border-r border-white/20"
        >
          + New
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-xs px-1.5 py-1 rounded-r bg-gray-900 text-white hover:opacity-90"
          title="New from template"
        >
          ▾
        </button>
      </div>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-md shadow-lg w-56 py-1"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="text-[10px] uppercase text-gray-500 px-3 py-1">
            New from template
          </div>
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => {
                setOpen(false);
                start(async () => {
                  const id = await addRowFromTemplate(slug, dbId, tpl.id);
                  if (id) onCreated(id);
                });
              }}
              className="w-full text-left text-xs px-3 py-1.5 hover:bg-black/5 flex items-center gap-2"
            >
              <span>{tpl.icon ?? "📄"}</span>
              <span className="truncate flex-1">{tpl.title || "Untitled"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const VIEW_KIND_ICONS: Record<DbView, string> = {
  table: "▤",
  kanban: "▥",
  gallery: "▦",
  calendar: "▣",
  timeline: "▰",
  list: "≣",
};

function ViewTabs({
  slug,
  dbId,
  views,
  activeViewId,
  readOnly,
}: {
  slug: string;
  dbId: string;
  views: { id: string; name: string; kind: DbView }[];
  activeViewId: string | null;
  readOnly: boolean;
}) {
  const [, start] = useTransition();
  const [adderOpen, setAdderOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-1 border-b border-gray-200 mb-3 -mx-2 px-2 overflow-x-auto">
      {views.map((v) => {
        const active = v.id === activeViewId;
        return (
          <div key={v.id} className="relative">
            <button
              disabled={readOnly}
              onClick={() => {
                if (!active) start(() => setActiveView(slug, dbId, v.id));
              }}
              onDoubleClick={() => {
                if (readOnly) return;
                const next = prompt("Rename view", v.name);
                if (next && next.trim() && next.trim() !== v.name) {
                  start(() => renameView(slug, dbId, v.id, next.trim()));
                }
              }}
              className={
                "px-3 py-1.5 text-sm border-b-2 -mb-px flex items-center gap-1.5 " +
                (active
                  ? "border-gray-900 text-gray-900 font-medium"
                  : "border-transparent text-gray-500 hover:text-gray-900")
              }
            >
              <span className="text-xs opacity-60">{VIEW_KIND_ICONS[v.kind]}</span>
              <span>{v.name}</span>
              {active && !readOnly && (
                <span
                  className="ml-1 text-gray-400 hover:text-gray-900"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor((cur) => (cur === v.id ? null : v.id));
                  }}
                >
                  ⌄
                </span>
              )}
            </button>
            {menuFor === v.id && (
              <div className="absolute z-20 top-full mt-1 left-0 bg-white border border-gray-200 rounded shadow text-xs min-w-[140px]">
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setMenuFor(null);
                    const next = prompt("Rename view", v.name);
                    if (next && next.trim() && next.trim() !== v.name) {
                      start(() => renameView(slug, dbId, v.id, next.trim()));
                    }
                  }}
                >
                  ✎ Rename
                </button>
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-black/5"
                  onClick={() => {
                    setMenuFor(null);
                    if (v.id === "__legacy") return;
                    start(async () => {
                      await duplicateView(slug, dbId, v.id);
                    });
                  }}
                  disabled={v.id === "__legacy"}
                >
                  ⎘ Duplicate
                </button>
                {views.length > 1 && (
                  <button
                    className="block w-full text-left px-3 py-1.5 hover:bg-black/5 text-red-600"
                    onClick={() => {
                      setMenuFor(null);
                      if (confirm(`Delete view "${v.name}"?`)) {
                        start(() => deleteView(slug, dbId, v.id));
                      }
                    }}
                  >
                    🗑 Delete
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <div className="relative">
          <button
            className="px-2 py-1.5 text-sm text-gray-400 hover:text-gray-900"
            onClick={() => setAdderOpen((o) => !o)}
          >
            + Add view
          </button>
          {adderOpen && (
            <div className="absolute z-20 top-full mt-1 left-0 bg-white border border-gray-200 rounded shadow text-xs min-w-[140px]">
              {(["table", "kanban", "gallery", "calendar", "timeline", "list"] as DbView[]).map(
                (k) => (
                  <button
                    key={k}
                    className="block w-full text-left px-3 py-1.5 hover:bg-black/5 capitalize"
                    onClick={() => {
                      setAdderOpen(false);
                      start(async () => {
                        await addView(slug, dbId, k);
                      });
                    }}
                  >
                    <span className="opacity-60 mr-1.5">{VIEW_KIND_ICONS[k]}</span>
                    {k}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
