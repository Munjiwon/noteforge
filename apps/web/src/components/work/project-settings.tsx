"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateWorkProject } from "@/app/w/[slug]/work/work-project-actions";
import { createComponent, deleteComponent } from "@/app/w/[slug]/work/work-meta-actions";

export function ProjectSettings({
  slug,
  project,
  members,
  components,
  labels,
  canEdit,
}: {
  slug: string;
  project: { id: string; name: string; description: string | null; leadId: string | null };
  members: { id: string; name: string }[];
  components: { id: string; name: string; description: string | null; leadName: string | null }[];
  labels: { name: string; color: string | null; count: number }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();

  return (
    <div className="space-y-8">
      {/* Details */}
      <section>
        <h3 className="mb-3 font-semibold">Project details</h3>
        <form action={updateWorkProject} className="space-y-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={project.id} />
          <div>
            <label className="block text-xs text-gray-500">Name</label>
            <input name="name" defaultValue={project.name} disabled={!canEdit} className="w-full rounded border border-gray-300 px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500">Description</label>
            <textarea name="description" defaultValue={project.description ?? ""} disabled={!canEdit} rows={2} className="w-full rounded border border-gray-300 px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500">Project lead</label>
            <select name="leadId" defaultValue={project.leadId ?? ""} disabled={!canEdit} className="rounded border border-gray-300 px-2 py-1 text-sm">
              <option value="">None</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          {canEdit && <button className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white">Save</button>}
        </form>
      </section>

      {/* Components */}
      <section>
        <h3 className="mb-3 font-semibold">Components</h3>
        <div className="mb-2 space-y-1">
          {components.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1 text-sm">
              <span className="font-medium">{c.name}</span>
              {c.description && <span className="text-xs text-gray-500">{c.description}</span>}
              {c.leadName && <span className="text-xs text-gray-400">· {c.leadName}</span>}
              {canEdit && (
                <button
                  onClick={() => { if (confirm("Delete component?")) start(async () => { await deleteComponent(slug, c.id); router.refresh(); }); }}
                  className="ml-auto text-gray-400 hover:text-red-600"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {components.length === 0 && <p className="text-xs text-gray-400">No components yet.</p>}
        </div>
        {canEdit && (
          <form action={createComponent} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="projectId" value={project.id} />
            <input name="name" placeholder="Component name" required className="rounded border border-gray-300 px-2 py-1 text-sm" />
            <input name="description" placeholder="Description (optional)" className="rounded border border-gray-300 px-2 py-1 text-sm" />
            <select name="leadId" className="rounded border border-gray-300 px-2 py-1 text-sm">
              <option value="">Lead…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <button className="rounded bg-gray-800 px-3 py-1 text-sm text-white">Add</button>
          </form>
        )}
      </section>

      {/* Labels */}
      <section>
        <h3 className="mb-3 font-semibold">Labels in use</h3>
        <div className="flex flex-wrap gap-2">
          {labels.map((l) => (
            <span key={l.name} className="rounded px-2 py-1 text-xs text-white" style={{ background: l.color ?? "#64748b" }}>
              {l.name} ({l.count})
            </span>
          ))}
          {labels.length === 0 && <p className="text-xs text-gray-400">No labels yet.</p>}
        </div>
      </section>
    </div>
  );
}
