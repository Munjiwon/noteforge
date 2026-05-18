"use client";

import { useEffect, useRef, useState } from "react";

type Source = { id: string; title: string };
type Msg = {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
};

export function AskAiPanel({
  slug,
  getPageText,
}: {
  slug: string;
  getPageText: () => string;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [scope, setScope] = useState<"page" | "workspace">("page");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs.length, open]);

  const ask = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setMsgs((prev) => [...prev, { role: "user", text: q }]);
    setBusy(true);
    try {
      const payload =
        scope === "workspace"
          ? { action: "askWorkspace", question: q, workspaceSlug: slug }
          : { action: "ask", question: q, text: getPageText() };
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        output?: string;
        error?: string;
        configured?: boolean;
        sources?: Source[];
      };
      if (typeof data.configured === "boolean") setConfigured(data.configured);
      const answer =
        data.output ??
        (data.error ? `⚠ ${data.error}` : "(no response)");
      setMsgs((prev) => [
        ...prev,
        { role: "assistant", text: answer, sources: data.sources },
      ]);
    } catch (e) {
      setMsgs((prev) => [
        ...prev,
        { role: "assistant", text: `⚠ ${(e as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-30 w-12 h-12 rounded-full bg-gray-900 text-white shadow-lg hover:opacity-90 flex items-center justify-center text-xl no-print"
          title="Ask AI about this page"
        >
          🤖
        </button>
      )}
      {open && (
        <div className="fixed bottom-5 right-5 z-30 w-[360px] max-w-[95vw] h-[480px] max-h-[80vh] bg-white border border-gray-200 rounded-xl shadow-2xl flex flex-col no-print">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="text-base">🤖</span>
              <span className="text-sm font-medium">Ask AI</span>
            </div>
            <div className="flex items-center gap-1">
              {msgs.length > 0 && (
                <button
                  onClick={() => setMsgs([])}
                  className="text-[11px] text-gray-500 hover:text-gray-900 px-1.5 py-0.5"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-900 px-1"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-100 text-[10px]">
            <span className="text-gray-500">Scope</span>
            <button
              onClick={() => setScope("page")}
              className={
                "px-1.5 py-0.5 rounded " +
                (scope === "page"
                  ? "bg-gray-900 text-white"
                  : "hover:bg-black/5 text-gray-500")
              }
            >
              This page
            </button>
            <button
              onClick={() => setScope("workspace")}
              className={
                "px-1.5 py-0.5 rounded " +
                (scope === "workspace"
                  ? "bg-gray-900 text-white"
                  : "hover:bg-black/5 text-gray-500")
              }
            >
              Workspace
            </button>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {configured === false && (
              <div className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                AI is in placeholder mode. Set OPENAI_API_KEY in apps/web/.env.local for real answers.
              </div>
            )}
            {msgs.length === 0 && (
              <div className="text-xs text-gray-400 text-center py-6">
                Ask anything about the current page — summaries, follow-ups,
                rewriting suggestions.
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i}>
                <div
                  className={
                    "text-sm whitespace-pre-wrap rounded-lg px-3 py-2 " +
                    (m.role === "user"
                      ? "bg-gray-900 text-white ml-8"
                      : "bg-gray-100 text-gray-900 mr-8")
                  }
                >
                  {m.text}
                </div>
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <div className="text-[10px] text-gray-500 mr-8 mt-1 px-3">
                    Sources:{" "}
                    {m.sources.map((s, j) => (
                      <span key={s.id}>
                        {j > 0 ? " · " : ""}
                        <a
                          href={`/w/${slug}/p/${s.id}`}
                          className="hover:underline"
                        >
                          {s.title}
                        </a>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="text-xs text-gray-400">Thinking…</div>
            )}
          </div>
          <div className="border-t border-gray-100 p-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask();
                }
              }}
              placeholder="Ask something about this page…"
              rows={2}
              disabled={busy}
              className="w-full text-sm outline-none resize-none border border-gray-200 rounded p-2 focus:border-gray-400"
            />
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-gray-400">
                Enter to send · Shift+Enter for newline
              </span>
              <button
                onClick={ask}
                disabled={busy || !input.trim()}
                className="text-xs px-3 py-1 rounded bg-gray-900 text-white hover:opacity-90 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
