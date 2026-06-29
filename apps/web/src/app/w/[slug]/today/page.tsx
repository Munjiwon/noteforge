import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { parseSchema } from "@/lib/database";
import { priorityMeta } from "@/lib/work";

function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export default async function TodayPage({
  params,
}: {
  params: { slug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const today = startOfDay();
  const tomorrow = endOfDay();

  const [databases, edited, comments, mentions, myDueIssues] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        kind: "database",
        deletedAt: null,
      },
      select: { id: true, title: true, icon: true, dbSchema: true },
    }),
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        deletedAt: null,
        isTemplate: false,
        updatedAt: { gte: today },
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        icon: true,
        kind: true,
        updatedAt: true,
        author: { select: { name: true, color: true } },
      },
    }),
    prisma.comment.findMany({
      where: {
        page: { workspaceId: ctx.workspace.id, deletedAt: null },
        createdAt: { gte: today },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        page: { select: { id: true, title: true, icon: true } },
        author: { select: { name: true, color: true } },
      },
    }),
    prisma.notification.findMany({
      where: {
        recipientId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        kind: "mention",
        createdAt: { gte: today },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        actor: { select: { name: true, color: true } },
      },
    }),
    prisma.issue.findMany({
      where: {
        assigneeId: ctx.user.id,
        project: { workspaceId: ctx.workspace.id, archivedAt: null },
        status: { category: { not: "done" } },
        dueDate: { not: null, lte: tomorrow },
      },
      orderBy: { dueDate: "asc" },
      take: 30,
      select: {
        number: true,
        summary: true,
        dueDate: true,
        priority: true,
        project: { select: { key: true } },
        type: { select: { icon: true } },
        status: { select: { name: true } },
      },
    }),
  ]);

  // Compute rows whose date property equals today.
  type DueRow = {
    id: string;
    title: string;
    icon: string | null;
    dbId: string;
    dbTitle: string;
    propName: string;
    date: Date;
  };
  const due: DueRow[] = [];
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
      take: 200,
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
        if (sameDay(dt, new Date())) {
          due.push({
            id: r.id,
            title: r.title,
            icon: r.icon,
            dbId: db.id,
            dbTitle: db.title,
            propName: p.name,
            date: dt,
          });
        }
      }
    }
  }

  const now = new Date();
  const fmtDate = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="max-w-4xl mx-auto px-8 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">☀️ Today</h1>
          <p className="text-sm text-gray-500">{fmtDate}</p>
        </div>
        <Link
          href={`/w/${params.slug}`}
          className="text-xs text-gray-500 hover:text-gray-900"
        >
          ← Back
        </Link>
      </div>

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          My issues due
          <span className="ml-2 text-xs text-gray-400">{myDueIssues.length}</span>
        </h2>
        {myDueIssues.length === 0 ? (
          <p className="text-xs text-gray-400">No assigned issues due today or overdue.</p>
        ) : (
          <ul className="space-y-1">
            {myDueIssues.map((i) => {
              // Compare by UTC date string (consistent with the Home page).
              const overdue =
                !!i.dueDate && i.dueDate.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10);
              return (
                <li key={`${i.project.key}-${i.number}`}>
                  <Link
                    href={`/w/${params.slug}/work/${i.project.key}/issue/${i.number}`}
                    className="flex items-center gap-2 text-sm text-gray-800 hover:bg-black/5 rounded px-2 py-1"
                  >
                    <span>{i.type.icon ?? "🎫"}</span>
                    <span className="font-mono text-[11px] text-gray-400 shrink-0">
                      {i.project.key}-{i.number}
                    </span>
                    <span className="flex-1 truncate">{i.summary || "Untitled"}</span>
                    <span style={{ color: priorityMeta(i.priority).color }}>
                      {priorityMeta(i.priority).icon}
                    </span>
                    <span
                      className={`text-[11px] shrink-0 ${overdue ? "font-medium text-red-600" : "text-gray-400"}`}
                    >
                      {overdue ? "Overdue" : "Today"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Due today
          <span className="ml-2 text-xs text-gray-400">{due.length}</span>
        </h2>
        {due.length === 0 ? (
          <p className="text-xs text-gray-400">No rows in any database due today.</p>
        ) : (
          <ul className="space-y-1">
            {due.map((d) => (
              <li key={`${d.dbId}-${d.id}`}>
                <Link
                  href={`/w/${params.slug}/p/${d.id}`}
                  className="flex items-center gap-2 text-sm text-gray-800 hover:bg-black/5 rounded px-2 py-1"
                >
                  <span>{d.icon ?? "📄"}</span>
                  <span className="flex-1 truncate">{d.title || "Untitled"}</span>
                  <span className="text-[11px] text-gray-400">
                    {d.dbTitle} · {d.propName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Mentions today
          <span className="ml-2 text-xs text-gray-400">{mentions.length}</span>
        </h2>
        {mentions.length === 0 ? (
          <p className="text-xs text-gray-400">
            No one has mentioned you today.
          </p>
        ) : (
          <ul className="space-y-1">
            {mentions.map((m) => (
              <li key={m.id}>
                <Link
                  href={
                    m.pageId
                      ? `/w/${params.slug}/p/${m.pageId}${m.commentId ? `?c=${m.commentId}` : ""}`
                      : `/w/${params.slug}/inbox`
                  }
                  className="flex items-center gap-2 text-sm text-gray-800 hover:bg-black/5 rounded px-2 py-1"
                >
                  {m.actor && (
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[9px] font-medium"
                      style={{ background: m.actor.color }}
                    >
                      {m.actor.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="flex-1 truncate">{m.preview}</span>
                  <span className="text-[11px] text-gray-400">
                    {new Date(m.createdAt).toLocaleTimeString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Recently edited
          <span className="ml-2 text-xs text-gray-400">{edited.length}</span>
        </h2>
        {edited.length === 0 ? (
          <p className="text-xs text-gray-400">Nothing edited yet today.</p>
        ) : (
          <ul className="space-y-1">
            {edited.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/w/${params.slug}/p/${p.id}`}
                  className="flex items-center gap-2 text-sm text-gray-800 hover:bg-black/5 rounded px-2 py-1"
                >
                  <span>{p.icon ?? (p.kind === "database" ? "📊" : "📄")}</span>
                  <span className="flex-1 truncate">{p.title || "Untitled"}</span>
                  {p.author && (
                    <span className="text-[11px] text-gray-400">{p.author.name}</span>
                  )}
                  <span className="text-[11px] text-gray-400">
                    {new Date(p.updatedAt).toLocaleTimeString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Comments today
          <span className="ml-2 text-xs text-gray-400">{comments.length}</span>
        </h2>
        {comments.length === 0 ? (
          <p className="text-xs text-gray-400">No comments yet today.</p>
        ) : (
          <ul className="space-y-1">
            {comments.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/w/${params.slug}/p/${c.page.id}?c=${c.id}`}
                  className="flex items-start gap-2 text-sm text-gray-800 hover:bg-black/5 rounded px-2 py-1"
                >
                  {c.author && (
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[9px] font-medium mt-0.5"
                      style={{ background: c.author.color }}
                    >
                      {c.author.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{c.body}</span>
                    <span className="text-[11px] text-gray-400">
                      on {c.page.title || "Untitled"} ·{" "}
                      {new Date(c.createdAt).toLocaleTimeString()}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <span className="hidden">{tomorrow.toISOString()}</span>
    </div>
  );
}
