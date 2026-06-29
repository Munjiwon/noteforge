"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createReactBlockSpec } from "@blocknote/react";
import { priorityMeta, categoryMeta } from "@/lib/work";

function slugFromUrl(): string {
  if (typeof window === "undefined") return "";
  const m = /^\/w\/([^/]+)/.exec(window.location.pathname);
  return m ? m[1] : "";
}

type IssueRow = {
  number: number;
  summary: string;
  priority: string;
  typeIcon: string | null;
  statusName: string;
  statusCategory: string;
  assigneeName: string | null;
  assigneeColor: string | null;
};

type Payload = {
  slug: string;
  projectKey: string;
  projectName: string;
  projectIcon: string | null;
  total: number;
  issues: IssueRow[];
};

export const WorkViewBlock = createReactBlockSpec(
  {
    type: "workView",
    propSchema: {
      projectKey: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const projectKey = block.props.projectKey;
      const editable = (editor as { isEditable: boolean }).isEditable;
      const [data, setData] = useState<Payload | null>(null);
      const [error, setError] = useState<string | null>(null);

      useEffect(() => {
        if (!projectKey) return;
        let cancelled = false;
        const slug = slugFromUrl();
        fetch(`/api/work-view?ws=${encodeURIComponent(slug)}&key=${encodeURIComponent(projectKey)}`)
          .then(async (r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            return r.json();
          })
          .then((d) => {
            if (!cancelled) {
              setData(d);
              setError(null);
            }
          })
          .catch((e) => {
            if (!cancelled) setError(String(e));
          });
        return () => {
          cancelled = true;
        };
      }, [projectKey]);

      if (!projectKey) {
        return (
          <div className="my-2 rounded border border-dashed border-gray-300 p-3 text-sm" contentEditable={false}>
            <div className="mb-2 text-gray-500">🎯 Embed a work project's open issues.</div>
            {editable ? (
              <ProjectPicker
                onPick={(key) =>
                  editor.updateBlock(block, { props: { projectKey: key } as Record<string, unknown> })
                }
              />
            ) : (
              <div className="text-xs text-gray-400">No project selected.</div>
            )}
          </div>
        );
      }

      if (error) {
        // Non-members / signed-out viewers (e.g. on a published page) get a
        // neutral placeholder rather than a red error.
        const denied = /\b(401|403)\b/.test(error);
        return (
          <div
            className={`my-2 rounded border p-3 text-xs ${denied ? "border-gray-200 text-gray-400" : "border-red-200 bg-red-50 text-red-700"}`}
            contentEditable={false}
          >
            {denied ? "🎯 Work issues (sign in with access to view)." : `Couldn't load work view (${error}).`}
          </div>
        );
      }
      if (!data) {
        return (
          <div className="my-2 rounded border border-gray-200 p-3 text-xs text-gray-400" contentEditable={false}>
            Loading issues…
          </div>
        );
      }

      return (
        <div className="my-2 overflow-hidden rounded border border-gray-200" contentEditable={false}>
          <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2 text-sm">
            <span>{data.projectIcon ?? "🎯"}</span>
            <Link href={`/w/${data.slug}/work/${data.projectKey}/board`} className="font-medium text-gray-900 hover:underline">
              {data.projectName}
            </Link>
            <span className="rounded bg-gray-200 px-1.5 font-mono text-[10px] text-gray-500">{data.projectKey}</span>
            <span className="ml-auto text-xs text-gray-500">{data.total} open</span>
            {editable && (
              <button
                onClick={() => editor.updateBlock(block, { props: { projectKey: "" } as Record<string, unknown> })}
                className="text-xs text-gray-400 hover:text-gray-700"
                title="Change project"
              >
                ✎
              </button>
            )}
          </div>
          <ul>
            {data.issues.map((i) => (
              <li key={i.number}>
                <Link
                  href={`/w/${data.slug}/work/${data.projectKey}/issue/${i.number}`}
                  className="flex items-center gap-2 border-b border-gray-50 px-3 py-1.5 text-xs last:border-b-0 hover:bg-gray-50"
                >
                  <span>{i.typeIcon ?? "🎫"}</span>
                  <span className="font-mono text-gray-400 shrink-0">{data.projectKey}-{i.number}</span>
                  <span className="flex-1 truncate text-gray-800">{i.summary || "Untitled"}</span>
                  <span style={{ color: priorityMeta(i.priority).color }}>{priorityMeta(i.priority).icon}</span>
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] shrink-0"
                    style={{
                      background: `${categoryMeta(i.statusCategory).color}22`,
                      color: categoryMeta(i.statusCategory).color,
                    }}
                  >
                    {i.statusName}
                  </span>
                  {i.assigneeName && (
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-medium text-white shrink-0"
                      style={{ background: i.assigneeColor ?? "#888" }}
                      title={i.assigneeName}
                    >
                      {i.assigneeName.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {data.issues.length === 0 && (
              <li className="px-3 py-3 text-center text-xs text-gray-400">No open issues 🎉</li>
            )}
          </ul>
          {data.total > data.issues.length && (
            <div className="border-t border-gray-100 px-3 py-1 text-[11px] text-gray-400">
              showing {data.issues.length} of {data.total} —{" "}
              <Link href={`/w/${data.slug}/work/${data.projectKey}/board`} className="text-blue-600 hover:underline">
                open board
              </Link>
            </div>
          )}
        </div>
      );
    },
  },
);

function ProjectPicker({ onPick }: { onPick: (key: string) => void }) {
  const [projects, setProjects] = useState<{ key: string; name: string; icon: string | null }[]>([]);
  useEffect(() => {
    const slug = slugFromUrl();
    if (!slug) return;
    fetch(`/api/work-view?ws=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, []);
  if (projects.length === 0) {
    return <div className="text-xs text-gray-400">No work projects yet.</div>;
  }
  return (
    <ul className="space-y-0.5">
      {projects.map((p) => (
        <li key={p.key}>
          <button
            onClick={() => onPick(p.key)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-sm hover:bg-black/5"
          >
            <span>{p.icon ?? "🎯"}</span>
            <span className="truncate">{p.name}</span>
            <span className="ml-auto rounded bg-gray-100 px-1.5 font-mono text-[10px] text-gray-500">{p.key}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
