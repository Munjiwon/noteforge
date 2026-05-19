import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ tags: [] }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const slug = req.nextUrl.searchParams.get("ws");
  if (!slug) return NextResponse.json({ tags: [] });
  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { members: { where: { userId }, select: { id: true } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ tags: [] }, { status: 403 });
  }
  const rows = await prisma.page.findMany({
    where: { workspaceId: ws.id, deletedAt: null, tags: { not: "[]" } },
    select: { tags: true },
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.tags ?? "[]");
      if (Array.isArray(arr))
        for (const t of arr) {
          if (typeof t === "string") counts.set(t, (counts.get(t) ?? 0) + 1);
        }
    } catch {}
  }
  const tags = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 40);
  return NextResponse.json({ tags });
}
