"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DescriptionEditor } from "./description-editor";
import { PRIORITIES, priorityMeta, categoryMeta, RESOLUTIONS } from "@/lib/work";
import {
  setIssueField,
  transitionIssue,
  addIssueComment,
  deleteIssue,
  toggleWatch,
  createIssue,
  cloneIssue,
  deleteIssueComment,
} from "@/app/w/[slug]/work/work-issue-actions";

export type IssueDetailData = {
  id: string;
  number: number;
  summary: string;
  description: string;
  priority: string;
  statusId: string;
  typeId: string;
  assigneeId: string | null;
  reporterId: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  epicId: string | null;
  parentId: string | null;
  sprintId: string | null;
  resolution: string | null;
};

export type Member = { id: string; name: string; color: string };
export type ProjectMeta = {
  statuses: { id: string; name: string; category: string; color: string | null }[];
  types: { id: string; name: string; icon: string | null; level: string }[];
  sprints: { id: string; name: string; state: string }[];
  epics: { id: string; number: number; summary: string }[];
};

function Avatar({ member }: { member: Member | null }) {
  if (!member) return <span className="text-xs text-gray-400">Unassigned</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium text-white"
        style={{ background: member.color }}
      >
        {member.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="text-sm">{member.name}</span>
    </span>
  );
}

