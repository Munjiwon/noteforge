"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

export async function createTeamspace(
  slug: string,
  name: string,
  options?: { icon?: string | null; description?: string | null; access?: "open" | "closed" | "private" },
) {
  const ctx = await assertEditor(slug);
  const trimmed = name.trim() || "Untitled teamspace";
  const max = await prisma.teamspace.aggregate({
    where: { workspaceId: ctx.workspace.id },
    _max: { position: true },
  });
  const ts = await prisma.teamspace.create({
    data: {
      workspaceId: ctx.workspace.id,
      name: trimmed,
      icon: options?.icon ?? null,
      description: options?.description ?? null,
      access: options?.access ?? "open",
      position: (max._max.position ?? 0) + 1,
      members: {
        create: { userId: ctx.user.id, role: "owner" },
      },
    },
  });
  revalidatePath(`/w/${slug}`);
  return ts.id;
}

export async function renameTeamspace(slug: string, teamspaceId: string, name: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { name: name.trim() || ts.name },
  });
  revalidatePath(`/w/${slug}`);
}

export async function setTeamspaceIcon(slug: string, teamspaceId: string, icon: string | null) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { icon },
  });
  revalidatePath(`/w/${slug}`);
}

export async function setTeamspaceDescription(
  slug: string,
  teamspaceId: string,
  description: string,
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  const t = description.trim();
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { description: t ? t : null },
  });
  revalidatePath(`/w/${slug}`);
}

export async function setTeamspaceAccess(
  slug: string,
  teamspaceId: string,
  access: "open" | "closed" | "private",
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { access },
  });
  revalidatePath(`/w/${slug}`);
}

export async function archiveTeamspace(slug: string, teamspaceId: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { archivedAt: new Date() },
  });
  revalidatePath(`/w/${slug}`);
}

export async function restoreTeamspace(slug: string, teamspaceId: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { archivedAt: null },
  });
  revalidatePath(`/w/${slug}`);
}

export async function deleteTeamspace(slug: string, teamspaceId: string) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  // Detach pages from this teamspace (move them back to workspace root scope)
  await prisma.page.updateMany({
    where: { teamspaceId, workspaceId: ctx.workspace.id },
    data: { teamspaceId: null },
  });
  await prisma.teamspace.delete({ where: { id: teamspaceId } });
  revalidatePath(`/w/${slug}`);
}

export async function addTeamspaceMember(
  slug: string,
  teamspaceId: string,
  userId: string,
  role: "owner" | "member" = "member",
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  // Confirm the user is actually a workspace member.
  const wsMember = await prisma.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspace.id, userId },
  });
  if (!wsMember) throw new Error("not a workspace member");
  await prisma.teamspaceMember.upsert({
    where: { teamspaceId_userId: { teamspaceId, userId } },
    update: { role },
    create: { teamspaceId, userId, role },
  });
  revalidatePath(`/w/${slug}`);
}

export async function removeTeamspaceMember(
  slug: string,
  teamspaceId: string,
  userId: string,
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspaceMember
    .delete({
      where: { teamspaceId_userId: { teamspaceId, userId } },
    })
    .catch(() => undefined);
  revalidatePath(`/w/${slug}`);
}

export async function movePageToTeamspace(
  slug: string,
  pageId: string,
  teamspaceId: string | null,
) {
  const ctx = await assertEditor(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
  });
  if (!page) throw new Error("not found");
  if (teamspaceId) {
    const ts = await prisma.teamspace.findFirst({
      where: { id: teamspaceId, workspaceId: ctx.workspace.id },
    });
    if (!ts) throw new Error("teamspace not found");
  }
  // Move the page and all descendants to the same teamspace.
  const descendantIds = new Set<string>([pageId]);
  let frontier = [pageId];
  while (frontier.length > 0) {
    const kids = await prisma.page.findMany({
      where: { parentId: { in: frontier }, workspaceId: ctx.workspace.id },
      select: { id: true },
    });
    frontier = [];
    for (const k of kids) {
      if (!descendantIds.has(k.id)) {
        descendantIds.add(k.id);
        frontier.push(k.id);
      }
    }
  }
  await prisma.page.updateMany({
    where: { id: { in: Array.from(descendantIds) } },
    data: { teamspaceId, parentId: null },
  });
  revalidatePath(`/w/${slug}`);
}

export async function createPageInTeamspace(
  slug: string,
  teamspaceId: string,
  kind: "doc" | "database" = "doc",
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("teamspace not found");
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId: null, teamspaceId },
    _max: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      teamspaceId,
      parentId: null,
      kind,
      title: "Untitled",
      ...(kind === "database" ? { dbSchema: '{"props":[{"id":"p_title","name":"Name","type":"text"}]}' } : {}),
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
    },
  });
  await prisma.pageActivity.create({
    data: { pageId: page.id, userId: ctx.user.id, action: "created" },
  });
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/p/${page.id}`);
}

export async function reorderTeamspace(
  slug: string,
  teamspaceId: string,
  position: number,
) {
  const ctx = await assertEditor(slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: teamspaceId, workspaceId: ctx.workspace.id },
  });
  if (!ts) throw new Error("not found");
  await prisma.teamspace.update({
    where: { id: teamspaceId },
    data: { position },
  });
  revalidatePath(`/w/${slug}`);
}
