import {
  effectiveFilterCombinator,
  effectiveFilters,
  effectiveSort,
  type DbFilter,
  type DbProp,
  type DbSchema,
} from "./database";

type BaseRow = {
  id: string;
  title: string;
  dataValues: Record<string, unknown>;
};

function valueOf(prop: DbProp, row: BaseRow): unknown {
  return prop.id === "p_title" ? row.title : row.dataValues[prop.id];
}

function isEmpty(v: unknown) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function passes(filter: DbFilter, prop: DbProp, row: BaseRow): boolean {
  const v = valueOf(prop, row);
  switch (filter.op) {
    case "empty":
      return isEmpty(v);
    case "not_empty":
      return !isEmpty(v);
    case "checked":
      return Boolean(v);
    case "unchecked":
      return !v;
    case "eq":
      return String(v ?? "") === String(filter.value ?? "");
    case "ne":
      return String(v ?? "") !== String(filter.value ?? "");
    case "contains": {
      if (isEmpty(v)) return false;
      return String(v).toLowerCase().includes(String(filter.value ?? "").toLowerCase());
    }
    case "before":
      return typeof v === "string" && v < String(filter.value ?? "");
    case "after":
      return typeof v === "string" && v > String(filter.value ?? "");
    default:
      return true;
  }
}

export function applyQuery<R extends BaseRow>(schema: DbSchema, rows: R[]): R[] {
  const filters = effectiveFilters(schema);
  const combinator = effectiveFilterCombinator(schema);
  const sort = effectiveSort(schema);

  let out = rows;

  if (filters.length > 0) {
    const test = (row: BaseRow, f: DbFilter) => {
      const prop = schema.props.find((p) => p.id === f.propId);
      if (!prop) return combinator === "and"; // unknown prop: AND keeps row, OR skips it
      return passes(f, prop, row);
    };
    out = rows.filter((row) =>
      combinator === "or"
        ? filters.some((f) => test(row, f))
        : filters.every((f) => test(row, f)),
    );
  }

  if (sort.length > 0) {
    out = [...out].sort((a, b) => {
      for (const s of sort) {
        const prop = schema.props.find((p) => p.id === s.propId);
        if (!prop) continue;
        const av = valueOf(prop, a);
        const bv = valueOf(prop, b);
        const cmp = compare(prop, av, bv);
        if (cmp !== 0) return s.dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  return out;
}

function compare(prop: DbProp, a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (prop.type === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return 0;
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  }
  if (prop.type === "checkbox") return (a ? 1 : 0) - (b ? 1 : 0);
  if (prop.type === "select") {
    const opts = prop.options;
    const ai = opts.findIndex((o) => o.id === a);
    const bi = opts.findIndex((o) => o.id === b);
    return ai - bi;
  }
  return String(a).localeCompare(String(b));
}
