import { notFound } from "next/navigation";
import { prisma } from "db";
import { PublicPageView } from "@/components/public-page-view";
import { PublicDatabaseView } from "@/components/public-database-view";
import { parseSchema, parseValues } from "@/lib/database";

export const dynamic = "force-dynamic";

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
