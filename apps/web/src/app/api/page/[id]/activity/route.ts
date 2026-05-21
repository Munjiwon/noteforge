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
    select: {
      workspaceId: true,
      workspace: { select: { members: { where: { userId }, select: { id: true } } } },
    },
  });
  if (!page || page.workspace.members.length === 0)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const activities = await prisma.pageActivity.findMany({
    where: { pageId: params.id },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  // Hydrate user info separately (Prisma relation depends on schema).
  const userIds = Array.from(
    new Set(activities.map((a) => a.userId).filter((x): x is string => !!x)),
  );
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, color: true },
        })
      : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  return NextResponse.json({
    activities: activities.map((a) => ({
      id: a.id,
      action: a.action,
      meta: a.meta,
      createdAt: a.createdAt.toISOString(),
      user: a.userId ? userMap.get(a.userId) ?? null : null,
    })),
  });
}
