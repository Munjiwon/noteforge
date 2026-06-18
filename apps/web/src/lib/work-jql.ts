import { prisma } from "db";
import type { Prisma } from "db";

// A pragmatic JQL-like query compiler. Supports clauses joined by AND, an
// optional trailing ORDER BY, and these fields:
//   status, statusCategory, type, priority, assignee, reporter, sprint,
//   project, label, component, resolution, summary/text, due, created
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

function clauseToWhere(ctx: Ctx, field: string, op: string, value: string): Prisma.IssueWhereInput | null {
  const f = field.toLowerCase();
  const v = unquote(value);
  const not = op === "!=";
  const list = () => value.replace(/^\s*\(|\)\s*$/g, "").split(",").map(unquote);

  switch (f) {
    case "status":
      return { status: not ? { name: { not: v } } : { name: v } };
    case "statuscategory":
    case "category":
      return { status: { category: v } };
    case "type":
    case "issuetype":
      return op === "in"
        ? { type: { name: { in: list() } } }
        : { type: not ? { name: { not: v } } : { name: v } };
    case "priority":
      return op === "in" ? { priority: { in: list() } } : not ? { priority: { not: v } } : { priority: v };
    case "assignee": {
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
      if (/^(active|current|open)$/i.test(v)) return { sprint: { state: "active" } };
      if (/^(empty|none|backlog)$/i.test(v)) return { sprintId: null };
      return { sprint: { name: v } };
    case "project":
      return { project: { key: v.toUpperCase() } };
    case "label":
    case "labels":
      return { labels: { some: { label: { name: v } } } };
    case "component":
      return { components: { some: { component: { name: v } } } };
    case "resolution":
      if (/^(unresolved|empty|none)$/i.test(v)) return { resolution: null };
      return { resolution: v };
    case "epic":
      return { epic: { project: { workspaceId: ctx.workspaceId } } };
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
  priority: "priority",
  due: "dueDate",
  points: "storyPoints",
  rank: "rank",
  number: "number",
};

export async function buildIssueQuery(
  jql: string,
  workspaceId: string,
  currentUserId: string,
): Promise<{ where: Prisma.IssueWhereInput; orderBy: Prisma.IssueOrderByWithRelationInput }> {
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
  let body = jql.trim();
  const orderMatch = /\border\s+by\s+(.+)$/i.exec(body);
  if (orderMatch) {
    body = body.slice(0, orderMatch.index).trim();
    const [field, dir] = orderMatch[1].trim().split(/\s+/);
    const col = ORDER_FIELDS[field.toLowerCase()];
    if (col) orderBy = { [col]: (dir || "asc").toLowerCase() === "desc" ? "desc" : "asc" } as Prisma.IssueOrderByWithRelationInput;
  }

  const and: Prisma.IssueWhereInput[] = [{ project: { workspaceId } }];
  if (body) {
    const clauses = body.split(/\bAND\b/i);
    for (const raw of clauses) {
      const clause = raw.trim();
      if (!clause) continue;
      const m = /^([A-Za-z]+)\s*(!=|>=|<=|=|~|>|<|\bin\b)\s*(.+)$/i.exec(clause);
      if (m) {
        const w = clauseToWhere(ctx, m[1], m[2].toLowerCase(), m[3]);
        if (w) and.push(w);
      } else {
        // Bare text → summary contains.
        and.push({ summary: { contains: unquote(clause) } });
      }
    }
  }
  return { where: { AND: and }, orderBy };
}
