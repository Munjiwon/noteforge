import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export type SearchHit = {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  snippet: string | null;
  parentTitle: string | null;
};

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ hits: [] }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const slug = req.nextUrl.searchParams.get("ws");
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const authorId = req.nextUrl.searchParams.get("author") || null;
  const sinceParam = req.nextUrl.searchParams.get("since"); // "7d" | "30d" | "90d" | ISO date
  const tagParam = (req.nextUrl.searchParams.get("tag") ?? "").trim();
  const sortParam = req.nextUrl.searchParams.get("sort"); // "recent" | "relevance"
  if (!slug) return NextResponse.json({ hits: [] });
  if (q.length < 1 && !tagParam && !authorId && !sinceParam) {
    return NextResponse.json({ hits: [] });
  }

  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { members: { where: { userId }, select: { id: true } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ hits: [] }, { status: 403 });
  }

  let since: Date | null = null;
  if (sinceParam) {
    const m = /^(\d+)d$/.exec(sinceParam);
    if (m) {
      since = new Date(Date.now() - Number(m[1]) * 24 * 3600 * 1000);
    } else {
      const dt = new Date(sinceParam);
      if (!Number.isNaN(dt.getTime())) since = dt;
    }
  }

  const where: Record<string, unknown> = {
    workspaceId: ws.id,
    deletedAt: null,
    OR: [{ title: { contains: q } }, { content: { contains: q } }],
  };
  if (authorId) where.authorId = authorId;
  if (since) where.updatedAt = { gte: since };
  // tags are stored as JSON arrays in a single string column — fall back to
  // a substring search of the encoded array so any "tag1" or "tag with space"
  // match works without a relational table.
  if (tagParam) {
    const tagFilter = { contains: JSON.stringify(tagParam).slice(1, -1) };
    // combine title/content OR with tags AND via wrapping
    where.AND = [{ OR: where.OR }, { tags: tagFilter }];
    delete (where as { OR?: unknown }).OR;
  }

  const rows = await prisma.page.findMany({
    where: where as never,
    take: 20,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      icon: true,
      kind: true,
      content: true,
      parent: {
        select: {
          title: true,
          parent: { select: { title: true } },
        },
      },
    },
  });

  const lower = q.toLowerCase();
  type Scored = SearchHit & { _score: number };
  const hits: Scored[] = rows.map((p) => {
    let snippet: string | null = null;
    let score = 0;
    const tLower = p.title.toLowerCase();
    if (tLower === lower) score += 100;
    else if (tLower.startsWith(lower)) score += 60;
    else if (tLower.includes(lower)) score += 30;
    if (p.kind === "doc" && p.content) {
      const text = stripBlockNoteJson(p.content);
      const idx = text.toLowerCase().indexOf(lower);
      if (idx >= 0) {
        score += 10;
        // earlier hit = better
        score += Math.max(0, 10 - Math.floor(idx / 100));
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + q.length + 60);
        snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
      } else if (text.length) {
        snippet = text.slice(0, 80) + (text.length > 80 ? "…" : "");
      }
    }
    const grandparent = p.parent?.parent?.title;
    const parentTitle = p.parent?.title
      ? grandparent
        ? `${grandparent} / ${p.parent.title}`
        : p.parent.title
      : null;
    return {
      id: p.id,
      title: p.title,
      icon: p.icon,
      kind: p.kind,
      snippet,
      parentTitle,
      _score: score,
    };
  });
  if (sortParam === "relevance") {
    hits.sort((a, b) => b._score - a._score);
  }

  return NextResponse.json({
    hits: hits.map(({ _score, ...rest }) => {
      void _score;
      return rest;
    }),
  });
}

function stripBlockNoteJson(json: string): string {
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return "";
    const parts: string[] = [];
    const walk = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const node = b as { content?: unknown; children?: unknown };
      const c = node.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (it && typeof it === "object" && "text" in it && typeof (it as { text: unknown }).text === "string") {
            parts.push((it as { text: string }).text);
          }
        }
      }
      if (Array.isArray(node.children)) for (const ch of node.children) walk(ch);
    };
    for (const b of blocks) walk(b);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}
