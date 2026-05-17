"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { purgePage, restorePage } from "@/app/w/[slug]/actions";

export function TrashBanner({
  slug,
  pageId,
  canEdit,
}: {
  slug: string;
  pageId: string;
  canEdit: boolean;
}) {
  const [, start] = useTransition();
  const router = useRouter();

  return (
    <div className="bg-amber-100 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-sm text-amber-900">
      <span>🗑 This page is in Trash. Read-only.</span>
      {canEdit && (
        <span className="ml-auto flex gap-2">
          <button
            onClick={() => start(() => restorePage(slug, pageId))}
            className="px-2 py-0.5 rounded bg-amber-900 text-amber-50 hover:bg-amber-800 text-xs"
          >
            Restore
          </button>
          <button
            onClick={() => {
              if (!confirm("Permanently delete? This cannot be undone.")) return;
              start(async () => {
                await purgePage(slug, pageId);
                router.push(`/w/${slug}`);
              });
            }}
            className="px-2 py-0.5 rounded border border-amber-900 text-amber-900 hover:bg-amber-200 text-xs"
          >
            Delete permanently
          </button>
        </span>
      )}
    </div>
  );
}
