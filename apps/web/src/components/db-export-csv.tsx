"use client";

import type { DbProp, DbSchema } from "@/lib/database";

type Row = {
  id: string;
  title: string;
  dataValues: Record<string, unknown>;
};

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function valueToCell(prop: DbProp, row: Row): string {
  const v = prop.id === "p_title" ? row.title : row.dataValues[prop.id];
  if (v === null || v === undefined) return "";
  if (prop.type === "select") {
    return prop.options.find((o) => o.id === v)?.name ?? "";
  }
  if (prop.type === "multi_select") {
    if (!Array.isArray(v)) return "";
    return v
      .map((id: string) => prop.options.find((o) => o.id === id)?.name ?? "")
      .filter(Boolean)
      .join(", ");
  }
  if (prop.type === "status") {
    return prop.options.find((o) => o.id === v)?.name ?? "";
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function DbExportCsvButton({
  title,
  schema,
  rows,
}: {
  title: string;
  schema: DbSchema;
  rows: Row[];
}) {
  const onClick = () => {
    const props = schema.props.filter((p) => !(schema.hiddenColumns ?? []).includes(p.id));
    const header = props.map((p) => csvEscape(p.name)).join(",");
    const body = rows
      .map((r) => props.map((p) => csvEscape(valueToCell(p, r))).join(","))
      .join("\n");
    const csv = header + "\n" + body + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (title || "Untitled").replace(/[^\w\d-]+/g, "_") + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <button
      onClick={onClick}
      className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
      title="Export rows as CSV"
    >
      ⬇ CSV
    </button>
  );
}
