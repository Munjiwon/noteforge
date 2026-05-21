import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "missing slug" }, { status: 400 });
  const userId = (session.user as { id: string }).id;
  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { members: { where: { userId } } },
  });
  if (!ws || ws.members.length === 0)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const count = await prisma.page.count({
    where: {
      workspaceId: ws.id,
      deletedAt: null,
      kind: "doc",
      isTemplate: false,
    },
  });
  if (count === 0) return NextResponse.json({ id: null });
  const offset = Math.floor(Math.random() * count);
  const row = await prisma.page.findFirst({
    where: {
      workspaceId: ws.id,
      deletedAt: null,
      kind: "doc",
      isTemplate: false,
    },
    skip: offset,
    select: { id: true },
  });
  return NextResponse.json({ id: row?.id ?? null });
}
