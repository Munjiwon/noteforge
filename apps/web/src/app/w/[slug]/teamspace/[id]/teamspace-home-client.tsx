"use client";

import { useState, useTransition } from "react";
import {
  renameTeamspace,
  setTeamspaceIcon,
  setTeamspaceDescription,
  setTeamspaceAccess,
  addTeamspaceMember,
  removeTeamspaceMember,
} from "@/app/w/[slug]/teamspace-actions";

type Member = {
  id: string;
  name: string;
  email: string;
  color: string;
  avatarUrl: string | null;
  role: string;
};

export function TeamspaceHomeClient({
  slug,
  teamspace,
  currentUserId,
  canEdit,
  workspaceMembers,
  memberIds,
  memberRoles,
}: {
  slug: string;
  teamspace: { id: string; name: string; description: string; access: "open" | "closed" | "private" };
  currentUserId: string;
  canEdit: boolean;
  workspaceMembers: Member[];
  memberIds: string[];
  memberRoles: Record<string, string>;
}) {
  const [ts, setTs] = useState(teamspace);
  const [ids, setIds] = useState<Set<string>>(new Set(memberIds));
  const [pending, start] = useTransition();
  if (!canEdit) {
    return (
      <section className="border border-gray-200 rounded p-4">
        <p className="text-xs text-gray-500">
          Viewer access — settings are read-only.
        </p>
      </section>
    );
  }
  return (
    <section className="border border-gray-200 rounded p-4 space-y-3">
      <h2 className="text-sm font-semibold text-gray-700">Teamspace settings</h2>
      <label className="block">
        <span className="block text-[11px] text-gray-500 mb-1">Name</span>
        <input
          type="text"
          value={ts.name}
          onChange={(e) => setTs((s) => ({ ...s, name: e.target.value }))}
          onBlur={() => start(() => renameTeamspace(slug, ts.id, ts.name))}
          className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400"
        />
      </label>
      <label className="block">
        <span className="block text-[11px] text-gray-500 mb-1">Icon (emoji)</span>
        <input
          type="text"
          maxLength={4}
          placeholder="👥"
          onBlur={(e) =>
            start(() =>
              setTeamspaceIcon(slug, ts.id, e.target.value.trim() || null),
            )
          }
          className="w-24 text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400"
        />
      </label>
      <label className="block">
        <span className="block text-[11px] text-gray-500 mb-1">Description</span>
        <textarea
          value={ts.description}
          onChange={(e) => setTs((s) => ({ ...s, description: e.target.value }))}
          onBlur={() => start(() => setTeamspaceDescription(slug, ts.id, ts.description))}
          rows={3}
          className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400"
        />
      </label>
      <label className="block">
        <span className="block text-[11px] text-gray-500 mb-1">Access</span>
        <select
          value={ts.access}
          onChange={(e) => {
            const next = e.target.value as "open" | "closed" | "private";
            setTs((s) => ({ ...s, access: next }));
            start(() => setTeamspaceAccess(slug, ts.id, next));
          }}
          className="text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-blue-400"
        >
          <option value="open">🌐 Open — any workspace member can join</option>
          <option value="closed">🔐 Closed — invite only</option>
          <option value="private">🔒 Private — invisible to non-members</option>
        </select>
      </label>
      <div>
        <h3 className="text-xs font-semibold text-gray-700 mt-2 mb-1">
          Members ({ids.size})
        </h3>
        <ul className="divide-y divide-gray-100">
          {workspaceMembers.map((m) => {
            const on = ids.has(m.id);
            const role = memberRoles[m.id];
            const isMe = m.id === currentUserId;
            return (
              <li key={m.id} className="flex items-center gap-2 py-1.5">
                <button
                  disabled={pending}
                  onClick={() => {
                    const next = new Set(ids);
                    if (on) next.delete(m.id);
                    else next.add(m.id);
                    setIds(next);
                    start(async () => {
                      if (on) await removeTeamspaceMember(slug, ts.id, m.id);
                      else await addTeamspaceMember(slug, ts.id, m.id);
                    });
                  }}
                  className="w-5 text-center text-xs"
                >
                  {on ? "✓" : "·"}
                </button>
                <span
                  className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-[10px] font-medium shrink-0"
                  style={{ background: m.color }}
                >
                  {m.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-gray-900 truncate">
                    {m.name}
                    {isMe && <span className="ml-1 text-gray-400 text-[10px]">(you)</span>}
                  </span>
                  <span className="block text-[10px] text-gray-500 truncate">{m.email}</span>
                </span>
                {on && role && (
                  <span className="text-[10px] text-gray-400">{role}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