export function IssueDetail({
  slug,
  projectKey,
  projectId,
  issue,
  meta,
  members,
  comments,
  activities,
  subtasks,
  currentUserId,
  isWatching,
  watcherCount,
  readOnly,
}: {
  slug: string;
  projectKey: string;
  projectId: string;
  issue: IssueDetailData;
  meta: ProjectMeta;
  members: Member[];
  comments: { id: string; body: string; authorId: string; authorName: string; authorColor: string; createdAt: string }[];
  activities: { id: string; field: string; from: string | null; to: string | null; userName: string | null; createdAt: string }[];
  subtasks: { id: string; number: number; summary: string; category: string }[];
  currentUserId: string;
  isWatching: boolean;
  watcherCount: number;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [summary, setSummary] = useState(issue.summary);
  const [editingSummary, setEditingSummary] = useState(false);
  const [comment, setComment] = useState("");
  const [newSubtask, setNewSubtask] = useState("");
  const [tab, setTab] = useState<"comments" | "history">("comments");

  const status = meta.statuses.find((s) => s.id === issue.statusId);
  const type = meta.types.find((t) => t.id === issue.typeId);
  const memberMap = new Map(members.map((m) => [m.id, m]));

  const save = (field: string, value: string | null) => {
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("issueId", issue.id);
    fd.set("field", field);
    if (value !== null) fd.set("value", value);
    startTransition(async () => {
      await setIssueField(fd);
      router.refresh();
    });
  };

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2 py-1.5">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div>{children}</div>
    </div>
  );

  const selectCls =
    "w-full rounded border border-transparent px-1.5 py-1 text-sm hover:border-gray-300 focus:border-gray-400 disabled:opacity-60";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
      {/* Main column */}
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
          <span>{type?.icon} {type?.name}</span>
          <span className="font-mono">
            {projectKey}-{issue.number}
          </span>
        </div>
        {editingSummary && !readOnly ? (
          <input
            autoFocus
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onBlur={() => {
              setEditingSummary(false);
              if (summary !== issue.summary) save("summary", summary);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="mb-3 w-full rounded border border-gray-300 px-2 py-1 text-xl font-semibold"
          />
        ) : (
          <h1
            onClick={() => !readOnly && setEditingSummary(true)}
            className="mb-3 cursor-text rounded px-1 text-xl font-semibold hover:bg-black/5"
          >
            {summary || "Untitled issue"}
          </h1>
        )}

        <div className="mb-2 text-xs font-medium text-gray-500">Description</div>
        <DescriptionEditor
          key={issue.id}
          initialContent={issue.description}
          readOnly={readOnly}
          onSave={(json) => save("description", json)}
        />

        {/* Sub-tasks */}
        <div className="mt-6">
          <div className="mb-2 text-xs font-medium text-gray-500">
            Sub-tasks ({subtasks.length})
          </div>
          <div className="space-y-1">
            {subtasks.map((s) => (
              <a
                key={s.id}
                href={`/w/${slug}/work/${projectKey}/issue/${s.number}`}
                className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-sm hover:bg-black/5"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: categoryMeta(s.category).color }}
                />
                <span className="font-mono text-xs text-gray-400">
                  {projectKey}-{s.number}
                </span>
                <span className="truncate">{s.summary}</span>
              </a>
            ))}
          </div>
          {!readOnly && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!newSubtask.trim()) return;
                const fd = new FormData();
                fd.set("slug", slug);
                fd.set("projectId", projectId);
                fd.set("summary", newSubtask.trim());
                fd.set("parentId", issue.id);
                startTransition(async () => {
                  await createIssue(fd);
                  setNewSubtask("");
                  router.refresh();
                });
              }}
              className="mt-1.5"
            >
              <input
                value={newSubtask}
                onChange={(e) => setNewSubtask(e.target.value)}
                placeholder="+ Add a sub-task"
                className="w-full rounded border border-gray-200 px-2 py-1 text-sm"
              />
            </form>
          )}
        </div>

        {/* Comments / History */}
        <div className="mt-6">
          <div className="mb-2 flex gap-3 border-b border-gray-200 text-sm">
            <button
              onClick={() => setTab("comments")}
              className={`-mb-px border-b-2 pb-1 ${tab === "comments" ? "border-gray-800 font-medium" : "border-transparent text-gray-500"}`}
            >
              Comments ({comments.length})
            </button>
            <button
              onClick={() => setTab("history")}
              className={`-mb-px border-b-2 pb-1 ${tab === "history" ? "border-gray-800 font-medium" : "border-transparent text-gray-500"}`}
            >
              History
            </button>
          </div>

          {tab === "comments" ? (
            <div className="space-y-3">
              {!readOnly && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!comment.trim()) return;
                    const fd = new FormData();
                    fd.set("slug", slug);
                    fd.set("issueId", issue.id);
                    fd.set("body", comment.trim());
                    startTransition(async () => {
                      await addIssueComment(fd);
                      setComment("");
                      router.refresh();
                    });
                  }}
                >
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Add a comment…"
                    rows={2}
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                  />
                  <div className="mt-1 text-right">
                    <button className="rounded bg-gray-800 px-3 py-1 text-xs text-white">
                      Comment
                    </button>
                  </div>
                </form>
              )}
              {comments.map((c) => (
                <div key={c.id} className="flex gap-2">
                  <span
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
                    style={{ background: c.authorColor }}
                  >
                    {c.authorName.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-gray-500">
                      <span className="font-medium text-gray-700">{c.authorName}</span>{" "}
                      {new Date(c.createdAt).toLocaleString()}
                      {c.authorId === currentUserId && (
                        <button
                          onClick={() =>
                            startTransition(async () => {
                              await deleteIssueComment(slug, c.id);
                              router.refresh();
                            })
                          }
                          className="ml-2 text-gray-400 hover:text-red-600"
                        >
                          delete
                        </button>
                      )}
                    </div>
                    <div className="whitespace-pre-wrap text-sm">{c.body}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5 text-sm">
              {activities.map((a) => (
                <div key={a.id} className="text-xs text-gray-600">
                  <span className="font-medium text-gray-700">{a.userName ?? "Someone"}</span>{" "}
                  {a.field === "created" ? (
                    <>created this issue</>
                  ) : (
                    <>
                      changed <span className="font-medium">{a.field}</span>
                      {a.from ? ` from "${a.from}"` : ""} {a.to ? `to "${a.to}"` : ""}
                    </>
                  )}{" "}
                  · {new Date(a.createdAt).toLocaleString()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Sidebar fields */}
      <aside className="space-y-1 rounded-lg border border-gray-200 p-3">
        <Field label="Status">
          <select
            disabled={readOnly}
            value={issue.statusId}
            onChange={(e) =>
              startTransition(async () => {
                await transitionIssue(slug, issue.id, e.target.value);
                router.refresh();
              })
            }
            className={selectCls}
            style={{ color: status ? categoryMeta(status.category).color : undefined }}
          >
            {meta.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {issue.resolution && (
          <Field label="Resolution">
            <span className="text-sm">
              {RESOLUTIONS.find((r) => r.id === issue.resolution)?.name ?? issue.resolution}
            </span>
          </Field>
        )}
        <Field label="Type">
          <select disabled={readOnly} value={issue.typeId} onChange={(e) => save("typeId", e.target.value)} className={selectCls}>
            {meta.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.icon} {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select disabled={readOnly} value={issue.priority} onChange={(e) => save("priority", e.target.value)} className={selectCls} style={{ color: priorityMeta(issue.priority).color }}>
            {PRIORITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon} {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assignee">
          <select disabled={readOnly} value={issue.assigneeId ?? ""} onChange={(e) => save("assigneeId", e.target.value)} className={selectCls}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {!readOnly && issue.assigneeId !== currentUserId && (
            <button
              onClick={() => save("assigneeId", currentUserId)}
              className="mt-0.5 px-1.5 text-[11px] text-[rgb(var(--accent,99_102_241))] hover:underline"
            >
              Assign to me
            </button>
          )}
        </Field>
        <Field label="Reporter">
          <Avatar member={issue.reporterId ? memberMap.get(issue.reporterId) ?? null : null} />
        </Field>
        <Field label="Story points">
          <input
            disabled={readOnly}
            type="number"
            min={0}
            step={0.5}
            defaultValue={issue.storyPoints ?? ""}
            onBlur={(e) => save("storyPoints", e.target.value || null)}
            className={selectCls}
          />
        </Field>
        <Field label="Sprint">
          <select disabled={readOnly} value={issue.sprintId ?? ""} onChange={(e) => save("sprintId", e.target.value)} className={selectCls}>
            <option value="">Backlog</option>
            {meta.sprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Epic">
          <select disabled={readOnly} value={issue.epicId ?? ""} onChange={(e) => save("epicId", e.target.value)} className={selectCls}>
            <option value="">None</option>
            {meta.epics.filter((ep) => ep.id !== issue.id).map((ep) => (
              <option key={ep.id} value={ep.id}>
                {projectKey}-{ep.number} {ep.summary}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due date">
          <input
            disabled={readOnly}
            type="date"
            defaultValue={issue.dueDate ? issue.dueDate.slice(0, 10) : ""}
            onChange={(e) => save("dueDate", e.target.value || null)}
            className={selectCls}
          />
        </Field>
        <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2">
          <button
            onClick={() =>
              startTransition(async () => {
                await toggleWatch(slug, issue.id);
                router.refresh();
              })
            }
            className="text-xs text-gray-500 hover:text-gray-900"
          >
            {isWatching ? "👁 Watching" : "👁 Watch"} ({watcherCount})
          </button>
          {!readOnly && (
            <div className="flex items-center gap-3">
              <button
                onClick={() =>
                  startTransition(async () => {
                    const res = await cloneIssue(slug, issue.id);
                    if (res) router.push(`/w/${slug}/work/${res.projectKey}/issue/${res.number}`);
                  })
                }
                className="text-xs text-gray-500 hover:text-gray-900"
              >
                Clone
              </button>
              <button
                onClick={() => {
                  if (!confirm("Delete this issue?")) return;
                  startTransition(async () => {
                    await deleteIssue(slug, issue.id);
                    router.push(`/w/${slug}/work/${projectKey}/board`);
                  });
                }}
                className="text-xs text-gray-400 hover:text-red-600"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
