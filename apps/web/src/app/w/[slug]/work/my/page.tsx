import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { IssueTable, toIssueRow } from "@/components/work/issue-table";
import { priorityMeta } from "@/lib/work";

export const dynamic = "force-dynamic";

export default async function MyWorkPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { all?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const showDone = searchParams.all === "1";

  const issues = await prisma.issue.findMany({
    where: {
      assigneeId: ctx.user.id,
      project: { workspaceId: ctx.workspace.id, archivedAt: null },
      ...(showDone ? {} : { status: { category: { not: "done" } } }),
    },
    // priority is a String column — order by recency in SQL, then by priority
    // severity in memory below (lexical priority order would be wrong).
    orderBy: [{ updatedAt: "desc" }],
    take: 200,
    include: {
      project: { select: { key: true, name: true } },
      type: { select: { icon: true, name: true } },
      status: { select: { name: true, category: true } },
      assignee: { select: { name: true, color: true } },
    },
  });
  issues.sort((a, b) => priorityMeta(b.priority).rank - priorityMeta(a.priority).rank);

  // Group by project (preserving the priority order within each group).
  const groups = new Map<string, { name: string; rows: typeof issues }>();
  for (const i of issues) {
    const g = groups.get(i.project.key) ?? { name: i.project.name, rows: [] };
    g.rows.push(i);
    groups.set(i.project.key, g);
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">My work</h1>
        <span className="text-sm text-gray-400">{issues.length}</span>
        <Link
          href={showDone ? "?" : "?all=1"}
          className="ml-auto rounded border border-gray-300 px-2 py-1 text-xs hover:bg-black/5"
        >
          {showDone ? "Hide done" : "Show done"}
        </Link>
      </div>
      {issues.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          Nothing assigned to you{showDone ? "" : " that's still open"}.
        </div>
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([key, g]) => (
            <div key={key}>
              <div className="mb-1.5 flex items-center gap-2 text-sm">
                <Link
                  href={`/w/${params.slug}/work/${key}/board`}
                  className="font-medium text-gray-800 hover:underline"
                >
                  {g.name}
                </Link>
                <span className="rounded bg-gray-100 px-1.5 font-mono text-[11px] text-gray-500">{key}</span>
                <span className="text-xs text-gray-400">{g.rows.length}</span>
              </div>
              <IssueTable slug={params.slug} rows={g.rows.map(toIssueRow)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
