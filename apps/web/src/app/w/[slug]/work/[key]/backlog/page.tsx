import { notFound, redirect } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { BacklogView, type BacklogItem } from "@/components/work/backlog-view";

export const dynamic = "force-dynamic";

export default async function BacklogPage({
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
  // Backlog/sprint planning is a scrum concept.
  if (project.type !== "scrum") redirect(`/w/${params.slug}/work/${project.key}/board`);

  const [sprints, issues, types] = await Promise.all([
    prisma.sprint.findMany({
      where: { projectId: project.id, state: { not: "completed" } },
      orderBy: { sequence: "asc" },
    }),
    prisma.issue.findMany({
      where: { projectId: project.id },
      orderBy: { rank: "asc" },
      include: {
        type: { select: { icon: true } },
        status: { select: { name: true, category: true } },
        assignee: { select: { name: true, color: true } },
      },
    }),
    prisma.issueType.findMany({ where: { projectId: project.id }, orderBy: { position: "asc" } }),
  ]);

  const toItem = (i: (typeof issues)[number]): BacklogItem => ({
    id: i.id,
    number: i.number,
    summary: i.summary,
    typeIcon: i.type.icon,
    priority: i.priority,
    statusName: i.status.name,
    statusCategory: i.status.category,
    assigneeName: i.assignee?.name ?? null,
    assigneeColor: i.assignee?.color ?? null,
    storyPoints: i.storyPoints,
    rank: i.rank,
  });

  const bySprint = new Map<string, BacklogItem[]>();
  const backlog: BacklogItem[] = [];
  for (const i of issues) {
    if (i.sprintId) {
      (bySprint.get(i.sprintId) ?? bySprint.set(i.sprintId, []).get(i.sprintId)!).push(toItem(i));
    } else {
      backlog.push(toItem(i));
    }
  }

  return (
    <BacklogView
      slug={params.slug}
      projectKey={project.key}
      projectId={project.id}
      readOnly={ctx.role === "viewer"}
      types={types.map((t) => ({ id: t.id, name: t.name, icon: t.icon }))}
      sprints={sprints.map((s) => ({
        id: s.id,
        name: s.name,
        goal: s.goal,
        state: s.state,
        startDate: s.startDate ? s.startDate.toISOString() : null,
        endDate: s.endDate ? s.endDate.toISOString() : null,
        items: bySprint.get(s.id) ?? [],
      }))}
      backlog={backlog}
    />
  );
}
