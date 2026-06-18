"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { createWorkProject } from "@/app/w/[slug]/work/work-project-actions";
import { suggestProjectKey } from "@/lib/work";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-[rgb(var(--accent,99_102_241))] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "Creating…" : "Create project"}
    </button>
  );
}

export function NewProjectDialog({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<"scrum" | "kanban">("scrum");

  const effectiveKey = keyTouched ? key : suggestProjectKey(name || "");

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded bg-[rgb(var(--accent,99_102_241))] px-3 py-1.5 text-sm font-medium text-white"
      >
        + New project
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-24"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold">Create work project</h2>
            <form action={createWorkProject} className="space-y-3">
              <input type="hidden" name="slug" value={slug} />
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Name</label>
                <input
                  name="name"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Mobile App"
                  className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-gray-500">Key</label>
                  <input
                    name="key"
                    value={effectiveKey}
                    onChange={(e) => {
                      setKeyTouched(true);
                      setKey(e.target.value.toUpperCase());
                    }}
                    className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm uppercase"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Icon</label>
                  <input
                    name="icon"
                    defaultValue="🚀"
                    maxLength={2}
                    className="w-14 rounded border border-gray-300 px-2.5 py-1.5 text-center text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Template</label>
                <div className="flex gap-2">
                  {(["scrum", "kanban"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setType(t)}
                      className={`flex-1 rounded border px-3 py-2 text-left text-sm ${
                        type === t
                          ? "border-[rgb(var(--accent,99_102_241))] bg-[rgb(var(--accent,99_102_241))]/5"
                          : "border-gray-300"
                      }`}
                    >
                      <div className="font-medium capitalize">{t}</div>
                      <div className="text-xs text-gray-500">
                        {t === "scrum" ? "Sprints + backlog" : "Continuous flow"}
                      </div>
                    </button>
                  ))}
                </div>
                <input type="hidden" name="type" value={type} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-black/5"
                >
                  Cancel
                </button>
                <SubmitButton />
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
