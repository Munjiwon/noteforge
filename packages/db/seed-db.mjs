// Seed a sample database page with some rows.
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();
const newId = (p) => `${p}_${randomBytes(6).toString("hex")}`;

const ws = await prisma.workspace.findUnique({ where: { slug: "demo-team" } });
if (!ws) throw new Error("workspace demo-team not found");

const exists = await prisma.page.findFirst({
  where: { workspaceId: ws.id, kind: "database", title: "Sprint backlog" },
});
if (exists) {
  console.log("already seeded:", exists.id);
  await prisma.$disconnect();
  process.exit(0);
}

const statusProp = {
  id: newId("p"),
  name: "Status",
  type: "select",
  options: [
    { id: newId("o"), name: "Todo", color: "#e5e7eb" },
    { id: newId("o"), name: "In Progress", color: "#bfdbfe" },
    { id: newId("o"), name: "Done", color: "#a7f3d0" },
  ],
};
const dueProp = { id: newId("p"), name: "Due", type: "date" };
const doneProp = { id: newId("p"), name: "Done", type: "checkbox" };
const sizeProp = { id: newId("p"), name: "Size", type: "number" };

const schema = {
  props: [
    { id: "p_title", name: "Task", type: "text" },
    statusProp,
    sizeProp,
    dueProp,
    doneProp,
  ],
};

const max = await prisma.page.aggregate({
  where: { workspaceId: ws.id, parentId: null },
  _max: { position: true },
});
const author = await prisma.user.findFirst({ where: { email: "alice@test.dev" } });

const db = await prisma.page.create({
  data: {
    workspaceId: ws.id,
    parentId: null,
    kind: "database",
    title: "Sprint backlog",
    icon: "📊",
    position: (max._max.position ?? 0) + 1,
    authorId: author?.id,
    dbSchema: JSON.stringify(schema),
  },
});

const rows = [
  { title: "Set up CI", status: statusProp.options[2].id, size: 2, due: "2026-05-12", done: true },
  { title: "Add database views (Board)", status: statusProp.options[1].id, size: 5, due: "2026-05-20" },
  { title: "Write tests for editor", status: statusProp.options[0].id, size: 3 },
  { title: "Polish presence cursors", status: statusProp.options[1].id, size: 2, due: "2026-05-18" },
];

let pos = 0;
for (const r of rows) {
  const values = {};
  values[statusProp.id] = r.status;
  if (r.size != null) values[sizeProp.id] = r.size;
  if (r.due) values[dueProp.id] = r.due;
  if (r.done) values[doneProp.id] = true;
  await prisma.page.create({
    data: {
      workspaceId: ws.id,
      parentId: db.id,
      kind: "doc",
      title: r.title,
      position: pos++,
      authorId: author?.id,
      dataValues: JSON.stringify(values),
    },
  });
}

console.log("seeded database:", `/w/demo-team/p/${db.id}`);
await prisma.$disconnect();
