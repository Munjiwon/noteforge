import { notFound } from "next/navigation";
import { prisma } from "db";
import { PublicPageView } from "@/components/public-page-view";
import { PublicDatabaseView } from "@/components/public-database-view";
import { parseSchema, parseValues } from "@/lib/database";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { token: string };
}) {
  const p = await prisma.page.findFirst({
    where: { publicSlug: params.token, publicAccess: "view", deletedAt: null },
    select: { title: true, icon: true, content: true },
  });
  if (!p) return { title: "Shared page" };
  const title = (p.title || "Untitled").slice(0, 80);
  let description = "";
  try {
    const blocks = JSON.parse(p.content) as unknown;
    if (Array.isArray(blocks)) {
      const parts: string[] = [];
      const walk = (b: unknown) => {
        if (!b || typeof b !== "object") return;
        const n = b as { content?: unknown; children?: unknown };
        if (Array.isArray(n.content)) {
          for (const it of n.content) {
            if (
              it &&
              typeof it === "object" &&
              "text" in it &&
              typeof (it as { text: unknown }).text === "string"
            ) {
              parts.push((it as { text: string }).text);
            }
          }
        }
        if (Array.isArray(n.children)) for (const c of n.children) walk(c);
      };
      for (const b of blocks) walk(b);
      description = parts.join(" ").slice(0, 200).trim();
    }
  } catch {}
  const iconSvg = p.icon
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="56">${p.icon}</text></svg>`
    : null;
  const iconHref = iconSvg
    ? `data:image/svg+xml;utf8,${encodeURIComponent(iconSvg)}`
    : null;
  return {
    title: p.icon ? `${p.icon} ${title}` : title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
    },
    ...(iconHref
      ? { icons: { icon: [{ url: iconHref, type: "image/svg+xml" }] } }
      : {}),
  };
}

export default async function PublicSharedPage({
  params,
}: {
  params: { token: string };
}) {
  const page = await prisma.page.findFirst({
    where: { publicSlug: params.token, publicAccess: "view", deletedAt: null },
    select: {
      id: true,
      kind: true,
      title: true,
      icon: true,
      cover: true,
      content: true,
      dbSchema: true,
    },
  });
  if (!page) notFound();

  // fire-and-forget public view count
  prisma.page
    .update({
      where: { id: page.id },
      data: { publicViewCount: { increment: 1 } },
    })
    .catch(() => {});

  if (page.kind === "database") {
    const rows = await prisma.page.findMany({
      where: { parentId: page.id, deletedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, cover: true, dataValues: true },
    });
    return (
      <PublicDatabaseView
        title={page.title}
        icon={page.icon}
        cover={page.cover}
        schema={parseSchema(page.dbSchema)}
        rows={rows.map((r) => ({
          id: r.id,
          title: r.title,
          cover: r.cover,
          dataValues: parseValues(r.dataValues),
        }))}
      />
    );
  }

  return (
    <PublicPageView
      title={page.title}
      icon={page.icon}
      cover={page.cover}
      content={page.content}
    />
  );
}
