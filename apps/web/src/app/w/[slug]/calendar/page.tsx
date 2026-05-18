import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { parseSchema } from "@/lib/database";

type Item = {
  date: Date;
  pageId: string;
  title: string;
  icon: string | null;
  kind: "row" | "reminder";
  dbTitle?: string;
  note?: string;
};

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfGrid(d: Date): Date {
  const first = startOfMonth(d);
  // Notion-like: Sunday-first grid
  first.setDate(1 - first.getDay());
  first.setHours(0, 0, 0, 0);
  return first;
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtMonth(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function parseMonth(q: string | undefined): Date {
  if (q && /^\d{4}-\d{2}$/.test(q)) {
    const [y, m] = q.split("-").map(Number);
    return new Date(y, m - 1, 1);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export default async function WorkspaceCalendar({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { m?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const cursor = parseMonth(searchParams.m);
  const gridStart = startOfGrid(cursor);
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  const [databases, reminders] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        kind: "database",
        deletedAt: null,
      },
      select: { id: true, title: true, dbSchema: true },
    }),
    prisma.reminder.findMany({
      where: {
        userId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        dueAt: { gte: gridStart, lt: gridEnd },
      },
      include: { page: { select: { id: true, title: true, icon: true } } },
    }),
  ]);

  const items: Item[] = [];
  for (const db of databases) {
    const schema = parseSchema(db.dbSchema);
    const dateProps = schema.props.filter((p) => p.type === "date");
    if (dateProps.length === 0) continue;
    const rows = await prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        parentId: db.id,
        deletedAt: null,
        isTemplate: false,
      },
      select: { id: true, title: true, icon: true, dataValues: true },
      take: 500,
    });
    for (const r of rows) {
      let vals: Record<string, unknown> = {};
      try {
        vals = JSON.parse(r.dataValues ?? "{}");
      } catch {}
      for (const p of dateProps) {
        const raw = vals[p.id];
        if (!raw || typeof raw !== "string") continue;
        const dt = new Date(raw);
        if (Number.isNaN(dt.getTime())) continue;
        if (dt >= gridStart && dt < gridEnd) {
          items.push({
            date: dt,
            pageId: r.id,
            title: r.title || "Untitled",
            icon: r.icon,
            kind: "row",
            dbTitle: db.title,
          });
        }
      }
    }
  }
  for (const r of reminders) {
    items.push({
      date: r.dueAt,
      pageId: r.page.id,
      title: r.page.title || "Untitled",
      icon: r.page.icon,
      kind: "reminder",
      note: r.note ?? undefined,
    });
  }
  items.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Bucket items by yyyy-mm-dd
  const byDay = new Map<string, Item[]>();
  for (const it of items) {
    const k =
      it.date.getFullYear() +
      "-" +
      String(it.date.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(it.date.getDate()).padStart(2, "0");
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(it);
  }

  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }
  const prevMonth = new Date(cursor);
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  const nextMonth = new Date(cursor);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const today = new Date();

  const monthIso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">📅 Calendar</h1>
          <p className="text-sm text-gray-500">
            All database dates and your reminders in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/w/${params.slug}/calendar?m=${monthIso(prevMonth)}`}
            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
          >
            ←
          </Link>
          <span className="text-sm font-medium min-w-[140px] text-center">
            {fmtMonth(cursor)}
          </span>
          <Link
            href={`/w/${params.slug}/calendar?m=${monthIso(nextMonth)}`}
            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
          >
            →
          </Link>
          {searchParams.m && (
            <Link
              href={`/w/${params.slug}/calendar`}
              className="text-xs text-gray-500 hover:text-gray-900 ml-1"
            >
              Today
            </Link>
          )}
        </div>
      </div>
      <div className="grid grid-cols-7 text-[11px] uppercase text-gray-500 mb-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="px-2 py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-gray-100 border border-gray-100">
        {cells.map((d) => {
          const inMonth = d.getMonth() === cursor.getMonth();
          const isToday = sameDay(d, today);
          const k =
            d.getFullYear() +
            "-" +
            String(d.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(d.getDate()).padStart(2, "0");
          const dayItems = byDay.get(k) ?? [];
          return (
            <div
              key={k}
              className={
                "bg-white min-h-[110px] p-1.5 flex flex-col gap-0.5 " +
                (inMonth ? "" : "opacity-50 bg-gray-50")
              }
            >
              <div className="flex items-center justify-between">
                <span
                  className={
                    "text-[11px] " +
                    (isToday
                      ? "bg-gray-900 text-white rounded-full w-5 h-5 inline-flex items-center justify-center"
                      : "text-gray-500")
                  }
                >
                  {d.getDate()}
                </span>
              </div>
              {dayItems.slice(0, 4).map((it, i) => (
                <Link
                  key={i}
                  href={`/w/${params.slug}/p/${it.pageId}`}
                  className={
                    "block text-[11px] truncate px-1.5 py-0.5 rounded " +
                    (it.kind === "reminder"
                      ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                      : "bg-blue-50 text-blue-700 hover:bg-blue-100")
                  }
                  title={
                    it.kind === "reminder"
                      ? `Reminder: ${it.note ?? it.title}`
                      : `${it.dbTitle ?? ""}: ${it.title}`
                  }
                >
                  {it.kind === "reminder" ? "⏰ " : it.icon ? `${it.icon} ` : ""}
                  {it.title}
                </Link>
              ))}
              {dayItems.length > 4 && (
                <span className="text-[10px] text-gray-400 px-1.5">
                  +{dayItems.length - 4} more
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
