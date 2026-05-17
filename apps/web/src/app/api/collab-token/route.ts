import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";
import { signCollabToken } from "@/lib/collab-token";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauth" }, { status: 401 });
  }
  const pid = req.nextUrl.searchParams.get("pageId");
  if (!pid) return NextResponse.json({ error: "missing pageId" }, { status: 400 });

  const userId = (session.user as { id: string }).id;
  const name = session.user.name ?? "User";
  const color = (session.user as { color: string }).color ?? "#888";

  // Verify the user can access this page: must belong to a workspace they're a member of.
  const page = await prisma.page.findUnique({
    where: { id: pid },
    select: {
      workspaceId: true,
      deletedAt: true,
      workspace: {
        select: {
          members: { where: { userId }, select: { role: true } },
        },
      },
    },
  });
  if (!page || page.deletedAt) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (page.workspace.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const token = signCollabToken({
    uid: userId,
    pid,
    name,
    color,
    exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
  });

  return NextResponse.json({ token });
}
