import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: session.user.id! },
    orderBy: { createdAt: "asc" },
    include: { workspace: true },
  });

  if (!membership) redirect("/onboarding");
  redirect(`/w/${membership.workspace.slug}`);
}
