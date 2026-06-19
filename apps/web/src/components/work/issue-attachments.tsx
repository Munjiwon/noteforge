"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addIssueAttachment,
  deleteIssueAttachment,
} from "@/app/w/[slug]/work/work-extra-actions";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function IssueAttachments({
  slug,
  issueId,
  attachments,
  currentUserId,
  readOnly,
}: {
  slug: string;
  issueId: string;
  attachments: { id: string; url: string; name: string; size: number; uploadedById: string | null; createdAt: string }[];
  currentUserId: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `upload failed (${res.status})`);
      }
      const { url, name, size } = await res.json();
      await addIssueAttachment(slug, issueId, url, name, size);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const isImage = (n: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);

  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Attachments ({attachments.length})</span>
        {!readOnly && (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "+ Attach file"}
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPick(f);
              }}
            />
          </>
        )}
      </div>
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
      {attachments.length === 0 ? (
        <p className="text-xs text-gray-400">No attachments.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div key={a.id} className="group relative w-28 rounded border border-gray-200 p-1.5 text-center">
              <a href={a.url} target="_blank" rel="noreferrer" className="block">
                {isImage(a.name) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.url} alt={a.name} className="mb-1 h-16 w-full rounded object-cover" />
                ) : (
                  <div className="mb-1 flex h-16 items-center justify-center rounded bg-gray-50 text-2xl">📎</div>
                )}
                <div className="truncate text-[11px]" title={a.name}>{a.name}</div>
                <div className="text-[10px] text-gray-400">{formatBytes(a.size)}</div>
              </a>
              {!readOnly && (a.uploadedById === currentUserId) && (
                <button
                  onClick={() => start(async () => { await deleteIssueAttachment(slug, a.id); router.refresh(); })}
                  className="absolute right-0.5 top-0.5 hidden rounded bg-white/90 px-1 text-xs text-gray-400 hover:text-red-600 group-hover:block"
                  title="Delete"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
