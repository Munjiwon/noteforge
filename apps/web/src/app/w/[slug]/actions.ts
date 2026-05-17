"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";
import { randomBytes } from "node:crypto";
import { blocksToMarkdown, markdownToBlocks } from "@/lib/markdown";
import { PAGE_TEMPLATES } from "@/lib/page-templates";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

export async function createPage(slug: string, parentId: string | null) {
  const ctx = await assertEditor(slug);
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId },
    _max: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId,
      title: "Untitled",
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
    },
  });
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/p/${page.id}`);
}

export async function createPageFromTemplate(
  slug: string,
  parentId: string | null,
  templateId: string,
) {
  const ctx = await assertEditor(slug);
  const tpl = PAGE_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error("template not found");
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId },
    _max: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId,
      title: tpl.title,
      icon: tpl.icon,
      content: JSON.stringify(tpl.content),
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
    },
  });
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/p/${page.id}`);
}

export async function renamePage(slug: string, pageId: string, title: string) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { title: title.trim() || "Untitled" },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function setPageIcon(slug: string, pageId: string, icon: string | null) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { icon },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function setPageCover(slug: string, pageId: string, cover: string | null) {
  const ctx = await assertEditor(slug);
  const trimmed = cover?.trim();
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { cover: trimmed ? trimmed : null },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

async function collectDescendantIds(workspaceId: string, rootId: string): Promise<string[]> {
  const ids: string[] = [rootId];
  let frontier = [rootId];
  while (frontier.length) {
    const children = await prisma.page.findMany({
      where: { workspaceId, parentId: { in: frontier } },
      select: { id: true },
    });
    if (children.length === 0) break;
    const childIds = children.map((c) => c.id);
    ids.push(...childIds);
    frontier = childIds;
  }
  return ids;
}

export async function deletePage(slug: string, pageId: string) {
  const ctx = await assertEditor(slug);
  const ids = await collectDescendantIds(ctx.workspace.id, pageId);
  await prisma.page.updateMany({
    where: { id: { in: ids }, workspaceId: ctx.workspace.id, deletedAt: null },
    data: { deletedAt: new Date(), favorite: false },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function restorePage(slug: string, pageId: string) {
  const ctx = await assertEditor(slug);
  const ids = await collectDescendantIds(ctx.workspace.id, pageId);
  await prisma.page.updateMany({
    where: { id: { in: ids }, workspaceId: ctx.workspace.id },
    data: { deletedAt: null },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function purgePage(slug: string, pageId: string) {
  const ctx = await assertEditor(slug);
  // Only allow purging items that are already in trash
  const row = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { deletedAt: true },
  });
  if (!row || !row.deletedAt) throw new Error("must be trashed first");
  await prisma.page.deleteMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function duplicatePage(slug: string, pageId: string) {
  const ctx = await assertEditor(slug);
  const src = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id, deletedAt: null },
  });
  if (!src) throw new Error("not found");

  async function copy(node: NonNullable<typeof src>, newParent: string | null) {
    const max = await prisma.page.aggregate({
      where: { workspaceId: ctx.workspace.id, parentId: newParent },
      _max: { position: true },
    });
    const created = await prisma.page.create({
      data: {
        workspaceId: ctx.workspace.id,
        parentId: newParent,
        kind: node.kind,
        title: node.title + (newParent === node.parentId ? " (copy)" : ""),
        icon: node.icon,
        cover: node.cover,
        content: node.content,
        dbSchema: node.dbSchema,
        dataValues: node.dataValues,
        position: (max._max.position ?? 0) + 1,
        authorId: ctx.user.id,
      },
    });
    const children = await prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        parentId: node.id,
        deletedAt: null,
      },
      orderBy: { position: "asc" },
    });
    for (const c of children) {
      await copy(c, created.id);
    }
    return created;
  }

  const cloned = await copy(src, src.parentId);
  revalidatePath(`/w/${slug}`, "layout");
  return cloned.id;
}

export async function reorderPage(
  slug: string,
  pageId: string,
  newParentId: string | null,
  newPosition: number,
) {
  const ctx = await assertEditor(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
  });
  if (!page) throw new Error("not found");
  // Prevent moving a page under itself or a descendant.
  if (newParentId) {
    let cur: string | null = newParentId;
    while (cur) {
      if (cur === pageId) throw new Error("cannot move under descendant");
      const parent: { parentId: string | null } | null =
        await prisma.page.findUnique({
          where: { id: cur },
          select: { parentId: true },
        });
      cur = parent?.parentId ?? null;
    }
  }
  await prisma.page.update({
    where: { id: pageId },
    data: { parentId: newParentId, position: newPosition },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function toggleFavorite(slug: string, pageId: string) {
  const ctx = await requireWorkspaceMember(slug);
  const row = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { favorite: true, deletedAt: true },
  });
  if (!row) throw new Error("not found");
  if (row.deletedAt) return;
  await prisma.page.update({
    where: { id: pageId },
    data: { favorite: !row.favorite },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function saveContent(slug: string, pageId: string, content: string) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { content },
  });
  // Opportunistically snapshot: only if last snapshot is older than the interval.
  const last = await prisma.pageSnapshot.findFirst({
    where: { pageId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, content: true },
  });
  const stale = !last || Date.now() - last.createdAt.getTime() > SNAPSHOT_INTERVAL_MS;
  if (stale && (!last || last.content !== content)) {
    await prisma.pageSnapshot.create({
      data: { pageId, content, authorId: ctx.user.id },
    });
  }
}

