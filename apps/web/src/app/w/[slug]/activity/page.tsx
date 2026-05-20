import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { ActivityFilterUser } from "./filter-user";

export const dynamic = "force-dynamic";

const ACTION_LABEL: Record<string, string> = {
  created: "created",
  renamed: "renamed",
  deleted: "moved to trash",
  restored: "restored",
  shared: "enabled sharing",
  unshared: "stopped sharing",
  snapshot: "saved a snapshot",
};

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { user?: string; action?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const userFilter = searchParams.user;
  const actionFilter = searchParams.action;
  // fetch latest 200 activities scoped to the workspace
  const activities = await prisma.pageActivity.findMany({
    where: {
      page: { workspaceId: ctx.workspace.id },
      ...(userFilter ? { userId: userFilter } : {}),
      ...(actionFilter ? { action: actionFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      page: { select: { id: true, title: true, icon: true, kind: true } },
    },
  });
  // For the filter UI, fetch all distinct authors across recent activity.
  const allUsers = await prisma.user.findMany({
    where: {
      memberships: { some: { workspaceId: ctx.workspace.id } },
    },
    select: { id: true, name: true, color: true },
    orderBy: { name: "asc" },
  });
  const userIds = Array.from(
    new Set(activities.map((a) => a.userId).filter((id): id is string => !!id)),
  );
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, color: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  // group by day
  const byDay = new Map<string, typeof activities>();
  for (const a of activities) {
    const day = a.createdAt.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(a);
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <h1 className="text-2xl font-bold mb-3">Activity</h1>
      <div className="flex flex-wrap items-center gap-2 mb-5 text-xs">
        <span className="text-gray-500">Filter:</span>
        <Link
          href={`/w/${params.slug}/activity`}
          className={
            "px-2 py-0.5 rounded " +
            (!userFilter && !actionFilter
              ? "bg-gray-900 text-white"
              : "hover:bg-black/5 text-gray-500")
          }
        >
          All
        </Link>
        <ActivityFilterUser
          slug={params.slug}
          users={allUsers}
          current={userFilter ?? ""}
        />
        {Object.entries(ACTION_LABEL).map(([k, label]) => (
          <Link
            key={k}
            href={`/w/${params.slug}/activity?action=${k}${userFilter ? `&user=${userFilter}` : ""}`}
            className={
              "px-2 py-0.5 rounded " +
              (actionFilter === k
                ? "bg-gray-900 text-white"
                : "hover:bg-black/5 text-gray-500")
            }
          >
            {label}
          </Link>
        ))}
      </div>
      {activities.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-10">
          No activity in this workspace yet.
        </p>
      ) : (
        Array.from(byDay.entries()).map(([day, items]) => (
          <section key={day} className="mb-8">
            <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
              {prettyDay(day)}
            </h2>
            <ul className="border border-gray-200 rounded divide-y divide-gray-100">
              {items.map((a) => {
                const u = a.userId ? userMap.get(a.userId) : null;
                return (
                  <li key={a.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                    {u ? (
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-[10px] font-medium shrink-0"
                        style={{ background: u.color }}
                      >
                        {u.name.slice(0, 1).toUpperCase()}
                      </span>
                    ) : (
                      <span className="w-6" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-gray-800">
                        <span className="font-medium">{u?.name ?? "Someone"}</span>{" "}
                        {ACTION_LABEL[a.action] ?? a.action}{" "}
                        <Link
                          href={`/w/${params.slug}/p/${a.page.id}`}
                          className="text-blue-600 hover:underline"
                        >
                          {a.page.icon ?? (a.page.kind === "database" ? "📊" : "📄")}{" "}
                          {a.page.title || "Untitled"}
                        </Link>
                      </div>
                      <div className="text-[11px] text-gray-400 mt-0.5">
                        {new Date(a.createdAt).toLocaleTimeString()}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function prettyDay(iso: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (iso === today) return "Today";
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (iso === yest.toISOString().slice(0, 10)) return "Yesterday";
  return new Date(iso).toLocaleDateString();
}
