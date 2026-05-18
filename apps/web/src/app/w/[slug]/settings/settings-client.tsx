"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteWorkspace,
  exportWorkspaceMarkdown,
  removeMember,
  renameWorkspace,
  revokeInvite,
  setWorkspaceColor,
  setWorkspaceIcon,
  updateMemberRole,
} from "./actions";
import { EmojiPicker } from "@/components/emoji-picker";
import { createApiToken, deleteApiToken } from "@/app/api-token-actions";

type Role = "owner" | "editor" | "viewer";

export function SettingsClient({
  slug,
  workspaceName,
  workspaceIcon,
  workspaceColor,
  currentUserId,
  role,
  members,
  invites,
  stats,
  tokens = [],
}: {
  slug: string;
  workspaceName: string;
  workspaceIcon: string | null;
  workspaceColor: string | null;
  currentUserId: string;
  role: Role;
  members: { userId: string; name: string; email: string; color: string; role: Role }[];
  invites: { token: string; role: string; createdAt: string }[];
  stats?: { pageCount: number; commentCount: number; lastActivityAt: string | null };
  tokens?: { id: string; name: string; lastUsedAt: string | null; createdAt: string }[];
}) {
  const [name, setName] = useState(workspaceName);
  const [icon, setIcon] = useState(workspaceIcon);
  const [color, setColor] = useState(workspaceColor ?? "#111111");
  const [iconOpen, setIconOpen] = useState(false);
  const [, start] = useTransition();
  const router = useRouter();
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [memberQ, setMemberQ] = useState("");
  const isOwner = role === "owner";
  const PRESET_COLORS = ["#111111", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#0ea5e9"];

  return (
    <div className="max-w-3xl mx-auto px-8 py-10 space-y-8">
      <h1 className="text-2xl font-bold">Workspace settings</h1>

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">General</h2>
        <div className="flex items-center gap-3 mb-3">
          <div className="relative">
            <button
              disabled={!isOwner}
              onClick={() => setIconOpen((v) => !v)}
              className="w-12 h-12 rounded grid place-items-center text-xl text-white"
              style={{ background: color }}
            >
              {icon ?? name.slice(0, 1).toUpperCase()}
            </button>
            {iconOpen && (
              <EmojiPicker
                onPick={(e) => {
                  setIcon(e);
                  start(() => setWorkspaceIcon(slug, e));
                }}
                onClose={() => setIconOpen(false)}
              />
            )}
          </div>
          <div className="flex-1">
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
            {isOwner && (
              <div className="flex items-center gap-1 mt-2">
                <span className="text-xs text-gray-500 mr-1">Color:</span>
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      setColor(c);
                      start(() => setWorkspaceColor(slug, c));
                    }}
                    className={
                      "w-5 h-5 rounded-full border-2 " +
                      (color === c ? "border-gray-900" : "border-transparent")
                    }
                    style={{ background: c }}
                  />
                ))}
                {icon && (
                  <button
                    onClick={() => {
                      setIcon(null);
                      start(() => setWorkspaceIcon(slug, null));
                    }}
                    className="ml-2 text-[11px] text-gray-500 hover:text-gray-900"
                  >
                    Clear icon
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Export</h2>
        <button
          onClick={() =>
            start(async () => {
              const md = await exportWorkspaceMarkdown(slug);
              const blob = new Blob([md], { type: "text/markdown" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = workspaceName.replace(/[^\w\d-]+/g, "_") + ".md";
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            })
          }
          className="text-xs px-3 py-1 rounded border border-gray-200 hover:bg-black/5"
        >
          ⬇ Download all pages as Markdown
        </button>
      </section>

      {stats && (
        <section>
          <h2 className="text-sm font-medium text-gray-700 mb-2">At a glance</h2>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="border border-gray-200 rounded p-3">
              <div className="text-xs text-gray-500">Pages</div>
              <div className="text-2xl font-semibold">{stats.pageCount}</div>
            </div>
            <div className="border border-gray-200 rounded p-3">
              <div className="text-xs text-gray-500">Comments</div>
              <div className="text-2xl font-semibold">{stats.commentCount}</div>
            </div>
            <div className="border border-gray-200 rounded p-3">
              <div className="text-xs text-gray-500">Last activity</div>
              <div className="text-sm font-medium">
                {stats.lastActivityAt
                  ? new Date(stats.lastActivityAt).toLocaleString()
                  : "—"}
              </div>
            </div>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Members ({members.length})</h2>
        {members.length > 6 && (
          <input
            value={memberQ}
            onChange={(e) => setMemberQ(e.target.value)}
            placeholder="Search members…"
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 outline-none mb-2"
          />
        )}
        <ul className="border border-gray-200 rounded divide-y divide-gray-100">
          {members
            .filter((m) => !memberQ ? true : (m.name + " " + m.email).toLowerCase().includes(memberQ.toLowerCase()))
            .map((m) => {
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

      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">API tokens ({tokens.length})</h2>
        <p className="text-xs text-gray-500 mb-2">
          Personal access tokens for the public REST API (<code>/api/v1/pages</code>).
          Send as <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
        <div className="flex gap-1 mb-2">
          <input
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder="Token name (e.g. CLI)"
            className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm outline-none"
          />
          <button
            onClick={() =>
              start(async () => {
                const t = await createApiToken(tokenName || "Untitled");
                setNewToken(t);
                setTokenName("");
              })
            }
            className="text-xs px-3 py-1 rounded bg-gray-900 text-white"
          >
            Create
          </button>
        </div>
        {newToken && (
          <div className="mb-2 text-xs bg-yellow-50 border border-yellow-200 rounded px-2 py-1">
            <strong>Copy now — it won't be shown again:</strong>
            <code className="block break-all mt-1 select-all">{newToken}</code>
            <button
              onClick={() => setNewToken(null)}
              className="mt-1 text-gray-500 hover:text-gray-900"
            >
              Dismiss
            </button>
          </div>
        )}
        {tokens.length > 0 && (
          <ul className="border border-gray-200 rounded divide-y divide-gray-100">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="flex-1 truncate">{t.name}</span>
                <span className="text-xs text-gray-400">
                  {t.lastUsedAt ? "used " + new Date(t.lastUsedAt).toLocaleDateString() : "never used"}
                </span>
                <button
                  onClick={() => {
                    if (!confirm("Revoke this token?")) return;
                    start(() => deleteApiToken(t.id));
                  }}
                  className="text-xs text-gray-400 hover:text-red-600"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <ClipperHint slug={slug} />
      </section>

      {isOwner && (
        <section className="border border-red-200 bg-red-50/30 rounded p-3">
          <h2 className="text-sm font-medium text-red-700 mb-1">Danger zone</h2>
          <p className="text-xs text-gray-600 mb-2">
            Permanently delete this workspace and all of its pages, comments,
            and data. This action cannot be undone.
          </p>
          <p className="text-xs text-gray-600 mb-1">
            Type <code className="bg-white border border-gray-200 px-1 rounded">{workspaceName}</code> to
            confirm.
          </p>
          <div className="flex gap-2">
            <input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="Workspace name"
              className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm outline-none"
            />
            <button
              onClick={() => {
                if (deleteConfirm !== workspaceName) return;
                if (!confirm("This will permanently delete the workspace. Continue?")) return;
                start(async () => {
                  await deleteWorkspace(slug, deleteConfirm);
                  router.push("/");
                });
              }}
              disabled={deleteConfirm !== workspaceName}
              className="text-xs px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-30"
            >
              Delete workspace
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function ClipperHint({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  // Bookmarklet that prompts for the user's token once, stores it, and posts
  // the current tab to /api/v1/clip. Replace the origin with the deployed
  // server's URL when sharing externally.
  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const code =
    "javascript:" +
    "(function(){var o='" +
    origin +
    "',k=localStorage.getItem('nf_clip_token');if(!k){k=prompt('Paste your API token:');if(!k)return;localStorage.setItem('nf_clip_token',k);}var s=getSelection().toString();fetch(o+'/api/v1/clip',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+k},body:JSON.stringify({workspaceSlug:'" +
    slug +
    "',url:location.href,title:document.title,content:s||document.body.innerText.slice(0,4000)})}).then(r=>r.json()).then(d=>{if(d.url){location.href=o+d.url;}else{alert('Clip failed: '+(d.error||'unknown'));}}).catch(e=>alert(e));})();";
  return (
    <details className="mt-3 text-xs border border-gray-100 rounded p-2 bg-gray-50">
      <summary className="cursor-pointer text-gray-600">
        🔖 Web clipper bookmarklet
      </summary>
      <p className="text-gray-500 mt-2">
        Drag this link to your bookmarks bar. Open any page and click it — the
        current page gets clipped into this workspace.
      </p>
      <p className="mt-2">
        <a
          href={code}
          className="text-xs px-2 py-1 rounded bg-gray-900 text-white inline-block no-underline"
          onClick={(e) => e.preventDefault()}
        >
          Clip to {slug}
        </a>
      </p>
      <p className="mt-2 text-gray-500">Or copy the source:</p>
      <pre className="mt-1 bg-white border border-gray-200 rounded p-2 text-[10px] overflow-x-auto whitespace-pre-wrap break-all">
        {code}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="mt-1 text-[11px] text-gray-500 hover:text-gray-900"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </details>
  );
}