export async function takeSnapshot(slug: string, pageId: string) {
  const ctx = await assertEditor(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { content: true },
  });
  if (!page) throw new Error("not found");
  await prisma.pageSnapshot.create({
    data: { pageId, content: page.content, authorId: ctx.user.id },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

export async function deleteSnapshot(slug: string, snapshotId: string) {
  const ctx = await assertEditor(slug);
  const snap = await prisma.pageSnapshot.findUnique({
    where: { id: snapshotId },
    select: { pageId: true, page: { select: { workspaceId: true } } },
  });
  if (!snap || snap.page.workspaceId !== ctx.workspace.id) throw new Error("not found");
  await prisma.pageSnapshot.delete({ where: { id: snapshotId } });
  revalidatePath(`/w/${slug}/p/${snap.pageId}`);
}

export async function setPagePublic(
  slug: string,
  pageId: string,
  access: "none" | "view",
) {
  const ctx = await assertEditor(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { publicSlug: true },
  });
  if (!page) throw new Error("not found");

  let nextSlug = page.publicSlug;
  if (access === "view" && !nextSlug) {
    nextSlug = randomBytes(12).toString("base64url");
  }
  if (access === "none") {
    nextSlug = null;
  }

  await prisma.page.update({
    where: { id: pageId },
    data: { publicAccess: access, publicSlug: nextSlug },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
  return nextSlug;
}

export async function setPagePermission(
  slug: string,
  pageId: string,
  userId: string,
  role: "view" | "comment" | "edit",
) {
  const ctx = await assertEditor(slug);
  // user must be a workspace member
  const m = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: ctx.workspace.id } },
  });
  if (!m) throw new Error("user is not a workspace member");
  await prisma.pagePermission.upsert({
    where: { pageId_userId: { pageId, userId } },
    update: { role },
    create: { pageId, userId, role },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

export async function removePagePermission(
  slug: string,
  pageId: string,
  userId: string,
) {
  const ctx = await assertEditor(slug);
  await prisma.pagePermission.deleteMany({
    where: { pageId, userId, page: { workspaceId: ctx.workspace.id } },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

export async function regeneratePublicSlug(slug: string, pageId: string) {
  const ctx = await assertEditor(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { publicAccess: true },
  });
  if (!page || page.publicAccess === "none") throw new Error("not shared");
  const nextSlug = randomBytes(12).toString("base64url");
  await prisma.page.update({
    where: { id: pageId },
    data: { publicSlug: nextSlug },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
  return nextSlug;
}

export async function exportPageMarkdown(slug: string, pageId: string) {
  const ctx = await requireWorkspaceMember(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { title: true, content: true, icon: true },
  });
  if (!page) throw new Error("not found");
  let blocks: unknown = [];
  try {
    blocks = JSON.parse(page.content || "[]");
  } catch {}
  const body = blocksToMarkdown(Array.isArray(blocks) ? (blocks as never[]) : []);
  const head = (page.icon ? `${page.icon} ` : "") + (page.title || "Untitled");
  return `# ${head}\n\n${body}\n`;
}

export async function importPageMarkdown(
  slug: string,
  parentId: string | null,
  filename: string,
  markdown: string,
) {
  const ctx = await assertEditor(slug);
  // First-line "# Title" becomes the page title; the rest becomes content.
  const lines = markdown.split(/\r?\n/);
  let title = filename.replace(/\.(md|markdown|txt)$/i, "") || "Imported";
  let bodyMd = markdown;
  const titleMatch = /^#\s+(.*)$/.exec(lines[0] ?? "");
  if (titleMatch) {
    title = titleMatch[1].trim() || title;
    bodyMd = lines.slice(1).join("\n").replace(/^\s+/, "");
  }
  const blocks = markdownToBlocks(bodyMd);
  const max = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId },
    _max: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: ctx.workspace.id,
      parentId,
      title,
      content: JSON.stringify(blocks),
      position: (max._max.position ?? 0) + 1,
      authorId: ctx.user.id,
    },
  });
  revalidatePath(`/w/${slug}`, "layout");
  return page.id;
}

export async function createInvite(slug: string, role: "editor" | "viewer" = "editor") {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role !== "owner") throw new Error("forbidden");
  const token = randomBytes(18).toString("base64url");
  await prisma.invite.create({
    data: {
      workspaceId: ctx.workspace.id,
      token,
      role,
      createdById: ctx.user.id,
    },
  });
  return token;
}
