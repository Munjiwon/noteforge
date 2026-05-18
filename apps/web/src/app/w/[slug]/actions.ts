"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";
import { randomBytes } from "crypto";
import { blocksToHtml, blocksToMarkdown, markdownToBlocks } from "@/lib/markdown";
import { PAGE_TEMPLATES } from "@/lib/page-templates";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

async function logActivity(
  pageId: string,
  userId: string | null,
  action: string,
  meta?: Record<string, unknown>,
) {
  await prisma.pageActivity
    .create({
      data: {
        pageId,
        userId,
        action,
        meta: meta ? JSON.stringify(meta) : null,
      },
    })
    .catch((e) => console.error("activity log failed", e));
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
  await logActivity(page.id, ctx.user.id, "created");
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
  const newTitle = title.trim() || "Untitled";
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { title: newTitle },
  });
  await logActivity(pageId, ctx.user.id, "renamed", { title: newTitle });
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

export async function setPageWordGoal(slug: string, pageId: string, goal: number | null) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { wordGoal: goal && goal > 0 ? Math.round(goal) : null },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

export async function setPageTags(
  slug: string,
  pageId: string,
  tags: string[],
) {
  const ctx = await assertEditor(slug);
  const cleaned = Array.from(
    new Set(tags.map((t) => t.trim()).filter(Boolean).slice(0, 20)),
  );
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { tags: JSON.stringify(cleaned) },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

export async function renameTagAcrossWorkspace(
  slug: string,
  oldName: string,
  newName: string,
) {
  const ctx = await assertEditor(slug);
  const cleanedOld = oldName.trim();
  const cleanedNew = newName.trim();
  if (!cleanedOld) throw new Error("empty tag");
  // Pull all tagged pages, parse and rewrite per row. Tag count is small so
  // the in-memory rewrite is cheap.
  const pages = await prisma.page.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      tags: { contains: JSON.stringify(cleanedOld).slice(1, -1) },
    },
    select: { id: true, tags: true },
  });
  for (const p of pages) {
    let arr: string[] = [];
    try {
      const v = JSON.parse(p.tags ?? "[]");
      if (Array.isArray(v)) arr = v.filter((x) => typeof x === "string");
    } catch {}
    if (!arr.includes(cleanedOld)) continue;
    const next = cleanedNew
      ? Array.from(new Set(arr.map((t) => (t === cleanedOld ? cleanedNew : t))))
      : arr.filter((t) => t !== cleanedOld);
    await prisma.page.update({
      where: { id: p.id },
      data: { tags: JSON.stringify(next) },
    });
  }
  revalidatePath(`/w/${slug}`, "layout");
  revalidatePath(`/w/${slug}/tags`);
}

export async function deleteTagAcrossWorkspace(slug: string, name: string) {
  await renameTagAcrossWorkspace(slug, name, "");
}

export async function setPageCoverPos(
  slug: string,
  pageId: string,
  pos: "top" | "center" | "bottom",
) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { coverPos: pos },
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
  await logActivity(pageId, ctx.user.id, "deleted", { descendantsAffected: ids.length });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function bulkDeletePages(slug: string, pageIds: string[]) {
  const ctx = await assertEditor(slug);
  if (pageIds.length === 0) return;
  const allIds = new Set<string>();
  for (const id of pageIds) {
    const ids = await collectDescendantIds(ctx.workspace.id, id);
    for (const i of ids) allIds.add(i);
  }
  await prisma.page.updateMany({
    where: {
      id: { in: Array.from(allIds) },
      workspaceId: ctx.workspace.id,
      deletedAt: null,
    },
    data: { deletedAt: new Date(), favorite: false },
  });
  for (const id of pageIds) {
    await logActivity(id, ctx.user.id, "deleted", { bulk: true });
  }
  revalidatePath(`/w/${slug}`, "layout");
}

