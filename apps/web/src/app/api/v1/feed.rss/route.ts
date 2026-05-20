import { NextRequest, NextResponse } from "next/server";
import { prisma } from "db";

async function tokenUser(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const t = await prisma.apiToken.findUnique({
    where: { token: m[1] },
    include: { user: true },
  });
  if (!t) return null;
  return t.user;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(req: NextRequest) {
  const user = await tokenUser(req);
  if (!user) return new NextResponse("unauthorized", { status: 401 });
  const ws = req.nextUrl.searchParams.get("workspace");
  if (!ws) return new NextResponse("missing workspace", { status: 400 });
  const workspace = await prisma.workspace.findUnique({
    where: { slug: ws },
    include: { members: { where: { userId: user.id }, select: { id: true } } },
  });
  if (!workspace || workspace.members.length === 0) {
    return new NextResponse("forbidden", { status: 403 });
  }
  const origin = req.nextUrl.origin;
  const pages = await prisma.page.findMany({
    where: {
      workspaceId: workspace.id,
      deletedAt: null,
      isTemplate: false,
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, title: true, icon: true, updatedAt: true },
  });
  const items = pages
    .map(
      (p) =>
        `    <item>\n      <title>${esc((p.icon ?? "") + " " + (p.title || "Untitled"))}</title>\n      <link>${origin}/w/${ws}/p/${p.id}</link>\n      <guid isPermaLink="false">${p.id}</guid>\n      <pubDate>${p.updatedAt.toUTCString()}</pubDate>\n    </item>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(workspace.name)}</title>
    <link>${origin}/w/${ws}</link>
    <description>Updates from the ${esc(workspace.name)} workspace</description>
${items}
  </channel>
</rss>`;
  return new NextResponse(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
