// Mention token format: @[user:ID|Label] or @[page:ID|Label]
// Label may not contain `]` or `|`.

export type MentionToken =
  | { type: "user"; id: string; label: string }
  | { type: "page"; id: string; label: string }
  | { type: "date"; id: string; label: string }; // id = YYYY-MM-DD

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; token: MentionToken };

const RE = /@\[(user|page|date):([^\]|]+)\|([^\]]+)\]/g;

export function parseMentions(body: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: "text", text: body.slice(last, idx) });
    out.push({
      kind: "mention",
      token: { type: m[1] as "user" | "page" | "date", id: m[2], label: m[3] },
    });
    last = idx + m[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}

export function mentionMarker(t: MentionToken): string {
  const safeLabel = t.label.replace(/[\]|]/g, " ").trim() || (t.type === "page" ? "Untitled" : "User");
  return `@[${t.type}:${t.id}|${safeLabel}]`;
}

export function extractMentionedUserIds(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(RE)) {
    if (m[1] === "user") ids.add(m[2]);
  }
  return Array.from(ids);
}
