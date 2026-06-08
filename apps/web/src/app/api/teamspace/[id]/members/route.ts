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

  const ts = await prisma.teamspace.findUnique({
    where: { id: params.id },
    include: {
      workspace: { select: { members: { where: { userId }, select: { role: true } } } },
      members: { select: { userId: true, role: true } },
    },
  });
  if (!ts) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (ts.workspace.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    members: ts.members.map((m) => ({ userId: m.userId, role: m.role })),
  });
}
