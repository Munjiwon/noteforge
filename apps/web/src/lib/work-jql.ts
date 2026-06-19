import { prisma } from "db";
import type { Prisma } from "db";

// A pragmatic JQL-like query compiler. Supports clauses joined by AND and OR
// (AND binds tighter than OR), an optional trailing ORDER BY, and these fields:
//   status, statusCategory, type, priority, assignee, reporter, sprint,
//   project, label, component, resolution, epic, summary/text, due, created
// Operators: = != ~ (contains) > < >= <= and `in (a, b)`. Bare words with no
// operator become a summary contains-search. `me`/`currentUser()` resolve to
// the current user for assignee/reporter.

type Ctx = {
  workspaceId: string;
  currentUserId: string;
  members: { id: string; name: string; email: string }[];
};

function resolveMember(ctx: Ctx, raw: string): string | null {
  const v = raw.trim().replace(/^["']|["']$/g, "");
  if (/^(me|currentuser\(\))$/i.test(v)) return ctx.currentUserId;
  if (/^(empty|null|unassigned|none)$/i.test(v)) return "__none";
  const m = ctx.members.find(
    (x) => x.email.toLowerCase() === v.toLowerCase() || x.name.toLowerCase() === v.toLowerCase(),
  );
  return m?.id ?? null;
}

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

function parseList(value: string): string[] {
  return value.replace(/^\s*\(|\)\s*$/g, "").split(",").map(unquote).filter(Boolean);
}

function clauseToWhere(ctx: Ctx, field: string, op: string, value: string): Prisma.IssueWhereInput | null {
  const f = field.toLowerCase();
  const v = unquote(value);
  const not = op === "!=";
  const isIn = op === "in";
  const list = parseList(value);

  switch (f) {
    case "status":
      if (isIn) return { status: { name: { in: list } } };
      return { status: not ? { name: { not: v } } : { name: v } };
    case "statuscategory":
    case "category":
      return isIn ? { status: { category: { in: list } } } : { status: { category: v } };
    case "type":
    case "issuetype":
      if (isIn) return { type: { name: { in: list } } };
      return { type: not ? { name: { not: v } } : { name: v } };
    case "priority":
      if (isIn) return { priority: { in: list } };
      return not ? { priority: { not: v } } : { priority: v };
    case "assignee": {
      if (isIn) {
        const ids = list.map((x) => resolveMember(ctx, x)).filter((x): x is string => !!x && x !== "__none");
        return { assigneeId: { in: ids.length ? ids : ["__no_match__"] } };
      }
      const id = resolveMember(ctx, v);
      if (id === "__none") return { assigneeId: not ? { not: null } : null };
      if (!id) return { id: "__no_match__" };
      return { assigneeId: not ? { not: id } : id };
    }
    case "reporter": {
      const id = resolveMember(ctx, v);
      if (id === "__none") return { reporterId: null };
      if (!id) return { id: "__no_match__" };
      return { reporterId: id };
    }
    case "sprint":
      if (isIn) return { sprint: { name: { in: list } } };
      if (/^(active|current|open)$/i.test(v)) return { sprint: { state: "active" } };
      if (/^(empty|none|backlog)$/i.test(v)) return { sprintId: null };
      return { sprint: { name: v } };
    case "project":
      if (isIn) return { project: { key: { in: list.map((x) => x.toUpperCase()) } } };
      return { project: { key: v.toUpperCase() } };
    case "label":
    case "labels":
      if (isIn) return { labels: { some: { label: { name: { in: list } } } } };
      return { labels: { some: { label: { name: v } } } };
    case "component":
      if (isIn) return { components: { some: { component: { name: { in: list } } } } };
      return { components: { some: { component: { name: v } } } };
    case "resolution":
      if (/^(unresolved|empty|none)$/i.test(v)) return { resolution: null };
      return isIn ? { resolution: { in: list } } : { resolution: v };
    case "epic": {
      // epic = KEY-123 -> the issue whose epic is that key; epic = none -> no epic.
      if (/^(empty|none|null)$/i.test(v)) return { epicId: not ? { not: null } : null };
      const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(v);
      if (m) {
        return { epic: { number: Number(m[2]), project: { key: m[1].toUpperCase(), workspaceId: ctx.workspaceId } } };
      }
      return { id: "__no_match__" };
    }
    case "text":
    case "summary":
      return { summary: { contains: v } };
    case "due":
    case "duedate": {
      const d = new Date(v);
      if (isNaN(+d)) return null;
      if (op === ">" || op === ">=") return { dueDate: { gte: d } };
      if (op === "<" || op === "<=") return { dueDate: { lte: d } };
      return { dueDate: d };
    }
    case "created": {
      const d = new Date(v);
      if (isNaN(+d)) return null;
      if (op === ">" || op === ">=") return { createdAt: { gte: d } };
      if (op === "<" || op === "<=") return { createdAt: { lte: d } };
      return null;
    }
    default:
      return null;
  }
}

const ORDER_FIELDS: Record<string, string> = {
  created: "createdAt",
  updated: "updatedAt",
  due: "dueDate",
  points: "storyPoints",
  rank: "rank",
  number: "number",
};

// Compile a single AND-group (clauses joined by AND) into where fragments.
function compileGroup(ctx: Ctx, body: string): Prisma.IssueWhereInput[] {
  const out: Prisma.IssueWhereInput[] = [];
  for (const raw of body.split(/\bAND\b/i)) {
    const clause = raw.trim();
    if (!clause) continue;
    const m = /^([A-Za-z]+)\s*(!=|>=|<=|=|~|>|<|\bin\b)\s*(.+)$/i.exec(clause);
    if (m) {
      const w = clauseToWhere(ctx, m[1], m[2].toLowerCase(), m[3]);
      if (w) out.push(w);
    } else {
      out.push({ summary: { contains: unquote(clause) } });
    }
  }
  return out;
}

export async function buildIssueQuery(
  jql: string,
  workspaceId: string,
  currentUserId: string,
): Promise<{
  where: Prisma.IssueWhereInput;
  orderBy: Prisma.IssueOrderByWithRelationInput;
  // "priority" sorting can't be expressed in SQL (string field), so callers
  // post-sort by severity rank when this is set.
  prioritySort: "asc" | "desc" | null;
}> {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const ctx: Ctx = {
    workspaceId,
    currentUserId,
    members: members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email })),
  };

  let orderBy: Prisma.IssueOrderByWithRelationInput = { updatedAt: "desc" };
  let prioritySort: "asc" | "desc" | null = null;
  let body = jql.trim();
  const orderMatch = /\border\s+by\s+(.+)$/i.exec(body);
  if (orderMatch) {
    body = body.slice(0, orderMatch.index).trim();
    const [field, dir] = orderMatch[1].trim().split(/\s+/);
    const desc = (dir || "asc").toLowerCase() === "desc";
    if (field.toLowerCase() === "priority") {
      prioritySort = desc ? "desc" : "asc";
    } else {
      const col = ORDER_FIELDS[field.toLowerCase()];
      if (col) orderBy = { [col]: desc ? "desc" : "asc" } as Prisma.IssueOrderByWithRelationInput;
    }
  }

  // Split on top-level OR first (AND binds tighter), then compile each group.
  const scope: Prisma.IssueWhereInput = { project: { workspaceId } };
  const orGroups = body ? body.split(/\bOR\b/i).map((g) => compileGroup(ctx, g)).filter((g) => g.length) : [];
  let where: Prisma.IssueWhereInput;
  if (orGroups.length <= 1) {
    where = { AND: [scope, ...(orGroups[0] ?? [])] };
  } else {
    where = { AND: [scope, { OR: orGroups.map((g) => ({ AND: g })) }] };
  }
  return { where, orderBy, prioritySort };
}
