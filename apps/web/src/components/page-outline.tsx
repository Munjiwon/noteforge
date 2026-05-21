"use client";

import { useEffect, useMemo, useState } from "react";

type Heading = { id: string; level: number; text: string };

function extract(json: string): Heading[] {
  const out: Heading[] = [];
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return out;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (b: any) => {
      if (!b || typeof b !== "object") return;
      if (b.type === "heading" && b.props?.level) {
        let text = "";
        const c = b.content;
        if (Array.isArray(c)) {
          for (const it of c) {
            if (it?.type === "text" && typeof it.text === "string") text += it.text;
          }
        }
        out.push({ id: b.id, level: b.props.level, text: text.trim() });
      }
      if (Array.isArray(b.children)) for (const ch of b.children) walk(ch);
    };
    for (const b of blocks) walk(b);
  } catch {
    /* ignore */
  }
  return out;
}

export function PageOutline({ content }: { content: string }) {
  const allHeadings = useMemo(() => extract(content), [content]);
  // On md and below, allow toggling the outline open/closed via a small button.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [maxDepth, setMaxDepth] = useState<1 | 2 | 3>(3);
  useEffect(() => {
    try {
      const d = localStorage.getItem("noteforge:outline-depth");
      if (d === "1" || d === "2" || d === "3") setMaxDepth(Number(d) as 1 | 2 | 3);
    } catch {}
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setMobileOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const headings = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return allHeadings
      .filter((h) => h.level <= maxDepth)
      .filter((h) => (q ? h.text.toLowerCase().includes(q) : true));
  }, [allHeadings, filter, maxDepth]);
  const setDepth = (d: 1 | 2 | 3) => {
    setMaxDepth(d);
    try {
      localStorage.setItem("noteforge:outline-depth", String(d));
    } catch {}
  };
  if (allHeadings.length === 0) return null;

  const controls = (
    <div className="mb-1 flex items-center gap-1">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter…"
        className="flex-1 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 outline-none focus:border-gray-400"
      />
      {([1, 2, 3] as const).map((d) => (
        <button
          key={d}
          onClick={() => setDepth(d)}
          className={
            "text-[10px] px-1.5 py-0.5 rounded border " +
            (maxDepth === d
              ? "bg-gray-900 text-white border-gray-900"
              : "border-gray-200 hover:bg-black/5")
          }
          title={`Show up to H${d}`}
        >
          H{d}
        </button>
      ))}
    </div>
  );

  const list = (
    <nav className="text-xs space-y-1 border-l-2 border-gray-200 pl-2">
      {headings.map((h) => (
        <a
          key={h.id}
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setMobileOpen(false);
            const el = document.querySelector(
              `[data-id="${h.id}"]`,
            ) as HTMLElement | null;
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className="block text-gray-600 hover:text-blue-600 truncate"
          style={{ paddingLeft: (h.level - 1) * 10 }}
        >
          {h.text || "Untitled heading"}
        </a>
      ))}
    </nav>
  );

  return (
    <>
      {/* Print-only TOC at top of page */}
      <section className="hidden print:block mb-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2">
          Contents
        </h2>
        <ol className="text-sm space-y-1">
          {headings.map((h) => (
            <li
              key={h.id}
              style={{ paddingLeft: (h.level - 1) * 12 }}
              className="list-none"
            >
              {h.text || "(untitled section)"}
            </li>
          ))}
        </ol>
      </section>
      {/* xl+ desktop: fixed sidebar outline */}
      <aside className="hidden xl:block fixed right-4 top-32 w-56 no-print">
        <div className="text-[10px] uppercase text-gray-500 mb-1 tracking-wide">
          Outline
        </div>
        {controls}
        {list}
      </aside>
      {/* below xl: floating button + popover */}
      <div className="xl:hidden fixed bottom-20 right-5 z-30 no-print">
        {mobileOpen ? (
          <div className="bg-white border border-gray-200 rounded-md shadow-xl p-3 w-64 max-h-[60vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase text-gray-500 tracking-wide">
                Outline
              </span>
              <button
                onClick={() => setMobileOpen(false)}
                className="text-gray-400 hover:text-gray-900 text-xs"
              >
                ✕
              </button>
            </div>
            {controls}
            {list}
          </div>
        ) : (
          <button
            onClick={() => setMobileOpen(true)}
            className="w-10 h-10 rounded-full bg-white border border-gray-200 shadow hover:bg-black/5 flex items-center justify-center"
            title="Page outline"
          >
            ☰
          </button>
        )}
      </div>
    </>
  );
}
