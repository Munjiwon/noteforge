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

export async function setMutedNotificationKinds(
  slug: string,
  kinds: string[],
) {
  const ctx = await requireWorkspaceMember(slug);
  const clean = Array.from(new Set(kinds.filter((k) => typeof k === "string"))).slice(0, 20);
  await prisma.workspaceMember.updateMany({
    where: { workspaceId: ctx.workspace.id, userId: ctx.user.id },
    data: { mutedKinds: JSON.stringify(clean) },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function setWorkspaceAnnouncement(
  slug: string,
  text: string | null,
) {
  const ctx = await assertOwner(slug);
  const clean = text?.trim() ? text.trim().slice(0, 400) : null;
  await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { announcement: clean },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function setWorkspaceBanner(slug: string, url: string | null) {
  const ctx = await assertOwner(slug);
  const safe = url && url.startsWith("/api/files/") ? url : null;
  await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { bannerUrl: safe },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function setWorkspaceDefaultFont(
  slug: string,
  font: "default" | "serif" | "mono",
) {
  const ctx = await assertOwner(slug);
  await prisma.workspace.update({
    where: { id: ctx.workspace.id },
    data: { defaultFont: font },
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

export async function exportWorkspaceJson(slug: string): Promise<string> {
  const ctx = await requireWorkspaceMember(slug);
  const pages = await prisma.page.findMany({
    where: { workspaceId: ctx.workspace.id, deletedAt: null },
    orderBy: [{ parentId: "asc" }, { position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      icon: true,
      kind: true,
      parentId: true,
      content: true,
      dbSchema: true,
      dataValues: true,
      tags: true,
      slug: true,
      isTemplate: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { id: true, name: true, email: true } },
    },
  });
  const payload = {
    workspace: {
      slug: ctx.workspace.slug,
      name: ctx.workspace.name,
      icon: ctx.workspace.icon,
      color: ctx.workspace.color,
      exportedAt: new Date().toISOString(),
    },
    pages: pages.map((p) => {
      let content: unknown = null;
      try {
        content = JSON.parse(p.content);
      } catch {
        content = null;
      }
      let dbSchema: unknown = null;
      if (p.dbSchema) {
        try {
          dbSchema = JSON.parse(p.dbSchema);
        } catch {}
      }
      let dataValues: unknown = null;
      if (p.dataValues) {
        try {
          dataValues = JSON.parse(p.dataValues);
        } catch {}
      }
      let tags: unknown = [];
      try {
        tags = JSON.parse(p.tags ?? "[]");
      } catch {}
      return {
        id: p.id,
        title: p.title,
        icon: p.icon,
        kind: p.kind,
        parentId: p.parentId,
        slug: p.slug,
        isTemplate: p.isTemplate,
        tags,
        author: p.author,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        content,
        dbSchema,
        dataValues,
      };
    }),
  };
  return JSON.stringify(payload, null, 2);
}

export async function exportWorkspaceMarkdown(slug: string): Promise<string> {
  const ctx = await requireWorkspaceMember(slug);
  const pages = await prisma.page.findMany({
    where: { workspaceId: ctx.workspace.id, deletedAt: null },
    orderBy: [{ parentId: "asc" }, { position: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, icon: true, kind: true, parentId: true, content: true },
  });
  const byParent = new Map<string | null, typeof pages>();
  for (const p of pages) {
    const k = p.parentId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(p);
  }
  const { blocksToMarkdown } = await import("@/lib/markdown");
  const out: string[] = [`# ${ctx.workspace.icon ?? "📒"} ${ctx.workspace.name}`, ""];
  const walk = (parentId: string | null, depth: number) => {
    const list = byParent.get(parentId) ?? [];
    for (const p of list) {
      const head = "#".repeat(Math.min(6, depth + 2));
      const icon = p.icon ?? (p.kind === "database" ? "📊" : "📄");
      out.push(`${head} ${icon} ${p.title || "Untitled"}`);
      try {
        const blocks = JSON.parse(p.content || "[]");
        if (Array.isArray(blocks) && blocks.length > 0) {
          out.push(blocksToMarkdown(blocks));
        }
      } catch {
        // ignore
      }
      out.push("");
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out.join("\n");
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
