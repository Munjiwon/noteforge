import type { BurndownPoint, VelocityBar, CfdRow, CycleSample } from "@/lib/work-reports";

const W = 640;
const H = 240;
const PAD = 36;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function BurndownChart({ points, unit }: { points: BurndownPoint[]; unit: string }) {
  if (points.length === 0) return <Empty />;
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.remaining, p.ideal)), 1));
  const x = (i: number) => PAD + (i / Math.max(points.length - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = (key: "remaining" | "ideal") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p[key])}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <Axes max={max} unit={unit} />
      <path d={line("ideal")} fill="none" stroke="#cbd5e1" strokeDasharray="4 4" strokeWidth={1.5} />
      <path d={line("remaining")} fill="none" stroke="#2563eb" strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.remaining)} r={2.5} fill="#2563eb" />
      ))}
    </svg>
  );
}

function Axes({ max, unit }: { max: number; unit: string }) {
  return (
    <>
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e5e7eb" />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#e5e7eb" />
      <text x={4} y={PAD + 4} fontSize={10} fill="#94a3b8">{max}</text>
      <text x={4} y={H - PAD} fontSize={10} fill="#94a3b8">0</text>
      <text x={W - PAD} y={H - 6} fontSize={10} fill="#94a3b8" textAnchor="end">{unit}</text>
    </>
  );
}

function Empty() {
  return <div className="py-10 text-center text-sm text-gray-400">Not enough data yet.</div>;
}

export function VelocityChart({ bars }: { bars: VelocityBar[] }) {
  if (bars.length === 0) return <Empty />;
  const max = niceMax(Math.max(...bars.flatMap((b) => [b.committed, b.completed]), 1));
  const groupW = (W - PAD * 2) / bars.length;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <Axes max={max} unit="points" />
      {bars.map((b, i) => {
        const gx = PAD + i * groupW;
        const bw = groupW * 0.3;
        return (
          <g key={i}>
            <rect x={gx + groupW * 0.18} y={y(b.committed)} width={bw} height={H - PAD - y(b.committed)} fill="#cbd5e1" />
            <rect x={gx + groupW * 0.5} y={y(b.completed)} width={bw} height={H - PAD - y(b.completed)} fill="#16a34a" />
            <text x={gx + groupW / 2} y={H - PAD + 12} fontSize={9} fill="#64748b" textAnchor="middle">
              {b.sprint.length > 12 ? b.sprint.slice(0, 11) + "…" : b.sprint}
            </text>
          </g>
        );
      })}
      <Legend items={[{ c: "#cbd5e1", l: "Committed" }, { c: "#16a34a", l: "Completed" }]} />
    </svg>
  );
}

export function CfdChart({ rows }: { rows: CfdRow[] }) {
  if (rows.length === 0) return <Empty />;
  const totals = rows.map((r) => r.todo + r.in_progress + r.done);
  const max = niceMax(Math.max(...totals, 1));
  const x = (i: number) => PAD + (i / Math.max(rows.length - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  // Stacked bands (bottom→top): done, in_progress, todo.
  const band = (lower: (r: CfdRow) => number, upper: (r: CfdRow) => number) => {
    const top = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(upper(r))}`).join(" ");
    const bottom = rows
      .map((r, i) => `L${x(rows.length - 1 - i)},${y(lower(rows[rows.length - 1 - i]))}`)
      .join(" ");
    return `${top} ${bottom} Z`;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <Axes max={max} unit="issues" />
      <path d={band(() => 0, (r) => r.done)} fill="#16a34a" opacity={0.7} />
      <path d={band((r) => r.done, (r) => r.done + r.in_progress)} fill="#2563eb" opacity={0.6} />
      <path d={band((r) => r.done + r.in_progress, (r) => r.done + r.in_progress + r.todo)} fill="#94a3b8" opacity={0.5} />
      <Legend items={[{ c: "#94a3b8", l: "To Do" }, { c: "#2563eb", l: "In Progress" }, { c: "#16a34a", l: "Done" }]} />
    </svg>
  );
}

export function ControlChart({ samples, avg }: { samples: CycleSample[]; avg: number }) {
  if (samples.length === 0) return <Empty />;
  const max = niceMax(Math.max(...samples.map((s) => s.days), 1));
  const x = (i: number) => PAD + (i / Math.max(samples.length - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <Axes max={max} unit="days" />
      <line x1={PAD} y1={y(avg)} x2={W - PAD} y2={y(avg)} stroke="#ef4444" strokeDasharray="4 4" />
      <text x={W - PAD} y={y(avg) - 4} fontSize={9} fill="#ef4444" textAnchor="end">avg {avg}d</text>
      {samples.map((s, i) => (
        <circle key={i} cx={x(i)} cy={y(s.days)} r={3} fill="#2563eb" opacity={0.7}>
          <title>{s.key}: {s.days}d (resolved {s.resolvedAt})</title>
        </circle>
      ))}
    </svg>
  );
}

function Legend({ items }: { items: { c: string; l: string }[] }) {
  return (
    <g>
      {items.map((it, i) => (
        <g key={i} transform={`translate(${PAD + i * 110}, 12)`}>
          <rect width={10} height={10} fill={it.c} />
          <text x={14} y={9} fontSize={10} fill="#64748b">{it.l}</text>
        </g>
      ))}
    </g>
  );
}
