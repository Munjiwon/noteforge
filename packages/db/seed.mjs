// One-off seed: create two users + one shared workspace for smoke tests.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function ensureUser(email, name, color) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash("password123", 10),
      color,
    },
  });
}

const alice = await ensureUser("alice@test.dev", "Alice", "#3b82f6");
const bob = await ensureUser("bob@test.dev", "Bob", "#ef4444");

let ws = await prisma.workspace.findUnique({ where: { slug: "demo-team" } });
if (!ws) {
  ws = await prisma.workspace.create({
    data: {
      name: "Demo Team",
      slug: "demo-team",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id, role: "editor" },
        ],
      },
      pages: {
        create: {
          title: "Welcome",
          icon: "👋",
          position: 0,
          authorId: alice.id,
        },
      },
    },
  });
}

console.log("Seeded:");
console.log("  alice@test.dev / password123");
console.log("  bob@test.dev / password123");
console.log("  workspace:", `/w/${ws.slug}`);

await prisma.$disconnect();
