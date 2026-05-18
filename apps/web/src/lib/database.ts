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
  | "phone"
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

export type NumberFormat = "integer" | "decimal" | "percent" | "currency" | "progress" | "rating";
export type DateFormat = "short" | "long" | "relative";

export type DbProp =
  | { id: string; name: string; description?: string; type: "text" }
  | { id: string; name: string; description?: string; type: "number"; format?: NumberFormat }
  | { id: string; name: string; description?: string; type: "select"; options: DbPropSelectOption[] }
  | { id: string; name: string; description?: string; type: "multi_select"; options: DbPropSelectOption[] }
  | { id: string; name: string; description?: string; type: "status"; options: DbStatusOption[] }
  | { id: string; name: string; description?: string; type: "date"; format?: DateFormat }
  | { id: string; name: string; description?: string; type: "checkbox" }
  | { id: string; name: string; description?: string; type: "url" }
  | { id: string; name: string; description?: string; type: "email" }
  | { id: string; name: string; description?: string; type: "phone" }
  | { id: string; name: string; description?: string; type: "person" }
  | { id: string; name: string; description?: string; type: "files" }
  | { id: string; name: string; description?: string; type: "relation"; targetDbId: string }
  | { id: string; name: string; description?: string; type: "rollup"; relationPropId: string; targetPropId: string; aggregate: RollupAggregate }
  | { id: string; name: string; description?: string; type: "formula"; expr: string };

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

export type DbView = "table" | "kanban" | "gallery" | "calendar" | "timeline" | "list";

export type DbSchema = {
  props: DbProp[];
  view?: DbView;
  kanbanGroupBy?: string;
  calendarDateBy?: string;
  timelineStartBy?: string;
  timelineEndBy?: string;
  filters?: DbFilter[];
  sort?: DbSort[];
  columnOrder?: string[];
  hiddenColumns?: string[];
  columnWidths?: Record<string, number>;
  tableGroupBy?: string;
};

export function formatNumber(n: number, format: NumberFormat | undefined): string {
  if (!Number.isFinite(n)) return "";
  switch (format) {
    case "integer":
      return Math.trunc(n).toLocaleString();
    case "percent":
      return (n * 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "%";
    case "currency":
      return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
    case "progress":
      return Math.round(Math.max(0, Math.min(1, n)) * 100) + "%";
    case "rating": {
      const v = Math.max(0, Math.min(5, Math.round(n)));
      return "★".repeat(v) + "☆".repeat(5 - v);
    }
    case "decimal":
    default:
      return n.toLocaleString();
  }
}

export function formatDate(iso: string, format: DateFormat | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  switch (format) {
    case "long":
      return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    case "relative": {
      const diff = (Date.now() - d.getTime()) / 1000;
      const abs = Math.abs(diff);
      const dir = diff > 0 ? "ago" : "from now";
      if (abs < 60) return "just now";
      if (abs < 3600) return `${Math.floor(abs / 60)}m ${dir}`;
      if (abs < 86400) return `${Math.floor(abs / 3600)}h ${dir}`;
      if (abs < 86400 * 7) return `${Math.floor(abs / 86400)}d ${dir}`;
      return d.toLocaleDateString();
    }
    case "short":
    default:
      return d.toISOString().slice(0, 10);
  }
}

export function orderedVisibleProps(schema: DbSchema): DbProp[] {
  const byId = new Map(schema.props.map((p) => [p.id, p]));
  const hidden = new Set(schema.hiddenColumns ?? []);
  const orderedIds = (schema.columnOrder ?? []).filter((id) => byId.has(id));
  const remaining = schema.props.filter((p) => !orderedIds.includes(p.id));
  return [...orderedIds.map((id) => byId.get(id)!), ...remaining].filter(
    (p) => p.id === "p_title" || !hidden.has(p.id),
  );
}

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
      const allowed: DbView[] = ["kanban", "gallery", "calendar", "timeline", "list"];
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
