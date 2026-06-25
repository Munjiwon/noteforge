"use client";

export type ExportRow = {
  key: string;
  type: string;
  summary: string;
  status: string;
  priority: string;
  assignee: string;
  points: string;
};

function toCsv(rows: ExportRow[]): string {
  const headers = ["Key", "Type", "Summary", "Status", "Priority", "Assignee", "Story Points"];
  const esc = (v: string) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([r.key, r.type, r.summary, r.status, r.priority, r.assignee, r.points].map(esc).join(","));
  }
  return lines.join("\r\n");
}

export function ExportIssuesButton({ rows, filename }: { rows: ExportRow[]; filename: string }) {
  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button
      onClick={download}
      disabled={rows.length === 0}
      className="rounded border border-gray-300 px-2 py-1 text-sm hover:bg-black/5 disabled:opacity-40"
      title="Export the current view to CSV"
    >
      ↓ Export CSV
    </button>
  );
}
