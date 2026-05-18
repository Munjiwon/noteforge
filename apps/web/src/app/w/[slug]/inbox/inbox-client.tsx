"use client";

import { useTransition } from "react";
import {
  clearReadNotifications,
  markAllNotificationsRead,
} from "@/app/notification-actions";

export function InboxClient({ slug }: { slug: string }) {
  const [, start] = useTransition();
  return (
    <div className="flex justify-end gap-3 mb-3 text-xs">
      <button
        onClick={() => start(async () => { await markAllNotificationsRead(); })}
        className="text-gray-500 hover:text-gray-900"
        suppressHydrationWarning
      >
        Mark all as read
      </button>
      <button
        onClick={() => {
          if (!confirm("Permanently delete all read notifications?")) return;
          start(async () => { await clearReadNotifications(); });
        }}
        className="text-gray-500 hover:text-red-600"
        suppressHydrationWarning
      >
        Clear read
      </button>
      <span className="hidden">{slug}</span>
    </div>
  );
}
