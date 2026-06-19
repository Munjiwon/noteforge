"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

async function loadProject(slug: string, projectId: string) {
  const ctx = await assertEditor(slug);
  const project = await prisma.workProject.findFirst({
    where: { id: projectId, workspaceId: ctx.workspace.id },
    select: { id: true, key: true },
  });
  if (!project) throw new Error("project not found");
  return { ctx, project };
}

function revalidate(slug: string, key: string) {
  revalidatePath(`/w/${slug}/work/${key}`, "layout");
}

// ---- Workflow statuses -------------------------------------------------

const CATEGORIES = ["todo", "in_progress", "done"];

export async function addStatus(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const projectId = String(formData.get("projectId") || "");
  const name = String(formData.get("name") || "").trim();
  const category = String(formData.get("category") || "todo");
  if (!name) return;
  if (!CATEGORIES.includes(category)) throw new Error("invalid category");
  const { project } = await loadProject(slug, projectId);

  const max = await prisma.workflowStatus.aggregate({
    where: { projectId },
    _max: { position: true },
  });
  const status = await prisma.workflowStatus.create({
    data: { projectId, name, category, position: (max._max.position ?? 0) + 1 },
    select: { id: true, name: true },
  });
  // Make it reachable (global transition) and visible on the board (own column).
  await prisma.workflowTransition.create({
    data: { projectId, name: status.name, fromStatusId: null, toStatusId: status.id },
  });
  const board = await prisma.board.findFirst({ where: { projectId }, select: { id: true } });
  if (board) {
    const colMax = await prisma.boardColumn.aggregate({
      where: { boardId: board.id },
      _max: { position: true },
    });
    await prisma.boardColumn.create({
      data: {
        boardId: board.id,
        name: status.name,
        statusIds: JSON.stringify([status.id]),
        position: (colMax._max.position ?? 0) + 1,
      },
    });
  }
  revalidate(slug, project.key);
}

export async function updateStatus(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const statusId = String(formData.get("statusId") || "");
  const ctx = await assertEditor(slug);
  const status = await prisma.workflowStatus.findFirst({
    where: { id: statusId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { key: true } } },
  });
  if (!status) throw new Error("not found");
  const data: Record<string, unknown> = {};
  if (formData.has("name")) data.name = String(formData.get("name")).trim() || status.name;
  if (formData.has("category")) {
    const c = String(formData.get("category"));
    if (!CATEGORIES.includes(c)) throw new Error("invalid category");
    data.category = c;
  }
  await prisma.workflowStatus.update({ where: { id: statusId }, data });
  revalidate(slug, status.project.key);
}

export async function deleteStatus(slug: string, statusId: string) {
  const ctx = await assertEditor(slug);
  const status = await prisma.workflowStatus.findFirst({
    where: { id: statusId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { id: true, key: true } } },
  });
  if (!status) throw new Error("not found");
  const [issueCount, statusCount] = await Promise.all([
    prisma.issue.count({ where: { statusId } }),
    prisma.workflowStatus.count({ where: { projectId: status.projectId } }),
  ]);
  if (issueCount > 0) throw new Error("reassign issues off this status before deleting it");
  if (statusCount <= 1) throw new Error("a project must keep at least one status");
  // Remove the status from any board columns that reference it.
  const cols = await prisma.boardColumn.findMany({
    where: { board: { projectId: status.projectId } },
    select: { id: true, statusIds: true },
  });
  for (const c of cols) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(c.statusIds);
    } catch {}
    if (ids.includes(statusId)) {
      await prisma.boardColumn.update({
        where: { id: c.id },
        data: { statusIds: JSON.stringify(ids.filter((x) => x !== statusId)) },
      });
    }
  }
  // Transitions cascade via the status relations.
  await prisma.workflowStatus.delete({ where: { id: statusId } });
  revalidate(slug, status.project.key);
}

// Replace the set of allowed transitions INTO a target status. fromStatusIds
// may be ["__any__"] for a global (from-any) transition, or a list of source
// status ids.
export async function setTransitionsFor(
  slug: string,
  projectId: string,
  toStatusId: string,
  fromStatusIds: string[],
) {
  const { project } = await loadProject(slug, projectId);
  const target = await prisma.workflowStatus.findFirst({
    where: { id: toStatusId, projectId },
    select: { id: true, name: true },
  });
  if (!target) throw new Error("invalid status");

  await prisma.workflowTransition.deleteMany({ where: { projectId, toStatusId } });
  const isAny = fromStatusIds.includes("__any__");
  if (isAny) {
    await prisma.workflowTransition.create({
      data: { projectId, name: target.name, fromStatusId: null, toStatusId },
    });
  } else if (fromStatusIds.length > 0) {
    // Validate sources belong to the project.
    const valid = await prisma.workflowStatus.findMany({
      where: { id: { in: fromStatusIds }, projectId },
      select: { id: true },
    });
    await prisma.workflowTransition.createMany({
      data: valid.map((s) => ({ projectId, name: target.name, fromStatusId: s.id, toStatusId })),
    });
  }
  revalidate(slug, project.key);
}

// ---- Board columns -----------------------------------------------------

export async function updateBoardColumn(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const columnId = String(formData.get("columnId") || "");
  const ctx = await assertEditor(slug);
  const col = await prisma.boardColumn.findFirst({
    where: { id: columnId, board: { project: { workspaceId: ctx.workspace.id } } },
    include: { board: { include: { project: { select: { id: true, key: true } } } } },
  });
  if (!col) throw new Error("not found");
  const data: Record<string, unknown> = {};
  if (formData.has("name")) data.name = String(formData.get("name")).trim() || col.name;
  if (formData.has("wipLimit")) {
    const raw = String(formData.get("wipLimit")).trim();
    const n = raw ? Number(raw) : null;
    if (n !== null && (!Number.isInteger(n) || n < 0)) throw new Error("invalid WIP limit");
    data.wipLimit = n;
  }
  if (formData.has("statusIds")) {
    // Comma-separated status ids; keep only those in this project.
    const requested = String(formData.get("statusIds")).split(",").map((s) => s.trim()).filter(Boolean);
    const valid = await prisma.workflowStatus.findMany({
      where: { id: { in: requested }, projectId: col.board.project.id },
      select: { id: true },
    });
    data.statusIds = JSON.stringify(valid.map((v) => v.id));
  }
  await prisma.boardColumn.update({ where: { id: columnId }, data });
  revalidate(slug, col.board.project.key);
}
