"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

async function projectKeyFor(projectId: string): Promise<string> {
  const p = await prisma.workProject.findUnique({
    where: { id: projectId },
    select: { key: true },
  });
  return p?.key ?? "";
}

function revalidate(slug: string, key: string) {
  revalidatePath(`/w/${slug}/work/${key}`, "layout");
}

async function ownsProject(workspaceId: string, projectId: string) {
  const p = await prisma.workProject.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true, key: true },
  });
  if (!p) throw new Error("project not found");
  return p;
}

// ---- Issue links -------------------------------------------------------

export async function addIssueLink(
  slug: string,
  sourceId: string,
  targetId: string,
  type: string,
) {
  const ctx = await assertEditor(slug);
  if (sourceId === targetId) throw new Error("cannot link an issue to itself");
  const issues = await prisma.issue.findMany({
    where: { id: { in: [sourceId, targetId] }, project: { workspaceId: ctx.workspace.id } },
    select: { id: true, projectId: true },
  });
  if (issues.length !== 2) throw new Error("issue not found");
  await prisma.issueLink.create({ data: { sourceId, targetId, type } }).catch(() => {});
  revalidate(slug, await projectKeyFor(issues[0].projectId));
}

export async function removeIssueLink(slug: string, linkId: string) {
  const ctx = await assertEditor(slug);
  const link = await prisma.issueLink.findFirst({
    where: { id: linkId, source: { project: { workspaceId: ctx.workspace.id } } },
    include: { source: { select: { projectId: true } } },
  });
  if (!link) throw new Error("not found");
  await prisma.issueLink.delete({ where: { id: linkId } });
  revalidate(slug, await projectKeyFor(link.source.projectId));
}

// ---- Components --------------------------------------------------------

export async function createComponent(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const projectId = String(formData.get("projectId") || "");
  const name = String(formData.get("name") || "").trim();
  if (!name) return;
  const ctx = await assertEditor(slug);
  const p = await ownsProject(ctx.workspace.id, projectId);
  await prisma.workComponent.create({
    data: {
      projectId,
      name,
      description: String(formData.get("description") || "") || null,
      leadId: String(formData.get("leadId") || "") || null,
    },
  });
  revalidate(slug, p.key);
}

export async function deleteComponent(slug: string, componentId: string) {
  const ctx = await assertEditor(slug);
  const c = await prisma.workComponent.findFirst({
    where: { id: componentId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { key: true } } },
  });
  if (!c) throw new Error("not found");
  await prisma.workComponent.delete({ where: { id: componentId } });
  revalidate(slug, c.project.key);
}

export async function setIssueComponent(
  slug: string,
  issueId: string,
  componentId: string,
  on: boolean,
) {
  const ctx = await assertEditor(slug);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project: { workspaceId: ctx.workspace.id } },
    select: { projectId: true },
  });
  if (!issue) throw new Error("not found");
  if (on) {
    await prisma.issueComponent.create({ data: { issueId, componentId } }).catch(() => {});
  } else {
    await prisma.issueComponent.deleteMany({ where: { issueId, componentId } });
  }
  revalidate(slug, await projectKeyFor(issue.projectId));
}

// ---- Versions / releases ----------------------------------------------

export async function createVersion(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const projectId = String(formData.get("projectId") || "");
  const name = String(formData.get("name") || "").trim();
  if (!name) return;
  const ctx = await assertEditor(slug);
  const p = await ownsProject(ctx.workspace.id, projectId);
  const max = await prisma.workVersion.aggregate({
    where: { projectId },
    _max: { position: true },
  });
  const release = String(formData.get("releaseDate") || "");
  await prisma.workVersion.create({
    data: {
      projectId,
      name,
      description: String(formData.get("description") || "") || null,
      releaseDate: release ? new Date(release) : null,
      position: (max._max.position ?? 0) + 1,
    },
  });
  revalidate(slug, p.key);
}

export async function setVersionReleased(slug: string, versionId: string, released: boolean) {
  const ctx = await assertEditor(slug);
  const v = await prisma.workVersion.findFirst({
    where: { id: versionId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { key: true } } },
  });
  if (!v) throw new Error("not found");
  await prisma.workVersion.update({
    where: { id: versionId },
    data: { released, releaseDate: released ? v.releaseDate ?? new Date() : v.releaseDate },
  });
  revalidate(slug, v.project.key);
}

export async function deleteVersion(slug: string, versionId: string) {
  const ctx = await assertEditor(slug);
  const v = await prisma.workVersion.findFirst({
    where: { id: versionId, project: { workspaceId: ctx.workspace.id } },
    include: { project: { select: { key: true } } },
  });
  if (!v) throw new Error("not found");
  await prisma.workVersion.delete({ where: { id: versionId } });
  revalidate(slug, v.project.key);
}

export async function setIssueFixVersion(
  slug: string,
  issueId: string,
  versionId: string,
  on: boolean,
) {
  const ctx = await assertEditor(slug);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project: { workspaceId: ctx.workspace.id } },
    select: { projectId: true },
  });
  if (!issue) throw new Error("not found");
  if (on) {
    await prisma.issueFixVersion.create({ data: { issueId, versionId } }).catch(() => {});
  } else {
    await prisma.issueFixVersion.deleteMany({ where: { issueId, versionId } });
  }
  revalidate(slug, await projectKeyFor(issue.projectId));
}

// ---- Labels (workspace-scoped) ----------------------------------------

const LABEL_COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b"];

export async function setIssueLabel(
  slug: string,
  issueId: string,
  name: string,
  on: boolean,
) {
  const ctx = await assertEditor(slug);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, project: { workspaceId: ctx.workspace.id } },
    select: { projectId: true },
  });
  if (!issue) throw new Error("not found");
  const trimmed = name.trim();
  if (!trimmed) return;
  // Find or create the workspace label.
  let label = await prisma.workLabel.findFirst({
    where: { workspaceId: ctx.workspace.id, name: trimmed },
  });
  if (!label && on) {
    const color = LABEL_COLORS[trimmed.length % LABEL_COLORS.length];
    label = await prisma.workLabel.create({
      data: { workspaceId: ctx.workspace.id, name: trimmed, color },
    });
  }
  if (!label) return;
  if (on) {
    await prisma.issueLabel.create({ data: { issueId, labelId: label.id } }).catch(() => {});
  } else {
    await prisma.issueLabel.deleteMany({ where: { issueId, labelId: label.id } });
  }
  revalidate(slug, await projectKeyFor(issue.projectId));
}
