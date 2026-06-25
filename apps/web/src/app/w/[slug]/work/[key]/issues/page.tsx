import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { loadProjectMeta } from "@/lib/work-server";
import { prisma } from "db";
import { QuickCreateIssue } from "@/components/work/quick-create-issue";
import { ExportIssuesButton } from "@/components/work/export-issues-button";
import { priorityMeta, categoryMeta } from "@/lib/work";

export const dynamic = "force-dynamic";

export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: { slug: string; key: string };
  searchParams: { status?: string; assignee?: string; type?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, key: true },
  });
  if (!project) notFound();

  const meta = await loadProjectMeta(project.id, ctx.workspace.id);
  const issues = await prisma.issue.findMany({
    where: {
      projectId: project.id,
      ...(searchParams.status ? { statusId: searchParams.status } : {}),
      ...(searchParams.assignee ? { assigneeId: searchParams.assignee } : {}),
      ...(searchParams.type ? { typeId: searchParams.type } : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    include: {
      status: true,
      type: true,
      assignee: { select: { name: true, color: true } },
    },
  });

  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Issues</h2>
        <span className="text-sm text-gray-400">{issues.length}</span>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <form className="flex gap-2">
            <select
              name="status"
              defaultValue={searchParams.status ?? ""}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">All statuses</option>
              {meta.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              name="type"
              defaultValue={searchParams.type ?? ""}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">All types</option>
              {meta.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button className="rounded border border-gray-300 px-2 py-1 text-sm hover:bg-black/5">
              Filter
            </button>
          </form>
          <ExportIssuesButton
            filename={`${project.key}-issues.csv`}
            rows={issues.map((i) => ({
              key: `${project.key}-${i.number}`,
              type: i.type.name,
              summary: i.summary,
              status: i.status.name,
              priority: priorityMeta(i.priority).name,
              assignee: i.assignee?.name ?? "",
              points: i.storyPoints?.toString() ?? "",
            }))}
          />
        </div>
      </div>

      {ctx.role !== "viewer" && (
        <div className="mb-3">
          <QuickCreateIssue
            slug={params.slug}
            projectId={project.id}
            types={meta.types.map((t) => ({ id: t.id, name: t.name, icon: t.icon }))}
          />
        </div>
      )}

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
            {issues.map((i) => (
              <tr key={i.id} className="border-t border-gray-100 hover:bg-black/[0.02]">
                <td className="px-3 py-2" title={i.type.name}>{i.type.icon}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-500">
                  <Link href={`/w/${params.slug}/work/${project.key}/issue/${i.number}`} className="hover:underline">
                    {project.key}-{i.number}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <Link href={`/w/${params.slug}/work/${project.key}/issue/${i.number}`} className="hover:underline">
                    {i.summary || <span className="text-gray-400">Untitled</span>}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span
                    className="inline-block rounded px-1.5 py-0.5 text-xs"
                    style={{
                      background: `${categoryMeta(i.status.category).color}22`,
                      color: categoryMeta(i.status.category).color,
                    }}
                  >
                    {i.status.name}
                  </span>
                </td>
                <td className="px-3 py-2" style={{ color: priorityMeta(i.priority).color }}>
                  {priorityMeta(i.priority).icon}
                </td>
                <td className="px-3 py-2">
                  {i.assignee ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-white"
                        style={{ background: i.assignee.color }}
                      >
                        {i.assignee.name.slice(0, 1).toUpperCase()}
                      </span>
                      {i.assignee.name}
                    </span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500">{i.storyPoints ?? ""}</td>
              </tr>
            ))}
            {issues.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                  No issues yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
