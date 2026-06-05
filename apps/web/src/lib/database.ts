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
  | "formula"
  | "created_at"
  | "updated_at"
  | "created_by"
  | "duration";

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
  | { id: string; name: string; description?: string; type: "formula"; expr: string }
  | { id: string; name: string; description?: string; type: "created_at"; format?: DateFormat }
  | { id: string; name: string; description?: string; type: "updated_at"; format?: DateFormat }
  | { id: string; name: string; description?: string; type: "created_by" }
  | { id: string; name: string; description?: string; type: "duration" };

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

export type FilterCombinator = "and" | "or";

export type SavedView = {
  id: string;
  name: string;
  kind: DbView;
  filters?: DbFilter[];
  filterCombinator?: FilterCombinator;
  sort?: DbSort[];
  hiddenColumns?: string[];
  columnOrder?: string[];
  tableGroupBy?: string;
  kanbanGroupBy?: string;
  calendarDateBy?: string;
  timelineStartBy?: string;
  timelineEndBy?: string;
};

export type DbSchema = {
  props: DbProp[];
  view?: DbView;
  views?: SavedView[];
  activeViewId?: string;
  kanbanGroupBy?: string;
  calendarDateBy?: string;
  timelineStartBy?: string;
  timelineEndBy?: string;
  filters?: DbFilter[];
  filterCombinator?: FilterCombinator;
  sort?: DbSort[];
  columnOrder?: string[];
  hiddenColumns?: string[];
  columnWidths?: Record<string, number>;
  tableGroupBy?: string;
};

export function getActiveView(schema: DbSchema): SavedView | null {
  if (!schema.views?.length) return null;
  return schema.views.find((v) => v.id === schema.activeViewId) ?? schema.views[0];
}

export function effectiveViewKind(schema: DbSchema): DbView {
  return getActiveView(schema)?.kind ?? schema.view ?? "table";
}

export function effectiveFilters(schema: DbSchema): DbFilter[] {
  const v = getActiveView(schema);
  return (v ? v.filters : schema.filters) ?? [];
}

export function effectiveFilterCombinator(schema: DbSchema): FilterCombinator {
  const v = getActiveView(schema);
  return (v ? v.filterCombinator : schema.filterCombinator) ?? "and";
}

export function effectiveSort(schema: DbSchema): DbSort[] {
  const v = getActiveView(schema);
  return (v ? v.sort : schema.sort) ?? [];
}

export function effectiveHidden(schema: DbSchema): string[] {
  const v = getActiveView(schema);
  return (v ? v.hiddenColumns : schema.hiddenColumns) ?? [];
}

export function effectiveColumnOrder(schema: DbSchema): string[] {
  const v = getActiveView(schema);
  return (v ? v.columnOrder : schema.columnOrder) ?? [];
}

export function effectiveTableGroupBy(schema: DbSchema): string | undefined {
  const v = getActiveView(schema);
  return v ? v.tableGroupBy : schema.tableGroupBy;
}

export function effectiveKanbanGroupBy(schema: DbSchema): string | undefined {
  const v = getActiveView(schema);
  return v ? v.kanbanGroupBy : schema.kanbanGroupBy;
}

export function effectiveCalendarDateBy(schema: DbSchema): string | undefined {
  const v = getActiveView(schema);
  return v ? v.calendarDateBy : schema.calendarDateBy;
}

export function effectiveTimelineRange(schema: DbSchema): { startBy?: string; endBy?: string } {
  const v = getActiveView(schema);
  return v
    ? { startBy: v.timelineStartBy, endBy: v.timelineEndBy }
    : { startBy: schema.timelineStartBy, endBy: schema.timelineEndBy };
}

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
  const hidden = new Set(effectiveHidden(schema));
  const orderedIds = effectiveColumnOrder(schema).filter((id) => byId.has(id));
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

// Duration helpers: stored as integer minutes.
export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return "";
  const m = Math.floor(minutes);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  if (rest === 0) return `${h}h`;
  return `${h}h ${rest}m`;
}

// Accepts "90", "1h 30m", "1h", "30m", "1:30". Returns minutes or null.
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const colon = /^(\d+):(\d{1,2})$/.exec(s);
  if (colon) return parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10);
  const re = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*$/.exec(s);
  if (re && (re[1] || re[2])) {
    return (parseInt(re[1] ?? "0", 10) || 0) * 60 + (parseInt(re[2] ?? "0", 10) || 0);
  }
  const plain = /^\d+$/.exec(s);
  if (plain) return parseInt(plain[0], 10);
  return null;
}
