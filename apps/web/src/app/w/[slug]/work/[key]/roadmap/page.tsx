import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { issueKey } from "@/lib/work";

export const dynamic = "force-dynamic";

const DAY = 86400000;

export default async function RoadmapPage({
  params,
}: {
  params: { slug: string; key: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, key: true },
  });
  if (!project) notFound();

  const epics = await prisma.issue.findMany({
    where: { projectId: project.id, type: { level: "epic" } },
    orderBy: { rank: "asc" },
    include: {
      status: { select: { category: true } },
      epicChildren: {
        select: { dueDate: true, createdAt: true, status: { select: { category: true } } },
      },
    },
  });

  type Bar = {
    id: string;
    number: number;
    summary: string;
    start: number;
    end: number;
    total: number;
    done: number;
    scheduled: boolean;
  };
  const bars: Bar[] = epics.map((e) => {
    const childDates = e.epicChildren.flatMap((c) => [
      c.createdAt.getTime(),
      ...(c.dueDate ? [c.dueDate.getTime()] : []),
    ]);
    const start = Math.min(e.createdAt.getTime(), ...(childDates.length ? childDates : [e.createdAt.getTime()]));
    const endCandidates = [
      ...(e.dueDate ? [e.dueDate.getTime()] : []),
      ...e.epicChildren.filter((c) => c.dueDate).map((c) => c.dueDate!.getTime()),
    ];
    const end = endCandidates.length ? Math.max(...endCandidates) : start + 14 * DAY;
    const total = e.epicChildren.length;
    const done = e.epicChildren.filter((c) => c.status.category === "done").length;
    return {
      id: e.id,
      number: e.number,
      summary: e.summary,
      start,
      end: Math.max(end, start + DAY),
      total,
      done,
      scheduled: endCandidates.length > 0 || total > 0,
    };
  });

  // Timeline range: snap to month boundaries spanning all bars (or a default
  // window around today when there are none).
  const now = Date.now();
  const minStart = bars.length ? Math.min(...bars.map((b) => b.start)) : now - 30 * DAY;
  const maxEnd = bars.length ? Math.max(...bars.map((b) => b.end)) : now + 90 * DAY;
  const rangeStart = new Date(minStart);
  rangeStart.setDate(1);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(maxEnd);
  rangeEnd.setMonth(rangeEnd.getMonth() + 1, 1);
  const span = rangeEnd.getTime() - rangeStart.getTime();

  // Month column headers.
  const months: { label: string; leftPct: number }[] = [];
  const cur = new Date(rangeStart);
  while (cur < rangeEnd) {
    months.push({
      label: cur.toLocaleString("en", { month: "short", year: "2-digit" }),
      leftPct: ((cur.getTime() - rangeStart.getTime()) / span) * 100,
    });
    cur.setMonth(cur.getMonth() + 1);
  }
  const pct = (t: number) => ((t - rangeStart.getTime()) / span) * 100;
  const todayPct = pct(now);

  return (
    <div className="px-6 py-5">
      <h2 className="mb-4 text-lg font-semibold">Roadmap</h2>
      {epics.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          No epics yet. Create an issue of type <b>Epic</b> to plan a roadmap.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            {/* Month header */}
            <div className="relative ml-64 h-6 border-b border-gray-200">
              {months.map((m, i) => (
                <div
                  key={i}
                  className="absolute top-0 text-[11px] text-gray-400"
                  style={{ left: `${m.leftPct}%` }}
                >
                  {m.label}
                </div>
              ))}
            </div>
            {/* Rows */}
            <div className="relative">
              {bars.map((b) => {
                const left = Math.max(0, pct(b.start));
                const width = Math.max(1.5, pct(b.end) - pct(b.start));
                const progress = b.total ? Math.round((b.done / b.total) * 100) : 0;
                return (
                  <div key={b.id} className="flex items-center border-b border-gray-100 py-1.5">
                    <div className="w-64 shrink-0 truncate pr-3 text-sm">
                      <Link
                        href={`/w/${params.slug}/work/${project.key}/issue/${b.number}`}
                        className="hover:underline"
                      >
                        <span className="font-mono text-xs text-gray-400">
                          {issueKey(project.key, b.number)}
                        </span>{" "}
                        {b.summary || "Untitled epic"}
                      </Link>
                    </div>
                    <div className="relative h-6 flex-1">
                      {todayPct >= 0 && todayPct <= 100 && (
                        <div
                          className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-red-400"
                          style={{ left: `${todayPct}%` }}
                        />
                      )}
                      <div
                        className="absolute top-0.5 h-5 overflow-hidden rounded bg-purple-200"
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${b.done}/${b.total} done`}
                      >
                        <div className="h-full bg-purple-500" style={{ width: `${progress}%` }} />
                        <span className="absolute inset-0 flex items-center px-1.5 text-[10px] text-purple-900">
                          {b.total > 0 ? `${progress}%` : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
