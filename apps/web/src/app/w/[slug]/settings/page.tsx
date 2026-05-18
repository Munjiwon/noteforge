import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
}: {
  params: { slug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const [tokens, currentUserRow] = await Promise.all([
    prisma.apiToken.findMany({
      where: { userId: ctx.user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, lastUsedAt: true, createdAt: true },
    }),
    prisma.user.findUnique({
      where: { id: ctx.user.id },
      select: { id: true, name: true, color: true, avatarUrl: true },
    }),
  ]);
  const [members, invites, pageCount, commentCount, lastActivity] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: ctx.workspace.id },
      include: { user: { select: { id: true, name: true, email: true, color: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invite.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
    }),
    prisma.page.count({
      where: { workspaceId: ctx.workspace.id, deletedAt: null },
    }),
    prisma.comment.count({
      where: { page: { workspaceId: ctx.workspace.id } },
    }),
    prisma.pageActivity.findFirst({
      where: { page: { workspaceId: ctx.workspace.id } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return (
    <SettingsClient
      slug={params.slug}
      workspaceName={ctx.workspace.name}
      workspaceIcon={ctx.workspace.icon}
      workspaceColor={ctx.workspace.color}
      workspaceDefaultFont={
        (ctx.workspace.defaultFont === "serif" ||
        ctx.workspace.defaultFont === "mono"
          ? ctx.workspace.defaultFont
          : "default") as "default" | "serif" | "mono"
      }
      workspaceBannerUrl={ctx.workspace.bannerUrl ?? null}
      currentUserId={ctx.user.id}
      role={ctx.role as "owner" | "editor" | "viewer"}
      members={members.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        color: m.user.color,
        role: m.role as "owner" | "editor" | "viewer",
        lastActiveAt: m.lastActiveAt ? m.lastActiveAt.toISOString() : null,
      }))}
      invites={invites.map((i) => ({
        token: i.token,
        role: i.role,
        createdAt: i.createdAt.toISOString(),
      }))}
      stats={{
        pageCount,
        commentCount,
        lastActivityAt: lastActivity?.createdAt.toISOString() ?? null,
      }}
      tokens={tokens.map((t) => ({
        id: t.id,
        name: t.name,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      }))}
      profile={
        currentUserRow
          ? {
              name: currentUserRow.name,
              color: currentUserRow.color,
              avatarUrl: currentUserRow.avatarUrl,
            }
          : null
      }
    />
  );
}
