import { prisma } from "db";

// Reconstruct agile reports from issue data + the IssueActivity history log.
// Status transitions are logged with status *names*; we map names to categories
// using the project's current workflow statuses. All day bucketing is done in
// UTC so day boundaries are consistent regardless of server timezone.

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// UTC midnight for a given day key.
function dayStartUTC(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

function endOfDayUTC(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

function eachDay(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cur = dayStartUTC(dayKey(start));
  const last = dayStartUTC(dayKey(end));
  while (cur <= last) {
    out.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function nameToCategory(projectId: string): Promise<Map<string, string>> {
  const statuses = await prisma.workflowStatus.findMany({
    where: { projectId },
    select: { name: true, category: true },
  });
  return new Map(statuses.map((s) => [s.name, s.category]));
}

type StatusActivity = { from: string | null; to: string | null; createdAt: Date };
type Timeline = { createdAt: Date; events: { at: Date; cat: string }[] };

// Build an issue's status-category timeline from its (ascending) status
// activities. The first event is the issue's category at creation, inferred
// from the first transition's `from` (default "todo").
function buildTimeline(
  createdAt: Date,
  activities: StatusActivity[],
  nameCat: Map<string, string>,
): Timeline {
  const events: { at: Date; cat: string }[] = [];
  const firstFrom = activities[0]?.from;
  const initialCat = (firstFrom && nameCat.get(firstFrom)) || "todo";
  events.push({ at: createdAt, cat: initialCat });
  for (const a of activities) {
    const cat = (a.to && nameCat.get(a.to)) || "todo";
    events.push({ at: a.createdAt, cat });
  }
  return { createdAt, events };
}

// Category at a given instant. Before the issue existed, returns its initial
// category (so it still counts as outstanding scope for burndown purposes).
function categoryAt(t: Timeline, cutoff: Date): string {
  let cat = t.events[0]?.cat ?? "todo";
  for (const e of t.events) {
    if (e.at <= cutoff) cat = e.cat;
    else break;
  }
  return cat;
}

export type BurndownPoint = { date: string; remaining: number; ideal: number };

export async function computeBurndown(
  projectId: string,
  sprint: { id: string; startDate: Date | null; endDate: Date | null },
): Promise<{ points: BurndownPoint[]; unit: "points" | "issues" }> {
  const start = sprint.startDate ?? new Date();
  const end = sprint.endDate ?? new Date();
  const nameCat = await nameToCategory(projectId);

  // Membership = currently in the sprint PLUS anything history shows was moved
  // into it (so issues carried out at completion don't make the line collapse).
  const movedIn = await prisma.issueActivity.findMany({
    where: { field: { in: ["sprint", "sprintId"] }, to: sprint.id, issue: { projectId } },
    select: { issueId: true },
  });
  const ids = new Set(movedIn.map((m) => m.issueId));
  const current = await prisma.issue.findMany({
    where: { sprintId: sprint.id },
    select: { id: true },
  });
  for (const c of current) ids.add(c.id);

  const issues = await prisma.issue.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      storyPoints: true,
      createdAt: true,
      activities: {
        where: { field: "status" },
        orderBy: { createdAt: "asc" },
        select: { from: true, to: true, createdAt: true },
      },
    },
  });

  const totalPoints = issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const unit: "points" | "issues" = totalPoints > 0 ? "points" : "issues";
  const weight = (i: (typeof issues)[number]) => (unit === "points" ? i.storyPoints ?? 0 : 1);
  const total = issues.reduce((s, i) => s + weight(i), 0);
  const timelines = new Map(issues.map((i) => [i.id, buildTimeline(i.createdAt, i.activities, nameCat)]));

  const days = eachDay(start, end);
  const n = Math.max(days.length - 1, 1);
  const points: BurndownPoint[] = days.map((d, idx) => {
    const cutoff = endOfDayUTC(d);
    let remaining = 0;
    for (const i of issues) {
      // Reconstruct done/not-done per day so reopened work counts as remaining
      // again (rather than gating only on the current status).
      if (categoryAt(timelines.get(i.id)!, cutoff) !== "done") remaining += weight(i);
    }
    return { date: dayKey(d), remaining, ideal: total * (1 - idx / n) };
  });
  return { points, unit };
}

export type VelocityBar = {
  sprint: string;
  committed: number;
  completed: number;
};

export async function computeVelocity(projectId: string, take = 6): Promise<VelocityBar[]> {
  const sprints = await prisma.sprint.findMany({
    where: { projectId, state: "completed" },
    orderBy: { sequence: "desc" },
    take,
  });
  sprints.reverse();
  const nameCat = await nameToCategory(projectId);
  const bars: VelocityBar[] = [];
  for (const s of sprints) {
    // "Ever in sprint" = current members plus issues whose history moved them in.
    // Accept the legacy "sprintId" field name alongside the canonical "sprint".
    const movedIn = await prisma.issueActivity.findMany({
      where: { field: { in: ["sprint", "sprintId"] }, to: s.id, issue: { projectId } },
      select: { issueId: true },
    });
    const ids = new Set(movedIn.map((m) => m.issueId));
    const current = await prisma.issue.findMany({
      where: { sprintId: s.id },
      select: { id: true },
    });
    for (const c of current) ids.add(c.id);

    const issues = await prisma.issue.findMany({
      where: { id: { in: [...ids] } },
      select: {
        storyPoints: true,
        createdAt: true,
        activities: {
          where: { field: "status" },
          orderBy: { createdAt: "asc" },
          select: { from: true, to: true, createdAt: true },
        },
      },
    });

    // "completed" = work that was Done as of the sprint's completion instant
    // (reconstructed from history), not merely whatever is Done now. "committed"
    // uses current story points (point history is not snapshotted at start).
    const asOf = s.completeDate ?? s.endDate ?? new Date();
    const committed = issues.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
    const completed = issues
      .filter((i) => categoryAt(buildTimeline(i.createdAt, i.activities, nameCat), asOf) === "done")
      .reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
    bars.push({ sprint: s.name, committed, completed });
  }
  return bars;
}

export type CfdRow = { date: string; todo: number; in_progress: number; done: number };

export async function computeCfd(projectId: string, days = 30): Promise<CfdRow[]> {
  const nameCat = await nameToCategory(projectId);
  const issues = await prisma.issue.findMany({
    where: { projectId },
    select: {
      createdAt: true,
      activities: {
        where: { field: "status" },
        orderBy: { createdAt: "asc" },
        select: { from: true, to: true, createdAt: true },
      },
    },
  });

  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const range = eachDay(start, end);
  const timelines = issues.map((i) => buildTimeline(i.createdAt, i.activities, nameCat));

  return range.map((d) => {
    const cutoff = endOfDayUTC(d);
    const row: CfdRow = { date: dayKey(d), todo: 0, in_progress: 0, done: 0 };
    for (const t of timelines) {
      if (t.createdAt > cutoff) continue; // not yet created
      const cat = categoryAt(t, cutoff);
      if (cat === "done") row.done += 1;
      else if (cat === "in_progress") row.in_progress += 1;
      else row.todo += 1;
    }
    return row;
  });
}

export type CycleSample = { key: string; days: number; resolvedAt: string };

export async function computeControlChart(
  projectId: string,
  projectKey: string,
  take = 50,
): Promise<{ samples: CycleSample[]; avg: number }> {
  const nameCat = await nameToCategory(projectId);
  const issues = await prisma.issue.findMany({
    where: { projectId, status: { category: "done" }, resolvedAt: { not: null } },
    orderBy: { resolvedAt: "desc" },
    take,
    select: {
      number: true,
      createdAt: true,
      resolvedAt: true,
      activities: {
        where: { field: "status" },
        orderBy: { createdAt: "asc" },
        select: { to: true, createdAt: true },
      },
    },
  });

  const samples: CycleSample[] = [];
  for (const i of issues) {
    if (!i.resolvedAt) continue;
    // Cycle time = first time work started (entered in_progress) → resolution.
    // If the issue never entered in_progress, it has no cycle phase, so skip it
    // rather than reporting lead-time (createdAt→done) as if it were cycle time.
    let startWork: Date | null = null;
    for (const a of i.activities) {
      if (a.to && nameCat.get(a.to) === "in_progress") {
        startWork = a.createdAt;
        break;
      }
    }
    if (!startWork) continue;
    const days = Math.max(0, (i.resolvedAt.getTime() - startWork.getTime()) / 86400000);
    samples.push({
      key: `${projectKey}-${i.number}`,
      days: Math.round(days * 10) / 10,
      resolvedAt: i.resolvedAt.toISOString().slice(0, 10),
    });
  }
  samples.reverse();
  const avg = samples.length
    ? Math.round((samples.reduce((s, x) => s + x.days, 0) / samples.length) * 10) / 10
    : 0;
  return { samples, avg };
}
