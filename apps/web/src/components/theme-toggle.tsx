"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "collab-notion-theme";

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? null;
    const initial: Theme = stored ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial);
    applyTheme(initial);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  return (
    <button
      onClick={toggle}
      className="text-xs px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
    >
      {theme === "dark" ? "🌙" : "☀️"}
    </button>
  );
}

export function ThemeBootstrap() {
  useEffect(() => {
    try {
      const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? null;
      const initial: Theme =
        stored ??
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      applyTheme(initial);
    } catch {
      // ignore
    }
  }, []);
  return null;
}
