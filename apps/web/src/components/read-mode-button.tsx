"use client";

import { useEffect, useState } from "react";

export function ReadModeButton() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (active) {
      document.body.classList.add("read-mode");
    } else {
      document.body.classList.remove("read-mode");
    }
    return () => document.body.classList.remove("read-mode");
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  // When read mode is on, the surrounding toolbar is hidden via CSS. We render
  // ourselves as a small fixed floating button so the user can still exit.
  if (active) {
    return (
      <button
        onClick={() => setActive(false)}
        className="read-mode-keep fixed top-4 right-4 z-40 text-xs px-3 py-1.5 rounded-full bg-gray-900 text-white shadow-lg hover:opacity-90"
        title="Exit read mode (Esc)"
      >
        ✕ Read mode
      </button>
    );
  }
  return (
    <button
      onClick={() => setActive(true)}
      className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
      title="Distraction-free read mode"
    >
      📖 Read
    </button>
  );
}
