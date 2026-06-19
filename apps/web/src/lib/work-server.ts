import { prisma } from "db";
import { requireWorkspaceMember } from "./workspace";

// Resolve a work project by its key within a workspace, enforcing membership.
// Returns the auth context plus the project row. Throws "not found" when the
// project does not exist in the workspace.
export async function requireWorkProject(slug: string, key: string) {
  const ctx = await requireWorkspaceMember(slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key },
  });
  if (!project) throw new Error("project not found");
  return { ctx, project };
}

export async function assertWorkEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

// Load the project's metadata used to populate issue editors and pickers:
// statuses, issue types, sprints, epics, components, versions, and labels.
export async function loadProjectMeta(projectId: string, workspaceId: string) {
  const [statuses, types, sprints, epics, components, versions, labels] =
    await Promise.all([
      prisma.workflowStatus.findMany({
        where: { projectId },
        orderBy: { position: "asc" },
      }),
      prisma.issueType.findMany({
        where: { projectId },
        orderBy: { position: "asc" },
      }),
      prisma.sprint.findMany({
        where: { projectId, state: { not: "completed" } },
        orderBy: { sequence: "asc" },
      }),
      prisma.issue.findMany({
        where: { projectId, type: { level: "epic" } },
        select: { id: true, number: true, summary: true },
      }),
      prisma.workComponent.findMany({ where: { projectId }, orderBy: { name: "asc" } }),
      prisma.workVersion.findMany({
        where: { projectId, archived: false },
        orderBy: { position: "asc" },
      }),
      prisma.workLabel.findMany({
        where: { workspaceId },
        orderBy: { name: "asc" },
      }),
    ]);
  return { statuses, types, sprints, epics, components, versions, labels };
}

// Validate that issue-reference fields point at rows in the SAME project (for
// sprint/type/epic/parent) or workspace (for assignee). Only truthy values are
// checked, so clearing a field (empty/null) is always allowed. Throws on any
// cross-project/cross-workspace reference — the guard against IDOR via
// client-supplied ids in createIssue/setIssueField.
export async function validateIssueRefs(opts: {
  workspaceId: string;
  projectId: string;
  selfIssueId?: string;
  assigneeId?: string | null;
  typeId?: string | null;
  sprintId?: string | null;
  epicId?: string | null;
  parentId?: string | null;
}): Promise<void> {
  const { workspaceId, projectId } = opts;
  const checks: Promise<void>[] = [];
  if (opts.assigneeId) {
    checks.push(
      prisma.workspaceMember
        .findFirst({ where: { workspaceId, userId: opts.assigneeId }, select: { id: true } })
        .then((m) => {
          if (!m) throw new Error("assignee is not a member of this workspace");
        }),
    );
  }
  if (opts.typeId) {
    checks.push(
      prisma.issueType
        .findFirst({ where: { id: opts.typeId, projectId }, select: { id: true } })
        .then((t) => {
          if (!t) throw new Error("issue type does not belong to this project");
        }),
    );
  }
  if (opts.sprintId) {
    checks.push(
      prisma.sprint
        .findFirst({ where: { id: opts.sprintId, projectId }, select: { id: true } })
        .then((s) => {
          if (!s) throw new Error("sprint does not belong to this project");
        }),
    );
  }
  for (const [kind, id] of [
    ["epic", opts.epicId],
    ["parent", opts.parentId],
  ] as const) {
    if (id) {
      checks.push(
        (async () => {
          if (id === opts.selfIssueId) throw new Error(`cannot set ${kind} to the issue itself`);
          const i = await prisma.issue.findFirst({ where: { id, projectId }, select: { id: true } });
          if (!i) throw new Error(`${kind} issue does not belong to this project`);
        })(),
      );
    }
  }
  await Promise.all(checks);
}

// Load the members of a workspace for assignee/reporter pickers.
export async function workspaceMemberOptions(workspaceId: string) {
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, color: true, avatarUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    color: m.user.color,
    avatarUrl: m.user.avatarUrl,
  }));
}
