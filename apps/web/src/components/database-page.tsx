"use client";

import { useEffect, useState, useTransition } from "react";
import { renamePage, setPageIcon } from "@/app/w/[slug]/actions";
import { PeekModal } from "./peek-modal";
import { PageStyleMenu, fontClass, widthClass } from "./page-style-menu";
import { EmojiPicker } from "./emoji-picker";
import { DbExportCsvButton } from "./db-export-csv";
import { setKanbanGroup, setView } from "@/app/w/[slug]/database-actions";
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
import type { DbSchema, DbView } from "@/lib/database";
import type { PermItem } from "./share-button";


export function DatabasePage({
  slug,
  db,
  rows,
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
  rows: { id: string; parentId: string; title: string; cover?: string | null; dataValues: Record<string, unknown> }[];
  role: "owner" | "editor" | "viewer";
  canChangeSettings?: boolean;
}) {
  const [title, setTitle] = useState(db.title);
  const [icon, setIcon] = useState(db.icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, start] = useTransition();
  const readOnly = role === "viewer";
  const width = db.width ?? "normal";
  const font = db.font ?? "default";
  const view: DbView = db.schema.view ?? "table";
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
        <div className="flex justify-end gap-2 mb-2">
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
              value={db.schema.kanbanGroupBy ?? selectProps[0].id}
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
