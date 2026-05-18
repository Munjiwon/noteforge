"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/notification-actions";

export type NotifItem = {
  id: string;
  kind: string;
  preview: string;
  read: boolean;
  createdAt: string;
  pageId: string | null;
  commentId: string | null;
  workspaceSlug: string | null;
  actor: { name: string; color: string } | null;
};

export function NotificationsButton({
  notifications: initialNotifications,
  workspaceSlug,
}: {
  notifications: NotifItem[];
  workspaceSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  // Polling state — keep an up-to-date view of notifications so a toast
  // can appear when something new arrives without a full refresh.
  const [notifications, setNotifications] = useState<NotifItem[]>(initialNotifications);
  const [toast, setToast] = useState<NotifItem | null>(null);
  const knownIds = useRef<Set<string>>(new Set(initialNotifications.map((n) => n.id)));
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/notifications/recent?workspace=${encodeURIComponent(workspaceSlug)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          unread: number;
          notifications: Array<Omit<NotifItem, "workspaceSlug">>;
        };
        if (cancelled) return;
        const fresh = data.notifications.map((n) => ({ ...n, workspaceSlug }));
        // detect new
        const newOnes = fresh.filter((n) => !knownIds.current.has(n.id));
        for (const n of newOnes) knownIds.current.add(n.id);
        if (newOnes.length > 0) setToast(newOnes[0]);
        setNotifications(fresh);
      } catch {
        /* ignore */
      }
    };
    const t = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [workspaceSlug]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative" ref={ref}>
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-white border border-gray-200 shadow-lg rounded-md px-3 py-2 text-xs max-w-[280px] flex items-start gap-2">
          {toast.actor ? (
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-medium shrink-0"
              style={{ background: toast.actor.color }}
            >
              {toast.actor.name.slice(0, 1).toUpperCase()}
            </span>
          ) : (
            <span className="w-5" />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">
              {toast.actor?.name ?? "Someone"} {
                toast.kind === "mention"
                  ? "mentioned you"
                  : toast.kind === "comment_reply"
                  ? "replied"
                  : toast.kind === "page_updated"
                  ? "edited a page you follow"
                  : toast.kind === "reminder"
                  ? "reminded you"
                  : "commented"
              }
            </div>
            <div className="text-gray-500 truncate">{toast.preview}</div>
          </div>
          <button onClick={() => setToast(null)} className="text-gray-400 hover:text-gray-900">
            ✕
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative px-2 py-1 rounded hover:bg-black/5"
        title="Notifications"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] rounded-full px-1 min-w-[16px] text-center animate-pulse">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded-md shadow-lg w-[360px] max-h-[480px] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-sm font-medium">Notifications</span>
            <span className="flex gap-2 items-center">
              <button
                onClick={() => setUnreadOnly((v) => !v)}
                className={
                  "text-xs " +
                  (unreadOnly ? "text-blue-600" : "text-gray-500 hover:text-gray-900")
                }
              >
                {unreadOnly ? "All" : "Unread only"}
              </button>
              {unread > 0 && (
                <button
                  onClick={() =>
                    start(async () => {
                      await markAllNotificationsRead();
                    })
                  }
                  className="text-xs text-gray-500 hover:text-gray-900"
                >
                  Mark all read
                </button>
              )}
            </span>
          </div>
          <div className="overflow-y-auto max-h-[420px]">
            {(() => {
              const filtered = unreadOnly ? notifications.filter((n) => !n.read) : notifications;
              return filtered.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-8">
                  {unreadOnly ? "No unread notifications." : "You're all caught up."}
                </p>
              ) : (
                <ul>
                  {filtered.map((n) => (
                  <li
                    key={n.id}
                    className={clsx(
                      "border-b border-gray-50 last:border-b-0",
                      !n.read && "bg-blue-50/40",
                    )}
                  >
                    <NotifRow
                      n={n}
                      onOpen={(id) => {
                        setOpen(false);
                        start(async () => {
                          await markNotificationRead(id);
                        });
                      }}
                    />
                  </li>
                ))}
                </ul>
              );
            })()}
          </div>
          <div className="border-t border-gray-100 px-3 py-1.5 text-[11px]">
            <Link
              href={`/w/${workspaceSlug}/inbox`}
              onClick={() => setOpen(false)}
              className="text-gray-500 hover:text-gray-900"
            >
              View all notifications →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function NotifRow({
  n,
  onOpen,
}: {
  n: NotifItem;
  onOpen: (id: string) => void;
}) {
  const verb =
    n.kind === "mention"
      ? "mentioned you"
      : n.kind === "comment_reply"
      ? "replied to your thread"
      : n.kind === "page_updated"
      ? "edited a page you follow"
      : n.kind === "reminder"
      ? "reminded you"
      : "commented";
  const href =
    n.workspaceSlug && n.pageId
      ? `/w/${n.workspaceSlug}/p/${n.pageId}${n.commentId ? `?c=${encodeURIComponent(n.commentId)}` : ""}`
      : "#";

  return (
    <Link
      href={href}
      onClick={() => onOpen(n.id)}
      className="block px-3 py-2 hover:bg-black/5"
    >
      <div className="flex items-start gap-2">
        {n.actor ? (
          <span
            className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-[10px] font-medium shrink-0"
            style={{ background: n.actor.color }}
          >
            {n.actor.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <span className="w-6" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-700">
            <span className="font-medium">{n.actor?.name ?? "Someone"}</span>{" "}
            {verb}
          </div>
          {n.preview && (
            <div className="text-xs text-gray-500 truncate">{n.preview}</div>
          )}
          <div className="text-[10px] text-gray-400 mt-0.5">
            {relative(n.createdAt)}
          </div>
        </div>
        {!n.read && (
          <span className="w-2 h-2 rounded-full bg-blue-500 mt-1 shrink-0" />
        )}
      </div>
    </Link>
  );
}

function relative(iso: string) {
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
