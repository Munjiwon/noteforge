"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createIssue } from "@/app/w/[slug]/work/work-issue-actions";

export function QuickCreateIssue({
  slug,
  projectId,
  types,
  sprintId,
  epicId,
  label = "+ Create issue",
}: {
  slug: string;
  projectId: string;
  types: { id: string; name: string; icon: string | null }[];
  sprintId?: string;
  epicId?: string;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-black/5 hover:text-gray-900"
      >
        {label}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!summary.trim()) return;
        const fd = new FormData();
        fd.set("slug", slug);
        fd.set("projectId", projectId);
        fd.set("summary", summary.trim());
        fd.set("typeId", typeId);
        if (sprintId) fd.set("sprintId", sprintId);
        if (epicId) fd.set("epicId", epicId);
        start(async () => {
          await createIssue(fd);
          setSummary("");
          router.refresh();
        });
      }}
      className="flex items-center gap-2 rounded border border-gray-300 px-2 py-1"
    >
      <select
        value={typeId}
        onChange={(e) => setTypeId(e.target.value)}
        className="rounded border border-gray-200 px-1 py-1 text-sm"
      >
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.icon} {t.name}
          </option>
        ))}
      </select>
      <input
        autoFocus
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="What needs to be done?"
        className="flex-1 px-1 py-1 text-sm outline-none"
      />
      <button
        disabled={pending}
        className="rounded bg-gray-800 px-3 py-1 text-xs text-white disabled:opacity-50"
      >
        Create
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-400">
        Cancel
      </button>
    </form>
  );
}
