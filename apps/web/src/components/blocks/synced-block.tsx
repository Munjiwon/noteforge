"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";

// A synced block is a shared chunk of text whose content lives in the
// SyncedBlock table — keyed by syncedBlockId. Every page that references the
// same ID renders the same content. Refreshes once a minute so concurrent
// edits propagate without realtime infrastructure.

export const SyncedBlock = createReactBlockSpec(
  {
    type: "synced",
    propSchema: {
      syncedBlockId: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const id = (block.props.syncedBlockId as string) ?? "";
      const [content, setContent] = useState("");
      const [draft, setDraft] = useState("");
      const [editing, setEditing] = useState(false);
      const [loading, setLoading] = useState(true);
      const [updatedAt, setUpdatedAt] = useState<string | null>(null);
      const fetchedFor = useRef<string | null>(null);

      async function refresh(target: string) {
        try {
          const res = await fetch(
            `/api/synced-block/${encodeURIComponent(target)}`,
          );
          if (!res.ok) return;
          const data = (await res.json()) as {
            content: string;
            updatedAt: string;
          };
          setContent(data.content);
          setUpdatedAt(data.updatedAt);
        } finally {
          setLoading(false);
        }
      }

      // Lazy create if no ID is set yet.
      useEffect(() => {
        if (id || fetchedFor.current === "creating") return;
        fetchedFor.current = "creating";
        const slug = window.location.pathname.split("/")[2];
        fetch("/api/synced-block", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceSlug: slug }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { id?: string } | null) => {
            if (!data?.id) return;
            editor.updateBlock(block, {
              props: {
                ...(block.props as Record<string, unknown>),
                syncedBlockId: data.id,
              },
            } as never);
          });
      }, [id, block, editor]);

      // Fetch content + poll periodically.
      useEffect(() => {
        if (!id || fetchedFor.current === id) return;
        fetchedFor.current = id;
        refresh(id);
        const t = setInterval(() => refresh(id), 60_000);
        return () => clearInterval(t);
      }, [id]);

      async function save() {
        if (!id) return;
        const res = await fetch(
          `/api/synced-block/${encodeURIComponent(id)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: draft }),
          },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            content: string;
            updatedAt: string;
          };
          setContent(data.content);
          setUpdatedAt(data.updatedAt);
        }
        setEditing(false);
      }

      return (
        <div className="w-full border-l-4 border-purple-300 bg-purple-50/40 my-2 rounded-r-md">
          <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-purple-700">
            <span>🔗 Synced</span>
            {updatedAt && (
              <span className="text-purple-400">
                · updated {new Date(updatedAt).toLocaleString()}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {id && !editing && (
                <button
                  onClick={() => {
                    navigator.clipboard
                      .writeText(id)
                      .then(() => alert(`Reference ID copied:\n${id}\nUse "Synced block" → "Existing" to insert.`))
                      .catch(() => {});
                  }}
                  className="hover:underline"
                >
                  Copy reference
                </button>
              )}
              {!editing ? (
                <button
                  onClick={() => {
                    setDraft(content);
                    setEditing(true);
                  }}
                  className="hover:underline"
                >
                  Edit
                </button>
              ) : (
                <>
                  <button onClick={save} className="hover:underline">
                    Save
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="hover:underline"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="px-3 pb-3">
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write something — this text will appear in every synced block instance."
                rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
                className="w-full text-sm border border-purple-200 rounded p-2 outline-none focus:border-purple-400 bg-white"
              />
            ) : loading && !content ? (
              <div className="text-xs text-purple-400">Loading…</div>
            ) : content ? (
              <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 m-0">
                {content}
              </pre>
            ) : (
              <div className="text-xs text-purple-400 italic">
                Empty. Click Edit to write the shared content.
              </div>
            )}
          </div>
        </div>
      );
    },
  },
);
