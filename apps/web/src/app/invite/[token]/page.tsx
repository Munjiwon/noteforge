import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "db";

export default async function InvitePage({ params }: { params: { token: string } }) {
  const session = await auth();
  if (!session?.user) {
    redirect(`/login?invite=${params.token}`);
  }

  const invite = await prisma.invite.findUnique({
    where: { token: params.token },
    include: { workspace: true },
  });

  if (!invite) {
    return (
      <main className="min-h-screen grid place-items-center">
        <div className="text-center">
          <p className="text-lg">This invite link is invalid or expired.</p>
        </div>
      </main>
    );
  }

  const userId = (session.user as any).id as string;
  const existing = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: invite.workspaceId } },
  });
  if (!existing) {
    await prisma.workspaceMember.create({
      data: { userId, workspaceId: invite.workspaceId, role: invite.role },
    });
  }
  redirect(`/w/${invite.workspace.slug}`);
}
