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
                <div className="mb-1 flex items-center gap-1.5">
                  <label className="block text-xs font-medium text-gray-500">Template</label>
                  <span className="group relative inline-flex">
                    <span className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-600">
                      ?
                    </span>
                    <span className="pointer-events-none absolute left-0 top-5 z-10 hidden w-80 rounded-md border border-gray-200 bg-white p-2.5 text-[11px] leading-relaxed text-gray-600 shadow-lg group-hover:block">
                      <b>Scrum</b> — 스프린트(정해진 기간) 단위로 일하는 방식이에요. <b>백로그</b> 탭에서 이슈를 모아 스프린트를 시작/완료하고, 보드는 <b>현재 진행 중인 스프린트</b>만 보여줍니다. 번다운·벨로시티 같은 리포트가 의미 있게 동작해요. (개발 팀의 반복 개발에 적합)
                      <br />
                      <br />
                      <b>Kanban</b> — 정해진 기간 없이 <b>연속적인 흐름</b>으로 일하는 방식이에요. 백로그·스프린트가 없고, 보드에 <b>모든 이슈</b>가 상태(To Do→진행중→완료)별로 계속 흐릅니다. (운영·지원·상시 업무에 적합)
                    </span>
                  </span>
                </div>
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
