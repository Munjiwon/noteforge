import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

// Backs the in-page work-view embed block. Without `key`, returns the
// workspace's projects (for the picker). With `key`, returns that project's
// open issues. Always enforces workspace membership (no cross-workspace leak).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const slug = req.nextUrl.searchParams.get("ws");
  const key = req.nextUrl.searchParams.get("key");
  if (!slug) return NextResponse.json({ error: "missing ws" }, { status: 400 });

  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { members: { where: { userId }, select: { id: true } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!key) {
    const projects = await prisma.workProject.findMany({
      where: { workspaceId: ws.id, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: { key: true, name: true, icon: true },
    });
    return NextResponse.json({ projects });
  }

  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ws.id, key },
    select: { id: true, key: true, name: true, icon: true },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [issues, total] = await Promise.all([
    prisma.issue.findMany({
      where: { projectId: project.id, status: { category: { not: "done" } } },
      orderBy: { rank: "asc" },
      take: 25,
      select: {
        number: true,
        summary: true,
        priority: true,
        type: { select: { icon: true } },
        status: { select: { name: true, category: true } },
        assignee: { select: { name: true, color: true } },
      },
    }),
    prisma.issue.count({
      where: { projectId: project.id, status: { category: { not: "done" } } },
    }),
  ]);

  return NextResponse.json({
    slug,
    projectKey: project.key,
    projectName: project.name,
    projectIcon: project.icon,
    total,
    issues: issues.map((i) => ({
      number: i.number,
      summary: i.summary,
      priority: i.priority,
      typeIcon: i.type.icon,
      statusName: i.status.name,
      statusCategory: i.status.category,
      assigneeName: i.assignee?.name ?? null,
      assigneeColor: i.assignee?.color ?? null,
    })),
  });
}
