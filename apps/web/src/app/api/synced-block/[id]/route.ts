import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

async function authorize(id: string, userId: string) {
  const sb = await prisma.syncedBlock.findUnique({
    where: { id },
    include: {
      workspace: { include: { members: { where: { userId } } } },
    },
  });
  if (!sb) return null;
  if (sb.workspace.members.length === 0) return null;
  return sb;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const sb = await authorize(params.id, userId);
  if (!sb) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    id: sb.id,
    content: sb.content,
    updatedAt: sb.updatedAt.toISOString(),
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const sb = await authorize(params.id, userId);
  if (!sb) return NextResponse.json({ error: "not found" }, { status: 404 });
  const role = sb.workspace.members[0]?.role ?? "viewer";
  if (role === "viewer") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as
    | { content?: string }
    | null;
  if (!body || typeof body.content !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const updated = await prisma.syncedBlock.update({
    where: { id: params.id },
    data: { content: body.content.slice(0, 64_000) },
  });
  return NextResponse.json({
    id: updated.id,
    content: updated.content,
    updatedAt: updated.updatedAt.toISOString(),
  });
}
