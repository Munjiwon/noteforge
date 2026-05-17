import { requireWorkspaceMember, getWorkspacesForUser } from "@/lib/workspace";
import { prisma } from "db";
import { Sidebar } from "@/components/sidebar";
import { SearchPalette } from "@/components/search-palette";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { MobileSidebarToggle } from "@/components/mobile-sidebar-toggle";

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
      },
    }),
    prisma.page.findMany({
      where: { workspaceId: ctx.workspace.id, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      select: { id: true, title: true, icon: true, kind: true },
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
      where: { workspaceId: ctx.workspace.id, deletedAt: null, parentId: null },
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
    workspaceSlug: ctx.workspace.slug,
    actor: n.actor ? { name: n.actor.name, color: n.actor.color } : null,
  }));

  // Hide database rows (children of database pages) from the sidebar tree.
  const databaseIds = new Set(allPages.filter((p) => p.kind === "database").map((p) => p.id));
  const pages = allPages.filter(
    (p) => !p.parentId || !databaseIds.has(p.parentId),
  );
  const favorites = allPages
    .filter((p) => p.favorite && (!p.parentId || !databaseIds.has(p.parentId)))
    .map((p) => ({
      id: p.id,
      title: p.title,
      icon: p.icon,
      parentId: p.parentId,
      kind: p.kind,
      favorite: p.favorite,
      preview: extractPreview(p.content),
    }));
  const pagesForSidebar = pages.map((p) => ({
    id: p.id,
    title: p.title,
    icon: p.icon,
    parentId: p.parentId,
    kind: p.kind,
    favorite: p.favorite,
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
        memberCount={memberCount}
        role={ctx.role as any}
        pages={pagesForSidebar}
        favorites={favorites}
        trashed={trashedPages}
        notifications={notifications}
        recent={recentRows}
        user={ctx.user}
      />
      <main className="flex-1 overflow-auto bg-white">
        <MobileSidebarToggle />
        {children}
      </main>
      <SearchPalette slug={ctx.workspace.slug} />
      <ShortcutsHelp />
    </div>
  );
}
