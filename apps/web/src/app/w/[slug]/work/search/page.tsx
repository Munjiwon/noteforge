import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { buildIssueQuery } from "@/lib/work-jql";
import { IssueTable, toIssueRow } from "@/components/work/issue-table";
import { createSavedFilter, deleteSavedFilter } from "@/app/w/[slug]/work/work-extra-actions";

export const dynamic = "force-dynamic";

const ISSUE_INCLUDE = {
  project: { select: { key: true } },
  type: { select: { icon: true, name: true } },
  status: { select: { name: true, category: true } },
  assignee: { select: { name: true, color: true } },
} as const;

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { q?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const q = searchParams.q ?? "";

  const [{ where, orderBy }, savedFilters] = await Promise.all([
    buildIssueQuery(q, ctx.workspace.id, ctx.user.id),
    prisma.savedFilter.findMany({
      where: { workspaceId: ctx.workspace.id, OR: [{ ownerId: ctx.user.id }, { shared: true }] },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const issues = q.trim()
    ? await prisma.issue.findMany({ where, orderBy, take: 200, include: ISSUE_INCLUDE })
    : [];

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-2 flex items-center gap-2">
        <Link href={`/w/${params.slug}/work`} className="text-sm text-gray-400 hover:text-gray-700">
          Projects
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-lg font-semibold">Search issues</h1>
      </div>

      <form className="mb-2 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder='e.g.  assignee = me AND status != Done ORDER BY priority desc'
          className="flex-1 rounded border border-gray-300 px-3 py-1.5 font-mono text-sm"
        />
        <button className="rounded bg-gray-800 px-4 py-1.5 text-sm text-white">Search</button>
      </form>
      <p className="mb-4 text-xs text-gray-400">
        Fields: status, type, priority, assignee, reporter, sprint, project, label, component,
        resolution, summary, due, created · operators = != ~ &gt; &lt; in · join with AND.
      </p>

      {savedFilters.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Saved:</span>
          {savedFilters.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs">
              <Link href={`?q=${encodeURIComponent(f.jql)}`} className="hover:underline">
                {f.name}
              </Link>
              {f.shared && <span className="text-gray-400">·shared</span>}
              <form action={deleteSavedFilter.bind(null, params.slug, f.id)}>
                <button className="text-gray-400 hover:text-red-600">×</button>
              </form>
            </span>
          ))}
        </div>
      )}

      {q.trim() && (
        <form action={createSavedFilter} className="mb-4 flex flex-wrap items-center gap-2">
          <input type="hidden" name="slug" value={params.slug} />
          <input type="hidden" name="jql" value={q} />
          <input name="name" placeholder="Save this filter as…" className="rounded border border-gray-300 px-2 py-1 text-sm" />
          <label className="flex items-center gap-1 text-xs text-gray-500">
            <input type="checkbox" name="shared" /> share
          </label>
          <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-black/5">Save filter</button>
        </form>
      )}

      {q.trim() ? (
        <>
          <div className="mb-2 text-sm text-gray-400">{issues.length} result{issues.length === 1 ? "" : "s"}</div>
          <IssueTable slug={params.slug} rows={issues.map(toIssueRow)} />
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          Enter a query to search across all projects.
        </div>
      )}
    </div>
  );
}
