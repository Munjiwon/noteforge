"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  inviteGuestByEmail,
  regeneratePublicSlug,
  removePagePermission,
  setPagePermission,
  setPagePublic,
} from "@/app/w/[slug]/actions";

export type PermItem = {
  userId: string;
  name: string;
  color: string;
  role: "view" | "comment" | "edit";
};

export function ShareButton({
  slug,
  pageId,
  initialAccess,
  initialPublicSlug,
  initialPermissions,
  canEdit,
}: {
  slug: string;
  pageId: string;
  initialAccess: "none" | "view";
  initialPublicSlug: string | null;
  initialPermissions: PermItem[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState(initialAccess);
  const [publicSlug, setPublicSlug] = useState(initialPublicSlug);
  const [permissions, setPermissions] = useState<PermItem[]>(initialPermissions);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberResults, setMemberResults] = useState<
    { id: string; name: string; color: string }[]
  >([]);
  const [pickRole, setPickRole] = useState<"view" | "comment" | "edit">("edit");
  const [email, setEmail] = useState("");
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [, start] = useTransition();
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (memberQuery.trim() === "" && memberResults.length === 0) {
      // load initial member list
      fetch(`/api/mentions?ws=${encodeURIComponent(slug)}&q=`)
        .then((r) => r.json())
        .then((d) =>
          setMemberResults(d.users ?? []),
        );
      return;
    }
    const t = setTimeout(() => {
      fetch(
        `/api/mentions?ws=${encodeURIComponent(slug)}&q=${encodeURIComponent(memberQuery)}`,
      )
        .then((r) => r.json())
        .then((d) => setMemberResults(d.users ?? []));
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, memberQuery]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const publicUrl =
    typeof window !== "undefined" && publicSlug
      ? `${window.location.origin}/share/${publicSlug}`
      : "";

  const enable = () =>
    start(async () => {
      const s = await setPagePublic(slug, pageId, "view");
      setAccess("view");
      setPublicSlug(s ?? null);
    });
  const disable = () =>
    start(async () => {
      await setPagePublic(slug, pageId, "none");
      setAccess("none");
      setPublicSlug(null);
    });
  const regen = () =>
    start(async () => {
      const s = await regeneratePublicSlug(slug, pageId);
      setPublicSlug(s);
    });

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
      >
        {access === "view" ? "🌐 Shared" : "Share"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white shadow-lg border rounded-md w-[360px] p-3 max-h-[80vh] overflow-y-auto">
          <div className="text-sm font-medium mb-2">Share this page</div>
          <p className="text-[11px] text-gray-500 mb-2">
            Workspace members already have the workspace-wide role (owner /
            editor / viewer). Use the controls below to grant extra access
            to specific people or anyone with the link.
          </p>
          {canEdit && (
            <section className="mb-3">
              <div className="text-xs text-gray-500 mb-1">Invite by email</div>
              <div className="flex gap-1 mb-2">
                <input
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailMsg(null);
                  }}
                  placeholder="name@example.com"
                  type="email"
                  className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 outline-none"
                />
                <button
                  onClick={() =>
                    start(async () => {
                      const res = await inviteGuestByEmail(slug, pageId, email, pickRole);
                      if (res.ok) {
                        setEmail("");
                        setEmailMsg("Invited. Refreshing…");
                        // permissions list will refresh via revalidatePath; force local refresh next open
                      } else {
                        setEmailMsg(res.error);
                      }
                    })
                  }
                  disabled={!email.trim()}
                  className="text-xs px-2 py-1 rounded bg-gray-900 text-white disabled:opacity-30"
                >
                  Invite
                </button>
              </div>
              {emailMsg && (
                <p className="text-[11px] text-gray-500 mb-2">{emailMsg}</p>
              )}
              <div className="text-xs text-gray-500 mb-1">Invite workspace members</div>
              <div className="flex gap-1 mb-1">
                <input
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                  placeholder="Search members…"
                  className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 outline-none"
                />
                <select
                  value={pickRole}
                  onChange={(e) => setPickRole(e.target.value as "view" | "comment" | "edit")}
                  className="text-xs border border-gray-200 rounded px-1 py-1"
                >
                  <option value="view">View</option>
                  <option value="comment">Comment</option>
                  <option value="edit">Edit</option>
                </select>
              </div>
              <ul className="max-h-32 overflow-y-auto border border-gray-100 rounded">
                {memberResults
                  .filter((m) => !permissions.find((p) => p.userId === m.id))
                  .map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() =>
                          start(async () => {
                            await setPagePermission(slug, pageId, m.id, pickRole);
                            setPermissions((prev) => [
                              ...prev,
                              {
                                userId: m.id,
                                name: m.name,
                                color: m.color,
                                role: pickRole,
                              },
                            ]);
                          })
                        }
                        className="w-full text-left flex items-center gap-2 text-xs px-2 py-1 hover:bg-black/5"
                      >
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium"
                          style={{ background: m.color }}
                        >
                          {m.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span>{m.name}</span>
                        <span className="ml-auto text-gray-400">+ {pickRole}</span>
                      </button>
                    </li>
                  ))}
                {memberResults.length === 0 && (
                  <li className="text-xs text-gray-400 px-2 py-1">No members.</li>
                )}
              </ul>
            </section>
          )}
          {permissions.length > 0 && (
            <section className="mb-3">
              <div className="text-xs text-gray-500 mb-1">People with explicit access</div>
              <ul className="border border-gray-100 rounded divide-y divide-gray-50">
                {permissions.map((p) => (
                  <li
                    key={p.userId}
                    className="flex items-center gap-2 px-2 py-1 text-xs"
                  >
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium"
                      style={{ background: p.color }}
                    >
                      {p.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="flex-1 truncate">{p.name}</span>
                    {canEdit ? (
                      <select
                        value={p.role}
                        onChange={(e) => {
                          const newRole = e.target.value as "view" | "comment" | "edit";
                          start(async () => {
                            await setPagePermission(slug, pageId, p.userId, newRole);
                            setPermissions((prev) =>
                              prev.map((x) =>
                                x.userId === p.userId ? { ...x, role: newRole } : x,
                              ),
                            );
                          });
                        }}
                        className="text-xs border border-gray-200 rounded px-1 py-0.5"
                      >
                        <option value="view">View</option>
                        <option value="comment">Comment</option>
                        <option value="edit">Edit</option>
                      </select>
                    ) : (
                      <span className="text-gray-500">{p.role}</span>
                    )}
                    {canEdit && (
                      <button
                        onClick={() =>
                          start(async () => {
                            await removePagePermission(slug, pageId, p.userId);
                            setPermissions((prev) =>
                              prev.filter((x) => x.userId !== p.userId),
                            );
                          })
                        }
                        className="text-gray-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="border-t border-gray-100 pt-3">
          {access === "view" && publicSlug ? (
            <>
              <p className="text-xs text-gray-500 mb-2">
                Anyone with the link can view (read-only).
              </p>
              <div className="flex gap-1">
                <input
                  readOnly
                  value={publicUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 outline-none"
                />
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(publicUrl);
                  }}
                  className="text-xs px-2 py-1 rounded bg-gray-900 text-white"
                >
                  Copy
                </button>
              </div>
              {canEdit && (
                <div className="flex justify-between mt-2 text-xs">
                  <button
                    onClick={regen}
                    className="text-gray-500 hover:text-gray-900"
                  >
                    Regenerate link
                  </button>
                  <button
                    onClick={disable}
                    className="text-red-600 hover:underline"
                  >
                    Stop sharing
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">
                Generate a public read-only link.
              </p>
              {canEdit ? (
                <button
                  onClick={enable}
                  className="text-xs px-3 py-1 rounded bg-gray-900 text-white"
                >
                  Create public link
                </button>
              ) : (
                <p className="text-xs text-gray-400">
                  Only editors can share this page.
                </p>
              )}
            </>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
