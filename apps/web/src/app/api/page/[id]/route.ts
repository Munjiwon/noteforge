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
      author: { select: { name: true, color: true } },
    },
  });
  if (!page || page.deletedAt) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (page.workspace.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
  });
}
