"use client";

import { useState, useTransition } from "react";
import { createInvite } from "@/app/w/[slug]/actions";

export function InviteButton({ slug }: { slug: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function generate() {
    start(async () => {
      const token = await createInvite(slug);
      const url = `${window.location.origin}/invite/${token}`;
      setLink(url);
      try {
        await navigator.clipboard.writeText(url);
      } catch {}
    });
  }

  return (
    <div>
      <button
        onClick={generate}
        disabled={pending}
        className="w-full text-sm bg-accent/10 text-accent rounded py-1.5 hover:bg-accent/20 disabled:opacity-50"
      >
        {pending ? "Generating…" : "Invite members"}
      </button>
      {link && (
        <p className="mt-2 text-[11px] text-gray-600 break-all">
          Copied to clipboard:<br />
          <span className="font-mono">{link}</span>
        </p>
      )}
    </div>
  );
}
