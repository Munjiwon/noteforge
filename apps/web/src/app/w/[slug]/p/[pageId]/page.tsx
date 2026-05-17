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
      content: true,
      dbSchema: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      publicAccess: true,
      publicSlug: true,
      author: { select: { name: true, color: true } },
    },
  });
  if (!page) notFound();

  const trashed = page.deletedAt !== null;
  const effectiveRole = trashed
    ? "viewer"
    : (ctx.role as "owner" | "editor" | "viewer");

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
    const rows = await prisma.page.findMany({
      where: { parentId: page.id, deletedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, cover: true, dataValues: true },
    });
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
            schema: parseSchema(page.dbSchema),
            publicAccess: page.publicAccess === "view" ? "view" : "none",
            publicSlug: page.publicSlug,
            permissions,
          }}
          rows={rows.map((r) => ({
            id: r.id,
            parentId: page.id,
            title: r.title,
            cover: r.cover,
            dataValues: parseValues(r.dataValues),
          }))}
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
        author: { select: { id: true, name: true, color: true } },
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
  const childCount = await prisma.page.count({
    where: { parentId: page.id, deletedAt: null },
  });
  const wordCount = countWords(page.content);
  const info = {
    author: page.author ?? null,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
    wordCount,
    commentCount: commentRows.length,
    backlinkCount: backlinkRows.length,
    childrenCount: childCount,
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
        }}
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
      />
    </>
  );
}
