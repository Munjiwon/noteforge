"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

// Resolve the issue + its project, asserting the project belongs to the
// workspace identified by `slug`, and that the caller may edit.
async function loadIssueForEdit(slug: string, issueId: string) {
  const ctx = await assertEditor(slug);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { id: true, key: true } }, status: true },
  });
  if (!issue) throw new Error("issue not found");
  return { ctx, issue };
}

function revalidateProject(slug: string, projectKey: string) {
  revalidatePath(`/w/${slug}/work/${projectKey}`, "layout");
}

async function recordActivity(
  issueId: string,
  userId: string | null,
  field: string,
  from: string | null,
  to: string | null,
) {
  await prisma.issueActivity.create({
    data: { issueId, userId, field, from, to },
  });
}

// Notify watchers (other than the actor) of a change on an issue.
async function notifyWatchers(
  issueId: string,
  actorId: string,
  workspaceId: string,
  kind: string,
  preview: string,
) {
  const watchers = await prisma.issueWatcher.findMany({
    where: { issueId, userId: { not: actorId } },
    select: { userId: true },
  });
  if (watchers.length === 0) return;
  await prisma.notification.createMany({
    data: watchers.map((w) => ({
      recipientId: w.userId,
      actorId,
      workspaceId,
      kind,
      preview,
    })),
  });
}

/**
 * Create an issue, allocating the next per-project key number atomically.
 */
export async function createIssue(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const projectId = String(formData.get("projectId") || "");
  const summary = String(formData.get("summary") || "").trim();
  const typeId = String(formData.get("typeId") || "") || null;
  const sprintId = String(formData.get("sprintId") || "") || null;
  const epicId = String(formData.get("epicId") || "") || null;
  const parentId = String(formData.get("parentId") || "") || null;
  const priority = String(formData.get("priority") || "medium");
  const assigneeId = String(formData.get("assigneeId") || "") || null;

  const ctx = await assertEditor(slug);
  const project = await prisma.workProject.findFirst({
    where: { id: projectId, workspaceId: ctx.workspace.id },
    select: { id: true, key: true },
  });
  if (!project) throw new Error("project not found");

  // Default type: first standard type (or first subtask type if creating under
  // a parent), default status: first "todo" status.
  const [types, todoStatus, rankAgg] = await Promise.all([
    prisma.issueType.findMany({ where: { projectId }, orderBy: { position: "asc" } }),
    prisma.workflowStatus.findFirst({
      where: { projectId, category: "todo" },
      orderBy: { position: "asc" },
    }),
    prisma.issue.aggregate({ where: { projectId }, _max: { rank: true } }),
  ]);
  const resolvedType =
    types.find((t) => t.id === typeId) ??
    (parentId ? types.find((t) => t.level === "subtask") : null) ??
    types.find((t) => t.level === "standard") ??
    types[0];
  if (!resolvedType) throw new Error("project has no issue types");
  const status =
    todoStatus ?? (await prisma.workflowStatus.findFirst({ where: { projectId } }));
  if (!status) throw new Error("project has no statuses");

  const issue = await prisma.$transaction(async (tx) => {
    const proj = await tx.workProject.update({
      where: { id: projectId },
      data: { nextNumber: { increment: 1 } },
      select: { nextNumber: true },
    });
    const number = proj.nextNumber - 1;
    return tx.issue.create({
      data: {
        projectId,
        number,
        summary,
        typeId: resolvedType.id,
        statusId: status.id,
        priority,
        assigneeId,
        reporterId: ctx.user.id,
        sprintId,
        epicId,
        parentId,
        rank: (rankAgg._max.rank ?? 0) + 1,
      },
      select: { id: true },
    });
  });

  await Promise.all([
    recordActivity(issue.id, ctx.user.id, "created", null, summary),
    prisma.issueWatcher.create({ data: { issueId: issue.id, userId: ctx.user.id } }),
    assigneeId && assigneeId !== ctx.user.id
      ? prisma.issueWatcher
          .create({ data: { issueId: issue.id, userId: assigneeId } })
          .catch(() => {})
      : Promise.resolve(),
  ]);

  revalidateProject(slug, project.key);
  return { id: issue.id };
}

