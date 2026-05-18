import { requireWorkspaceMember, getWorkspacesForUser } from "@/lib/workspace";
import { prisma } from "db";
import { Sidebar } from "@/components/sidebar";
import { SearchPalette } from "@/components/search-palette";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { MobileSidebarToggle } from "@/components/mobile-sidebar-toggle";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

function extractPreview(content: string): string {
  try {
    const blocks = JSON.parse(content) as unknown;
    if (!Array.isArray(blocks)) return "";
    const parts: string[] = [];
    const walk = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const node = b as { content?: unknown; children?: unknown };
      const c = node.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (it && typeof it === "object" && "text" in it && typeof (it as { text: unknown }).text === "string") {
            parts.push((it as { text: string }).text);
          }
        }
      }
      if (Array.isArray(node.children)) for (const ch of node.children) walk(ch);
    };
    for (const b of blocks) walk(b);
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    return "";
  }
}

export default async function WorkspaceLayout({
  params,
  children,
}: {
  params: { slug: string };
  children: React.ReactNode;
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  // Best-effort auto-purge: hard-delete pages that have been in the trash
  // longer than 30 days. The Page.parentId cascade takes care of descendants
  // and PageActivity/PageSnapshot/Comment/etc. rows.
  prisma.page
    .deleteMany({
      where: {
        workspaceId: ctx.workspace.id,
        deletedAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    })
    .catch(() => {});
  // Best-effort auto-expire: delete read notifications older than 30 days
  // (cheap to run as part of the normal layout fetch; runs in background).
  prisma.notification
    .deleteMany({
      where: {
        recipientId: ctx.user.id,
        read: true,
        createdAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    })
    .catch(() => {});
  const [allPages, trashedPages, workspaces, memberCount, notifRows, recentRows] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId: ctx.workspace.id, deletedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        icon: true,
        parentId: true,
        position: true,
        kind: true,
        favorite: true,
        content: true,
        isTemplate: true,
      },
    }),
    prisma.page.findMany({
      where: { workspaceId: ctx.workspace.id, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      select: { id: true, title: true, icon: true, kind: true, deletedAt: true },
    }),
    getWorkspacesForUser(ctx.user.id),
    prisma.workspaceMember.count({ where: { workspaceId: ctx.workspace.id } }),
    prisma.notification.findMany({
      where: { recipientId: ctx.user.id, workspaceId: ctx.workspace.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        actor: { select: { name: true, color: true } },
      },
    }),
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        deletedAt: null,
        parentId: null,
        OR: [
          { title: { not: "" } },
          // include recently-updated empty-title pages (within last day)
          { updatedAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, title: true, icon: true, kind: true },
    }),
  ]);

  const notifications = notifRows.map((n) => ({
    id: n.id,
    kind: n.kind,
    preview: n.preview,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
    pageId: n.pageId,
    commentId: n.commentId,
    workspaceSlug: ctx.workspace.slug,
    actor: n.actor ? { name: n.actor.name, color: n.actor.color } : null,
  }));

  // Hide database rows (children of database pages) from the sidebar tree,
  // and split off templates into their own section.
  const databaseIds = new Set(allPages.filter((p) => p.kind === "database").map((p) => p.id));
  const templateIds = new Set(allPages.filter((p) => p.isTemplate).map((p) => p.id));
  const isUnder = (pid: string | null, set: Set<string>): boolean => {
    let cur = pid;
    while (cur) {
      if (set.has(cur)) return true;
      cur = allPages.find((x) => x.id === cur)?.parentId ?? null;
    }
    return false;
  };
  const templatePages = allPages.filter((p) => p.isTemplate);
  const pages = allPages.filter(
    (p) =>
      !p.isTemplate &&
      !isUnder(p.parentId, templateIds) &&
      (!p.parentId || !databaseIds.has(p.parentId)),
  );
  const favorites = allPages
    .filter(
      (p) =>
        !p.isTemplate &&
        !isUnder(p.parentId, templateIds) &&
        p.favorite &&
        (!p.parentId || !databaseIds.has(p.parentId)),
    )
    .map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      parentId: p.parentId,
      kind: p.kind,
      favorite: p.favorite,
      preview: extractPreview(p.content),
    }));
  // count children for sidebar badges (db rows for databases, sub-pages otherwise)
  const childCount = new Map<string, number>();
  for (const p of allPages) {
    if (p.parentId) {
      childCount.set(p.parentId, (childCount.get(p.parentId) ?? 0) + 1);
    }
  }
  const pagesForSidebar = pages.map((p) => ({
    id: p.id,
    title: p.title,
    icon: p.icon,
    parentId: p.parentId,
    kind: p.kind,
    favorite: p.favorite,
    count: childCount.get(p.id) ?? 0,
    preview: extractPreview(p.content),
  }));

  return (
    <div className="flex h-screen">
      <Sidebar
        workspaces={workspaces.map((m) => ({
          slug: m.workspace.slug,
          name: m.workspace.name,
        }))}
        currentSlug={ctx.workspace.slug}
        currentName={ctx.workspace.name}
        currentIcon={ctx.workspace.icon}
        currentColor={ctx.workspace.color}
        memberCount={memberCount}
        role={ctx.role as any}
        pages={pagesForSidebar}
        favorites={favorites}
        templates={templatePages.map((p) => ({
          id: p.id,
          title: p.title,
          icon: p.icon,
          kind: p.kind,
        }))}
        trashed={trashedPages}
        notifications={notifications}
        recent={recentRows}
        trashStaleCount={trashedPages.filter((t) => t.deletedAt && Date.now() - t.deletedAt.getTime() > 30 * 24 * 3600 * 1000).length}
        user={ctx.user}
      />
      <main className="flex-1 overflow-auto bg-white">
        <MobileSidebarToggle />
        {children}
      </main>
      <SearchPalette slug={ctx.workspace.slug} />
      <ShortcutsHelp />
      <WorkspaceSwitcher
        workspaces={workspaces.map((m) => ({
          slug: m.workspace.slug,
          name: m.workspace.name,
        }))}
        currentSlug={ctx.workspace.slug}
      />
    </div>
  );
}
