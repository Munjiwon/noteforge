import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { ArchiveList } from "./client";

export default async function ArchivePage({
  params,
}: {
  params: { slug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const rows = await prisma.page.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      archivedAt: { not: null },
      deletedAt: null,
    },
    orderBy: { archivedAt: "desc" },
    select: {
      id: true,
      title: true,
      icon: true,
      kind: true,
      archivedAt: true,
    },
  });

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">📦 Archive</h1>
          <p className="text-sm text-gray-500">
            Pages you&apos;ve archived. Unlike Trash, archived pages stay forever
            until you restore or delete them.
          </p>
        </div>
        <Link
          href={`/w/${params.slug}`}
          className="text-xs text-gray-500 hover:text-gray-900"
        >
          ← Back
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-5xl mb-2">📦</div>
          <p className="text-sm text-gray-700">No archived pages.</p>
          <p className="text-xs text-gray-400 mt-1">
            Open a page → ⋯ Page style → 📦 Archive to put it here.
          </p>
        </div>
      ) : (
        <ArchiveList
          slug={params.slug}
          rows={rows.map((r) => ({
            id: r.id,
            title: r.title,
            icon: r.icon,
            kind: r.kind,
            archivedAt: r.archivedAt!.toISOString(),
          }))}
          canEdit={ctx.role !== "viewer"}
        />
      )}
    </div>
  );
}
