"use client";

import { useEffect, useState } from "react";

const GROUPS: { name: string; items: { keys: string; desc: string }[] }[] = [
  {
    name: "Navigation",
    items: [
      { keys: "⌘ K / ⌘ P", desc: "Open search palette / jump to page" },
      { keys: "⌘ F", desc: "Find within the current page (browser)" },
      { keys: "⌘ ⇧ L", desc: "Switch workspace" },
      { keys: "⌘ ⇧ B", desc: "Toggle favorite on current page" },
      { keys: "⌘ ⇧ I", desc: "Quick-capture a note into 📥 Inbox" },
      { keys: "⌘ D", desc: "Duplicate the current page (with sub-pages)" },
      { keys: "⌘ N", desc: "Create a new page at workspace root" },
      { keys: "⌘ \\", desc: "Collapse / expand the sidebar" },
      { keys: "⌘ ⌫", desc: "Archive the current page" },
      { keys: "?", desc: "Show this help" },
      { keys: "Esc", desc: "Close dialogs / palettes / exit read mode" },
    ],
  },
  {
    name: "Editor",
    items: [
      { keys: "/", desc: "Open block / slash menu" },
      { keys: "@", desc: "Mention person or page" },
      { keys: "⌘ B", desc: "Bold" },
      { keys: "⌘ I", desc: "Italic" },
      { keys: "⌘ Shift S", desc: "Strikethrough" },
      { keys: "⌘ E", desc: "Inline code" },
      { keys: "⌘ Z / ⌘ Shift Z", desc: "Undo / Redo" },
      { keys: "Tab / Shift Tab", desc: "Indent / outdent block" },
      { keys: "/ai", desc: "AI: Summarize · Translate · Improve · Continue" },
      { keys: "⌘ J", desc: "AI · Edit current selection (or surrounding text)" },
    ],
  },
  {
    name: "Page",
    items: [
      { keys: "Click ☆ next to title", desc: "Star this page (= add to Favorites)" },
      { keys: "📖 Read", desc: "Distraction-free reading mode" },
      { keys: "🤖 (bottom-right)", desc: "Open Ask AI — scope: this page / workspace" },
      { keys: "⏰ Remind", desc: "Schedule a reminder (one-off or recurring)" },
      { keys: "🔔 Subscribe", desc: "Get notified on first edit after idle" },
      { keys: "📦 Archive", desc: "Hide from sidebar without trashing" },
    ],
  },
  {
    name: "Comments",
    items: [
      { keys: "⌘ Enter", desc: "Submit comment" },
    ],
  },
  {
    name: "Database",
    items: [
      { keys: "Drag card", desc: "Move between Kanban columns / Calendar days" },
      { keys: "Drag row", desc: "Reorder rows in Table view" },
      { keys: "Drag column edge", desc: "Resize Table column width" },
      { keys: "↗ Open", desc: "Open row as full page" },
      { keys: "👁 Peek", desc: "Open row as a side modal preview" },
    ],
  },
  {
    name: "Sidebar",
    items: [
      { keys: "Tab", desc: "Cycle through sidebar pages (browser default focus)" },
      { keys: "Hover ★", desc: "Toggle favorite on a page" },
      { keys: "+", desc: "Add sub-page or sub-database" },
      { keys: "Drag page", desc: "Reorder or nest under another page" },
      { keys: "Select / Done", desc: "Multi-select pages for bulk delete or favorite" },
      { keys: "‹ / ›", desc: "Collapse / expand the sidebar" },
    ],
  },
];

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inForm =
        target && (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        );
      if (!inForm && e.key === "?") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[680px] max-w-[95vw] max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
          <h2 className="text-sm font-medium">Keyboard shortcuts</h2>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-900">
            ✕
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 overflow-y-auto">
          {GROUPS.map((g) => (
            <section key={g.name}>
              <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                {g.name}
              </h3>
              <ul className="space-y-0.5">
                {g.items.map((it) => (
                  <li key={it.keys} className="flex items-center justify-between text-sm py-0.5">
                    <span className="text-gray-700">{it.desc}</span>
                    <kbd className="text-[11px] text-gray-500 border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50">
                      {it.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
