import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { NewProjectDialog } from "@/components/work/new-project-dialog";
import { restoreWorkProject } from "@/app/w/[slug]/work/work-project-actions";

export const dynamic = "force-dynamic";

export default async function WorkProjectsPage({
  params,
}: {
  params: { slug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const projects = await prisma.workProject.findMany({
    where: { workspaceId: ctx.workspace.id, archivedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      lead: { select: { name: true, color: true, avatarUrl: true } },
      _count: { select: { issues: true, sprints: true } },
    },
  });

  // Count open (non-done) issues per project in one query.
  const openCounts = await prisma.issue.groupBy({
    by: ["projectId"],
    where: {
      project: { workspaceId: ctx.workspace.id },
      status: { category: { not: "done" } },
    },
    _count: { _all: true },
  });
  const openByProject = new Map(openCounts.map((c) => [c.projectId, c._count._all]));

  const archived = await prisma.workProject.findMany({
    where: { workspaceId: ctx.workspace.id, archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
    select: { id: true, key: true, name: true, icon: true },
  });
  const canEdit = ctx.role !== "viewer";

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Work projects</h1>
          <p className="text-sm text-gray-500">
            JIRA-style issue tracking, boards, and sprints.
          </p>
        </div>
        {ctx.role !== "viewer" && <NewProjectDialog slug={params.slug} />}
      </div>

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center">
          <div className="mb-2 text-4xl">🗂️</div>
          <p className="mb-1 font-medium">No work projects yet</p>
          <p className="text-sm text-gray-500">
            Create a project to start tracking issues with boards and sprints.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/w/${params.slug}/work/${p.key}`}
              className="group rounded-lg border border-gray-200 p-4 transition hover:border-gray-300 hover:shadow-sm"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xl">{p.icon || "🗂️"}</span>
                <span className="font-semibold">{p.name}</span>
                <span className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-500">
                  {p.key}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="capitalize">{p.type}</span>
                <span>·</span>
                <span>{openByProject.get(p.id) ?? 0} open</span>
                <span>·</span>
                <span>{p._count.issues} total</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
            Archived ({archived.length})
          </h2>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {archived.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span>{p.icon || "🗂️"}</span>
                <span className="text-gray-600">{p.name}</span>
                <span className="rounded bg-gray-100 px-1.5 font-mono text-[11px] text-gray-400">{p.key}</span>
                {canEdit && (
                  <form action={restoreWorkProject.bind(null, params.slug, p.id)} className="ml-auto">
                    <button className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-black/5">
                      Restore
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
