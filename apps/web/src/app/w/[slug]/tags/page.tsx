import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { TagsClient } from "./client";

export default async function TagsPage({
  params,
}: {
  params: { slug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const rows = await prisma.page.findMany({
    where: { workspaceId: ctx.workspace.id, deletedAt: null },
    select: { id: true, title: true, icon: true, tags: true, kind: true },
  });

  type Hit = {
    pageId: string;
    title: string;
    icon: string | null;
    kind: string;
  };
  const byTag = new Map<string, Hit[]>();
  for (const p of rows) {
    let arr: string[] = [];
    try {
      const v = JSON.parse(p.tags ?? "[]");
      if (Array.isArray(v)) arr = v.filter((x) => typeof x === "string");
    } catch {}
    for (const t of arr) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t)!.push({
        pageId: p.id,
        title: p.title,
        icon: p.icon,
        kind: p.kind,
      });
    }
  }
  const tags = Array.from(byTag.entries())
    .map(([name, pages]) => ({ name, pages }))
    .sort((a, b) => b.pages.length - a.pages.length || a.name.localeCompare(b.name));

  const canEdit = ctx.role !== "viewer";

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Tags</h1>
        <Link
          href={`/w/${params.slug}`}
          className="text-xs text-gray-500 hover:text-gray-900"
        >
          ← Back
        </Link>
      </div>
      {tags.length === 0 ? (
        <p className="text-sm text-gray-500">
          No tags yet. Open a page and add tags below the title.
        </p>
      ) : (
        <TagsClient slug={params.slug} tags={tags} canEdit={canEdit} />
      )}
    </div>
  );
}
