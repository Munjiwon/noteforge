"use client";

import { useEffect, useState } from "react";

const RECENT_KEY = "collab-notion-emoji-recent";
function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveRecent(emoji: string) {
  try {
    const prev = loadRecent();
    const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, 16);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

const CATEGORIES: { name: string; emojis: string[] }[] = [
  {
    name: "Common",
    emojis: [
      "📄", "📝", "📌", "✅", "🚀", "💡", "📊", "🐛", "🎯", "🗂️",
      "🔥", "👋", "📚", "🎨", "⚙️", "🧪", "🌟", "🔮", "🌱", "🛠️",
    ],
  },
  {
    name: "People",
    emojis: ["😀", "😎", "🤔", "😴", "🥳", "👀", "🙏", "👏", "🤝", "🧠", "💪", "👨‍💻", "👩‍🎨", "🧑‍🔬", "🧑‍🏫"],
  },
  {
    name: "Nature",
    emojis: ["🌸", "🌳", "🌊", "🔥", "🌈", "☀️", "🌙", "⭐", "🪐", "🍀", "🌿", "🌵", "🍂", "❄️", "🌎"],
  },
  {
    name: "Food",
    emojis: ["☕", "🍵", "🍔", "🍕", "🍣", "🥗", "🍎", "🍌", "🍇", "🍷", "🍺", "🍰", "🍪", "🍫", "🍩"],
  },
  {
    name: "Objects",
    emojis: ["💻", "📱", "📷", "🎧", "🕹️", "📀", "💾", "🖥️", "📞", "🔑", "🗝️", "🔒", "🔓", "🎁", "📦"],
  },
  {
    name: "Symbols",
    emojis: ["❤️", "💙", "💚", "💛", "💜", "🖤", "🤍", "⚡", "✨", "💥", "💯", "✔️", "❌", "❓", "❗"],
  },
];

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState("Recent");
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => setRecent(loadRecent()), []);
  const categoriesWithRecent = [
    ...(recent.length > 0 ? [{ name: "Recent", emojis: recent }] : []),
    ...CATEGORIES,
  ];
  const cat =
    categoriesWithRecent.find((c) => c.name === active) ??
    categoriesWithRecent[0];
  const all = CATEGORIES.flatMap((c) => c.emojis);
  const display = q ? all.filter(() => true) : cat.emojis;
  const pick = (e: string) => {
    saveRecent(e);
    onPick(e);
    onClose();
  };
  // very crude search: just filter when q is non-empty by including any from the active cat
  // (real emoji search would need name index)

  return (
    <div className="absolute top-12 left-0 z-20 bg-white shadow-lg border rounded-md p-2 w-[280px]">
      <div className="flex items-center gap-1 mb-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="flex-1 text-xs border border-gray-200 rounded px-2 py-0.5 outline-none"
        />
        <button
          onClick={() => {
            const pool = CATEGORIES.flatMap((c) => c.emojis);
            pick(pool[Math.floor(Math.random() * pool.length)]);
          }}
          className="text-xs text-gray-500 hover:text-gray-900 px-1"
          title="Random emoji"
        >
          🎲
        </button>
        <button
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-gray-900 px-1"
        >
          ✕
        </button>
      </div>
      {!q && (
        <div className="flex flex-wrap gap-0.5 mb-2 border-b border-gray-100 pb-1">
          {categoriesWithRecent.map((c) => (
            <button
              key={c.name}
              onClick={() => setActive(c.name)}
              className={
                "text-[10px] px-1.5 py-0.5 rounded " +
                (c.name === active ? "bg-gray-900 text-white" : "hover:bg-black/5 text-gray-600")
              }
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-8 gap-1 max-h-44 overflow-y-auto">
        {display.map((e, i) => (
          <button
            key={e + i}
            className="text-xl hover:bg-black/5 rounded p-1"
            onClick={() => pick(e)}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
