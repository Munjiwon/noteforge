// newId uses Math.random — fine for non-secret prop/option ids that don't leave the client.
// (Used in both client components and server actions.)

export type DbPropType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "person"
  | "files"
  | "relation"
  | "rollup"
  | "formula";

export type StatusGroup = "todo" | "in_progress" | "complete";

export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  todo: "To-do",
  in_progress: "In progress",
  complete: "Complete",
};

export type DbStatusOption = {
  id: string;
  name: string;
  color: string;
  group: StatusGroup;
};

export const DEFAULT_STATUS_OPTIONS: DbStatusOption[] = [
  { id: "s_todo", name: "Not started", color: "#e5e7eb", group: "todo" },
  { id: "s_inprog", name: "In progress", color: "#bfdbfe", group: "in_progress" },
  { id: "s_done", name: "Done", color: "#a7f3d0", group: "complete" },
];

export type RollupAggregate = "count" | "sum" | "min" | "max" | "unique";

export type DbPropSelectOption = { id: string; name: string; color: string };

export type DbProp =
  | { id: string; name: string; type: "text" }
  | { id: string; name: string; type: "number" }
  | { id: string; name: string; type: "select"; options: DbPropSelectOption[] }
  | { id: string; name: string; type: "multi_select"; options: DbPropSelectOption[] }
  | { id: string; name: string; type: "status"; options: DbStatusOption[] }
  | { id: string; name: string; type: "date" }
  | { id: string; name: string; type: "checkbox" }
  | { id: string; name: string; type: "url" }
  | { id: string; name: string; type: "email" }
  | { id: string; name: string; type: "person" }
  | { id: string; name: string; type: "files" }
  | { id: string; name: string; type: "relation"; targetDbId: string }
  | { id: string; name: string; type: "rollup"; relationPropId: string; targetPropId: string; aggregate: RollupAggregate }
  | { id: string; name: string; type: "formula"; expr: string };

export type DbFilterOp =
  | "eq"
  | "ne"
  | "contains"
  | "empty"
  | "not_empty"
  | "checked"
  | "unchecked"
  | "before"
  | "after";

export type DbFilter = {
  id: string;
  propId: string;
  op: DbFilterOp;
  value?: string | number | boolean | null;
};

export type DbSort = { propId: string; dir: "asc" | "desc" };

export type DbView = "table" | "kanban" | "gallery" | "calendar" | "timeline";

export type DbSchema = {
  props: DbProp[];
  view?: DbView;
  kanbanGroupBy?: string;
  calendarDateBy?: string;
  timelineStartBy?: string;
  timelineEndBy?: string;
  filters?: DbFilter[];
  sort?: DbSort[];
};

export type DbValues = Record<string, unknown>;

export const SELECT_COLORS = [
  "#fde68a", "#fca5a5", "#a7f3d0", "#bfdbfe", "#ddd6fe",
  "#fbcfe8", "#fed7aa", "#e5e7eb",
];

export function newId(prefix: string) {
  // 12-hex-char random suffix (collision-resistant for prop/option ids).
  const hex = Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `${prefix}_${hex}`;
}

export function parseSchema(s: string | null | undefined): DbSchema {
  if (!s) return { props: [{ id: "p_title", name: "Name", type: "text" }], view: "table" };
  try {
    const p = JSON.parse(s);
    if (p && Array.isArray(p.props)) {
      const schema = p as DbSchema;
      const allowed: DbView[] = ["kanban", "gallery", "calendar", "timeline"];
      if (!allowed.includes(schema.view as DbView)) schema.view = "table";
      return schema;
    }
  } catch {}
  return { props: [{ id: "p_title", name: "Name", type: "text" }], view: "table" };
}

export function parseValues(s: string | null | undefined): DbValues {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v ? (v as DbValues) : {};
  } catch {
    return {};
  }
}
