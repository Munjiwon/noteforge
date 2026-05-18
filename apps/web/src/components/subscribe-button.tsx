"use client";

import { useTransition } from "react";
import { togglePageSubscription } from "@/app/w/[slug]/actions";

export function SubscribeButton({
  slug,
  pageId,
  subscribed,
}: {
  slug: string;
  pageId: string;
  subscribed: boolean;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      onClick={() => start(() => togglePageSubscription(slug, pageId))}
      disabled={pending}
      title={
        subscribed
          ? "You'll stop receiving update notifications for this page"
          : "Get notified the next time someone edits this page"
      }
      className={
        "text-xs px-2 py-1 rounded border " +
        (subscribed
          ? "bg-blue-50 border-blue-200 text-blue-700"
          : "border-gray-200 hover:bg-black/5")
      }
    >
      {subscribed ? "🔔 Subscribed" : "🔕 Subscribe"}
    </button>
  );
}
