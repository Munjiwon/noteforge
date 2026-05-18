"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";

async function assertOwner(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role !== "owner") throw new Error("forbidden");
  return ctx;
}

export async function renameWorkspace(slug: string, name: string) {
  const ctx = await assertOwner(slug);
  const trimmed = name.trim();
  if (!trimmed) return;
  await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { name: trimmed },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function setWorkspaceIcon(slug: string, icon: string | null) {
  const ctx = await assertOwner(slug);
  await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { icon: icon?.trim() || null },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function setWorkspaceColor(slug: string, color: string | null) {
  const ctx = await assertOwner(slug);
  await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { color: color?.trim() || null },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function updateMemberRole(
  slug: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
) {
  const ctx = await assertOwner(slug);
  if (userId === ctx.user.id && role !== "owner") {
    // Prevent demoting the only owner
    const owners = await prisma.workspaceMember.count({
      where: { workspaceId: ctx.workspace.id, role: "owner" },
    });
    if (owners <= 1) throw new Error("cannot demote the last owner");
  }
  await prisma.workspaceMember.updateMany({
    where: { workspaceId: ctx.workspace.id, userId },
    data: { role },
  });
  revalidatePath(`/w/${slug}/settings`);
}

export async function removeMember(slug: string, userId: string) {
  const ctx = await assertOwner(slug);
  if (userId === ctx.user.id) {
    const owners = await prisma.workspaceMember.count({
      where: { workspaceId: ctx.workspace.id, role: "owner" },
    });
    if (owners <= 1) throw new Error("cannot remove the last owner");
  }
  await prisma.workspaceMember.deleteMany({
    where: { workspaceId: ctx.workspace.id, userId },
  });
  revalidatePath(`/w/${slug}/settings`);
}

export async function deleteWorkspace(slug: string, confirmName: string) {
  const ctx = await assertOwner(slug);
  if (confirmName !== ctx.workspace.name) {
    throw new Error("Workspace name did not match");
  }
  await prisma.workspace.delete({ where: { id: ctx.workspace.id } });
  revalidatePath("/", "layout");
}

export async function revokeInvite(slug: string, token: string) {
  const ctx = await assertOwner(slug);
  await prisma.invite.deleteMany({
    where: { workspaceId: ctx.workspace.id, token },
  });
  revalidatePath(`/w/${slug}/settings`);
}
