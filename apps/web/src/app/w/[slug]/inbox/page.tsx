import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { InboxClient } from "./inbox-client";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { filter?: string; kind?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const filter = searchParams.filter === "unread" ? "unread" : "all";
  const kind =
    searchParams.kind === "mention" ||
    searchParams.kind === "comment_reply" ||
    searchParams.kind === "comment_new"
      ? searchParams.kind
      : null;

  const rows = await prisma.notification.findMany({
    where: {
      recipientId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      ...(filter === "unread" ? { read: false } : {}),
      ...(kind ? { kind } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actor: { select: { name: true, color: true } } },
  });

  // group by pageId
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.pageId ?? "no-page";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const pageInfos = await prisma.page.findMany({
    where: { id: { in: Array.from(groups.keys()).filter((k) => k !== "no-page") } },
    select: { id: true, title: true, icon: true, kind: true },
  });
  const pageMap = new Map(pageInfos.map((p) => [p.id, p]));

  const unreadCount = await prisma.notification.count({
    where: { recipientId: ctx.user.id, workspaceId: ctx.workspace.id, read: false },
  });

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Inbox</h1>
        <div className="flex flex-wrap gap-1 text-xs">
          <Link
            href={`/w/${params.slug}/inbox?filter=all${kind ? `&kind=${kind}` : ""}`}
            className={
              "px-2 py-1 rounded " +
              (filter === "all" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
          >
            All
          </Link>
          <Link
            href={`/w/${params.slug}/inbox?filter=unread${kind ? `&kind=${kind}` : ""}`}
            className={
              "px-2 py-1 rounded " +
              (filter === "unread" ? "bg-gray-900 text-white" : "hover:bg-black/5")
            }
          >
            Unread {unreadCount > 0 && <span className="ml-1 text-[10px]">({unreadCount})</span>}
          </Link>
          <span className="w-px h-4 bg-gray-200 mx-1" />
          {([
            { k: null, label: "Any" },
            { k: "mention", label: "@mentions" },
            { k: "comment_reply", label: "Replies" },
            { k: "comment_new", label: "Comments" },
          ] as { k: string | null; label: string }[]).map((c) => {
            const href = `/w/${params.slug}/inbox?filter=${filter}${c.k ? `&kind=${c.k}` : ""}`;
            const active = c.k === kind;
            return (
              <Link
                key={c.k ?? "any"}
                href={href}
                className={
                  "px-2 py-1 rounded " +
                  (active ? "bg-gray-900 text-white" : "hover:bg-black/5")
                }
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      </div>
      <InboxClient slug={params.slug} />
      {rows.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-5xl mb-2">{filter === "unread" ? "🎉" : "📭"}</div>
          <p className="text-sm text-gray-700">
            {filter === "unread" ? "All caught up!" : "No notifications yet."}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Mentions, replies, and page updates land here.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {Array.from(groups.entries()).map(([pageId, items]) => {
            const page = pageMap.get(pageId);
            return (
              <section key={pageId}>
                <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                  {pageId === "no-page" ? (
                    <span>🎯 Issues &amp; activity</span>
                  ) : (
                    <>
                      <span>{page?.icon ?? (page?.kind === "database" ? "📊" : "📄")}</span>
                      <Link
                        href={page ? `/w/${params.slug}/p/${page.id}` : "#"}
                        className="hover:underline"
                      >
                        {page?.title || "Unknown page"}
                      </Link>
                    </>
                  )}
                </div>
                <ul className="border border-gray-200 rounded divide-y divide-gray-100">
                  {items.map((n) => {
                    const verb =
                      n.kind === "mention"
                        ? "mentioned you"
                        : n.kind === "comment_reply"
                        ? "replied to your thread"
                        : n.kind === "issue_assigned"
                        ? "assigned you an issue"
                        : n.kind === "issue_status"
                        ? "updated an issue's status"
                        : n.kind === "issue_comment"
                        ? "commented on an issue"
                        : "commented";
                    return (
                      <li
                        key={n.id}
                        className={
                          "px-3 py-2 flex items-start gap-2 " +
                          (n.read ? "" : "bg-blue-50/40")
                        }
                      >
                        {n.actor ? (
                          <span
                            className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-[10px] font-medium shrink-0"
                            style={{ background: n.actor.color }}
                          >
                            {n.actor.name.slice(0, 1).toUpperCase()}
                          </span>
                        ) : (
                          <span className="w-6" />
                        )}
                        <div className="flex-1 min-w-0 text-sm">
                          <div className="text-gray-800">
                            <span className="font-medium">{n.actor?.name ?? "Someone"}</span>{" "}
                            {verb}
                          </div>
                          {n.preview &&
                            (n.linkPath ? (
                              <Link href={n.linkPath} className="text-xs text-blue-600 hover:underline">
                                {n.preview}
                              </Link>
                            ) : (
                              <div className="text-xs text-gray-500">{n.preview}</div>
                            ))}
                          <div className="text-[10px] text-gray-400 mt-0.5">
                            {new Date(n.createdAt).toLocaleString()}
                          </div>
                        </div>
                        {!n.read && (
                          <span className="w-2 h-2 rounded-full bg-blue-500 mt-2 shrink-0" />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
