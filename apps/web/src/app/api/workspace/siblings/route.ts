import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const pageId = url.searchParams.get("page");
  if (!slug || !pageId)
    return NextResponse.json({ error: "missing slug/page" }, { status: 400 });
  const userId = (session.user as { id: string }).id;
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      parentId: true,
      position: true,
      workspaceId: true,
      workspace: { select: { slug: true, members: { where: { userId } } } },
    },
  });
  if (!page || page.workspace.slug !== slug || page.workspace.members.length === 0)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const siblings = await prisma.page.findMany({
    where: {
      workspaceId: page.workspaceId,
      parentId: page.parentId,
      deletedAt: null,
      isTemplate: false,
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, icon: true },
  });
  const idx = siblings.findIndex((s) => s.id === pageId);
  return NextResponse.json({
    prev: idx > 0 ? siblings[idx - 1] : null,
    next: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null,
    total: siblings.length,
    index: idx,
  });
}
