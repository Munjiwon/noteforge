"use client";

import { useState, useTransition } from "react";
import { joinTeamspace } from "@/app/w/[slug]/teamspace-actions";

export function JoinTeamspaceButton({
  slug,
  teamspaceId,
}: {
  slug: string;
  teamspaceId: string;
}) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <span className="text-xs px-3 py-1.5 rounded bg-green-50 text-green-700">
        ✓ Joined
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await joinTeamspace(slug, teamspaceId);
          setDone(true);
        })
      }
      className="text-xs px-3 py-1.5 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
    >
      {pending ? "Joining…" : "+ Join teamspace"}
    </button>
  );
}
