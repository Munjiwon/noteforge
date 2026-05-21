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

  const pages = await prisma.page.findMany({
    where: { workspaceId: ws.id, deletedAt: null },
    orderBy: [{ parentId: "asc" }, { position: "asc" }],
    select: {
      id: true,
      title: true,
      icon: true,
      cover: true,
      kind: true,
      parentId: true,
      tags: true,
      content: true,
      dbSchema: true,
      dataValues: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { name: true, email: true } },
    },
  });

  const payload = {
    exportedAt: new Date().toISOString(),
    workspace: {
      slug: ws.slug,
      name: ws.name,
      icon: ws.icon,
      color: ws.color,
    },
    pages,
    version: 1,
  };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}-export.json"`,
    },
  });
}
