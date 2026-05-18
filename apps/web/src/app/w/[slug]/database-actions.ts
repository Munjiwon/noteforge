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
  newId,
  parseSchema,
  parseValues,
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

export async function addColumn(slug: string, dbId: string, type: DbPropType, name?: string) {
  const { schema } = await loadDb(slug, dbId);
  const id = newId("p");
  const prop: DbProp =
    type === "select"
      ? { id, name: name ?? "Select", type: "select", options: [] }
      : type === "multi_select"
      ? { id, name: name ?? "Multi-select", type: "multi_select", options: [] }
      : type === "status"
      ? { id, name: name ?? "Status", type: "status", options: [...DEFAULT_STATUS_OPTIONS] }
      : type === "number"
      ? { id, name: name ?? "Number", type: "number" }
      : type === "date"
      ? { id, name: name ?? "Date", type: "date" }
      : type === "checkbox"
      ? { id, name: name ?? "Checkbox", type: "checkbox" }
      : type === "url"
      ? { id, name: name ?? "URL", type: "url" }
      : type === "email"
      ? { id, name: name ?? "Email", type: "email" }
      : type === "phone"
      ? { id, name: name ?? "Phone", type: "phone" }
      : type === "person"
      ? { id, name: name ?? "Person", type: "person" }
      : type === "files"
      ? { id, name: name ?? "Files", type: "files" }
      : type === "relation"
      ? { id, name: name ?? "Relation", type: "relation", targetDbId: "" }
      : type === "rollup"
      ? { id, name: name ?? "Rollup", type: "rollup", relationPropId: "", targetPropId: "", aggregate: "count" }
      : type === "formula"
      ? { id, name: name ?? "Formula", type: "formula", expr: "" }
      : { id, name: name ?? "Text", type: "text" };
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
  aggregate: "count" | "sum" | "min" | "max" | "unique",
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
  format: "integer" | "decimal" | "percent" | "currency",
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
  schema.hiddenColumns = ids.filter((id) => id !== "p_title");
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setColumnOrder(
  slug: string,
  dbId: string,
  order: string[],
) {
  const { schema } = await loadDb(slug, dbId);
  schema.columnOrder = order;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setTableGroup(
  slug: string,
  dbId: string,
  propId: string | null,
) {
  const { schema } = await loadDb(slug, dbId);
  if (propId) {
    const p = schema.props.find((x) => x.id === propId);
    if (!p || (p.type !== "select" && p.type !== "status")) {
      throw new Error("group-by must be a select or status column");
    }
    schema.tableGroupBy = propId;
  } else {
    schema.tableGroupBy = undefined;
  }
  await saveSchema(dbId, schema);
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
  schema.filters = filters;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setSort(slug: string, dbId: string, sort: DbSort[]) {
  const { schema } = await loadDb(slug, dbId);
  schema.sort = sort;
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
  if (TEXTY.includes(p.type) && TEXTY.includes(newType)) {
    // values stay as strings; just update the prop discriminator
    const cleaned: DbProp = (
      newType === "text"
        ? { id: p.id, name: p.name, description: p.description, type: "text" }
        : newType === "url"
        ? { id: p.id, name: p.name, description: p.description, type: "url" }
        : newType === "email"
        ? { id: p.id, name: p.name, description: p.description, type: "email" }
        : { id: p.id, name: p.name, description: p.description, type: "phone" }
    ) as DbProp;
    const idx = schema.props.findIndex((x) => x.id === propId);
    schema.props[idx] = cleaned;
    await saveSchema(dbId, schema);
    revalidatePath(`/w/${slug}/p/${dbId}`);
    return;
  }
  throw new Error("Only text / url / email / phone columns can be converted between each other right now");
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
  if (!p || (p.type !== "select" && p.type !== "multi_select")) return;
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

export async function addRow(slug: string, dbId: string) {
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
      dataValues: "{}",
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
  if (propId === "p_title") {
    await prisma.page.update({
      where: { id: rowId },
      data: { title: String(value ?? "").trim() },
    });
  } else {
    const values = parseValues(row.dataValues);
    if (value === null || value === undefined || value === "") {
      delete values[propId];
    } else {
      values[propId] = value;
    }
    await prisma.page.update({
      where: { id: rowId },
      data: { dataValues: JSON.stringify(values) },
    });
  }
  revalidatePath(`/w/${slug}/p/${row.parentId}`);
}

export async function setView(slug: string, dbId: string, view: DbView) {
  const { schema } = await loadDb(slug, dbId);
  schema.view = view;
  if (view === "kanban" && !schema.kanbanGroupBy) {
    const firstSelect = schema.props.find((p) => p.type === "select");
    if (firstSelect) schema.kanbanGroupBy = firstSelect.id;
  }
  if (view === "calendar" && !schema.calendarDateBy) {
    const firstDate = schema.props.find((p) => p.type === "date");
    if (firstDate) schema.calendarDateBy = firstDate.id;
  }
  if (view === "timeline") {
    const dateProps = schema.props.filter((p) => p.type === "date");
    if (!schema.timelineStartBy && dateProps[0]) schema.timelineStartBy = dateProps[0].id;
    if (!schema.timelineEndBy && dateProps[1]) schema.timelineEndBy = dateProps[1].id;
    if (!schema.timelineEndBy && dateProps[0]) schema.timelineEndBy = dateProps[0].id;
  }
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setCalendarDate(slug: string, dbId: string, propId: string) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "date") throw new Error("must be a date column");
  schema.calendarDateBy = propId;
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
  schema.timelineStartBy = startPropId;
  schema.timelineEndBy = endPropId;
  await saveSchema(dbId, schema);
  revalidatePath(`/w/${slug}/p/${dbId}`);
}

export async function setKanbanGroup(slug: string, dbId: string, propId: string) {
  const { schema } = await loadDb(slug, dbId);
  const p = schema.props.find((x) => x.id === propId);
  if (!p || p.type !== "select") throw new Error("group-by must be a select column");
  schema.kanbanGroupBy = propId;
  await saveSchema(dbId, schema);
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
