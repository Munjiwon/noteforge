"use client";

import { useTransition } from "react";
import { markAllNotificationsRead } from "@/app/notification-actions";

export function InboxClient({ slug }: { slug: string }) {
  const [, start] = useTransition();
  return (
    <div className="flex justify-end mb-3">
      <button
        onClick={() => start(async () => { await markAllNotificationsRead(); })}
        className="text-xs text-gray-500 hover:text-gray-900"
        suppressHydrationWarning
      >
        Mark all as read
      </button>
      {/* slug used implicitly via global action; placeholder for future per-WS filtering */}
      <span className="hidden">{slug}</span>
    </div>
  );
}
