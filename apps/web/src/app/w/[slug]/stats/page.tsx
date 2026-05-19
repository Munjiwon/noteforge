import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";

const DAYS = 30;

function dayKey(d: Date): string {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

export default async function StatsPage({
  params,
}: {
  params: { slug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (DAYS - 1));

  const [pages, comments, activities] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        deletedAt: null,
        isTemplate: false,
        createdAt: { gte: start },
      },
      select: { createdAt: true },
    }),
    prisma.comment.findMany({
      where: {
        page: { workspaceId: ctx.workspace.id },
        createdAt: { gte: start },
      },
      select: { createdAt: true },
    }),
    prisma.pageActivity.findMany({
      where: {
        page: { workspaceId: ctx.workspace.id },
        createdAt: { gte: start },
      },
      select: { createdAt: true, action: true },
    }),
  ]);

  // Pre-fill day buckets
  const days: { key: string; date: Date; pages: number; comments: number; edits: number }[] = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push({ key: dayKey(d), date: d, pages: 0, comments: 0, edits: 0 });
  }
  const byKey = new Map(days.map((d) => [d.key, d]));
  for (const p of pages) {
    const k = dayKey(new Date(p.createdAt));
    const b = byKey.get(k);
    if (b) b.pages += 1;
  }
  for (const c of comments) {
    const k = dayKey(new Date(c.createdAt));
    const b = byKey.get(k);
    if (b) b.comments += 1;
  }
  for (const a of activities) {
    const k = dayKey(new Date(a.createdAt));
    const b = byKey.get(k);
    if (b) b.edits += 1;
  }
  const max = Math.max(
    1,
    ...days.map((d) => d.pages + d.comments + d.edits),
  );

  const totalPages = pages.length;
  const totalComments = comments.length;
  const totalEdits = activities.length;

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">📊 Stats</h1>
          <p className="text-sm text-gray-500">Activity over the last {DAYS} days.</p>
        </div>
        <Link
          href={`/w/${params.slug}`}
          className="text-xs text-gray-500 hover:text-gray-900"
        >
          ← Back
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6 text-center text-xs text-gray-500">
        <div className="border border-gray-200 rounded p-3">
          <div className="text-2xl font-semibold text-gray-900">{totalPages}</div>
          New pages
        </div>
        <div className="border border-gray-200 rounded p-3">
          <div className="text-2xl font-semibold text-gray-900">{totalEdits}</div>
          Edits
        </div>
        <div className="border border-gray-200 rounded p-3">
          <div className="text-2xl font-semibold text-gray-900">{totalComments}</div>
          Comments
        </div>
      </div>

      <div className="border border-gray-200 rounded p-4">
        <div className="flex items-end gap-1 h-48">
          {days.map((d) => {
            const totalH = ((d.pages + d.comments + d.edits) / max) * 100;
            const pagePct = totalH === 0 ? 0 : (d.pages / (d.pages + d.comments + d.edits)) * totalH;
            const editPct = totalH === 0 ? 0 : (d.edits / (d.pages + d.comments + d.edits)) * totalH;
            const commentPct = totalH === 0 ? 0 : (d.comments / (d.pages + d.comments + d.edits)) * totalH;
            return (
              <div
                key={d.key}
                className="flex-1 flex flex-col-reverse"
                title={`${d.date.toLocaleDateString()} · ${d.pages} pages, ${d.edits} edits, ${d.comments} comments`}
              >
                {pagePct > 0 && (
                  <div
                    className="bg-blue-500"
                    style={{ height: `${pagePct}%` }}
                  />
                )}
                {editPct > 0 && (
                  <div
                    className="bg-emerald-500"
                    style={{ height: `${editPct}%` }}
                  />
                )}
                {commentPct > 0 && (
                  <div
                    className="bg-amber-500"
                    style={{ height: `${commentPct}%` }}
                  />
                )}
                {totalH === 0 && <div className="h-px bg-gray-200" />}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between text-[10px] text-gray-400 mt-2">
          <span>{days[0].date.toLocaleDateString()}</span>
          <span>{days[days.length - 1].date.toLocaleDateString()}</span>
        </div>
        <div className="flex gap-4 text-[11px] text-gray-500 mt-3">
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 bg-blue-500 inline-block" /> New pages
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 bg-emerald-500 inline-block" /> Edits
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 bg-amber-500 inline-block" /> Comments
          </span>
        </div>
      </div>
    </div>
  );
}
