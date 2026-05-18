import { redirect } from "next/navigation";
import { auth } from "./auth";
import { prisma } from "db";

export async function requireWorkspaceMember(slug: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const userId = (session.user as any).id as string;

  const ws = await prisma.workspace.findUnique({
    where: { slug },
    include: {
      members: {
        where: { userId },
        select: { role: true },
      },
    },
  });
  if (!ws || ws.members.length === 0) redirect("/");

  return {
    user: { id: userId, name: session.user.name!, color: (session.user as any).color as string },
    workspace: {
      id: ws.id,
      slug: ws.slug,
      name: ws.name,
      icon: ws.icon,
      color: ws.color,
      defaultFont: ws.defaultFont,
      bannerUrl: ws.bannerUrl,
    },
    role: ws.members[0].role,
  };
}

export async function getWorkspacesForUser(userId: string) {
  return prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
}
