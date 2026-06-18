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
