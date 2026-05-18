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
  prisma.apiToken
    .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return t.user;
}

function stripHtml(html: string): string {
  // Cheap-and-cheerful HTML → plain text. Good enough for clipped articles.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const user = await tokenUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        workspaceSlug?: string;
        url?: string;
        title?: string;
        content?: string;
        html?: string;
      }
    | null;
  if (!body?.workspaceSlug || !body.url) {
    return NextResponse.json(
      { error: "missing workspaceSlug or url" },
      { status: 400 },
    );
  }
  const u = safeUrl(body.url);
  if (!u) return NextResponse.json({ error: "invalid url" }, { status: 400 });

  const ws = await prisma.workspace.findUnique({
    where: { slug: body.workspaceSlug },
    include: { members: { where: { userId: user.id } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const role = ws.members[0]?.role ?? "viewer";
  if (role === "viewer") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let textContent =
    typeof body.content === "string" && body.content.trim()
      ? body.content
      : body.html
        ? stripHtml(body.html)
        : "";
  textContent = textContent.slice(0, 50_000);

  const paragraphs = textContent.split(/\n\n+/).filter(Boolean);
  const blocks: unknown[] = [
    {
      type: "bookmark",
      props: { url: u.toString() },
    },
  ];
  for (const p of paragraphs) {
    blocks.push({
      type: "paragraph",
      content: [{ type: "text", text: p.replace(/\n/g, " "), styles: {} }],
    });
  }

  const max = await prisma.page.aggregate({
    where: { workspaceId: ws.id, parentId: null },
    _max: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: ws.id,
      parentId: null,
      title: body.title?.trim() || u.hostname,
      icon: "🌐",
      content: JSON.stringify(blocks),
      position: (max._max.position ?? 0) + 1,
      authorId: user.id,
    },
  });

  return NextResponse.json({
    id: page.id,
    title: page.title,
    workspaceSlug: ws.slug,
    url: `/w/${ws.slug}/p/${page.id}`,
  });
}
