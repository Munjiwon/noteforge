import { NextRequest, NextResponse } from "next/server";
import { prisma } from "db";

async function tokenUser(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const t = await prisma.apiToken.findUnique({
    where: { token: m[1] },
    include: { user: true },
  });
  if (!t) return null;
  // best-effort update
  prisma.apiToken
    .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return t.user;
}

export async function GET(req: NextRequest) {
  const user = await tokenUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ws = req.nextUrl.searchParams.get("workspace");
  const pages = await prisma.page.findMany({
    where: {
      deletedAt: null,
      workspace: {
        ...(ws ? { slug: ws } : {}),
        members: { some: { userId: user.id } },
      },
    },
    select: {
      id: true,
      title: true,
      icon: true,
      kind: true,
      parentId: true,
      createdAt: true,
      updatedAt: true,
      workspace: { select: { slug: true } },
    },
    take: 200,
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      kind: p.kind,
      parentId: p.parentId,
      workspaceSlug: p.workspace.slug,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await tokenUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { workspaceSlug: string; title?: string; parentId?: string | null }
    | null;
  if (!body || !body.workspaceSlug) {
    return NextResponse.json({ error: "missing workspaceSlug" }, { status: 400 });
  }
  const ws = await prisma.workspace.findUnique({
    where: { slug: body.workspaceSlug },
    include: { members: { where: { userId: user.id } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const max = await prisma.page.aggregate({
    where: { workspaceId: ws.id, parentId: body.parentId ?? null },
    _max: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: ws.id,
      parentId: body.parentId ?? null,
      title: body.title?.trim() || "Untitled",
      position: (max._max.position ?? 0) + 1,
      authorId: user.id,
    },
  });
  return NextResponse.json({
    id: page.id,
    title: page.title,
    workspaceSlug: ws.slug,
  });
}
