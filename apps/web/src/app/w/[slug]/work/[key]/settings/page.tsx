import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { workspaceMemberOptions } from "@/lib/work-server";
import { prisma } from "db";
import { ProjectSettings } from "@/components/work/project-settings";
import { WorkflowEditor, type WfTransitions } from "@/components/work/workflow-editor";

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

  const [members, components, statuses, transitions, board, labels] = await Promise.all([
    workspaceMemberOptions(ctx.workspace.id),
    prisma.workComponent.findMany({
      where: { projectId: project.id },
      orderBy: { name: "asc" },
      include: { lead: { select: { name: true } } },
    }),
    prisma.workflowStatus.findMany({
      where: { projectId: project.id },
      orderBy: { position: "asc" },
      include: { _count: { select: { issues: true } } },
    }),
    prisma.workflowTransition.findMany({
      where: { projectId: project.id },
      select: { fromStatusId: true, toStatusId: true },
    }),
    prisma.board.findFirst({
      where: { projectId: project.id },
      include: { columns: { orderBy: { position: "asc" } } },
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

  // Build the per-target transition map for the editor.
  const trMap: WfTransitions = {};
  for (const s of statuses) trMap[s.id] = { any: false, from: [] };
  for (const t of transitions) {
    const cur = trMap[t.toStatusId] ?? { any: false, from: [] };
    if (t.fromStatusId === null) cur.any = true;
    else cur.from.push(t.fromStatusId);
    trMap[t.toStatusId] = cur;
  }

  const canEdit = ctx.role !== "viewer";

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-6">
      <ProjectSettings
        slug={params.slug}
        canEdit={canEdit}
        project={project}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
        components={components.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          leadName: c.lead?.name ?? null,
        }))}
        labels={labels.map((l) => ({ name: l.name, color: l.color, count: l._count.issues }))}
      />
      <WorkflowEditor
        slug={params.slug}
        projectId={project.id}
        canEdit={canEdit}
        statuses={statuses.map((s) => ({ id: s.id, name: s.name, category: s.category, issueCount: s._count.issues }))}
        transitions={trMap}
        columns={(board?.columns ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          wipLimit: c.wipLimit,
          statusIds: (() => {
            try {
              return JSON.parse(c.statusIds) as string[];
            } catch {
              return [];
            }
          })(),
        }))}
      />
    </div>
  );
}
