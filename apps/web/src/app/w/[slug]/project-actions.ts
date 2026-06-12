"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "db";
import { requireWorkspaceMember } from "@/lib/workspace";
import type { DbSchema } from "@/lib/database";

async function assertEditor(slug: string) {
  const ctx = await requireWorkspaceMember(slug);
  if (ctx.role === "viewer") throw new Error("forbidden");
  return ctx;
}

const PRIORITY_OPTIONS = [
  { id: "pr_low", name: "Low", color: "#e5e7eb" },
  { id: "pr_med", name: "Medium", color: "#fde68a" },
  { id: "pr_high", name: "High", color: "#fecaca" },
];

// Build the three interlinked schemas. Relation/rollup props reference the
// sibling database ids, so the caller must already know all three page ids.
function buildSchemas(ids: { projects: string; tasks: string; sprints: string }) {
  const projects: DbSchema = {
    props: [
      { id: "p_title", name: "Project name", type: "text" },
      {
        id: "p_status",
        name: "Status",
        type: "status",
        options: [
          { id: "st_plan", name: "Planning", color: "#e5e7eb", group: "todo" },
          { id: "st_active", name: "In progress", color: "#bfdbfe", group: "in_progress" },
          { id: "st_paused", name: "Paused", color: "#fde68a", group: "in_progress" },
          { id: "st_done", name: "Done", color: "#a7f3d0", group: "complete" },
        ],
      },
      { id: "p_owner", name: "Owner", type: "person" },
      { id: "p_priority", name: "Priority", type: "select", options: PRIORITY_OPTIONS },
      { id: "p_dates", name: "Dates", type: "date" },
      { id: "p_summary", name: "Summary", type: "text" },
      { id: "p_tasks", name: "Tasks", type: "relation", targetDbId: ids.tasks },
      {
        id: "p_taskcount",
        name: "Task count",
        type: "rollup",
        relationPropId: "p_tasks",
        targetPropId: "p_title",
        aggregate: "count",
      },
    ],
    activeViewId: "v_board",
    views: [
      { id: "v_board", name: "Board", kind: "kanban", kanbanGroupBy: "p_status" },
      { id: "v_all", name: "All projects", kind: "table" },
    ],
  };

  const tasks: DbSchema = {
    props: [
      { id: "p_title", name: "Task name", type: "text" },
      {
        id: "p_status",
        name: "Status",
        type: "status",
        options: [
          { id: "ts_todo", name: "Not started", color: "#e5e7eb", group: "todo" },
          { id: "ts_prog", name: "In progress", color: "#bfdbfe", group: "in_progress" },
          { id: "ts_review", name: "In review", color: "#ddd6fe", group: "in_progress" },
          { id: "ts_done", name: "Done", color: "#a7f3d0", group: "complete" },
        ],
      },
      { id: "p_assignee", name: "Assignee", type: "person" },
      { id: "p_priority", name: "Priority", type: "select", options: PRIORITY_OPTIONS },
      { id: "p_due", name: "Due", type: "date" },
      { id: "p_project", name: "Project", type: "relation", targetDbId: ids.projects },
      { id: "p_sprint", name: "Sprint", type: "relation", targetDbId: ids.sprints },
    ],
    activeViewId: "v_board",
    views: [
      { id: "v_board", name: "Board", kind: "kanban", kanbanGroupBy: "p_status" },
      { id: "v_all", name: "All tasks", kind: "table" },
      { id: "v_cal", name: "Calendar", kind: "calendar", calendarDateBy: "p_due" },
    ],
  };

  const sprints: DbSchema = {
    props: [
      { id: "p_title", name: "Sprint name", type: "text" },
      {
        id: "p_sprintstatus",
        name: "Status",
        type: "select",
        options: [
          { id: "sp_future", name: "Future", color: "#e5e7eb" },
          { id: "sp_current", name: "Current", color: "#bfdbfe" },
          { id: "sp_past", name: "Past", color: "#d1d5db" },
        ],
      },
      { id: "p_start", name: "Start", type: "date" },
      { id: "p_end", name: "End", type: "date" },
      { id: "p_sprinttasks", name: "Tasks", type: "relation", targetDbId: ids.tasks },
      {
        id: "p_sprinttaskcount",
        name: "Task count",
        type: "rollup",
        relationPropId: "p_sprinttasks",
        targetPropId: "p_title",
        aggregate: "count",
      },
    ],
    activeViewId: "v_all",
    views: [
      { id: "v_all", name: "All sprints", kind: "table" },
      { id: "v_board", name: "By status", kind: "kanban", kanbanGroupBy: "p_sprintstatus" },
    ],
  };

  return { projects, tasks, sprints };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Scaffold a Notion-style project-management workspace: three interlinked
 * databases (Projects, Tasks, Sprints) with relations, a task-count rollup,
 * status boards, and a seeded current sprint + sample project and tasks.
 * Created under `teamspaceId` when provided, otherwise at the workspace root.
 * Redirects to the Tasks board.
 */
export async function createProjectManagement(
  slug: string,
  teamspaceId: string | null = null,
) {
  const ctx = await assertEditor(slug);
  if (teamspaceId) {
    const ts = await prisma.teamspace.findFirst({
      where: { id: teamspaceId, workspaceId: ctx.workspace.id },
      select: { id: true },
    });
    if (!ts) throw new Error("teamspace not found");
  }

  const baseMax = await prisma.page.aggregate({
    where: { workspaceId: ctx.workspace.id, parentId: null, teamspaceId },
    _max: { position: true },
  });
  let pos = (baseMax._max.position ?? 0) + 1;

  const mkDb = async (title: string, icon: string) =>
    prisma.page.create({
      data: {
        workspaceId: ctx.workspace.id,
        teamspaceId,
        parentId: null,
        kind: "database",
        title,
        icon,
        position: pos++,
        authorId: ctx.user.id,
        dbSchema: '{"props":[{"id":"p_title","name":"Name","type":"text"}]}',
      },
      select: { id: true },
    });

  // Create the three pages first so relations can reference real ids.
  const projectsPage = await mkDb("Projects", "📁");
  const tasksPage = await mkDb("Tasks", "✅");
  const sprintsPage = await mkDb("Sprints", "🏃");

  const ids = {
    projects: projectsPage.id,
    tasks: tasksPage.id,
    sprints: sprintsPage.id,
  };
  const schemas = buildSchemas(ids);

  await prisma.page.update({
    where: { id: ids.projects },
    data: { dbSchema: JSON.stringify(schemas.projects) },
  });
  await prisma.page.update({
    where: { id: ids.tasks },
    data: { dbSchema: JSON.stringify(schemas.tasks) },
  });
  await prisma.page.update({
    where: { id: ids.sprints },
    data: { dbSchema: JSON.stringify(schemas.sprints) },
  });

  // ---- Seed sample data ----
  const now = new Date();
  const sprintStart = new Date(now);
  sprintStart.setDate(now.getDate() - 3);
  const sprintEnd = new Date(now);
  sprintEnd.setDate(now.getDate() + 11);

  const mkRow = async (
    dbId: string,
    title: string,
    values: Record<string, unknown>,
    position: number,
  ) => {
    const row = await prisma.page.create({
      data: {
        workspaceId: ctx.workspace.id,
        parentId: dbId,
        kind: "doc",
        title,
        position,
        authorId: ctx.user.id,
        dataValues: JSON.stringify(values),
      },
      select: { id: true },
    });
    return row.id;
  };

  // Current sprint.
  const sprintId = await mkRow(
    ids.sprints,
    "Sprint 1",
    { p_sprintstatus: "sp_current", p_start: iso(sprintStart), p_end: iso(sprintEnd) },
    1,
  );

  // Sample project.
  const projectId = await mkRow(
    ids.projects,
    "Website redesign",
    {
      p_status: "st_active",
      p_priority: "pr_high",
      p_summary: "Refresh the marketing site and ship a new landing page.",
    },
    1,
  );

  // Tasks, linked to the project and sprint.
  const taskSpecs: { title: string; status: string; priority: string; dueOffset: number }[] = [
    { title: "Audit current pages", status: "ts_done", priority: "pr_med", dueOffset: -1 },
    { title: "Design new landing page", status: "ts_prog", priority: "pr_high", dueOffset: 3 },
    { title: "Implement hero section", status: "ts_todo", priority: "pr_high", dueOffset: 6 },
    { title: "QA and launch", status: "ts_todo", priority: "pr_med", dueOffset: 10 },
  ];
  const taskIds: string[] = [];
  let tpos = 1;
  for (const t of taskSpecs) {
    const due = new Date(now);
    due.setDate(now.getDate() + t.dueOffset);
    const id = await mkRow(
      ids.tasks,
      t.title,
      {
        p_status: t.status,
        p_priority: t.priority,
        p_due: iso(due),
        p_project: [projectId],
        p_sprint: [sprintId],
      },
      tpos++,
    );
    taskIds.push(id);
  }

  // Relations are one-way, so populate the reverse sides explicitly: the
  // project and sprint must list their task ids for rollups/links to resolve.
  await prisma.page.update({
    where: { id: projectId },
    data: {
      dataValues: JSON.stringify({
        p_status: "st_active",
        p_priority: "pr_high",
        p_summary: "Refresh the marketing site and ship a new landing page.",
        p_tasks: taskIds,
      }),
    },
  });
  await prisma.page.update({
    where: { id: sprintId },
    data: {
      dataValues: JSON.stringify({
        p_sprintstatus: "sp_current",
        p_start: iso(sprintStart),
        p_end: iso(sprintEnd),
        p_sprinttasks: taskIds,
      }),
    },
  });

  await prisma.pageActivity.createMany({
    data: [ids.projects, ids.tasks, ids.sprints].map((pageId) => ({
      pageId,
      userId: ctx.user.id,
      action: "created",
    })),
  });

  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/p/${ids.tasks}`);
}
