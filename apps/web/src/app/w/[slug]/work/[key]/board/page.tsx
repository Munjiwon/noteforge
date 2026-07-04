import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { BoardView } from "@/components/work/board-view";
import { issueKey } from "@/lib/work";

export const dynamic = "force-dynamic";

export default async function BoardPage({
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

  const board = await prisma.board.findFirst({
    where: { projectId: project.id },
    include: { columns: { orderBy: { position: "asc" } } },
  });
  if (!board) notFound();

  // Scrum boards show the active sprint; kanban boards show everything.
  const activeSprint =
    project.type === "scrum"
      ? await prisma.sprint.findFirst({
          where: { projectId: project.id, state: "active" },
        })
      : null;

  const issues =
    project.type === "scrum" && !activeSprint
      ? []
      : await prisma.issue.findMany({
          where: {
            projectId: project.id,
            ...(activeSprint ? { sprintId: activeSprint.id } : {}),
          },
          orderBy: { rank: "asc" },
          include: {
            type: { select: { icon: true } },
            assignee: { select: { name: true, color: true } },
            epic: { select: { number: true, summary: true } },
            status: { select: { category: true } },
          },
        });

  const cards = issues.map((i) => ({
    id: i.id,
    number: i.number,
    summary: i.summary,
    typeIcon: i.type.icon,
    priority: i.priority,
    statusId: i.statusId,
    assigneeId: i.assigneeId,
    assigneeName: i.assignee?.name ?? null,
    assigneeColor: i.assignee?.color ?? null,
    storyPoints: i.storyPoints,
    epicId: i.epicId,
    epicLabel: i.epic ? issueKey(project.key, i.epic.number) : null,
    dueDate: i.dueDate ? i.dueDate.toISOString() : null,
    statusCategory: i.status.category,
  }));

  const epics = await prisma.issue.findMany({
    where: { projectId: project.id, type: { level: "epic" } },
    select: { id: true, number: true, summary: true },
  });
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: ctx.workspace.id },
    include: { user: { select: { id: true, name: true } } },
  });
  const types = await prisma.issueType.findMany({
    where: { projectId: project.id },
    orderBy: { position: "asc" },
    select: { id: true, name: true, icon: true, level: true },
  });

  return (
    <div>
      {project.type === "scrum" && (
        <div className="flex items-center gap-2 px-4 pt-3 text-sm text-gray-600">
          {activeSprint ? (
            <span className="font-medium">
              {activeSprint.name}
              {activeSprint.endDate && (
                <span className="ml-2 font-normal text-gray-400">
                  ends {activeSprint.endDate.toISOString().slice(0, 10)}
                </span>
              )}
            </span>
          ) : (
            <span className="text-gray-400">No active sprint.</span>
          )}
          <Link
            href={`/w/${params.slug}/work/${project.key}/backlog`}
            className="ml-auto rounded border border-gray-300 px-2 py-1 text-xs hover:bg-black/5"
          >
            Plan sprint →
          </Link>
        </div>
      )}
      {project.type === "scrum" && !activeSprint ? (
        <div className="px-6 py-16 text-center text-gray-400">
          Start a sprint from the{" "}
          <Link href={`/w/${params.slug}/work/${project.key}/backlog`} className="text-blue-600 hover:underline">
            backlog
          </Link>{" "}
          to populate the board.
        </div>
      ) : (
        <BoardView
          slug={params.slug}
          projectKey={project.key}
          projectId={project.id}
          activeSprintId={activeSprint?.id ?? null}
          createTypes={types
            .filter((t) => t.level !== "epic")
            .map((t) => ({ id: t.id, name: t.name, icon: t.icon }))}
          currentUserId={ctx.user.id}
          readOnly={ctx.role === "viewer"}
          columns={board.columns.map((c) => ({
            id: c.id,
            name: c.name,
            statusIds: JSON.parse(c.statusIds) as string[],
            wipLimit: c.wipLimit,
          }))}
          cards={cards}
          swimlaneOptions={{
            epics: epics.map((e) => ({ id: e.id, label: `${issueKey(project.key, e.number)} ${e.summary}` })),
            members: members.map((m) => ({ id: m.user.id, name: m.user.name })),
          }}
        />
      )}
    </div>
  );
}
