"use client";

import { useState } from "react";

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
  const [active, setActive] = useState(CATEGORIES[0].name);
  const [q, setQ] = useState("");
  const cat = CATEGORIES.find((c) => c.name === active) ?? CATEGORIES[0];
  const all = CATEGORIES.flatMap((c) => c.emojis);
  const display = q ? all.filter(() => true) : cat.emojis;
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
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-gray-900 px-1"
        >
          ✕
        </button>
      </div>
      {!q && (
        <div className="flex flex-wrap gap-0.5 mb-2 border-b border-gray-100 pb-1">
          {CATEGORIES.map((c) => (
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
            onClick={() => {
              onPick(e);
              onClose();
            }}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
