import { notFound, redirect } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";

export default async function CustomSlugRoute({
  params,
}: {
  params: { slug: string; customSlug: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const page = await prisma.page.findFirst({
    where: {
      workspaceId: ctx.workspace.id,
      slug: params.customSlug,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!page) notFound();
  redirect(`/w/${params.slug}/p/${page.id}`);
}
