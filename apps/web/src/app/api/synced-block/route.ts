import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

// POST { workspaceSlug } → creates a new empty synced block, returns { id }.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const body = (await req.json().catch(() => null)) as
    | { workspaceSlug?: string }
    | null;
  if (!body?.workspaceSlug) {
    return NextResponse.json({ error: "missing workspace" }, { status: 400 });
  }
  const ws = await prisma.workspace.findUnique({
    where: { slug: body.workspaceSlug },
    include: { members: { where: { userId } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sb = await prisma.syncedBlock.create({
    data: {
      workspaceId: ws.id,
      createdById: userId,
    },
  });
  return NextResponse.json({ id: sb.id });
}
