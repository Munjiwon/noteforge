"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";
import {
  DbFilter,
  DbProp,
  DbPropType,
  DbSchema,
  DbSort,
  DbView,
  DEFAULT_STATUS_OPTIONS,
  FilterCombinator,
  getActiveView,
  newId,
  parseSchema,
  parseValues,
  SavedView,
  SELECT_COLORS,
} from "@/lib/database";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

export async function createDatabase(slug: string, parentId: string | null) {
  const ctx = await assertEditor(slug);
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId },
    _max: { position: true },
  });
  const initialSchema: DbSchema = {
    props: [
      { id: "p_title", name: "Name", type: "text" },
      {
        id: newId("p"),
        name: "Status",
        type: "select",
        options: [
          { id: newId("o"), name: "Todo", color: SELECT_COLORS[7] },
          { id: newId("o"), name: "In Progress", color: SELECT_COLORS[3] },
          { id: newId("o"), name: "Done", color: SELECT_COLORS[2] },
        ],
      },
      { id: newId("p"), name: "Due", type: "date" },
      { id: newId("p"), name: "Done", type: "checkbox" },
    ],
  };
  const db = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId,
      kind: "database",
      title: "Untitled database",
      icon: "📊",
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
      dbSchema: JSON.stringify(initialSchema),
    },
  });
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/p/${db.id}`);
}

async function loadDb(slug: string, dbId: string) {
  const ctx = await assertEditor(slug);
  const db = await prisma.page.findFirst({
    where: { id: dbId, workspaceId: ctx.workspace.id, kind: "database" },
  });
  if (!db) throw new Error("not found");
  return { ctx, db, schema: parseSchema(db.dbSchema) };
}

async function saveSchema(dbId: string, schema: DbSchema) {
  await prisma.page.update({
    where: { id: dbId },
    data: { dbSchema: JSON.stringify(schema) },
  });
}

const TYPE_DEFAULT_NAME: Record<DbPropType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  multi_select: "Multi-select",
  status: "Status",
  date: "Date",
  checkbox: "Checkbox",
  url: "URL",
  email: "Email",
  phone: "Phone",
  person: "Person",
  files: "Files",
  relation: "Relation",
  rollup: "Rollup",
  formula: "Formula",
  created_at: "Created at",
  updated_at: "Updated at",
  created_by: "Created by",
  duration: "Duration",
};

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return base;
}

export async function addColumn(slug: string, dbId: string, type: DbPropType, name?: string) {
  const { schema } = await loadDb(slug, dbId);
  const existingNames = new Set(schema.props.map((p) => p.name));
  const chosen = name?.trim() || uniqueName(TYPE_DEFAULT_NAME[type], existingNames);
  const id = newId("p");
  const prop: DbProp =
    type === "select"
      ? { id, name: chosen, type: "select", options: [] }
      : type === "multi_select"
      ? { id, name: chosen, type: "multi_select", options: [] }
      : type === "status"
      ? { id, name: chosen, type: "status", options: [...DEFAULT_STATUS_OPTIONS] }
      : type === "number"
      ? { id, name: chosen, type: "number" }
      : type === "date"
      ? { id, name: chosen, type: "date" }
      : type === "checkbox"
      ? { id, name: chosen, type: "checkbox" }
      : type === "url"
      ? { id, name: chosen, type: "url" }
      : type === "email"
      ? { id, name: chosen, type: "email" }
      : type === "phone"
      ? { id, name: chosen, type: "phone" }
      : type === "person"
      ? { id, name: chosen, type: "person" }
      : type === "files"
      ? { id, name: chosen, type: "files" }
      : type === "relation"
      ? { id, name: chosen, type: "relation", targetDbId: "" }
      : type === "rollup"
      ? { id, name: chosen, type: "rollup", relationPropId: "", targetPropId: "", aggregate: "count" }
      : type === "formula"
      ? { id, name: chosen, type: "formula", expr: "" }
      : type === "created_at"
      ? { id, name: chosen, type: "created_at" }
      : type === "updated_at"
      ? { id, name: chosen, type: "updated_at" }
      : type === "created_by"
      ? { id, name: chosen, type: "created_by" }
      : type === "duration"
      ? { id, name: chosen, type: "duration" }
      : { id, name: chosen, type: "text" };
  schema.props.push(prop);
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function configureRelation(
  slug: string,
  dbId: string,
  propId: string,
  targetDbId: string,
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "relation") throw new Error("not a relation");
  p.targetDbId = targetDbId;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function configureRollup(
  slug: string,
  dbId: string,
  propId: string,
  relationPropId: string,
  targetPropId: string,
  aggregate: "count" | "sum" | "min" | "max" | "unique" | "percent_complete" | "percent_checked",
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "rollup") throw new Error("not a rollup");
  p.relationPropId = relationPropId;
  p.targetPropId = targetPropId;
  p.aggregate = aggregate;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setNumberFormat(
  slug: string,
  dbId: string,
  propId: string,
  format: "integer" | "decimal" | "percent" | "currency" | "progress" | "rating",
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "number") throw new Error("not a number column");
  p.format = format;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setDateFormat(
  slug: string,
  dbId: string,
  propId: string,
  format: "short" | "long" | "relative",
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "date") throw new Error("not a date column");
  p.format = format;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function configureFormula(
  slug: string,
  dbId: string,
  propId: string,
  expr: string,
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "formula") throw new Error("not a formula");
  p.expr = expr;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setHiddenColumns(
  slug: string,
  dbId: string,
  ids: string[],
) {
  const { schema } = await loadDb(slug, dbId);
  const filtered = ids.filter((id) => id !== "p_title");
  const active = getActiveView(schema);
  if (active) active.hiddenColumns = filtered;
  else schema.hiddenColumns = filtered;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setColumnOrder(
  slug: string,
  dbId: string,
  order: string[],
) {
  const { schema } = await loadDb(slug, dbId);
  const active = getActiveView(schema);
  if (active) active.columnOrder = order;
  else schema.columnOrder = order;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function addHiddenColumn(
  slug: string,
  dbId: string,
  propId: string,
) {
  if (propId === "p_title") return;
  const { schema } = await loadDb(slug, dbId);
  const active = getActiveView(schema);
  const cur = active?.hiddenColumns ?? schema.hiddenColumns ?? [];
  if (cur.includes(propId)) return;
  const next = [...cur, propId];
  if (active) active.hiddenColumns = next;
  else schema.hiddenColumns = next;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setTableGroup(
  slug: string,
  dbId: string,
  propId: string | null,
) {
  const { schema } = await loadDb(slug, dbId);
  const next = propId ?? undefined;
  if (propId) {
    const p = schema.props.find((x) => x.id === propId);
    if (
      !p ||
      (p.type !== "select" &&
        p.type !== "status" &&
        p.type !== "date" &&
        p.type !== "relation")
    ) {
      throw new Error("group-by must be a select, status, date, or relation column");
    }
  }
  const active = getActiveView(schema);
  if (active) active.tableGroupBy = next;
  else schema.tableGroupBy = next;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function bulkSetCheckboxColumn(
  slug: string,
  dbId: string,
  propId: string,
  value: boolean,
) {
  const ctx = await assertEditor(slug);
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "checkbox") throw new Error("not a checkbox column");
  const rows = await prisma.page.findMany({
    where: { parentId: dbId, workspaceId: ctx.workspace.id, deletedAt: null },
    select: { id: true, dataValues: true },
  });
  for (const r of rows) {
    const values = parseValues(r.dataValues);
    if (value) values[propId] = true;
    else delete values[propId];
    await prisma.page.update({
      where: { id: r.id },
      data: { dataValues: JSON.stringify(values) },
    });
  }
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setColumnWidth(
  slug: string,
  dbId: string,
  propId: string,
  width: number,
) {
  const { schema } = await loadDb(slug, dbId);
  schema.columnWidths = { ...(schema.columnWidths ?? {}), [propId]: Math.max(60, Math.min(800, Math.round(width))) };
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setFilters(slug: string, dbId: string, filters: DbFilter[]) {
  const { schema } = await loadDb(slug, dbId);
  const active = getActiveView(schema);
  if (active) active.filters = filters;
  else schema.filters = filters;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setFilterCombinator(
  slug: string,
  dbId: string,
  combinator: FilterCombinator,
) {
  const { schema } = await loadDb(slug, dbId);
  const active = getActiveView(schema);
  if (active) active.filterCombinator = combinator;
  else schema.filterCombinator = combinator;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setSort(slug: string, dbId: string, sort: DbSort[]) {
  const { schema } = await loadDb(slug, dbId);
  const active = getActiveView(schema);
  if (active) active.sort = sort;
  else schema.sort = sort;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

const TEXTY: DbPropType[] = ["text", "url", "email", "phone"];

export async function changeColumnType(
  slug: string,
  dbId: string,
  propId: string,
  newType: DbPropType,
) {
  if (propId === "p_title") throw new Error("cannot change title column type");
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p) throw new Error("not found");
  if (p.type === newType) return;
  const idx = schema.props.findIndex((x) => x.id === propId);

  // text-family <-> text-family
  if (TEXTY.includes(p.type) && TEXTY.includes(newType)) {
    const cleaned: DbProp = (
      newType === "text"
        ? { id: p.id, name: p.name, description: p.description, type: "text" }
        : newType === "url"
        ? { id: p.id, name: p.name, description: p.description, type: "url" }
        : newType === "email"
        ? { id: p.id, name: p.name, description: p.description, type: "email" }
        : { id: p.id, name: p.name, description: p.description, type: "phone" }
    ) as DbProp;
    schema.props[idx] = cleaned;
    await saveSchema(dbId, schema);
    revalidatePath(`/w/${slug}/p/${dbId}`);
    return;
  }

  // number <-> text family: rebuild prop. Values cast lazily in cells.
  if ((p.type === "number" && TEXTY.includes(newType)) || (TEXTY.includes(p.type) && newType === "number")) {
    if (newType === "number") {
      // text -> number: rewrite dataValues so parseable strings become numbers.
      const rows = await prisma.page.findMany({
        where: { parentId: dbId },
        select: { id: true, dataValues: true },
      });
      for (const r of rows) {
        const v = parseValues(r.dataValues);
        const raw = v[propId];
        if (typeof raw === "string") {
          const n = Number(raw);
          if (!Number.isNaN(n)) v[propId] = n;
          else delete v[propId];
        } else if (typeof raw !== "number") {
          delete v[propId];
        }
        await prisma.page.update({
          where: { id: r.id },
          data: { dataValues: JSON.stringify(v) },
        });
      }
      schema.props[idx] = { id: p.id, name: p.name, description: p.description, type: "number" };
    } else {
      // number -> text family: numbers become strings; just rewrap prop type.
      const target = newType as "text" | "url" | "email" | "phone";
      schema.props[idx] = {
        id: p.id,
        name: p.name,
        description: p.description,
        type: target,
      } as DbProp;
    }
    await saveSchema(dbId, schema);
    revalidatePath(`/w/${slug}/p/${dbId}`);
    return;
  }

  // select <-> multi_select: keep options, convert values single<->array
  if (
    (p.type === "select" && newType === "multi_select") ||
    (p.type === "multi_select" && newType === "select")
  ) {
    const options = (p as { options: { id: string; name: string; color: string }[] }).options;
    schema.props[idx] =
      newType === "multi_select"
        ? { id: p.id, name: p.name, description: p.description, type: "multi_select", options }
        : { id: p.id, name: p.name, description: p.description, type: "select", options };
    await saveSchema(dbId, schema);
    const rows = await prisma.page.findMany({
      where: { parentId: dbId },
      select: { id: true, dataValues: true },
    });
    for (const r of rows) {
      const v = parseValues(r.dataValues);
      const raw = v[propId];
      if (newType === "multi_select") {
        v[propId] = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
      } else {
        v[propId] = Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
        if (v[propId] === null) delete v[propId];
      }
      await prisma.page.update({
        where: { id: r.id },
        data: { dataValues: JSON.stringify(v) },
      });
    }
    revalidatePath(`/w/${slug}/p/${dbId}`);
    return;
  }

  throw new Error("That column type conversion isn't supported yet");
}

export async function renameColumn(slug: string, dbId: string, propId: string, name: string) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (p) p.name = name.trim() || p.name;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setColumnDescription(
  slug: string,
  dbId: string,
  propId: string,
  description: string,
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p) throw new Error("not found");
  const t = description.trim();
  p.description = t ? t : undefined;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setSelectOptionColor(
  slug: string,
  dbId: string,
  propId: string,
  optionId: string,
  color: string,
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || (p.type !== "select" && p.type !== "multi_select")) {
    throw new Error("not a select column");
  }
  const opt = p.options.find((o) => o.id === optionId);
  if (!opt) throw new Error("option not found");
  opt.color = color;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function deleteColumn(slug: string, dbId: string, propId: string) {
  if (propId === "p_title") throw new Error("cannot delete title");
  const { schema } = await loadDb(slug, dbId);
  schema.props = schema.props.filter((p) => p.id !== propId);
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function addSelectOption(
  slug: string,
  dbId: string,
  propId: string,
  name: string,
) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p) return;
  if (p.type === "status") {
    // New columns added from a status board land in the To-do group by default,
    // (you re-group them from the property editor afterward).
    const sopt = {
      id: newId("o"),
      name: name.trim(),
      color: SELECT_COLORS[p.options.length % SELECT_COLORS.length],
      group: "todo" as const,
    };
    p.options.push(sopt);
    await saveSchema(dbId, schema);
    revalidatePath(`/w/${slug}/p/${dbId}`);
    return sopt;
  }
  if (p.type !== "select" && p.type !== "multi_select") return;
  const opt = {
    id: newId("o"),
    name: name.trim(),
    color: SELECT_COLORS[p.options.length % SELECT_COLORS.length],
  };
  p.options.push(opt);
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
  return opt;
}

export async function addRow(
  slug: string,
  dbId: string,
  initialValues?: Record<string, unknown>,
) {
  const ctx = await assertEditor(slug);
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId: dbId },
    _max: { position: true },
  });
  const row = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId: dbId,
      kind: "doc",
      title: "",
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
      dataValues: JSON.stringify(initialValues ?? {}),
    },
  });
  revalidatePath(`/w/${slug}/p/${dbId}`);
  return row.id;
}

export async function addRowBefore(
  slug: string,
  dbId: string,
  anchorRowId: string,
) {
  const ctx = await assertEditor(slug);
  const anchor = await prisma.page.findFirst({
    where: { id: anchorRowId, parentId: dbId, workspaceId: ctx.workspace.id },
    select: { position: true },
  });
  if (!anchor) throw new Error("anchor not found");
  // Find the row immediately before the anchor so we can pick a midpoint.
  const prev = await prisma.page.findFirst({
    where: {
      parentId: dbId,
      workspaceId: ctx.workspace.id,
      position: { lt: anchor.position },
      deletedAt: null,
    },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const pos =
    prev !== null ? (prev.position + anchor.position) / 2 : anchor.position - 1;
  const row = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId: dbId,
      kind: "doc",
      title: "",
      position: pos,
      authorId: ctx.user.id,
      dataValues: "{}",
    },
  });
  revalidatePath(`/w/${slug}/p/${dbId}`);
  return row.id;
}

export async function addRowFromTemplate(
  slug: string,
  dbId: string,
  templateRowId: string,
) {
  const ctx = await assertEditor(slug);
  const tpl = await prisma.page.findFirst({
    where: {
      id: templateRowId,
      parentId: dbId,
      workspaceId: ctx.workspace.id,
      isTemplate: true,
    },
  });
  if (!tpl) throw new Error("template not found");
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId: dbId },
    _max: { position: true },
  });
  const row = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId: dbId,
      kind: "doc",
      title: tpl.title,
      icon: tpl.icon,
      cover: tpl.cover,
      content: tpl.content,
      dataValues: tpl.dataValues ?? "{}",
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
      isTemplate: false,
    },
  });
  revalidatePath(`/w/${slug}/p/${dbId}`);
  return row.id;
}

export async function updateCell(
  slug: string,
  rowId: string,
  propId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
) {
  const ctx = await assertEditor(slug);
  const row = await prisma.page.findFirst({
    where: { id: rowId, workspaceId: ctx.workspace.id },
  });
  if (!row || !row.parentId) throw new Error("not found");
  let oldValue: unknown = null;
  let newValue: unknown = null;
  if (propId === "p_title") {
    oldValue = row.title;
    newValue = String(value ?? "").trim();
    await prisma.page.update({
      where: { id: rowId },
      data: { title: newValue as string },
    });
  } else {
    const values = parseValues(row.dataValues);
    oldValue = values[propId] ?? null;
    if (value === null || value === undefined || value === "") {
      delete values[propId];
      newValue = null;
    } else {
      values[propId] = value;
      newValue = value;
    }
    await prisma.page.update({
      where: { id: rowId },
      data: { dataValues: JSON.stringify(values) },
    });
  }
  // Skip logging no-ops (same value, e.g. clicking a select that's already set)
  if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
    await prisma.pageActivity.create({
      data: {
        pageId: rowId,
        userId: ctx.user.id,
        action: "cell_changed",
        meta: JSON.stringify({
          propId,
          oldValue: oldValue ?? null,
          newValue: newValue ?? null,
        }),
      },
    });
  }
  revalidatePath(`/w/${slug}/p/${row.parentId}`);
}

function applyViewKindDefaults(schema: DbSchema, target: DbSchema | SavedView, view: DbView) {
  if (view === "kanban" && !target.kanbanGroupBy) {
    const firstSelect = schema.props.find((p) => p.type === "select");
    if (firstSelect) target.kanbanGroupBy = firstSelect.id;
  }
  if (view === "calendar" && !target.calendarDateBy) {
    const firstDate = schema.props.find((p) => p.type === "date");
    if (firstDate) target.calendarDateBy = firstDate.id;
  }
  if (view === "timeline") {
    const dateProps = schema.props.filter((p) => p.type === "date");
    if (!target.timelineStartBy && dateProps[0]) target.timelineStartBy = dateProps[0].id;
    if (!target.timelineEndBy && dateProps[1]) target.timelineEndBy = dateProps[1].id;
    if (!target.timelineEndBy && dateProps[0]) target.timelineEndBy = dateProps[0].id;
  }
}

export async function setView(slug: string, dbId: string, view: DbView) {
  const { schema } = await loadDb(slug, dbId);
  const active = getActiveView(schema);
  if (active) {
    active.kind = view;
    applyViewKindDefaults(schema, active, view);
  } else {
    schema.view = view;
    applyViewKindDefaults(schema, schema, view);
  }
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function addView(slug: string, dbId: string, kind: DbView, name?: string) {
  await assertEditor(slug);
  const { schema } = await loadDb(slug, dbId);
  if (!schema.views) {
    // First named view — seed with the current legacy single view so users don't lose state.
    schema.views = [
      {
        id: newId("v"),
        name: "Default",
        kind: schema.view ?? "table",
        filters: schema.filters,
        sort: schema.sort,
        hiddenColumns: schema.hiddenColumns,
        columnOrder: schema.columnOrder,
        tableGroupBy: schema.tableGroupBy,
        kanbanGroupBy: schema.kanbanGroupBy,
        calendarDateBy: schema.calendarDateBy,
        timelineStartBy: schema.timelineStartBy,
        timelineEndBy: schema.timelineEndBy,
      },
    ];
    if (!schema.activeViewId) schema.activeViewId = schema.views[0].id;
  }
  const view: SavedView = {
    id: newId("v"),
    name: name?.trim() || defaultViewName(kind, schema.views!.length + 1),
    kind,
  };
  applyViewKindDefaults(schema, view, kind);
  schema.views!.push(view);
  schema.activeViewId = view.id;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
  return view.id;
}

export async function renameView(slug: string, dbId: string, viewId: string, name: string) {
  await assertEditor(slug);
  const { schema } = await loadDb(slug, dbId);
  const view = schema.views?.find((v) => v.id === viewId);
  if (!view) throw new Error("view not found");
  view.name = name.trim() || view.name;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function duplicateView(slug: string, dbId: string, viewId: string) {
  await assertEditor(slug);
  const { schema } = await loadDb(slug, dbId);
  const src = schema.views?.find((v) => v.id === viewId);
  if (!src) throw new Error("view not found");
  const copy: SavedView = {
    ...src,
    id: newId("v"),
    name: src.name + " (copy)",
  };
  const idx = schema.views!.indexOf(src);
  schema.views!.splice(idx + 1, 0, copy);
  schema.activeViewId = copy.id;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
  return copy.id;
}

export async function deleteView(slug: string, dbId: string, viewId: string) {
  await assertEditor(slug);
  const { schema } = await loadDb(slug, dbId);
  if (!schema.views?.length) return;
  if (schema.views.length === 1) throw new Error("cannot delete the only view");
  schema.views = schema.views.filter((v) => v.id !== viewId);
  if (schema.activeViewId === viewId) schema.activeViewId = schema.views[0]?.id;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setActiveView(slug: string, dbId: string, viewId: string) {
  await assertEditor(slug);
  const { schema } = await loadDb(slug, dbId);
  if (!schema.views?.some((v) => v.id === viewId)) throw new Error("view not found");
  schema.activeViewId = viewId;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

function defaultViewName(kind: DbView, n: number): string {
  const map: Record<DbView, string> = {
    table: "Table",
    kanban: "Board",
    gallery: "Gallery",
    calendar: "Calendar",
    timeline: "Timeline",
    list: "List",
  };
  return `${map[kind]} ${n}`;
}

export async function setCalendarDate(slug: string, dbId: string, propId: string) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "date") throw new Error("must be a date column");
  const active = getActiveView(schema);
  if (active) active.calendarDateBy = propId;
  else schema.calendarDateBy = propId;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setTimelineRange(
  slug: string,
  dbId: string,
  startPropId: string,
  endPropId: string,
) {
  const { schema } = await loadDb(slug, dbId);
  const s = schema.props.find((x) => x.id === startPropId);
  const e = schema.props.find((x) => x.id === endPropId);
  if (!s || s.type !== "date" || !e || e.type !== "date") {
    throw new Error("both must be date columns");
  }
  const active = getActiveView(schema);
  if (active) {
    active.timelineStartBy = startPropId;
    active.timelineEndBy = endPropId;
  } else {
    schema.timelineStartBy = startPropId;
    schema.timelineEndBy = endPropId;
  }
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setKanbanGroup(slug: string, dbId: string, propId: string) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || (p.type !== "select" && p.type !== "status"))
    throw new Error("group-by must be a select or status column");
  const active = getActiveView(schema);
  if (active) active.kanbanGroupBy = propId;
  else schema.kanbanGroupBy = propId;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function recreateRow(
  slug: string,
  dbId: string,
  title: string,
  dataValues: Record<string, unknown>,
) {
  const ctx = await assertEditor(slug);
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId: dbId },
    _max: { position: true },
  });
  const row = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId: dbId,
      kind: "doc",
      title: title || "",
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
      dataValues: JSON.stringify(dataValues || {}),
    },
  });
  revalidatePath(`/w/${slug}/p/${dbId}`);
  return row.id;
}

export async function bulkDeleteRows(slug: string, dbId: string, rowIds: string[]) {
  const ctx = await assertEditor(slug);
  if (rowIds.length === 0) return;
  await prisma.page.deleteMany({
    where: {
      id: { in: rowIds },
      parentId: dbId,
      workspaceId: ctx.workspace.id,
    },
  });
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function deleteRow(slug: string, rowId: string) {
  const ctx = await assertEditor(slug);
  const row = await prisma.page.findFirst({
    where: { id: rowId, workspaceId: ctx.workspace.id },
  });
  if (!row) return;
  await prisma.page.delete({ where: { id: rowId } });
  if (row.parentId) revalidatePath(`/w/${slug}/p/${row.parentId}`);
}
