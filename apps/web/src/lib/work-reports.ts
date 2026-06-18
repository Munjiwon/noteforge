import { prisma } from "db";

// Reconstruct agile reports from issue data + the IssueActivity history log.
// Status transitions are logged with status *names*; we map names to categories
// using the project's current workflow statuses.

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDay(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cur = new Date(dayKey(start));
  const last = new Date(dayKey(end));
  while (cur <= last) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
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

export type BurndownPoint = { date: string; remaining: number; ideal: number };

export async function computeBurndown(
  projectId: string,
  sprint: { id: string; startDate: Date | null; endDate: Date | null },
): Promise<{ points: BurndownPoint[]; unit: "points" | "issues" }> {
  const start = sprint.startDate ?? new Date();
  const end = sprint.endDate ?? new Date();
  const nameCat = await nameToCategory(projectId);

  const issues = await prisma.issue.findMany({
    where: { sprintId: sprint.id },
    select: {
      id: true,
      storyPoints: true,
      status: { select: { category: true } },
      activities: {
        where: { field: "status" },
        orderBy: { createdAt: "asc" },
        select: { to: true, createdAt: true },
      },
    },
  });

  const totalPoints = issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const unit: "points" | "issues" = totalPoints > 0 ? "points" : "issues";
  const weight = (i: (typeof issues)[number]) =>
    unit === "points" ? i.storyPoints ?? 0 : 1;
  const total = issues.reduce((s, i) => s + weight(i), 0);

  // doneTime per issue: last transition into a done-category status (only if it
  // currently sits in a done status).
  const doneTime = new Map<string, Date | null>();
  for (const i of issues) {
    let t: Date | null = null;
    if (i.status.category === "done") {
      for (const a of i.activities) {
        if (a.to && nameCat.get(a.to) === "done") t = a.createdAt;
      }
    }
    doneTime.set(i.id, t);
  }

  const days = eachDay(start, end);
  const n = Math.max(days.length - 1, 1);
  const points: BurndownPoint[] = days.map((d, idx) => {
    const cutoff = new Date(d);
    cutoff.setHours(23, 59, 59, 999);
    let remaining = 0;
    for (const i of issues) {
      const dt = doneTime.get(i.id);
      if (!dt || dt > cutoff) remaining += weight(i);
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
  const bars: VelocityBar[] = [];
  for (const s of sprints) {
    // "Ever in sprint" = current members plus issues whose history moved them in.
    const movedIn = await prisma.issueActivity.findMany({
      where: { field: "sprint", to: s.id, issue: { projectId } },
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
      select: { storyPoints: true, status: { select: { category: true } } },
    });
    const committed = issues.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
    const completed = issues
      .filter((i) => i.status.category === "done")
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
      status: { select: { category: true } },
      activities: {
        where: { field: "status" },
        orderBy: { createdAt: "asc" },
        select: { from: true, to: true, createdAt: true },
      },
    },
  });

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const range = eachDay(start, end);

  // Per-issue category timeline: [{at, cat}] sorted ascending.
  const timelines = issues.map((i) => {
    const events: { at: Date; cat: string }[] = [];
    const firstFrom = i.activities[0]?.from;
    const initialCat = (firstFrom && nameCat.get(firstFrom)) || "todo";
    events.push({ at: i.createdAt, cat: initialCat });
    for (const a of i.activities) {
      const cat = (a.to && nameCat.get(a.to)) || "todo";
      events.push({ at: a.createdAt, cat });
    }
    return { createdAt: i.createdAt, events };
  });

  return range.map((d) => {
    const cutoff = new Date(d);
    cutoff.setHours(23, 59, 59, 999);
    const row: CfdRow = { date: dayKey(d), todo: 0, in_progress: 0, done: 0 };
    for (const t of timelines) {
      if (t.createdAt > cutoff) continue;
      let cat = "todo";
      for (const e of t.events) {
        if (e.at <= cutoff) cat = e.cat;
        else break;
      }
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
    let startWork: Date | null = null;
    for (const a of i.activities) {
      if (a.to && nameCat.get(a.to) === "in_progress") {
        startWork = a.createdAt;
        break;
      }
    }
    const from = startWork ?? i.createdAt;
    const days = Math.max(0, (i.resolvedAt.getTime() - from.getTime()) / 86400000);
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
