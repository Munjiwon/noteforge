import Link from "next/link";
import { priorityMeta, categoryMeta } from "@/lib/work";

export type IssueRow = {
  id: string;
  number: number;
  projectKey: string;
  summary: string;
  typeIcon: string | null;
  typeName: string;
  statusName: string;
  statusCategory: string;
  priority: string;
  assigneeName: string | null;
  assigneeColor: string | null;
  storyPoints: number | null;
};

// Cross-project issue list table, shared by the search and my-work views.
export function IssueTable({ slug, rows }: { slug: string; rows: IssueRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium">Summary</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Priority</th>
            <th className="px-3 py-2 font-medium">Assignee</th>
            <th className="px-3 py-2 font-medium">Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            const href = `/w/${slug}/work/${i.projectKey}/issue/${i.number}`;
            return (
              <tr key={i.id} className="border-t border-gray-100 hover:bg-black/[0.02]">
                <td className="px-3 py-2" title={i.typeName}>{i.typeIcon}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-500">
                  <Link href={href} className="hover:underline">{i.projectKey}-{i.number}</Link>
                </td>
                <td className="px-3 py-2">
                  <Link href={href} className="hover:underline">
                    {i.summary || <span className="text-gray-400">Untitled</span>}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span
                    className="inline-block rounded px-1.5 py-0.5 text-xs"
                    style={{
                      background: `${categoryMeta(i.statusCategory).color}22`,
                      color: categoryMeta(i.statusCategory).color,
                    }}
                  >
                    {i.statusName}
                  </span>
                </td>
                <td className="px-3 py-2" style={{ color: priorityMeta(i.priority).color }}>
                  {priorityMeta(i.priority).icon}
                </td>
                <td className="px-3 py-2">
                  {i.assigneeName ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-white"
                        style={{ background: i.assigneeColor ?? "#888" }}
                      >
                        {i.assigneeName.slice(0, 1).toUpperCase()}
                      </span>
                      {i.assigneeName}
                    </span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500">{i.storyPoints ?? ""}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-gray-400">No issues match.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function toIssueRow(i: {
  id: string;
  number: number;
  summary: string;
  priority: string;
  storyPoints: number | null;
  project: { key: string };
  type: { icon: string | null; name: string };
  status: { name: string; category: string };
  assignee: { name: string; color: string } | null;
}): IssueRow {
  return {
    id: i.id,
    number: i.number,
    projectKey: i.project.key,
    summary: i.summary,
    typeIcon: i.type.icon,
    typeName: i.type.name,
    statusName: i.status.name,
    statusCategory: i.status.category,
    priority: i.priority,
    assigneeName: i.assignee?.name ?? null,
    assigneeColor: i.assignee?.color ?? null,
    storyPoints: i.storyPoints,
  };
}
