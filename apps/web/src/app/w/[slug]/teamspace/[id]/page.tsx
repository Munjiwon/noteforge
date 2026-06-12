import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { TeamspaceHomeClient } from "./teamspace-home-client";
import { JoinTeamspaceButton } from "./join-button";

export const dynamic = "force-dynamic";

export default async function TeamspaceHomePage({
  params,
}: {
  params: { slug: string; id: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const ts = await prisma.teamspace.findFirst({
    where: { id: params.id, workspaceId: ctx.workspace.id },
    include: {
      members: { select: { userId: true, role: true } },
      pages: {
        where: { deletedAt: null, archivedAt: null, isTemplate: false },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          icon: true,
          kind: true,
          updatedAt: true,
          authorId: true,
        },
      },
    },
  });
  if (!ts) notFound();
  if (ts.access === "private" && !ts.members.some((m) => m.userId === ctx.user.id) && ctx.role !== "owner") {
    notFound();
  }
  const workspaceMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId: ctx.workspace.id },
    include: { user: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
  const memberIdSet = new Set(ts.members.map((m) => m.userId));
  const isMember = memberIdSet.has(ctx.user.id);
  const memberRoleById = new Map(ts.members.map((m) => [m.userId, m.role]));
  const userById = new Map(
    workspaceMembers.map((m) => [m.user.id, { name: m.user.name, color: m.user.color, avatarUrl: m.user.avatarUrl, email: m.user.email }]),
  );
  return (
    <div className="max-w-5xl mx-auto py-10 px-6">
      <Link
        href={`/w/${params.slug}`}
        className="text-xs text-gray-500 hover:text-gray-900 inline-block mb-4"
      >
        ← Back to workspace
      </Link>
      <div className="flex items-start gap-4 mb-6">
        <div className="text-5xl leading-none">{ts.icon ?? "👥"}</div>
        <div className="flex-1">
          <h1 className="text-3xl font-bold mb-1">{ts.name}</h1>
          {ts.description && (
            <p className="text-sm text-gray-600">{ts.description}</p>
          )}
          <div className="text-xs text-gray-500 mt-2">
            <span className="inline-block mr-3">
              {ts.access === "private" ? "🔒 Private" : ts.access === "closed" ? "🔐 Closed" : "🌐 Open"}
            </span>
            <span>{ts.members.length} member{ts.members.length === 1 ? "" : "s"}</span>
            <span className="mx-1">·</span>
            <span>{ts.pages.length} page{ts.pages.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        {!isMember && ts.access === "open" && (
          <JoinTeamspaceButton slug={params.slug} teamspaceId={ts.id} />
        )}
      </div>
      <TeamspaceHomeClient
        slug={params.slug}
        teamspace={{
          id: ts.id,
          name: ts.name,
          description: ts.description ?? "",
          access: ts.access as "open" | "closed" | "private",
        }}
        currentUserId={ctx.user.id}
        canEdit={ctx.role !== "viewer"}
        workspaceMembers={workspaceMembers.map((m) => ({
          id: m.user.id,
          name: m.user.name,
          email: m.user.email,
          color: m.user.color,
          avatarUrl: m.user.avatarUrl,
          role: m.role,
        }))}
        memberIds={Array.from(memberIdSet)}
        memberRoles={Array.from(memberRoleById.entries()).reduce<Record<string, string>>(
          (acc, [k, v]) => {
            acc[k] = v;
            return acc;
          },
          {},
        )}
      />
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Pages</h2>
        {ts.pages.length === 0 ? (
          <p className="text-xs text-gray-400">No pages yet. Use the + on the sidebar header to create one.</p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ts.pages.map((p) => {
              const author = p.authorId ? userById.get(p.authorId) : null;
              return (
                <li key={p.id}>
                  <Link
                    href={`/w/${params.slug}/p/${p.id}`}
                    className="block border border-gray-200 rounded p-3 hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span>{p.icon ?? (p.kind === "database" ? "📊" : "📄")}</span>
                      <span className="font-medium text-gray-900 truncate">
                        {p.title || "Untitled"}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      {author?.name ?? "Unknown"} · {new Date(p.updatedAt).toLocaleDateString()}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