export async function bulkFavoritePages(
  slug: string,
  pageIds: string[],
  favorite: boolean,
) {
  const ctx = await requireWorkspaceMember(slug);
  if (pageIds.length === 0) return;
  await prisma.page.updateMany({
    where: {
      id: { in: pageIds },
      workspaceId: ctx.workspace.id,
      deletedAt: null,
    },
    data: { favorite },
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
  await logActivity(pageId, ctx.user.id, "restored");
  revalidatePath(`/w/${slug}`, "layout");
}

export async function emptyTrash(slug: string) {
  const ctx = await assertEditor(slug);
  await prisma.page.deleteMany({
    where: {
      workspaceId: ctx.workspace.id,
      deletedAt: { not: null },
    },
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

export async function setPageAsTemplate(
  slug: string,
  pageId: string,
  on: boolean,
) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { isTemplate: on },
  });
  revalidatePath(`/w/${slug}`, "layout");
}

export async function createPageFromUserTemplate(
  slug: string,
  parentId: string | null,
  templatePageId: string,
) {
  const ctx = await assertEditor(slug);
  const tpl = await prisma.page.findFirst({
    where: {
      id: templatePageId,
      workspaceId: ctx.workspace.id,
      isTemplate: true,
      deletedAt: null,
    },
  });
  if (!tpl) throw new Error("template not found");

  async function copy(
    node: NonNullable<typeof tpl>,
    newParent: string | null,
    isRoot: boolean,
  ): Promise<{ id: string }> {
    const max = await prisma.page.aggregate({
      where: { workspaceId: ctx.workspace.id, parentId: newParent },
      _max: { position: true },
    });
    const created = await prisma.page.create({
      data: {
        workspaceId: ctx.workspace.id,
        parentId: newParent,
        kind: node.kind,
        title: node.title,
        icon: node.icon,
        cover: node.cover,
        coverPos: node.coverPos,
        tags: node.tags,
        width: node.width,
        font: node.font,
        content: node.content,
        dbSchema: node.dbSchema,
        dataValues: node.dataValues,
        position: isRoot ? (max._max.position ?? 0) + 1 : node.position,
        authorId: ctx.user.id,
        isTemplate: false,
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
      await copy(c, created.id, false);
    }
    return { id: created.id };
  }

  const cloned = await copy(tpl, parentId, true);
  await logActivity(cloned.id, ctx.user.id, "created_from_template");
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/p/${cloned.id}`);
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
        coverPos: node.coverPos,
        tags: node.tags,
        width: node.width,
        font: node.font,
        wordGoal: node.wordGoal,
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

export async function setPageWidth(
  slug: string,
  pageId: string,
  width: "normal" | "wide" | "full",
) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { width },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

export async function setPageFont(
  slug: string,
  pageId: string,
  font: "default" | "serif" | "mono",
) {
  const ctx = await assertEditor(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { font },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

export async function incrementPageView(slug: string, pageId: string) {
  const ctx = await requireWorkspaceMember(slug);
  await prisma.page.updateMany({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    data: { viewCount: { increment: 1 } },
  });
}

export async function togglePageLock(
  slug: string,
  pageId: string,
  durationHours?: number,
) {
  const ctx = await assertEditor(slug);
  const row = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { locked: true },
  });
  if (!row) throw new Error("not found");
  const newLocked = !row.locked;
  await prisma.page.update({
    where: { id: pageId },
    data: {
      locked: newLocked,
      lockedUntil:
        newLocked && durationHours && durationHours > 0
          ? new Date(Date.now() + durationHours * 3600 * 1000)
          : null,
    },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
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
  await logActivity(pageId, ctx.user.id, "snapshot");
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

export async function restoreSnapshot(slug: string, snapshotId: string) {
  const ctx = await assertEditor(slug);
  const snap = await prisma.pageSnapshot.findUnique({
    where: { id: snapshotId },
    select: {
      id: true,
      content: true,
      pageId: true,
      page: { select: { workspaceId: true, content: true } },
    },
  });
  if (!snap || snap.page.workspaceId !== ctx.workspace.id) throw new Error("not found");

  // Take a safety snapshot of the current content before overwriting so
  // restores remain reversible.
  await prisma.pageSnapshot.create({
    data: {
      pageId: snap.pageId,
      content: snap.page.content,
      authorId: ctx.user.id,
    },
  });
  await prisma.page.update({
    where: { id: snap.pageId },
    data: { content: snap.content },
  });
  await logActivity(snap.pageId, ctx.user.id, "restore_snapshot");
  revalidatePath(`/w/${slug}/p/${snap.pageId}`);
  return snap.pageId;
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
  await logActivity(pageId, ctx.user.id, access === "view" ? "shared" : "unshared");
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

export async function inviteGuestByEmail(
  slug: string,
  pageId: string,
  email: string,
  role: "view" | "comment" | "edit",
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const ctx = await assertEditor(slug);
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !/.+@.+\..+/.test(trimmed)) {
    return { ok: false, error: "Invalid email" };
  }
  const user = await prisma.user.findUnique({ where: { email: trimmed } });
  if (!user) {
    return {
      ok: false,
      error:
        "User not registered. Ask them to sign up first, then invite again.",
    };
  }
  // Ensure they are at least a viewer of the workspace
  const member = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ctx.workspace.id } },
  });
  if (!member) {
    await prisma.workspaceMember.create({
      data: {
        userId: user.id,
        workspaceId: ctx.workspace.id,
        role: "viewer",
      },
    });
  }
  // Set page-level permission
  await prisma.pagePermission.upsert({
    where: { pageId_userId: { pageId, userId: user.id } },
    update: { role },
    create: { pageId, userId: user.id, role },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
  return { ok: true, userId: user.id };
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

export async function exportPageHtml(slug: string, pageId: string) {
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
  const body = blocksToHtml(Array.isArray(blocks) ? (blocks as never[]) : []);
  const titleText = (page.icon ? `${page.icon} ` : "") + (page.title || "Untitled");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${titleText.replace(/[<>]/g, "")}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1f2937; }
  pre { background: #f6f7f9; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }
  blockquote { border-left: 3px solid #e5e7eb; padding-left: 1rem; color: #4b5563; }
  .callout { background: #fef9c3; border: 1px solid #fde68a; border-radius: 6px; padding: 0.75rem 1rem; }
  img { max-width: 100%; }
</style>
</head>
<body>
<h1>${titleText.replace(/[<>]/g, "")}</h1>
${body}
</body>
</html>`;
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
