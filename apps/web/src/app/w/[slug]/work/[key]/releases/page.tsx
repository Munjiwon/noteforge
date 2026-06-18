import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { ReleasesView, type VersionRow } from "@/components/work/releases-view";

export const dynamic = "force-dynamic";

export default async function ReleasesPage({
  params,
}: {
  params: { slug: string; key: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true },
  });
  if (!project) notFound();

  const versions = await prisma.workVersion.findMany({
    where: { projectId: project.id, archived: false },
    orderBy: { position: "asc" },
    include: {
      issues: {
        include: { issue: { select: { status: { select: { category: true } } } } },
      },
    },
  });

  const rows: VersionRow[] = versions.map((v) => {
    const total = v.issues.length;
    const done = v.issues.filter((i) => i.issue.status.category === "done").length;
    return {
      id: v.id,
      name: v.name,
      description: v.description,
      releaseDate: v.releaseDate ? v.releaseDate.toISOString() : null,
      released: v.released,
      total,
      done,
    };
  });

  return (
    <ReleasesView
      slug={params.slug}
      projectId={project.id}
      versions={rows}
      readOnly={ctx.role === "viewer"}
    />
  );
}
