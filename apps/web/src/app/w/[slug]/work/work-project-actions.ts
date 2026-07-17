"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";
import {
  DEFAULT_ISSUE_TYPES,
  DEFAULT_STATUSES,
  suggestProjectKey,
} from "@/lib/work";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

// Ensure a project key is unique within the workspace by appending digits.
async function uniqueKey(workspaceId: string, base: string): Promise<string> {
  let key = base.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PROJ";
  let n = 1;
  while (
    await prisma.workProject.findFirst({
      where: { workspaceId, key },
      select: { id: true },
    })
  ) {
    n += 1;
    key = `${base.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)}${n}`;
  }
  return key;
}

/**
 * Create a work-management project with the full default agile scaffold:
 * issue types, a workflow (statuses + permissive transitions), and a board
 * whose columns map 1:1 to the statuses. Redirects to the new project's board.
 */
export async function createWorkProject(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const name = String(formData.get("name") || "").trim() || "Untitled project";
  const type = String(formData.get("type") || "scrum") === "kanban" ? "kanban" : "scrum";
  const keyInput = String(formData.get("key") || "").trim();
  const icon = String(formData.get("icon") || "🚀").trim() || "🚀";

  const ctx = await assertEditor(slug);
  const key = await uniqueKey(ctx.workspace.id, keyInput || suggestProjectKey(name));

  const project = await prisma.workProject.create({
    data: {
      workspaceId: ctx.workspace.id,
      key,
      name,
      type,
      icon,
      leadId: ctx.user.id,
    },
    select: { id: true },
  });

  // Issue types.
  await prisma.issueType.createMany({
    data: DEFAULT_ISSUE_TYPES.map((t, i) => ({
      projectId: project.id,
      name: t.name,
      icon: t.icon,
      level: t.level,
      color: t.color,
      position: i,
    })),
  });

  // Workflow statuses — created one at a time so we can capture their ids.
  const statusIds: string[] = [];
  for (let i = 0; i < DEFAULT_STATUSES.length; i++) {
    const s = DEFAULT_STATUSES[i];
    const row = await prisma.workflowStatus.create({
      data: {
        projectId: project.id,
        name: s.name,
        category: s.category,
        color: s.color,
        position: i,
      },
      select: { id: true },
    });
    statusIds.push(row.id);
  }

  // Permissive workflow: a global transition into every status (allowed from
  // any status). Users can later restrict this in the workflow editor.
  await prisma.workflowTransition.createMany({
    data: DEFAULT_STATUSES.map((s, i) => ({
      projectId: project.id,
      name: s.name,
      fromStatusId: null,
      toStatusId: statusIds[i],
    })),
  });

  // Default board with one column per status.
  const board = await prisma.board.create({
    data: { projectId: project.id, name: `${name} board`, type },
    select: { id: true },
  });
  await prisma.boardColumn.createMany({
    data: DEFAULT_STATUSES.map((s, i) => ({
      boardId: board.id,
      name: s.name,
      statusIds: JSON.stringify([statusIds[i]]),
      position: i,
    })),
  });

  revalidatePath(`/w/${slug}/work`, "layout");
  redirect(`/w/${slug}/work/${key}/board`);
}

export async function updateWorkProject(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const id = String(formData.get("id") || "");
  const ctx = await assertEditor(slug);
  const data: Record<string, unknown> = {};
  if (formData.has("name")) data.name = String(formData.get("name")).trim();
  if (formData.has("description")) data.description = String(formData.get("description"));
  if (formData.has("icon")) data.icon = String(formData.get("icon"));
  if (formData.has("color")) data.color = String(formData.get("color"));
  if (formData.has("leadId")) data.leadId = String(formData.get("leadId")) || null;
  await prisma.workProject.updateMany({
    where: { id, workspaceId: ctx.workspace.id },
    data,
  });
  revalidatePath(`/w/${slug}/work`, "layout");
}

export async function archiveWorkProject(slug: string, id: string) {
  const ctx = await assertEditor(slug);
  await prisma.workProject.updateMany({
    where: { id, workspaceId: ctx.workspace.id },
    data: { archivedAt: new Date() },
  });
  revalidatePath(`/w/${slug}/work`, "layout");
  redirect(`/w/${slug}/work`);
}

export async function restoreWorkProject(slug: string, id: string) {
  const ctx = await assertEditor(slug);
  await prisma.workProject.updateMany({
    where: { id, workspaceId: ctx.workspace.id },
    data: { archivedAt: null },
  });
  revalidatePath(`/w/${slug}/work`, "layout");
}

export async function deleteWorkProject(slug: string, id: string) {
  const ctx = await assertEditor(slug);
  if (ctx.role !== "owner") throw new Error("forbidden");
  await prisma.workProject.deleteMany({
    where: { id, workspaceId: ctx.workspace.id },
  });
  revalidatePath(`/w/${slug}/work`, "layout");
  redirect(`/w/${slug}/work`);
}
