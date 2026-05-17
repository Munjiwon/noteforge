import { redirect } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";

export default async function WorkspaceHome({ params }: { params: { slug: string } }) {
  const ctx = await requireWorkspaceMember(params.slug);
  const first = await prisma.page.findFirst({
    where: { workspaceId: ctx.workspace.id, parentId: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  if (first) redirect(`/w/${params.slug}/p/${first.id}`);

  return (
    <div className="h-full grid place-items-center text-gray-500">
      <div className="text-center">
        <p className="mb-2">No pages yet.</p>
        <p className="text-sm">Click + in the sidebar to create your first page.</p>
      </div>
    </div>
  );
}
