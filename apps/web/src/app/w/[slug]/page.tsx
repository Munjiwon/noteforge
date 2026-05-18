import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { TemplateGalleryButton } from "@/components/template-gallery";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default async function WorkspaceHome({
  params,
}: {
  params: { slug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [recents, favorites, totals, dueCount] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        deletedAt: null,
        isTemplate: false,
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: {
        id: true,
        title: true,
        icon: true,
        kind: true,
        updatedAt: true,
      },
    }),
    prisma.page.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        favorite: true,
        deletedAt: null,
        isTemplate: false,
      },
      take: 8,
      select: { id: true, title: true, icon: true, kind: true },
    }),
    Promise.all([
      prisma.page.count({
        where: {
          workspaceId: ctx.workspace.id,
          deletedAt: null,
          isTemplate: false,
        },
      }),
      prisma.page.count({
        where: {
          workspaceId: ctx.workspace.id,
          deletedAt: null,
          kind: "database",
        },
      }),
      prisma.workspaceMember.count({
        where: { workspaceId: ctx.workspace.id },
      }),
    ]),
    prisma.notification.count({
      where: {
        recipientId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        read: false,
      },
    }),
  ]);
  const [pageTotal, dbTotal, memberTotal] = totals;

  return (
    <div>
      {ctx.workspace.bannerUrl && (
        <div
          className="w-full h-40 bg-center bg-cover"
          style={{ backgroundImage: `url("${ctx.workspace.bannerUrl}")` }}
        />
      )}
      <div className="max-w-4xl mx-auto px-8 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">
          {greeting()}, {ctx.user.name}.
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {new Date().toLocaleDateString(undefined, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </header>

      <section className="grid grid-cols-2 sm:grid-cols-7 gap-3 mb-8">
        <DashLink
          href={`/w/${params.slug}/today`}
          icon="☀️"
          label="Today"
        />
        <DashLink
          href={`/w/${params.slug}/tasks`}
          icon="✅"
          label="Tasks"
        />
        <DashLink
          href={`/w/${params.slug}/inbox`}
          icon="📬"
          label="Inbox"
          badge={dueCount}
        />
        <DashLink
          href={`/w/${params.slug}/activity`}
          icon="📜"
          label="Activity"
        />
        <DashLink
          href={`/w/${params.slug}/calendar`}
          icon="📅"
          label="Calendar"
        />
        <DashLink
          href={`/w/${params.slug}/tags`}
          icon="🏷"
          label="Tags"
        />
        <TemplateGalleryButton slug={params.slug} />
      </section>

      <section className="grid sm:grid-cols-2 gap-6 mb-8">
        <Card title="Recently edited" emptyText="No pages yet — click + in the sidebar.">
          {recents.map((p) => (
            <li key={p.id}>
              <Link
                href={`/w/${params.slug}/p/${p.id}`}
                className="flex items-center gap-2 text-sm text-gray-800 hover:bg-black/5 rounded px-2 py-1"
              >
                <span>{p.icon ?? (p.kind === "database" ? "📊" : "📄")}</span>
                <span className="flex-1 truncate">{p.title || "Untitled"}</span>
                <span className="text-[11px] text-gray-400">
                  {timeAgo(p.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </Card>
        <Card title="Favorites" emptyText="Star pages to pin them here.">
          {favorites.map((p) => (
            <li key={p.id}>
              <Link
                href={`/w/${params.slug}/p/${p.id}`}
                className="flex items-center gap-2 text-sm text-gray-800 hover:bg-black/5 rounded px-2 py-1"
              >
                <span>{p.icon ?? (p.kind === "database" ? "📊" : "📄")}</span>
                <span className="flex-1 truncate">{p.title || "Untitled"}</span>
              </Link>
            </li>
          ))}
        </Card>
      </section>

      <section className="grid grid-cols-3 gap-3 text-center text-xs text-gray-500">
        <div className="border border-gray-200 rounded p-3">
          <div className="text-xl font-semibold text-gray-900">{pageTotal}</div>
          Pages
        </div>
        <div className="border border-gray-200 rounded p-3">
          <div className="text-xl font-semibold text-gray-900">{dbTotal}</div>
          Databases
        </div>
        <div className="border border-gray-200 rounded p-3">
          <div className="text-xl font-semibold text-gray-900">{memberTotal}</div>
          Members
        </div>
      </section>
      </div>
    </div>
  );
}

function DashLink({
  href,
  icon,
  label,
  badge,
}: {
  href: string;
  icon: string;
  label: string;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="relative flex flex-col items-start gap-1 border border-gray-200 rounded-md px-3 py-3 hover:bg-black/5 hover:border-gray-300"
    >
      <span className="text-xl">{icon}</span>
      <span className="text-sm font-medium text-gray-800">{label}</span>
      {!!badge && badge > 0 && (
        <span className="absolute top-2 right-2 text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5">
          {badge}
        </span>
      )}
    </Link>
  );
}

function Card({
  title,
  children,
  emptyText,
}: {
  title: string;
  children: React.ReactNode;
  emptyText: string;
}) {
  const arr = Array.isArray(children) ? children : [children];
  const filtered = arr.filter(Boolean);
  return (
    <div className="border border-gray-200 rounded-md p-3">
      <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        {title}
      </h2>
      {filtered.length === 0 ? (
        <p className="text-xs text-gray-400">{emptyText}</p>
      ) : (
        <ul className="space-y-0.5">{filtered}</ul>
      )}
    </div>
  );
}

function timeAgo(d: Date): string {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400 / 7)}w`;
  return `${Math.floor(s / 86400 / 30)}mo`;
}
