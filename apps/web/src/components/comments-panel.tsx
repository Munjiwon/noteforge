"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import clsx from "clsx";
import {
  createComment,
  deleteComment,
  editComment,
  resolveAllComments,
  setCommentResolved,
  toggleReaction,
} from "@/app/w/[slug]/comment-actions";
import { MentionTextarea } from "./mention-textarea";
import { MentionBody } from "./mention-body";
import { Avatar } from "./avatar";

export type CommentItem = {
  id: string;
  body: string;
  resolved: boolean;
  blockId: string | null;
  threadId: string | null;
  createdAt: string;
  author: { id: string; name: string; color: string; avatarUrl?: string | null };
  reactions?: { userId: string; emoji: string }[];
};

const QUICK_EMOJIS = ["👍", "❤️", "🎉", "🚀", "👀", "❓"];

export function CommentsPanel({
  slug,
  pageId,
  comments,
  currentUserId,
  readOnly,
}: {
  slug: string;
  pageId: string;
  comments: CommentItem[];
  currentUserId: string;
  readOnly: boolean;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [mentionsOnly, setMentionsOnly] = useState(false);
  const [sortDir, setSortDirState] = useState<"newest" | "oldest">("newest");
  useEffect(() => {
    try {
      const v = localStorage.getItem("collab-notion-comments-sort");
      if (v === "oldest") setSortDirState("oldest");
    } catch {}
  }, []);
  const setSortDir = (v: "newest" | "oldest" | ((p: "newest" | "oldest") => "newest" | "oldest")) => {
    setSortDirState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try {
        localStorage.setItem("collab-notion-comments-sort", next);
      } catch {}
      return next;
    });
  };
  const [draft, setDraft] = useState("");
  const [, start] = useTransition();

  const threads = new Map<string, CommentItem[]>();
  const tops: CommentItem[] = [];
  for (const c of comments) {
    if (c.threadId) {
      if (!threads.has(c.threadId)) threads.set(c.threadId, []);
      threads.get(c.threadId)!.push(c);
    } else {
      tops.push(c);
    }
  }
  const mentionsMe = (body: string) =>
    new RegExp(`@\\[u:${currentUserId}\\]`).test(body);
  const visible = tops
    .filter((t) => showResolved || !t.resolved)
    .filter((t) => {
      if (!mentionsOnly) return true;
      if (mentionsMe(t.body)) return true;
      const replies = threads.get(t.threadId ?? t.id) ?? [];
      return replies.some((r) => mentionsMe(r.body));
    })
    .sort((a, b) => {
      const da = new Date(a.createdAt).getTime();
      const db_ = new Date(b.createdAt).getTime();
      return sortDir === "newest" ? db_ - da : da - db_;
    });

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    start(async () => {
      await createComment(slug, pageId, body);
    });
  };

  const openCount = tops.filter((t) => !t.resolved).length;
  const resolvedCount = tops.length - openCount;
  const blockAnchored = tops.filter((t) => t.blockId && !t.resolved);

  return (
    <section data-comments-panel className="mt-10 border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">
          Comments
          <span className="ml-2 text-xs text-gray-400">
            {openCount} open
            {blockAnchored.length > 0 ? ` · 📍 ${blockAnchored.length} on blocks` : ""}
            {resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ""}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              setSortDir((d) => (d === "newest" ? "oldest" : "newest"))
            }
            className="text-xs text-gray-500 hover:text-gray-900"
            title="Toggle sort order"
          >
            {sortDir === "newest" ? "↓ Newest" : "↑ Oldest"}
          </button>
          <button
            onClick={() => setMentionsOnly((v) => !v)}
            className={
              "text-xs " +
              (mentionsOnly
                ? "text-blue-700 font-medium"
                : "text-gray-500 hover:text-gray-900")
            }
            title="Show only comments that mention you"
          >
            @ me
          </button>
          {resolvedCount > 0 && (
            <button
              onClick={() => setShowResolved((v) => !v)}
              className="text-xs text-gray-500 hover:text-gray-900"
            >
              {showResolved ? "Hide resolved" : "Show resolved"}
            </button>
          )}
          {!readOnly && openCount > 1 && (
            <button
              onClick={() => {
                if (!confirm(`Resolve all ${openCount} open comments?`)) return;
                start(() => resolveAllComments(slug, pageId));
              }}
              className="text-xs text-gray-500 hover:text-gray-900"
            >
              ✓ Resolve all
            </button>
          )}
        </div>
      </div>

      {blockAnchored.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1">
          {blockAnchored.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                const el = document.querySelector(`[data-id="${c.blockId}"]`) as HTMLElement | null;
                if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
              title={c.body.slice(0, 80)}
            >
              📍 {c.body.slice(0, 24)}{c.body.length > 24 ? "…" : ""}
            </button>
          ))}
        </div>
      )}

      {readOnly && comments.length > 0 && (
        <p className="text-[11px] text-gray-500 mb-3">
          You're viewing this page read-only — new comments are disabled.
        </p>
      )}
      {!readOnly && (
        <div className="mb-4">
          <MentionTextarea
            slug={slug}
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            placeholder="Add a comment… (@ to mention, ⌘+Enter to send)"
            minHeight={60}
          />
          <div className="flex justify-end items-center gap-1 mt-1">
            <AttachButton onAppend={(md) => setDraft((d) => (d ? d + "\n" : "") + md)} />
            <button
              onClick={submit}
              disabled={!draft.trim()}
              className="text-xs px-3 py-1 rounded bg-gray-900 text-white disabled:opacity-30"
            >
              Comment
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="text-xs text-gray-400 py-4 text-center">No comments yet</div>
      ) : (
        <div className="space-y-4">
          {visible.map((c) => (
            <Thread
              key={c.id}
              slug={slug}
              pageId={pageId}
              top={c}
              replies={threads.get(c.id) ?? []}
              currentUserId={currentUserId}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Thread({
  slug,
  pageId,
  top,
  replies,
  currentUserId,
  readOnly,
}: {
  slug: string;
  pageId: string;
  top: CommentItem;
  replies: CommentItem[];
  currentUserId: string;
  readOnly: boolean;
}) {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [, start] = useTransition();

  const submitReply = () => {
    const body = reply.trim();
    if (!body) return;
    setReply("");
    setReplying(false);
    start(async () => {
      await createComment(slug, pageId, body, { threadId: top.id });
    });
  };

  return (
    <div
      className={clsx(
        "border border-gray-200 rounded-md p-3 bg-white",
        top.resolved && "opacity-60",
      )}
    >
      <CommentRow
        comment={top}
        slug={slug}
        currentUserId={currentUserId}
        readOnly={readOnly}
        canResolve
      />
      {replies.length > 0 && (
        <div className="ml-8 mt-0.5 text-[11px] text-gray-500">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </div>
      )}
      {replies.length > 0 && (
        <div className="ml-6 mt-3 space-y-3 border-l border-gray-100 pl-3">
          {replies.map((r) => (
            <CommentRow
              key={r.id}
              comment={r}
              slug={slug}
              currentUserId={currentUserId}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
      {!readOnly && !top.resolved && (
        <div className="ml-6 mt-2">
          {replying ? (
            <div>
              <MentionTextarea
                slug={slug}
                value={reply}
                onChange={setReply}
                onSubmit={submitReply}
                placeholder="Reply… (@ to mention)"
                autoFocus
                minHeight={48}
              />
              <div className="flex gap-2 mt-1">
                <button
                  onClick={submitReply}
                  disabled={!reply.trim()}
                  className="text-xs px-2 py-0.5 rounded bg-gray-900 text-white disabled:opacity-30"
                >
                  Reply
                </button>
                <button
                  onClick={() => {
                    setReplying(false);
                    setReply("");
                  }}
                  className="text-xs px-2 py-0.5 rounded text-gray-500 hover:bg-black/5"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setReplying(true)}
                className="text-xs text-gray-500 hover:text-gray-900"
              >
                Reply
              </button>
              <button
                onClick={() => {
                  const excerpt = top.body
                    .replace(/@\[[^|]+\|([^\]]+)\]/g, "@$1")
                    .slice(0, 80);
                  const suffix = top.body.length > 80 ? "…" : "";
                  setReply(`> ${excerpt}${suffix}\n\n`);
                  setReplying(true);
                }}
                className="text-xs text-gray-500 hover:text-gray-900"
                title="Reply quoting the original"
              >
                ↩ Quote
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  slug,
  currentUserId,
  readOnly,
  canResolve,
}: {
  comment: CommentItem;
  slug: string;
  currentUserId: string;
  readOnly: boolean;
  canResolve?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [, start] = useTransition();
  const mine = comment.author.id === currentUserId;

  const save = () => {
    const body = draft.trim();
    if (!body || body === comment.body) {
      setEditing(false);
      setDraft(comment.body);
      return;
    }
    setEditing(false);
    start(() => editComment(slug, comment.id, body));
  };

  return (
    <div data-comment-id={comment.id}>
      <div className="flex items-center gap-2 text-xs">
        <Avatar user={comment.author} size="sm" />
        <span className="font-medium text-gray-800">{comment.author.name}</span>
        <span className="text-gray-400">{relative(comment.createdAt)}</span>
        {comment.blockId && (
          <button
            type="button"
            onClick={() => {
              const el = document.querySelector(
                `[data-id="${comment.blockId}"]`,
              ) as HTMLElement | null;
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="text-[10px] text-blue-600 hover:underline"
            title="Jump to block"
          >
            📍 block
          </button>
        )}
        {comment.resolved && (
          <span className="text-[10px] uppercase text-emerald-600 ml-1">resolved</span>
        )}
        <span className="ml-auto flex items-center gap-2 text-gray-400">
          <button
            className="hover:text-gray-900"
            onClick={() => {
              const u = new URL(window.location.href);
              u.searchParams.set("c", comment.id);
              void navigator.clipboard?.writeText(u.toString()).then(() => {
                const tip = document.createElement("div");
                tip.textContent = "Comment link copied";
                tip.className =
                  "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                document.body.appendChild(tip);
                setTimeout(() => tip.remove(), 1200);
              });
            }}
            title="Copy direct link to this comment"
          >
            🔗
          </button>
          {canResolve && !readOnly && (
            <button
              className="hover:text-emerald-600"
              onClick={() =>
                start(() => setCommentResolved(slug, comment.id, !comment.resolved))
              }
            >
              {comment.resolved ? "Reopen" : "Resolve"}
            </button>
          )}
          {mine && !readOnly && !editing && (
            <>
              <button onClick={() => setEditing(true)} className="hover:text-gray-900">
                Edit
              </button>
              <button
                onClick={() => {
                  if (confirm("Delete comment?")) {
                    start(() => deleteComment(slug, comment.id));
                  }
                }}
                className="hover:text-red-600"
              >
                Delete
              </button>
            </>
          )}
        </span>
      </div>
      <Reactions
        commentId={comment.id}
        slug={slug}
        currentUserId={currentUserId}
        reactions={comment.reactions ?? []}
      />
      <div className="ml-8 mt-1">
        {editing ? (
          <div>
            <MentionTextarea
              slug={slug}
              value={draft}
              onChange={setDraft}
              onSubmit={save}
              autoFocus
              minHeight={48}
            />
            <div className="flex gap-2 mt-1">
              <button
                onClick={save}
                className="text-xs px-2 py-0.5 rounded bg-gray-900 text-white"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setDraft(comment.body);
                }}
                className="text-xs px-2 py-0.5 rounded text-gray-500 hover:bg-black/5"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <MentionBody body={comment.body} slug={slug} />
        )}
      </div>
    </div>
  );
}

function Reactions({
  commentId,
  slug,
  currentUserId,
  reactions,
}: {
  commentId: string;
  slug: string;
  currentUserId: string;
  reactions: { userId: string; emoji: string }[];
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, start] = useTransition();
  // group by emoji
  const groups = new Map<string, string[]>();
  for (const r of reactions) {
    if (!groups.has(r.emoji)) groups.set(r.emoji, []);
    groups.get(r.emoji)!.push(r.userId);
  }
  const toggle = (emoji: string) => {
    setPickerOpen(false);
    start(async () => {
      await toggleReaction(slug, commentId, emoji);
    });
  };
  const hasThumbs = (groups.get("👍") ?? []).length > 0;
  return (
    <div className="ml-8 mt-1 flex flex-wrap items-center gap-1">
      {!hasThumbs && (
        <button
          onClick={() => toggle("👍")}
          className="text-xs px-1.5 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-blue-700 hover:bg-blue-50"
          title="React with 👍"
        >
          👍
        </button>
      )}
      {Array.from(groups.entries()).map(([emoji, users]) => {
        const mine = users.includes(currentUserId);
        return (
          <button
            key={emoji}
            onClick={() => toggle(emoji)}
            className={
              "text-xs px-1.5 py-0.5 rounded border " +
              (mine
                ? "bg-blue-50 border-blue-200 text-blue-700"
                : "bg-white border-gray-200 hover:bg-black/5")
            }
            title={mine ? "Remove your reaction" : "Add your reaction"}
          >
            {emoji} {users.length}
          </button>
        );
      })}
      <div className="relative">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="text-xs px-1.5 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-gray-700 hover:bg-black/5"
          title="Add reaction"
        >
          ☺ +
        </button>
        {pickerOpen && (
          <div className="absolute z-30 top-full left-0 mt-1 bg-white border border-gray-200 rounded shadow-lg p-1 flex gap-0.5">
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => toggle(e)}
                className="text-base px-1 py-0.5 hover:bg-black/5 rounded"
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AttachButton({ onAppend }: { onAppend: (md: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        onClick={() => fileRef.current?.click()}
        className="text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-black/5"
        title="Attach a file"
      >
        📎
      </button>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const form = new FormData();
          form.append("file", f);
          const res = await fetch("/api/upload", { method: "POST", body: form });
          if (!res.ok) return;
          const data = (await res.json()) as { url: string; name?: string; type?: string };
          const isImage = data.type?.startsWith("image/");
          const md = isImage ? `![${data.name ?? "image"}](${data.url})` : `[${data.name ?? "file"}](${data.url})`;
          onAppend(md);
        }}
      />
    </>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
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
