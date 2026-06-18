import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { IssueTable, toIssueRow } from "@/components/work/issue-table";

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
    orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
    take: 200,
    include: {
      project: { select: { key: true } },
      type: { select: { icon: true, name: true } },
      status: { select: { name: true, category: true } },
      assignee: { select: { name: true, color: true } },
    },
  });

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
      <IssueTable slug={params.slug} rows={issues.map(toIssueRow)} />
    </div>
  );
}
