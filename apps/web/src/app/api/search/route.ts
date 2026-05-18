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
  if (!slug || q.length < 1) return NextResponse.json({ hits: [] });

  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: { members: { where: { userId }, select: { id: true } } },
  });
  if (!ws || ws.members.length === 0) {
    return NextResponse.json({ hits: [] }, { status: 403 });
  }

  const rows = await prisma.page.findMany({
    where: {
      workspaceId: ws.id,
      deletedAt: null,
      OR: [{ title: { contains: q } }, { content: { contains: q } }],
    },
    take: 20,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      icon: true,
      kind: true,
      content: true,
      parent: { select: { title: true } },
    },
  });

  const lower = q.toLowerCase();
  const hits: SearchHit[] = rows.map((p) => {
    let snippet: string | null = null;
    if (p.kind === "doc" && p.content) {
      const text = stripBlockNoteJson(p.content);
      const idx = text.toLowerCase().indexOf(lower);
      if (idx >= 0) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + q.length + 60);
        snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
      } else if (text.length) {
        snippet = text.slice(0, 80) + (text.length > 80 ? "…" : "");
      }
    }
    return {
      id: p.id,
      title: p.title,
      icon: p.icon,
      kind: p.kind,
      snippet,
      parentTitle: p.parent?.title ?? null,
    };
  });

  return NextResponse.json({ hits });
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
