import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const slug = req.nextUrl.searchParams.get("workspace");
  const ws = slug
    ? await prisma.workspace.findUnique({
        where: { slug },
        include: { members: { where: { userId }, select: { id: true, mutedKinds: true } } },
      })
    : null;
  if (slug && (!ws || ws.members.length === 0)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let muted: string[] = [];
  if (ws?.members[0]) {
    try {
      const v = JSON.parse(ws.members[0].mutedKinds ?? "[]");
      if (Array.isArray(v)) muted = v.filter((x) => typeof x === "string");
    } catch {}
  }
  const where = {
    recipientId: userId,
    ...(ws ? { workspaceId: ws.id } : {}),
    ...(muted.length > 0 ? { kind: { notIn: muted } } : {}),
  };
  const [latest, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { actor: { select: { name: true, color: true, avatarUrl: true } } },
    }),
    prisma.notification.count({ where: { ...where, read: false } }),
  ]);
  return NextResponse.json({
    unread,
    notifications: latest.map((n) => ({
      id: n.id,
      kind: n.kind,
      preview: n.preview,
      read: n.read,
      createdAt: n.createdAt.toISOString(),
      pageId: n.pageId,
      commentId: n.commentId,
      actor: n.actor
        ? { name: n.actor.name, color: n.actor.color, avatarUrl: n.actor.avatarUrl }
        : null,
    })),
  });
}
