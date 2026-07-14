import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { loadProjectMeta, workspaceMemberOptions } from "@/lib/work-server";
import { prisma } from "db";
import { QuickCreateIssue } from "@/components/work/quick-create-issue";
import { ExportIssuesButton } from "@/components/work/export-issues-button";
import { priorityMeta, categoryMeta, PRIORITIES } from "@/lib/work";

export const dynamic = "force-dynamic";

export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: { slug: string; key: string };
  searchParams: {
    status?: string;
    assignee?: string;
    type?: string;
    priority?: string;
    sort?: string;
    dir?: string;
  };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, key: true },
  });
  if (!project) notFound();

  const [meta, members] = await Promise.all([
    loadProjectMeta(project.id, ctx.workspace.id),
    workspaceMemberOptions(ctx.workspace.id),
  ]);
  const sort = searchParams.sort ?? "updated";
  const dir: "asc" | "desc" = searchParams.dir === "asc" ? "asc" : "desc";
  const dbOrderBy =
    sort === "number"
      ? { number: dir }
      : sort === "points"
      ? { storyPoints: dir }
      : { updatedAt: dir }; // "updated" (default) and "priority" (sorted in memory)

  const issues = await prisma.issue.findMany({
    where: {
      projectId: project.id,
      ...(searchParams.status ? { statusId: searchParams.status } : {}),
      ...(searchParams.assignee ? { assigneeId: searchParams.assignee } : {}),
      ...(searchParams.type ? { typeId: searchParams.type } : {}),
      ...(searchParams.priority ? { priority: searchParams.priority } : {}),
    },
    orderBy: [dbOrderBy],
    include: {
      status: true,
      type: true,
      assignee: { select: { name: true, color: true } },
      labels: { include: { label: { select: { name: true, color: true } } } },
    },
  });
  if (sort === "priority") {
    issues.sort((a, b) => {
      const d = priorityMeta(b.priority).rank - priorityMeta(a.priority).rank;
      return dir === "asc" ? -d : d;
    });
  }

  // Build a sortable-column header link that preserves the active filters and
  // toggles direction when the same column is clicked.
  const sortLink = (field: string) => {
    const p = new URLSearchParams();
    for (const k of ["status", "assignee", "type", "priority"] as const) {
      if (searchParams[k]) p.set(k, searchParams[k]!);
    }
    p.set("sort", field);
    p.set("dir", sort === field && dir === "desc" ? "asc" : "desc");
    return `?${p.toString()}`;
  };
  const arrow = (field: string) => (sort === field ? (dir === "asc" ? " ▲" : " ▼") : "");

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
            <select
              name="assignee"
              defaultValue={searchParams.assignee ?? ""}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">All assignees</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <select
              name="priority"
              defaultValue={searchParams.priority ?? ""}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">All priorities</option>
              {PRIORITIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
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
              <th className="px-3 py-2 font-medium">
                <Link href={sortLink("number")} className="hover:text-gray-900">Key{arrow("number")}</Link>
              </th>
              <th className="px-3 py-2 font-medium">Summary</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">
                <Link href={sortLink("priority")} className="hover:text-gray-900">Priority{arrow("priority")}</Link>
              </th>
              <th className="px-3 py-2 font-medium">Assignee</th>
              <th className="px-3 py-2 font-medium">
                <Link href={sortLink("points")} className="hover:text-gray-900">Pts{arrow("points")}</Link>
              </th>
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
                  {i.labels.length > 0 && (
                    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                      {i.labels.map((l) => (
                        <span
                          key={l.id}
                          className="rounded px-1.5 py-0.5 text-[10px] text-white"
                          style={{ background: l.label.color ?? "#64748b" }}
                        >
                          {l.label.name}
                        </span>
                      ))}
                    </span>
                  )}
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