// Generic single-field update with activity logging for tracked fields.
export async function setIssueField(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const issueId = String(formData.get("issueId") || "");
  const field = String(formData.get("field") || "");
  const rawValue = formData.get("value");
  const value = rawValue === null ? null : String(rawValue);

  const { ctx, issue } = await loadIssueForEdit(slug, issueId);

  const data: Record<string, unknown> = {};
  let from: string | null = null;
  let to: string | null = value;
  switch (field) {
    case "summary":
      data.summary = value ?? "";
      from = issue.summary;
      break;
    case "description":
      data.description = value ?? "[]";
      break;
    case "priority":
      data.priority = value ?? "medium";
      from = issue.priority;
      break;
    case "assigneeId":
      data.assigneeId = value || null;
      from = issue.assigneeId;
      break;
    case "typeId":
      data.typeId = value || issue.typeId;
      from = issue.typeId;
      break;
    case "storyPoints":
      data.storyPoints = value ? Number(value) : null;
      from = issue.storyPoints?.toString() ?? null;
      break;
    case "dueDate":
      data.dueDate = value ? new Date(value) : null;
      from = issue.dueDate?.toISOString() ?? null;
      break;
    case "epicId":
      data.epicId = value || null;
      from = issue.epicId;
      break;
    case "parentId":
      data.parentId = value || null;
      from = issue.parentId;
      break;
    case "sprintId":
      data.sprintId = value || null;
      from = issue.sprintId;
      break;
    default:
      throw new Error(`unknown field ${field}`);
  }

  await prisma.issue.update({ where: { id: issueId }, data });
  // Log meaningful changes (skip noisy description/summary keystrokes only when
  // unchanged) for the history tab and burndown reconstruction.
  if (field !== "description" && from !== to) {
    await recordActivity(issueId, ctx.user.id, field, from, to);
  }
  if (field === "assigneeId" && value && value !== ctx.user.id) {
    await prisma.issueWatcher
      .create({ data: { issueId, userId: value } })
      .catch(() => {});
    await prisma.notification.create({
      data: {
        recipientId: value,
        actorId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        kind: "issue_assigned",
        preview: `Assigned to you: ${issue.project.key}-${issue.number} ${issue.summary}`,
      },
    });
  }
  revalidateProject(slug, issue.project.key);
}

/**
 * Transition an issue to a new status, validating the workflow and recording
 * the change. Sets/clears resolution when entering/leaving a "done" status.
 */
export async function transitionIssue(
  slug: string,
  issueId: string,
  toStatusId: string,
) {
  const { ctx, issue } = await loadIssueForEdit(slug, issueId);
  if (toStatusId === issue.statusId) return;

  const [toStatus, transition] = await Promise.all([
    prisma.workflowStatus.findFirst({
      where: { id: toStatusId, projectId: issue.projectId },
    }),
    prisma.workflowTransition.findFirst({
      where: {
        projectId: issue.projectId,
        toStatusId,
        OR: [{ fromStatusId: null }, { fromStatusId: issue.statusId }],
      },
    }),
  ]);
  if (!toStatus) throw new Error("invalid status");
  if (!transition) throw new Error("transition not allowed");

  const data: Record<string, unknown> = { statusId: toStatusId };
  if (toStatus.category === "done" && issue.status.category !== "done") {
    data.resolution = "done";
    data.resolvedAt = new Date();
  } else if (toStatus.category !== "done" && issue.status.category === "done") {
    data.resolution = null;
    data.resolvedAt = null;
  }
  await prisma.issue.update({ where: { id: issueId }, data });
  await recordActivity(issueId, ctx.user.id, "status", issue.status.name, toStatus.name);
  await notifyWatchers(
    issueId,
    ctx.user.id,
    ctx.workspace.id,
    "issue_status",
    `${issue.project.key}-${issue.number} → ${toStatus.name}`,
  );
  revalidateProject(slug, issue.project.key);
}

// Reorder an issue relative to the project's other issues (board/backlog DnD).
export async function setIssueRank(slug: string, issueId: string, rank: number) {
  const { issue } = await loadIssueForEdit(slug, issueId);
  await prisma.issue.update({ where: { id: issueId }, data: { rank } });
  revalidateProject(slug, issue.project.key);
}

export async function deleteIssue(slug: string, issueId: string) {
  const { issue } = await loadIssueForEdit(slug, issueId);
  await prisma.issue.delete({ where: { id: issueId } });
  revalidateProject(slug, issue.project.key);
}

export async function toggleWatch(slug: string, issueId: string) {
  const { ctx, issue } = await loadIssueForEdit(slug, issueId);
  const existing = await prisma.issueWatcher.findUnique({
    where: { issueId_userId: { issueId, userId: ctx.user.id } },
  });
  if (existing) {
    await prisma.issueWatcher.delete({ where: { id: existing.id } });
  } else {
    await prisma.issueWatcher.create({ data: { issueId, userId: ctx.user.id } });
  }
  revalidateProject(slug, issue.project.key);
}

export async function addIssueComment(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const issueId = String(formData.get("issueId") || "");
  const body = String(formData.get("body") || "").trim();
  if (!body) return;
  const { ctx, issue } = await loadIssueForEdit(slug, issueId);
  await prisma.issueComment.create({
    data: { issueId, authorId: ctx.user.id, body },
  });
  await notifyWatchers(
    issueId,
    ctx.user.id,
    ctx.workspace.id,
    "issue_comment",
    `${issue.project.key}-${issue.number}: ${body.slice(0, 60)}`,
  );
  revalidateProject(slug, issue.project.key);
}

export async function deleteIssueComment(slug: string, commentId: string) {
  const ctx = await assertEditor(slug);
  const comment = await prisma.issueComment.findFirst({
    where: { id: commentId, issue: { project: { workspaceId: ctx.workspace.id } } },
    include: { issue: { include: { project: { select: { key: true } } } } },
  });
  if (!comment) throw new Error("not found");
  if (comment.authorId !== ctx.user.id && ctx.role !== "owner") throw new Error("forbidden");
  await prisma.issueComment.delete({ where: { id: commentId } });
  revalidateProject(slug, comment.issue.project.key);
}
