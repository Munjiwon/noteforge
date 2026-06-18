import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { loadProjectMeta, workspaceMemberOptions } from "@/lib/work-server";
import { prisma } from "db";
import { IssueDetail } from "@/components/work/issue-detail";

export const dynamic = "force-dynamic";

export default async function IssuePage({
  params,
}: {
  params: { slug: string; key: string; num: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, key: true },
  });
  if (!project) notFound();
  const number = Number(params.num);
  if (!Number.isFinite(number)) notFound();

  const issue = await prisma.issue.findFirst({
    where: { projectId: project.id, number },
    include: {
      comments: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { name: true, color: true } } },
      },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { user: { select: { name: true } } },
      },
      subtasks: {
        orderBy: { rank: "asc" },
        include: { status: { select: { category: true } } },
      },
      watchers: { select: { userId: true } },
    },
  });
  if (!issue) notFound();

  const [meta, members] = await Promise.all([
    loadProjectMeta(project.id, ctx.workspace.id),
    workspaceMemberOptions(ctx.workspace.id),
  ]);

  const readOnly = ctx.role === "viewer";

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <IssueDetail
        slug={params.slug}
        projectKey={project.key}
        projectId={project.id}
        currentUserId={ctx.user.id}
        readOnly={readOnly}
        isWatching={issue.watchers.some((w) => w.userId === ctx.user.id)}
        watcherCount={issue.watchers.length}
        issue={{
          id: issue.id,
          number: issue.number,
          summary: issue.summary,
          description: issue.description,
          priority: issue.priority,
          statusId: issue.statusId,
          typeId: issue.typeId,
          assigneeId: issue.assigneeId,
          reporterId: issue.reporterId,
          storyPoints: issue.storyPoints,
          dueDate: issue.dueDate ? issue.dueDate.toISOString() : null,
          epicId: issue.epicId,
          parentId: issue.parentId,
          sprintId: issue.sprintId,
          resolution: issue.resolution,
        }}
        meta={{
          statuses: meta.statuses.map((s) => ({ id: s.id, name: s.name, category: s.category, color: s.color })),
          types: meta.types.map((t) => ({ id: t.id, name: t.name, icon: t.icon, level: t.level })),
          sprints: meta.sprints.map((s) => ({ id: s.id, name: s.name, state: s.state })),
          epics: meta.epics,
        }}
        members={members.map((m) => ({ id: m.id, name: m.name, color: m.color }))}
        comments={issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          authorId: c.authorId,
          authorName: c.author.name,
          authorColor: c.author.color,
          createdAt: c.createdAt.toISOString(),
        }))}
        activities={issue.activities.map((a) => ({
          id: a.id,
          field: a.field,
          from: a.from,
          to: a.to,
          userName: a.user?.name ?? null,
          createdAt: a.createdAt.toISOString(),
        }))}
        subtasks={issue.subtasks.map((s) => ({
          id: s.id,
          number: s.number,
          summary: s.summary,
          category: s.status.category,
        }))}
      />
    </div>
  );
}
