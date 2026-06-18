import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { workspaceMemberOptions } from "@/lib/work-server";
import { prisma } from "db";
import { ProjectSettings } from "@/components/work/project-settings";

export const dynamic = "force-dynamic";

export default async function ProjectSettingsPage({
  params,
}: {
  params: { slug: string; key: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, name: true, description: true, leadId: true },
  });
  if (!project) notFound();

  const [members, components, statuses, labels] = await Promise.all([
    workspaceMemberOptions(ctx.workspace.id),
    prisma.workComponent.findMany({
      where: { projectId: project.id },
      orderBy: { name: "asc" },
      include: { lead: { select: { name: true } } },
    }),
    prisma.workflowStatus.findMany({
      where: { projectId: project.id },
      orderBy: { position: "asc" },
    }),
    prisma.workLabel.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        issues: { some: { issue: { projectId: project.id } } },
      },
      include: {
        _count: { select: { issues: { where: { issue: { projectId: project.id } } } } },
      },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <ProjectSettings
      slug={params.slug}
      canEdit={ctx.role !== "viewer"}
      project={project}
      members={members.map((m) => ({ id: m.id, name: m.name }))}
      components={components.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        leadName: c.lead?.name ?? null,
      }))}
      statuses={statuses.map((s) => ({ id: s.id, name: s.name, category: s.category }))}
      labels={labels.map((l) => ({ name: l.name, color: l.color, count: l._count.issues }))}
    />
  );
}
