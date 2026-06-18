"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";
import { parseDuration } from "@/lib/work";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

async function issueProjectKey(workspaceId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project: { workspaceId } },
    select: { id: true, project: { select: { key: true } } },
  });
  if (!issue) throw new Error("issue not found");
  return issue.project.key;
}

// ---- Worklog / time tracking ------------------------------------------

export async function logWork(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const issueId = String(formData.get("issueId") || "");
  const duration = String(formData.get("duration") || "");
  const comment = String(formData.get("comment") || "") || null;
  const startedRaw = String(formData.get("startedAt") || "");

  const ctx = await assertEditor(slug);
  const seconds = parseDuration(duration);
  if (!seconds || seconds <= 0) throw new Error("invalid duration");
  const key = await issueProjectKey(ctx.workspace.id, issueId);
  await prisma.worklog.create({
    data: {
      issueId,
      authorId: ctx.user.id,
      seconds,
      comment,
      startedAt: startedRaw ? new Date(startedRaw) : new Date(),
    },
  });
  revalidatePath(`/w/${slug}/work/${key}`, "layout");
}

export async function deleteWorklog(slug: string, worklogId: string) {
  const ctx = await assertEditor(slug);
  const wl = await prisma.worklog.findFirst({
    where: { id: worklogId, issue: { project: { workspaceId: ctx.workspace.id } } },
    include: { issue: { include: { project: { select: { key: true } } } } },
  });
  if (!wl) throw new Error("not found");
  if (wl.authorId !== ctx.user.id && ctx.role !== "owner") throw new Error("forbidden");
  await prisma.worklog.delete({ where: { id: worklogId } });
  revalidatePath(`/w/${slug}/work/${wl.issue.project.key}`, "layout");
}

export async function setOriginalEstimate(slug: string, issueId: string, duration: string) {
  const ctx = await assertEditor(slug);
  const key = await issueProjectKey(ctx.workspace.id, issueId);
  const seconds = duration.trim() ? parseDuration(duration) : null;
  await prisma.issue.update({
    where: { id: issueId },
    data: { originalEstimate: seconds },
  });
  revalidatePath(`/w/${slug}/work/${key}`, "layout");
}

// ---- Saved filters -----------------------------------------------------

export async function createSavedFilter(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const name = String(formData.get("name") || "").trim();
  const jql = String(formData.get("jql") || "").trim();
  const shared = formData.get("shared") === "on";
  if (!name) return;
  const ctx = await requireWorkspaceMember(slug);
  await prisma.savedFilter.create({
    data: { workspaceId: ctx.workspace.id, ownerId: ctx.user.id, name, jql, shared },
  });
  revalidatePath(`/w/${slug}/work/search`);
}

export async function deleteSavedFilter(slug: string, id: string) {
  const ctx = await requireWorkspaceMember(slug);
  const f = await prisma.savedFilter.findFirst({
    where: { id, workspaceId: ctx.workspace.id },
  });
  if (!f) throw new Error("not found");
  if (f.ownerId !== ctx.user.id && ctx.role !== "owner") throw new Error("forbidden");
  await prisma.savedFilter.delete({ where: { id } });
  revalidatePath(`/w/${slug}/work/search`);
}
