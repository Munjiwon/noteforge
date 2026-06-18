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

async function loadSprint(slug: string, sprintId: string) {
  const ctx = await assertEditor(slug);
  const sprint = await prisma.sprint.findFirst({
    where: { id: sprintId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { id: true, key: true } } },
  });
  if (!sprint) throw new Error("sprint not found");
  return { ctx, sprint };
}

function revalidate(slug: string, key: string) {
  revalidatePath(`/w/${slug}/work/${key}`, "layout");
}

export async function createSprint(slug: string, projectId: string) {
  const { project } = await loadProject(slug, projectId);
  const count = await prisma.sprint.count({ where: { projectId } });
  const maxSeq = await prisma.sprint.aggregate({
    where: { projectId },
    _max: { sequence: true },
  });
  await prisma.sprint.create({
    data: {
      projectId,
      name: `${project.key} Sprint ${count + 1}`,
      sequence: (maxSeq._max.sequence ?? 0) + 1,
      state: "future",
    },
  });
  revalidate(slug, project.key);
}

export async function updateSprint(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const sprintId = String(formData.get("sprintId") || "");
  const { sprint } = await loadSprint(slug, sprintId);
  const data: Record<string, unknown> = {};
  if (formData.has("name")) data.name = String(formData.get("name")).trim();
  if (formData.has("goal")) data.goal = String(formData.get("goal"));
  if (formData.has("startDate")) {
    const v = String(formData.get("startDate"));
    data.startDate = v ? new Date(v) : null;
  }
  if (formData.has("endDate")) {
    const v = String(formData.get("endDate"));
    data.endDate = v ? new Date(v) : null;
  }
  await prisma.sprint.update({ where: { id: sprintId }, data });
  revalidate(slug, sprint.project.key);
}

// Start a sprint: mark active and set dates if missing (default 2 weeks).
export async function startSprint(slug: string, sprintId: string) {
  const { sprint } = await loadSprint(slug, sprintId);
  const start = sprint.startDate ?? new Date();
  let end = sprint.endDate;
  if (!end) {
    end = new Date(start);
    end.setDate(end.getDate() + 14);
  }
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { state: "active", startDate: start, endDate: end },
  });
  revalidate(slug, sprint.project.key);
}

/**
 * Complete a sprint: incomplete issues (not in a "done" status) move to the
 * given destination sprint, or back to the backlog when none is provided.
 */
export async function completeSprint(
  slug: string,
  sprintId: string,
  destSprintId: string | null = null,
) {
  const { sprint } = await loadSprint(slug, sprintId);
  const incomplete = await prisma.issue.findMany({
    where: { sprintId, status: { category: { not: "done" } } },
    select: { id: true },
  });
  if (incomplete.length > 0) {
    await prisma.issue.updateMany({
      where: { id: { in: incomplete.map((i) => i.id) } },
      data: { sprintId: destSprintId },
    });
  }
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { state: "completed", completeDate: new Date() },
  });
  revalidate(slug, sprint.project.key);
}

export async function deleteSprint(slug: string, sprintId: string) {
  const { sprint } = await loadSprint(slug, sprintId);
  // Issues keep existing; their sprintId is nulled by the relation onDelete.
  await prisma.sprint.delete({ where: { id: sprintId } });
  revalidate(slug, sprint.project.key);
}

// Move an issue to a sprint (or backlog when sprintId is null) and re-rank it.
export async function moveIssueToSprint(
  slug: string,
  issueId: string,
  sprintId: string | null,
  rank?: number,
) {
  const ctx = await assertEditor(slug);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { key: true } } },
  });
  if (!issue) throw new Error("issue not found");
  let newRank = rank;
  if (newRank === undefined) {
    const agg = await prisma.issue.aggregate({
      where: { projectId: issue.projectId, sprintId },
      _max: { rank: true },
    });
    newRank = (agg._max.rank ?? 0) + 1;
  }
  await prisma.issue.update({
    where: { id: issueId },
    data: { sprintId, rank: newRank },
  });
  if (sprintId !== issue.sprintId) {
    await prisma.issueActivity.create({
      data: { issueId, userId: ctx.user.id, field: "sprint", from: issue.sprintId, to: sprintId },
    });
  }
  revalidate(slug, issue.project.key);
}
