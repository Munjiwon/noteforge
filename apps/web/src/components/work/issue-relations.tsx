"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ISSUE_LINK_TYPES } from "@/lib/work";
import {
  addIssueLink,
  removeIssueLink,
  setIssueLabel,
  setIssueComponent,
  setIssueFixVersion,
} from "@/app/w/[slug]/work/work-meta-actions";

export type IssueLinkRow = {
  id: string;
  typeLabel: string;
  otherNumber: number;
  otherSummary: string;
};

export function IssueRelations({
  slug,
  projectKey,
  issueId,
  links,
  linkableIssues,
  allComponents,
  selectedComponentIds,
  allVersions,
  selectedVersionIds,
  allLabels,
  selectedLabels,
  readOnly,
}: {
  slug: string;
  projectKey: string;
  issueId: string;
  links: IssueLinkRow[];
  linkableIssues: { id: string; number: number; summary: string }[];
  allComponents: { id: string; name: string }[];
  selectedComponentIds: string[];
  allVersions: { id: string; name: string; released: boolean }[];
  selectedVersionIds: string[];
  allLabels: { name: string; color: string | null }[];
  selectedLabels: string[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [linkType, setLinkType] = useState<string>(ISSUE_LINK_TYPES[0].id);
  const [linkTarget, setLinkTarget] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const refresh = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });

  const selectedComp = new Set(selectedComponentIds);
  const selectedVer = new Set(selectedVersionIds);
  const selectedLab = new Set(selectedLabels);

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
      {/* Labels */}
      <Panel title="Labels">
        <div className="flex flex-wrap gap-1.5">
          {allLabels
            .filter((l) => selectedLab.has(l.name))
            .map((l) => (
              <span
                key={l.name}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-white"
                style={{ background: l.color ?? "#64748b" }}
              >
                {l.name}
                {!readOnly && (
                  <button onClick={() => refresh(() => setIssueLabel(slug, issueId, l.name, false))}>×</button>
                )}
              </span>
            ))}
          {selectedLab.size === 0 && <span className="text-xs text-gray-400">None</span>}
        </div>
        {!readOnly && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!newLabel.trim()) return;
              refresh(() => setIssueLabel(slug, issueId, newLabel.trim(), true));
              setNewLabel("");
            }}
            className="mt-2 flex gap-1"
          >
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              list="ws-labels"
              placeholder="+ Add label"
              className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs"
            />
            <datalist id="ws-labels">
              {allLabels.map((l) => (
                <option key={l.name} value={l.name} />
              ))}
            </datalist>
          </form>
        )}
      </Panel>

      {/* Components */}
      <Panel title="Components">
        {allComponents.length === 0 ? (
          <p className="text-xs text-gray-400">No components defined (add them in Settings).</p>
        ) : (
          <div className="space-y-1">
            {allComponents.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={selectedComp.has(c.id)}
                  onChange={(e) => refresh(() => setIssueComponent(slug, issueId, c.id, e.target.checked))}
                />
                {c.name}
              </label>
            ))}
          </div>
        )}
      </Panel>

      {/* Fix versions */}
      <Panel title="Fix versions">
        {allVersions.length === 0 ? (
          <p className="text-xs text-gray-400">No versions (create them in Releases).</p>
        ) : (
          <div className="space-y-1">
            {allVersions.map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={selectedVer.has(v.id)}
                  onChange={(e) => refresh(() => setIssueFixVersion(slug, issueId, v.id, e.target.checked))}
                />
                {v.name}
                {v.released && <span className="text-[10px] text-green-600">released</span>}
              </label>
            ))}
          </div>
        )}
      </Panel>

      {/* Links */}
      <Panel title="Linked issues">
        <div className="space-y-1">
          {links.map((l) => (
            <div key={l.id} className="flex items-center gap-2 text-sm">
              <span className="text-xs text-gray-500">{l.typeLabel}</span>
              <a
                href={`/w/${slug}/work/${projectKey}/issue/${l.otherNumber}`}
                className="font-mono text-xs text-blue-600 hover:underline"
              >
                {projectKey}-{l.otherNumber}
              </a>
              <span className="min-w-0 flex-1 truncate text-gray-600">{l.otherSummary}</span>
              {!readOnly && (
                <button
                  onClick={() => refresh(() => removeIssueLink(slug, l.id))}
                  className="text-gray-400 hover:text-red-600"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {links.length === 0 && <span className="text-xs text-gray-400">None</span>}
        </div>
        {!readOnly && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!linkTarget) return;
              refresh(() => addIssueLink(slug, issueId, linkTarget, linkType));
              setLinkTarget("");
            }}
            className="mt-2 flex gap-1"
          >
            <select value={linkType} onChange={(e) => setLinkType(e.target.value)} className="rounded border border-gray-200 px-1 py-1 text-xs">
              {ISSUE_LINK_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <select value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)} className="flex-1 rounded border border-gray-200 px-1 py-1 text-xs">
              <option value="">Select issue…</option>
              {linkableIssues.map((i) => (
                <option key={i.id} value={i.id}>
                  {projectKey}-{i.number} {i.summary}
                </option>
              ))}
            </select>
            <button className="rounded bg-gray-800 px-2 py-1 text-xs text-white">Link</button>
          </form>
        )}
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="mb-2 text-xs font-medium text-gray-500">{title}</div>
      {children}
    </div>
  );
}
