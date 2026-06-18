import { prisma } from "db";
import { requireWorkspaceMember } from "./workspace";

// Resolve a work project by its key within a workspace, enforcing membership.
// Returns the auth context plus the project row. Throws "not found" when the
// project does not exist in the workspace.
export async function requireWorkProject(slug: string, key: string) {
  const ctx = await requireWorkspaceMember(slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key },
  });
  if (!project) throw new Error("project not found");
  return { ctx, project };
}

export async function assertWorkEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

// Load the project's metadata used to populate issue editors and pickers:
// statuses, issue types, sprints, epics, components, versions, and labels.
export async function loadProjectMeta(projectId: string, workspaceId: string) {
  const [statuses, types, sprints, epics, components, versions, labels] =
    await Promise.all([
      prisma.workflowStatus.findMany({
        where: { projectId },
        orderBy: { position: "asc" },
      }),
      prisma.issueType.findMany({
        where: { projectId },
        orderBy: { position: "asc" },
      }),
      prisma.sprint.findMany({
        where: { projectId, state: { not: "completed" } },
        orderBy: { sequence: "asc" },
      }),
      prisma.issue.findMany({
        where: { projectId, type: { level: "epic" } },
        select: { id: true, number: true, summary: true },
      }),
      prisma.workComponent.findMany({ where: { projectId }, orderBy: { name: "asc" } }),
      prisma.workVersion.findMany({
        where: { projectId, archived: false },
        orderBy: { position: "asc" },
      }),
      prisma.workLabel.findMany({
        where: { workspaceId },
        orderBy: { name: "asc" },
      }),
    ]);
  return { statuses, types, sprints, epics, components, versions, labels };
}

// Load the members of a workspace for assignee/reporter pickers.
export async function workspaceMemberOptions(workspaceId: string) {
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, color: true, avatarUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    color: m.user.color,
    avatarUrl: m.user.avatarUrl,
  }));
}
