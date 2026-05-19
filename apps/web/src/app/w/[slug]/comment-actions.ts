"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";
import { extractMentionedUserIds, parseMentions } from "@/lib/mentions";

async function assertEditorOnPage(slug: string, pageId: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { id: true },
  });
  if (!page) throw new Error("not found");
  return ctx;
}

async function assertPageVisible(slug: string, pageId: string) {
  const ctx = await requireWorkspaceMember(slug);
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { id: true },
  });
  if (!page) throw new Error("not found");
  return ctx;
}

export async function createComment(
  slug: string,
  pageId: string,
  body: string,
  opts: { blockId?: string | null; threadId?: string | null } = {},
) {
  const ctx = await assertEditorOnPage(slug, pageId);
  const trimmed = body.trim();
  if (!trimmed) return null;
  const c = await prisma.comment.create({
    data: {
      pageId,
      authorId: ctx.user.id,
      body: trimmed,
      blockId: opts.blockId ?? null,
      threadId: opts.threadId ?? null,
    },
  });

  // Build the set of recipients: explicit @user mentions + thread participants (if reply).
  const mentionedIds = extractMentionedUserIds(trimmed).filter(
    (id) => id !== ctx.user.id,
  );

  let threadParticipantIds: string[] = [];
  if (opts.threadId) {
    const top = await prisma.comment.findUnique({
      where: { id: opts.threadId },
      select: { authorId: true },
    });
    const replies = await prisma.comment.findMany({
      where: { threadId: opts.threadId },
      select: { authorId: true },
    });
    const all = new Set<string>();
    if (top) all.add(top.authorId);
    for (const r of replies) all.add(r.authorId);
    all.delete(ctx.user.id);
    threadParticipantIds = Array.from(all);
  }

  const preview =
    parseMentions(trimmed)
      .map((s) => (s.kind === "text" ? s.text : `@${s.token.label}`))
      .join("")
      .slice(0, 140);

  const notifs: {
    recipientId: string;
    actorId: string;
    workspaceId: string;
    pageId: string;
    commentId: string;
    kind: string;
    preview: string;
  }[] = [];

  for (const uid of mentionedIds) {
    notifs.push({
      recipientId: uid,
      actorId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      pageId,
      commentId: c.id,
      kind: "mention",
      preview,
    });
  }
  const mentionedSet = new Set(mentionedIds);
  for (const uid of threadParticipantIds) {
    if (mentionedSet.has(uid)) continue; // mention already covers it
    notifs.push({
      recipientId: uid,
      actorId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      pageId,
      commentId: c.id,
      kind: "comment_reply",
      preview,
    });
  }
  // For top-level comments, notify the page author too (if not already covered).
  if (!opts.threadId) {
    const page = await prisma.page.findUnique({
      where: { id: pageId },
      select: { authorId: true },
    });
    if (
      page?.authorId &&
      page.authorId !== ctx.user.id &&
      !mentionedSet.has(page.authorId) &&
      !threadParticipantIds.includes(page.authorId)
    ) {
      notifs.push({
        recipientId: page.authorId,
        actorId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        pageId,
        commentId: c.id,
        kind: "comment_new",
        preview,
      });
    }
  }
  if (notifs.length > 0) {
    // Make sure recipients are workspace members to avoid leaking notifs across workspaces.
    const members = await prisma.workspaceMember.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        userId: { in: notifs.map((n) => n.recipientId) },
      },
      select: { userId: true },
    });
    const allowed = new Set(members.map((m) => m.userId));
    const filtered = notifs.filter((n) => allowed.has(n.recipientId));
    if (filtered.length > 0) {
      await prisma.notification.createMany({ data: filtered });
    }
  }

  revalidatePath(`/w/${slug}/p/${pageId}`);
  return c.id;
}

export async function editComment(slug: string, commentId: string, body: string) {
  const ctx = await requireWorkspaceMember(slug);
  const trimmed = body.trim();
  if (!trimmed) return;
  const c = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { authorId: true, pageId: true, page: { select: { workspaceId: true } } },
  });
  if (!c || c.page.workspaceId !== ctx.workspace.id) throw new Error("not found");
  if (c.authorId !== ctx.user.id) throw new Error("forbidden");
  await prisma.comment.update({ where: { id: commentId }, data: { body: trimmed } });
  revalidatePath(`/w/${slug}/p/${c.pageId}`);
}

export async function deleteComment(slug: string, commentId: string) {
  const ctx = await requireWorkspaceMember(slug);
  const c = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { authorId: true, pageId: true, page: { select: { workspaceId: true } } },
  });
  if (!c || c.page.workspaceId !== ctx.workspace.id) throw new Error("not found");
  if (c.authorId !== ctx.user.id && ctx.role !== "owner") throw new Error("forbidden");
  await prisma.comment.delete({ where: { id: commentId } });
  revalidatePath(`/w/${slug}/p/${c.pageId}`);
}

export async function toggleReaction(
  slug: string,
  commentId: string,
  emoji: string,
) {
  const ctx = await requireWorkspaceMember(slug);
  const c = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { pageId: true, page: { select: { workspaceId: true } } },
  });
  if (!c || c.page.workspaceId !== ctx.workspace.id) throw new Error("not found");
  const existing = await prisma.commentReaction.findUnique({
    where: { commentId_userId_emoji: { commentId, userId: ctx.user.id, emoji } },
  });
  if (existing) {
    await prisma.commentReaction.delete({ where: { id: existing.id } });
  } else {
    await prisma.commentReaction.create({
      data: { commentId, userId: ctx.user.id, emoji },
    });
  }
  revalidatePath(`/w/${slug}/p/${c.pageId}`);
}

export async function setCommentResolved(
  slug: string,
  commentId: string,
  resolved: boolean,
) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  const c = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { pageId: true, page: { select: { workspaceId: true } } },
  });
  if (!c || c.page.workspaceId !== ctx.workspace.id) throw new Error("not found");
  await prisma.comment.update({ where: { id: commentId }, data: { resolved } });
  revalidatePath(`/w/${slug}/p/${c.pageId}`);
}

export async function resolveAllComments(slug: string, pageId: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspace.id },
    select: { id: true },
  });
  if (!page) throw new Error("not found");
  await prisma.comment.updateMany({
    where: { pageId, resolved: false },
    data: { resolved: true },
  });
  revalidatePath(`/w/${slug}/p/${pageId}`);
}

// Silence unused warning for assertPageVisible (reserved for future viewer-friendly actions)
export { assertPageVisible };
