import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ users: [], pages: [], issues: [] }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const slug = req.nextUrl.searchParams.get("ws");
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!slug) return NextResponse.json({ users: [], pages: [], issues: [] });

  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { members: { where: { userId }, select: { id: true } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ users: [], pages: [], issues: [] }, { status: 403 });
  }

  // Allow matching a typed key like "ENG-12" by its trailing number.
  const numMatch = /(\d+)\s*$/.exec(q)?.[1];

  const [users, pages, issues] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: {
        workspaceId: ws.id,
        ...(q
          ? {
              user: {
                OR: [
                  { name: { contains: q } },
                  { email: { contains: q } },
                ],
              },
            }
          : {}),
      },
      take: 6,
      include: { user: { select: { id: true, name: true, color: true } } },
    }),
    prisma.page.findMany({
      where: {
        workspaceId: ws.id,
        deletedAt: null,
        ...(q ? { title: { contains: q } } : {}),
      },
      take: 6,
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, icon: true, kind: true },
    }),
    prisma.issue.findMany({
      where: {
        project: { workspaceId: ws.id, archivedAt: null },
        ...(q
          ? {
              OR: [
                { summary: { contains: q } },
                ...(numMatch ? [{ number: Number(numMatch) }] : []),
              ],
            }
          : {}),
      },
      take: 6,
      orderBy: { updatedAt: "desc" },
      select: { id: true, number: true, summary: true, project: { select: { key: true } } },
    }),
  ]);

  return NextResponse.json({
    users: users.map((m) => m.user),
    pages,
    issues: issues.map((i) => ({
      id: i.id,
      number: i.number,
      summary: i.summary,
      projectKey: i.project.key,
    })),
  });
}
