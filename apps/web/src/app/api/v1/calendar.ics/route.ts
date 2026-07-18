import { NextRequest, NextResponse } from "next/server";
import { prisma } from "db";
import { parseSchema } from "@/lib/database";

async function tokenUser(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const t = await prisma.apiToken.findUnique({
    where: { token: m[1] },
    include: { user: true },
  });
  if (!t) return null;
  prisma.apiToken
    .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return t.user;
}

function ics(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export async function GET(req: NextRequest) {
  const user = await tokenUser(req);
  if (!user) return new NextResponse("unauthorized", { status: 401 });
  const ws = req.nextUrl.searchParams.get("workspace");
  if (!ws) return new NextResponse("missing workspace", { status: 400 });
  const workspace = await prisma.workspace.findUnique({
    where: { slug: ws },
    include: { members: { where: { userId: user.id }, select: { id: true } } },
  });
  if (!workspace || workspace.members.length === 0) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NoteForge//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${esc(workspace.name)}`,
  ];

  // 1) DB rows with date properties
  const dbs = await prisma.page.findMany({
    where: { workspaceId: workspace.id, kind: "database", deletedAt: null },
    select: { id: true, title: true, dbSchema: true },
  });
  for (const db of dbs) {
    const schema = parseSchema(db.dbSchema);
    const dateProps = schema.props.filter((p) => p.type === "date");
    if (dateProps.length === 0) continue;
    const rows = await prisma.page.findMany({
      where: {
        workspaceId: workspace.id,
        parentId: db.id,
        deletedAt: null,
        isTemplate: false,
      },
      select: { id: true, title: true, dataValues: true, updatedAt: true },
    });
    for (const r of rows) {
      let vals: Record<string, unknown> = {};
      try {
        vals = JSON.parse(r.dataValues ?? "{}");
      } catch {}
      for (const p of dateProps) {
        const raw = vals[p.id];
        if (!raw || typeof raw !== "string") continue;
        const dt = new Date(raw);
        if (Number.isNaN(dt.getTime())) continue;
        lines.push(
          "BEGIN:VEVENT",
          `UID:row-${r.id}-${p.id}@collab-notion`,
          `DTSTAMP:${ics(r.updatedAt)}`,
          `DTSTART:${ics(dt)}`,
          `SUMMARY:${esc(`${db.title}: ${r.title || "Untitled"}`)}`,
          `DESCRIPTION:${esc(p.name)}`,
          "END:VEVENT",
        );
      }
    }
  }

  // 2) Reminders (for the calling user)
  const reminders = await prisma.reminder.findMany({
    where: { userId: user.id, workspaceId: workspace.id, sentAt: null },
    include: { page: { select: { title: true } } },
  });
  for (const r of reminders) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:reminder-${r.id}@collab-notion`,
      `DTSTAMP:${ics(r.createdAt)}`,
      `DTSTART:${ics(r.dueAt)}`,
      `SUMMARY:${esc(r.note ?? `Reminder · ${r.page.title || "Untitled"}`)}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return new NextResponse(lines.join("\r\n"), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${ws}.ics"`,
    },
  });
}
