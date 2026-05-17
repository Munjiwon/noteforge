"use client";

import type { DbSchema } from "@/lib/database";
import { DatabaseView } from "./database-view";
import { KanbanView } from "./kanban-view";
import { GalleryView } from "./gallery-view";
import { applyQuery } from "@/lib/db-query";

type Row = {
  id: string;
  title: string;
  cover?: string | null;
  dataValues: Record<string, unknown>;
};

export function PublicDatabaseView({
  title,
  icon,
  cover,
  schema,
  rows,
}: {
  title: string;
  icon: string | null;
  cover: string | null;
  schema: DbSchema;
  rows: Row[];
}) {
  const view = schema.view ?? "table";
  const visibleRows = applyQuery(schema, rows);
  // Database actions still require auth → server actions will throw if invoked.
  // Read-only UI (readOnly=true) hides all mutation buttons.
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 px-6 py-2 flex items-center justify-between">
        <span className="text-sm text-gray-500">📊 Shared database · read-only</span>
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
      <div className="max-w-6xl mx-auto px-6 md:px-12 py-10">
        <div className="text-4xl leading-none mb-2">{icon ?? "📊"}</div>
        <h1 className="text-4xl font-bold mb-6">{title || "Untitled database"}</h1>
        {view === "kanban" ? (
          <KanbanView
            slug=""
            dbId=""
            schema={schema}
            rows={visibleRows.map((r) => ({ id: r.id, parentId: "", title: r.title, dataValues: r.dataValues }))}
            readOnly
          />
        ) : view === "gallery" ? (
          <GalleryView
            slug=""
            dbId=""
            schema={schema}
            rows={visibleRows.map((r) => ({ id: r.id, parentId: "", title: r.title, cover: r.cover, dataValues: r.dataValues }))}
            readOnly
          />
        ) : (
          <DatabaseView
            slug=""
            dbId=""
            schema={schema}
            rows={visibleRows.map((r) => ({ id: r.id, parentId: "", title: r.title, dataValues: r.dataValues }))}
            readOnly
          />
        )}
      </div>
    </div>
  );
}
