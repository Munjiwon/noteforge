"use client";

import { useState, useTransition } from "react";
import {
  removeMember,
  renameWorkspace,
  revokeInvite,
  updateMemberRole,
} from "./actions";

type Role = "owner" | "editor" | "viewer";

export function SettingsClient({
  slug,
  workspaceName,
  currentUserId,
  role,
  members,
  invites,
}: {
  slug: string;
  workspaceName: string;
  currentUserId: string;
  role: Role;
  members: { userId: string; name: string; email: string; color: string; role: Role }[];
  invites: { token: string; role: string; createdAt: string }[];
}) {
  const [name, setName] = useState(workspaceName);
  const [, start] = useTransition();
  const isOwner = role === "owner";

  return (
    <div className="max-w-3xl mx-auto px-8 py-10 space-y-8">
      <h1 className="text-2xl font-bold">Workspace settings</h1>

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">General</h2>
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Workspace name</span>
          <input
            value={name}
            disabled={!isOwner}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name.trim() !== workspaceName) {
                start(() => renameWorkspace(slug, name));
              }
            }}
            className="w-full border border-gray-200 rounded px-2 py-1 text-sm outline-none focus:border-gray-400 disabled:bg-gray-50"
          />
        </label>
      </section>

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Members ({members.length})</h2>
        <ul className="border border-gray-200 rounded divide-y divide-gray-100">
          {members.map((m) => {
            const isMe = m.userId === currentUserId;
            return (
              <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
                <span
                  className="inline-flex items-center justify-center w-7 h-7 rounded-full text-white text-xs font-medium"
                  style={{ background: m.color }}
                >
                  {m.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{m.name} {isMe && <span className="text-xs text-gray-400">(you)</span>}</div>
                  <div className="text-xs text-gray-500 truncate">{m.email}</div>
                </div>
                {isOwner ? (
                  <select
                    value={m.role}
                    onChange={(e) =>
                      start(() => updateMemberRole(slug, m.userId, e.target.value as Role))
                    }
                    className="text-xs border border-gray-200 rounded px-1 py-0.5"
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span className="text-xs text-gray-500">{m.role}</span>
                )}
                {isOwner && (
                  <button
                    onClick={() => {
                      if (!confirm(`Remove ${m.name} from this workspace?`)) return;
                      start(() => removeMember(slug, m.userId));
                    }}
                    className="text-xs text-gray-400 hover:text-red-600 px-2"
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {isOwner && (
        <section>
          <h2 className="text-sm font-medium text-gray-700 mb-2">Pending invites ({invites.length})</h2>
          {invites.length === 0 ? (
            <p className="text-xs text-gray-400">
              No active invites. Create one from the sidebar.
            </p>
          ) : (
            <ul className="border border-gray-200 rounded divide-y divide-gray-100">
              {invites.map((i) => (
                <li key={i.token} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <code className="text-xs text-gray-500 truncate">
                    /invite/{i.token}
                  </code>
                  <span className="text-xs text-gray-500 ml-auto">
                    {i.role} · {new Date(i.createdAt).toLocaleDateString()}
                  </span>
                  <button
                    onClick={() => start(() => revokeInvite(slug, i.token))}
                    className="text-xs text-gray-400 hover:text-red-600"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
