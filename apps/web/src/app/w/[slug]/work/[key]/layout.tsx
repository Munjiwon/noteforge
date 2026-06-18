import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import { WorkProjectNav } from "@/components/work/work-project-nav";

export const dynamic = "force-dynamic";

export default async function WorkProjectLayout({
  params,
  children,
}: {
  params: { slug: string; key: string };
  children: React.ReactNode;
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, key: true, name: true, icon: true, type: true },
  });
  if (!project) notFound();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 px-4 pt-4">
        <Link href={`/w/${params.slug}/work`} className="text-gray-400 hover:text-gray-700">
          Projects
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-lg">{project.icon || "🗂️"}</span>
        <h1 className="font-semibold">{project.name}</h1>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-500">
          {project.key}
        </span>
      </header>
      <WorkProjectNav slug={params.slug} projectKey={project.key} type={project.type} />
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
