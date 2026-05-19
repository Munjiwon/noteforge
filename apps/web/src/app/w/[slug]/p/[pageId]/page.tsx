import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { PageView } from "@/components/page-view";
import { DatabasePage } from "@/components/database-page";
import { TrashBanner } from "@/components/trash-banner";
import { parseSchema, parseValues } from "@/lib/database";

function countWords(json: string): number {
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return 0;
    const parts: string[] = [];
    const walk = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const node = b as { content?: unknown; children?: unknown };
      const c = node.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (it && typeof it === "object" && "text" in it && typeof (it as { text: unknown }).text === "string") {
            parts.push((it as { text: string }).text);
          }
        }
      }
      if (Array.isArray(node.children)) for (const ch of node.children) walk(ch);
    };
    for (const b of blocks) walk(b);
    return parts.join(" ").trim().split(/\s+/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string; pageId: string };
}) {
  const p = await prisma.page.findUnique({
    where: { id: params.pageId },
    select: { title: true, icon: true },
  });
  if (!p) return { title: "Untitled" };
  const t = (p.title || "Untitled").slice(0, 80);
  return {
    title: p.icon ? `${p.icon} ${t}` : t,
  };
}

export default async function PageRoute({
  params,
}: {
  params: { slug: string; pageId: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const page = await prisma.page.findFirst({
    where: { id: params.pageId, workspaceId: ctx.workspace.id },
    select: {
      id: true,
      kind: true,
      title: true,
      icon: true,
      cover: true,
      coverPos: true,
      content: true,
      dbSchema: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      publicAccess: true,
      publicSlug: true,
      publicViewCount: true,
      locked: true,
      lockedUntil: true,
      width: true,
      font: true,
      tags: true,
      viewCount: true,
      wordGoal: true,
      favorite: true,
      slug: true,
      expiresAt: true,
      author: { select: { name: true, color: true, avatarUrl: true } },
    },
  });
  if (!page) notFound();

  const trashed = page.deletedAt !== null;
  // honor lockedUntil: if expiry passed, treat as unlocked at read time
  const lockExpired =
    page.locked && page.lockedUntil && page.lockedUntil.getTime() < Date.now();
  const effectivelyLocked = page.locked && !lockExpired;
  const effectiveRole = (trashed || effectivelyLocked)
    ? "viewer"
    : (ctx.role as "owner" | "editor" | "viewer");
  const canChangePageSettings = !trashed && ctx.role !== "viewer";

  // Detect "this page is a database row" — parent is a database
  const parentIdRow = (await prisma.page.findUnique({
    where: { id: page.id },
    select: { parentId: true, dataValues: true },
  }));
  const parentDb = page.kind === "doc" && parentIdRow?.parentId
    ? await prisma.page.findUnique({
        where: { id: parentIdRow.parentId },
        select: { id: true, title: true, icon: true, kind: true, dbSchema: true },
      })
    : null;
  const rowContext =
    parentDb && parentDb.kind === "database"
      ? {
          dbId: parentDb.id,
          dbTitle: parentDb.title,
          dbIcon: parentDb.icon,
          schema: parseSchema(parentDb.dbSchema),
          dataValues: parseValues(parentIdRow?.dataValues ?? null),
        }
      : null;

  // Collect ancestor chain for breadcrumb
  const ancestors: { id: string; title: string; icon: string | null }[] = [];
  let cursor: { id: string; title: string; icon: string | null; parentId: string | null } | null = await prisma.page.findUnique({
    where: { id: page.id },
    select: { id: true, title: true, icon: true, parentId: true },
  });
  // walk up via parentId, max 10 hops
  for (let i = 0; i < 10 && cursor && cursor.parentId; i++) {
    const parent = await prisma.page.findUnique({
      where: { id: cursor.parentId },
      select: { id: true, title: true, icon: true, parentId: true },
    });
    if (!parent) break;
    ancestors.unshift({ id: parent.id, title: parent.title, icon: parent.icon });
    cursor = parent;
  }

  const permRows = await prisma.pagePermission.findMany({
    where: { pageId: page.id },
    include: { user: { select: { id: true, name: true, color: true } } },
  });
  const permissions = permRows.map((p) => ({
    userId: p.user.id,
    name: p.user.name,
    color: p.user.color,
    role: (p.role === "view" || p.role === "comment" || p.role === "edit"
      ? p.role
      : "view") as "view" | "comment" | "edit",
  }));

  if (page.kind === "database") {
    const [rows, rowTemplates] = await Promise.all([
      prisma.page.findMany({
        where: {
          parentId: page.id,
          deletedAt: null,
          isTemplate: false,
        },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          cover: true,
          dataValues: true,
          createdAt: true,
          updatedAt: true,
          author: { select: { id: true, name: true, color: true, avatarUrl: true } },
        },
      }),
      prisma.page.findMany({
        where: {
          parentId: page.id,
          deletedAt: null,
          isTemplate: true,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, icon: true },
      }),
    ]);
    return (
      <>
        {trashed && (
          <TrashBanner
            slug={params.slug}
            pageId={page.id}
            canEdit={ctx.role !== "viewer"}
          />
        )}
        <DatabasePage
          slug={params.slug}
          db={{
            id: page.id,
            title: page.title,
            icon: page.icon,
            cover: page.cover,
            coverPos: page.coverPos,
            schema: parseSchema(page.dbSchema),
            publicAccess: page.publicAccess === "view" ? "view" : "none",
            publicSlug: page.publicSlug,
            publicViewCount: page.publicViewCount,
            permissions,
            locked: page.locked,
            width: (page.width === "wide" || page.width === "full" ? page.width : "normal") as "normal" | "wide" | "full",
            font: (page.font === "serif" || page.font === "mono" ? page.font : "default") as "default" | "serif" | "mono",
          }}
          canChangeSettings={canChangePageSettings}
          rows={rows.map((r) => ({
            id: r.id,
            parentId: page.id,
            title: r.title,
            cover: r.cover,
            dataValues: parseValues(r.dataValues),
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            author: r.author,
          }))}
          rowTemplates={rowTemplates}
          role={effectiveRole}
        />
      </>
    );
  }

  const [commentRows, snapshotRows, backlinkRows] = await Promise.all([
    prisma.comment.findMany({
      where: { pageId: page.id },
      orderBy: { createdAt: "asc" },
      include: {
        author: { select: { id: true, name: true, color: true, avatarUrl: true } },
        reactions: { select: { userId: true, emoji: true } },
      },
    }),
    prisma.pageSnapshot.findMany({
      where: { pageId: page.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        page: { select: { workspaceId: true } },
      },
    }),
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        deletedAt: null,
        id: { not: page.id },
        content: { contains: page.id },
      },
      select: { id: true, title: true, icon: true, kind: true },
      take: 30,
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  const comments = commentRows.map((c) => ({
    id: c.id,
    body: c.body,
    resolved: c.resolved,
    blockId: c.blockId,
    threadId: c.threadId,
    createdAt: c.createdAt.toISOString(),
    author: c.author,
    reactions: c.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })),
  }));
  // Pull author names for snapshots (separate fetch keeps query simple).
  const authorIds = Array.from(
    new Set(snapshotRows.map((s) => s.authorId).filter((id): id is string => !!id)),
  );
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, name: true, color: true },
      })
    : [];
  const authorMap = new Map(authors.map((a) => [a.id, a]));
  const [childCount, activityRows, reactionRows] = await Promise.all([
    prisma.page.count({ where: { parentId: page.id, deletedAt: null } }),
    prisma.pageActivity.findMany({
      where: { pageId: page.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.pageReaction.findMany({
      where: { pageId: page.id },
      include: { user: { select: { id: true, name: true } } },
    }),
  ]);
  const subscribed = !!(await prisma.pageSubscription.findUnique({
    where: { pageId_userId: { pageId: page.id, userId: ctx.user.id } },
  }));
  const pendingReminders = await prisma.reminder.findMany({
    where: {
      userId: ctx.user.id,
      pageId: page.id,
      sentAt: null,
      dueAt: { gt: new Date() },
    },
    orderBy: { dueAt: "asc" },
    select: { id: true, dueAt: true, note: true, repeatRule: true },
  });
  const reactionGroupsMap = new Map<
    string,
    { emoji: string; users: { id: string; name: string }[]; reactedByMe: boolean }
  >();
  for (const r of reactionRows) {
    if (!reactionGroupsMap.has(r.emoji)) {
      reactionGroupsMap.set(r.emoji, {
        emoji: r.emoji,
        users: [],
        reactedByMe: false,
      });
    }
    const g = reactionGroupsMap.get(r.emoji)!;
    g.users.push({ id: r.user.id, name: r.user.name });
    if (r.userId === ctx.user.id) g.reactedByMe = true;
  }
  const reactionGroups = Array.from(reactionGroupsMap.values()).sort(
    (a, b) => b.users.length - a.users.length,
  );
  const activityUsers = await prisma.user.findMany({
    where: { id: { in: activityRows.map((a) => a.userId).filter((id): id is string => !!id) } },
    select: { id: true, name: true, color: true },
  });
  const userMap = new Map(activityUsers.map((u) => [u.id, u]));
  const wordCount = countWords(page.content);
  const info = {
    author: page.author ?? null,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
    wordCount,
    commentCount: commentRows.length,
    backlinkCount: backlinkRows.length,
    childrenCount: childCount,
    viewCount: page.viewCount,
    wordGoal: page.wordGoal,
    activity: activityRows.map((a) => ({
      id: a.id,
      action: a.action,
      createdAt: a.createdAt.toISOString(),
      user: a.userId ? userMap.get(a.userId) ?? null : null,
    })),
  };
  const snapshots = snapshotRows.map((s) => ({
    id: s.id,
    content: s.content,
    createdAt: s.createdAt.toISOString(),
    author: s.authorId ? authorMap.get(s.authorId) ?? null : null,
  }));

  return (
    <>
      {trashed && (
        <TrashBanner
          slug={params.slug}
          pageId={page.id}
          canEdit={ctx.role !== "viewer"}
        />
      )}
      <PageView
        key={page.id}
        slug={params.slug}
        page={{
          ...page,
          publicAccess: (page.publicAccess === "view" ? "view" : "none"),
          width: (page.width === "wide" || page.width === "full" ? page.width : "normal") as "normal" | "wide" | "full",
          font: (page.font === "serif" || page.font === "mono" ? page.font : "default") as "default" | "serif" | "mono",
          expiresAt: page.expiresAt ? page.expiresAt.toISOString() : null,
        }}
        canChangeSettings={canChangePageSettings}
        user={ctx.user}
        role={effectiveRole}
        comments={comments}
        snapshots={snapshots.map((s) => ({
          id: s.id,
          content: s.content,
          createdAt: s.createdAt,
          author: s.author ? { name: s.author.name, color: s.author.color } : null,
        }))}
        backlinks={backlinkRows}
        info={info}
        permissions={permissions}
        ancestors={ancestors}
        rowContext={rowContext}
        reactions={reactionGroups}
        subscribed={subscribed}
        reminders={pendingReminders.map((r) => ({
          id: r.id,
          dueAt: r.dueAt.toISOString(),
          note: r.note,
          repeatRule: r.repeatRule,
        }))}
        workspaceDefaultFont={
          (ctx.workspace.defaultFont === "serif" ||
          ctx.workspace.defaultFont === "mono"
            ? ctx.workspace.defaultFont
            : "default") as "default" | "serif" | "mono"
        }
      />
    </>
  );
}
