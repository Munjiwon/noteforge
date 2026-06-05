import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const page = await prisma.page.findUnique({
    where: { id: params.id },
    include: {
      workspace: { include: { members: { where: { userId } } } },
      author: { select: { name: true, color: true, avatarUrl: true } },
    },
  });
  if (!page || page.deletedAt) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (page.workspace.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parentDb = page.parentId
    ? await prisma.page.findUnique({
        where: { id: page.parentId },
        select: { id: true, title: true, icon: true, kind: true, dbSchema: true },
      })
    : null;
  const parentDatabase =
    parentDb && parentDb.kind === "database"
      ? {
          id: parentDb.id,
          title: parentDb.title,
          icon: parentDb.icon,
          schema: parentDb.dbSchema,
        }
      : null;
  const activities = await prisma.pageActivity.findMany({
    where: { pageId: page.id },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  const userIds = Array.from(
    new Set(activities.map((a) => a.userId).filter((x): x is string => !!x)),
  );
  const userMap = new Map<string, { name: string; color: string }>();
  if (userIds.length > 0) {
    const rows = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, color: true },
    });
    for (const r of rows) userMap.set(r.id, { name: r.name, color: r.color });
  }
  return NextResponse.json({
    id: page.id,
    title: page.title,
    icon: page.icon,
    cover: page.cover,
    kind: page.kind,
    content: page.content,
    dataValues: page.dataValues,
    slug: page.workspace.slug,
    author: page.author,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
    parentDatabase,
    activities: activities.map((a) => ({
      id: a.id,
      action: a.action,
      meta: a.meta,
      createdAt: a.createdAt.toISOString(),
      user: a.userId ? userMap.get(a.userId) ?? null : null,
    })),
  });
}
