import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";
import { parseSchema, parseValues } from "@/lib/database";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const db = await prisma.page.findFirst({
    where: { id: params.id, kind: "database", deletedAt: null },
    select: {
      id: true,
      title: true,
      icon: true,
      dbSchema: true,
      workspaceId: true,
      workspace: { select: { slug: true, members: { where: { userId } } } },
    },
  });
  if (!db) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (db.workspace.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await prisma.page.findMany({
    where: { parentId: db.id, deletedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, cover: true, dataValues: true },
  });
  return NextResponse.json({
    id: db.id,
    slug: db.workspace.slug,
    title: db.title,
    icon: db.icon,
    schema: parseSchema(db.dbSchema),
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      cover: r.cover,
      dataValues: parseValues(r.dataValues),
    })),
  });
}
