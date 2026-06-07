import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";
import { updateCell } from "@/app/w/[slug]/database-actions";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const page = await prisma.page.findUnique({
    where: { id: params.id },
    select: { id: true, workspace: { select: { slug: true, members: { where: { userId } } } } },
  });
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (page.workspace.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { propId?: string; value?: unknown }
    | null;
  if (!body || typeof body.propId !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  await updateCell(page.workspace.slug, page.id, body.propId, body.value);
  return NextResponse.json({ ok: true });
}
