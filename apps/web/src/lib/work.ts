// Shared types, constants, and helpers for the JIRA-style work-management
// module. Kept framework-agnostic so it can be imported from server actions,
// route handlers, and (constants only) client components.

export const PRIORITIES = [
  { id: "highest", name: "Highest", icon: "⤒", color: "#dc2626", rank: 5 },
  { id: "high", name: "High", icon: "↑", color: "#ea580c", rank: 4 },
  { id: "medium", name: "Medium", icon: "=", color: "#ca8a04", rank: 3 },
  { id: "low", name: "Low", icon: "↓", color: "#2563eb", rank: 2 },
  { id: "lowest", name: "Lowest", icon: "⤓", color: "#64748b", rank: 1 },
] as const;

export type PriorityId = (typeof PRIORITIES)[number]["id"];

export function priorityMeta(id: string | null | undefined) {
  return PRIORITIES.find((p) => p.id === id) ?? PRIORITIES[2];
}

export const RESOLUTIONS = [
  { id: "done", name: "Done" },
  { id: "wontdo", name: "Won't Do" },
  { id: "duplicate", name: "Duplicate" },
  { id: "cannot_reproduce", name: "Cannot Reproduce" },
] as const;

export const STATUS_CATEGORIES = [
  { id: "todo", name: "To Do", color: "#94a3b8" },
  { id: "in_progress", name: "In Progress", color: "#2563eb" },
  { id: "done", name: "Done", color: "#16a34a" },
] as const;

export type StatusCategory = (typeof STATUS_CATEGORIES)[number]["id"];

export function categoryMeta(id: string | null | undefined) {
  return STATUS_CATEGORIES.find((c) => c.id === id) ?? STATUS_CATEGORIES[0];
}

export const ISSUE_LINK_TYPES = [
  { id: "blocks", name: "blocks", inward: "is blocked by" },
  { id: "relates", name: "relates to", inward: "relates to" },
  { id: "duplicates", name: "duplicates", inward: "is duplicated by" },
  { id: "clones", name: "clones", inward: "is cloned by" },
] as const;

// Default issue types created for a new project.
export const DEFAULT_ISSUE_TYPES = [
  { name: "Epic", icon: "🏆", level: "epic", color: "#8b5cf6" },
  { name: "Story", icon: "📗", level: "standard", color: "#22c55e" },
  { name: "Task", icon: "🟦", level: "standard", color: "#3b82f6" },
  { name: "Bug", icon: "🐞", level: "standard", color: "#ef4444" },
  { name: "Sub-task", icon: "↳", level: "subtask", color: "#94a3b8" },
] as const;

// Default workflow statuses (name + category) created for a new project.
export const DEFAULT_STATUSES = [
  { name: "To Do", category: "todo", color: "#94a3b8" },
  { name: "In Progress", category: "in_progress", color: "#3b82f6" },
  { name: "In Review", category: "in_progress", color: "#a855f7" },
  { name: "Done", category: "done", color: "#16a34a" },
] as const;

export function issueKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`;
}

// Derive a project key (e.g. "Engineering Platform" -> "EP") from a name.
export function suggestProjectKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "PROJ";
  if (words.length === 1) return words[0].slice(0, 4);
  return words
    .slice(0, 4)
    .map((w) => w[0])
    .join("");
}

export function formatDuration(seconds: number): string {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ") || "0m";
}

// Parse "2h 30m" / "1d 4h" / "90m" style input into seconds.
export function parseDuration(input: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*([wdhm])/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    matched = true;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit === "w" ? 144000 : unit === "d" ? 28800 : unit === "h" ? 3600 : 60;
    total += n * mult;
  }
  return matched ? Math.round(total) : null;
}
