import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const candidate = (url.searchParams.get("candidate") ?? "").trim();
  const pageId = url.searchParams.get("page") ?? null;
  if (!slug) return NextResponse.json({ error: "missing slug" }, { status: 400 });
  if (!candidate) return NextResponse.json({ available: true });
  const userId = (session.user as { id: string }).id;
  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { members: { where: { userId } } },
  });
  if (!ws || ws.members.length === 0)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // valid characters
  if (!/^[a-z0-9-]{1,64}$/i.test(candidate))
    return NextResponse.json({ available: false, reason: "invalid" });
  const conflict = await prisma.page.findFirst({
    where: {
      workspaceId: ws.id,
      slug: candidate,
      ...(pageId ? { NOT: { id: pageId } } : {}),
    },
    select: { id: true },
  });
  return NextResponse.json({ available: !conflict });
}
