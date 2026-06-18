import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";
import {
  computeBurndown,
  computeVelocity,
  computeCfd,
  computeControlChart,
} from "@/lib/work-reports";
import {
  BurndownChart,
  VelocityChart,
  CfdChart,
  ControlChart,
} from "@/components/work/report-charts";

export const dynamic = "force-dynamic";

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="mb-2">
        <h3 className="font-medium">{title}</h3>
        {hint && <p className="text-xs text-gray-400">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: { slug: string; key: string };
  searchParams: { sprint?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const project = await prisma.workProject.findFirst({
    where: { workspaceId: ctx.workspace.id, key: params.key },
    select: { id: true, key: true },
  });
  if (!project) notFound();

  const sprints = await prisma.sprint.findMany({
    where: { projectId: project.id },
    orderBy: { sequence: "desc" },
  });
  const selected =
    sprints.find((s) => s.id === searchParams.sprint) ??
    sprints.find((s) => s.state === "active") ??
    sprints[0] ??
    null;

  const [burndown, velocity, cfd, control] = await Promise.all([
    selected
      ? computeBurndown(project.id, selected)
      : Promise.resolve({ points: [], unit: "points" as const }),
    computeVelocity(project.id),
    computeCfd(project.id, 30),
    computeControlChart(project.id, project.key),
  ]);

  return (
    <div className="px-6 py-5">
      <h2 className="mb-4 text-lg font-semibold">Reports</h2>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Sprint burndown" hint="Remaining work vs. the ideal trend line.">
          {sprints.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {sprints.map((s) => (
                <Link
                  key={s.id}
                  href={`?sprint=${s.id}`}
                  className={`rounded px-2 py-0.5 text-xs ${
                    selected?.id === s.id ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {s.name}
                </Link>
              ))}
            </div>
          )}
          <BurndownChart points={burndown.points} unit={burndown.unit} />
        </Card>
        <Card title="Velocity" hint="Committed vs. completed story points per finished sprint.">
          <VelocityChart bars={velocity} />
        </Card>
        <Card title="Cumulative flow" hint="Issue count by status category over the last 30 days.">
          <CfdChart rows={cfd} />
        </Card>
        <Card title="Control chart" hint="Cycle time (in-progress → done) per resolved issue.">
          <ControlChart samples={control.samples} avg={control.avg} />
        </Card>
      </div>
    </div>
  );
}
