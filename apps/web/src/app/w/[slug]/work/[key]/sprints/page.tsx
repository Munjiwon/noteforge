import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { priorityMeta, categoryMeta } from "@/lib/work";

export const dynamic = "force-dynamic";

type Row = {
  number: number;
  summary: string;
  typeIcon: string | null;
  priority: string;
  statusName: string;
  statusCategory: string;
  storyPoints: number | null;
  assigneeName: string | null;
  assigneeColor: string | null;
  carriedOut: boolean; // was in this sprint but later moved elsewhere
};

export default async function SprintsPage({
  params,
}: {
  params: { slug: string; key: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, key: true, type: true },
  });
  if (!project) notFound();
  if (project.type !== "scrum") redirect(`/w/${params.slug}/work/${project.key}/board`);

  const sprints = await prisma.sprint.findMany({
    where: { projectId: project.id },
    orderBy: { sequence: "desc" },
    take: 50,
  });
  const sprintIds = sprints.map((s) => s.id);

  const issueSelect = {
    number: true,
    summary: true,
    priority: true,
    storyPoints: true,
    sprintId: true,
    type: { select: { icon: true } },
    status: { select: { name: true, category: true } },
    assignee: { select: { name: true, color: true } },
  } as const;

  // Issues currently in any of these sprints, grouped by sprint.
  const current = sprintIds.length
    ? await prisma.issue.findMany({
        where: { projectId: project.id, sprintId: { in: sprintIds } },
        orderBy: { rank: "asc" },
        select: { id: true, ...issueSelect },
      })
    : [];

  // Issues whose history shows they were moved INTO one of these sprints
  // (so completed sprints can show work that was carried out afterwards).
  const movedIn = sprintIds.length
    ? await prisma.issueActivity.findMany({
        where: { field: { in: ["sprint", "sprintId"] }, to: { in: sprintIds }, issue: { projectId: project.id } },
        select: { issueId: true, to: true },
      })
    : [];

  // Fetch details for moved-in issues not already loaded as current members.
  const currentIds = new Set(current.map((i) => i.id));
  const extraIds = [...new Set(movedIn.map((m) => m.issueId).filter((id) => !currentIds.has(id)))];
  const extras = extraIds.length
    ? await prisma.issue.findMany({ where: { id: { in: extraIds } }, select: { id: true, ...issueSelect } })
    : [];
  const issueById = new Map([...current, ...extras].map((i) => [i.id, i]));

  // sprintId -> ordered set of issue ids that ever belonged to it.
  const everBySprint = new Map<string, string[]>();
  for (const i of current) {
    if (!i.sprintId) continue;
    (everBySprint.get(i.sprintId) ?? everBySprint.set(i.sprintId, []).get(i.sprintId)!).push(i.id);
  }
  for (const m of movedIn) {
    const arr = everBySprint.get(m.to!) ?? everBySprint.set(m.to!, []).get(m.to!)!;
    if (!arr.includes(m.issueId)) arr.push(m.issueId);
  }

  const toRow = (id: string, sprintId: string): Row | null => {
    const i = issueById.get(id);
    if (!i) return null;
    return {
      number: i.number,
      summary: i.summary,
      typeIcon: i.type.icon,
      priority: i.priority,
      statusName: i.status.name,
      statusCategory: i.status.category,
      storyPoints: i.storyPoints,
      assigneeName: i.assignee?.name ?? null,
      assigneeColor: i.assignee?.color ?? null,
      carriedOut: i.sprintId !== sprintId,
    };
  };

  const sections = sprints.map((s) => {
    const rows = (everBySprint.get(s.id) ?? [])
      .map((id) => toRow(id, s.id))
      .filter((r): r is Row => r !== null);
    const points = rows.reduce((sum, r) => sum + (r.storyPoints ?? 0), 0);
    const donePoints = rows
      .filter((r) => r.statusCategory === "done")
      .reduce((sum, r) => sum + (r.storyPoints ?? 0), 0);
    const doneCount = rows.filter((r) => r.statusCategory === "done").length;
    return { sprint: s, rows, points, donePoints, doneCount };
  });

  const stateBadge: Record<string, { label: string; cls: string }> = {
    active: { label: "ACTIVE", cls: "bg-green-100 text-green-700" },
    future: { label: "FUTURE", cls: "bg-gray-100 text-gray-500" },
    completed: { label: "COMPLETED", cls: "bg-blue-100 text-blue-700" },
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <h2 className="mb-4 text-lg font-semibold">Sprints</h2>
      {sections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          No sprints yet. Create one from the{" "}
          <Link href={`/w/${params.slug}/work/${project.key}/backlog`} className="text-blue-600 hover:underline">
            backlog
          </Link>
          .
        </div>
      ) : (
        <div className="space-y-4">
          {sections.map(({ sprint: s, rows, points, donePoints, doneCount }) => {
            const badge = stateBadge[s.state] ?? stateBadge.future;
            return (
              <div key={s.id} className="overflow-hidden rounded-lg border border-gray-200">
                <div className="flex flex-wrap items-center gap-2 bg-gray-50 px-3 py-2">
                  <span className="font-medium">{s.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.label}</span>
                  {s.startDate && s.endDate && (
                    <span className="text-xs text-gray-400">
                      {s.startDate.toISOString().slice(0, 10)} → {s.endDate.toISOString().slice(0, 10)}
                    </span>
                  )}
                  {s.completeDate && (
                    <span className="text-xs text-gray-400">· completed {s.completeDate.toISOString().slice(0, 10)}</span>
                  )}
                  <span className="ml-auto text-xs text-gray-500">
                    {rows.length} issue{rows.length === 1 ? "" : "s"} · {doneCount} done · {donePoints}/{points} pts
                  </span>
                </div>
                {s.goal && <div className="border-b border-gray-100 px-3 py-1.5 text-xs text-gray-500">🎯 {s.goal}</div>}
                <ul>
                  {rows.map((r) => (
                    <li key={r.number}>
                      <Link
                        href={`/w/${params.slug}/work/${project.key}/issue/${r.number}`}
                        className="flex items-center gap-2 border-b border-gray-50 px-3 py-1.5 text-sm last:border-b-0 hover:bg-black/[0.02]"
                      >
                        <span>{r.typeIcon ?? "🎫"}</span>
                        <span className="font-mono text-xs text-gray-400 shrink-0">{project.key}-{r.number}</span>
                        <span className="flex-1 truncate">{r.summary || "Untitled"}</span>
                        {r.carriedOut && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 shrink-0" title="Moved out of this sprint">
                            carried out
                          </span>
                        )}
                        {r.storyPoints != null && (
                          <span className="rounded-full bg-gray-100 px-1.5 text-xs shrink-0">{r.storyPoints}</span>
                        )}
                        <span style={{ color: priorityMeta(r.priority).color }}>{priorityMeta(r.priority).icon}</span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] shrink-0"
                          style={{ background: `${categoryMeta(r.statusCategory).color}22`, color: categoryMeta(r.statusCategory).color }}
                        >
                          {r.statusName}
                        </span>
                        {r.assigneeName && (
                          <span
                            className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-white shrink-0"
                            style={{ background: r.assigneeColor ?? "#888" }}
                            title={r.assigneeName}
                          >
                            {r.assigneeName.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                  {rows.length === 0 && (
                    <li className="px-3 py-3 text-center text-xs text-gray-400">No issues in this sprint.</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
