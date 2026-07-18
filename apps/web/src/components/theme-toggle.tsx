"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "auto";

const STORAGE_KEY = "collab-notion-theme";

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const effective =
    theme === "auto"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  if (effective === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? null;
    const initial: Theme = stored ?? "light";
    setTheme(initial);
    applyTheme(initial);
    // when in auto mode, react to system changes
    const mql = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const cur = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "light";
      if (cur === "auto") applyTheme("auto");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const cycle = () => {
    const next: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  // ⌘⇧D — quick toggle (jumps directly between light and dark)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const next: Theme = theme === "dark" ? "light" : "dark";
        setTheme(next);
        localStorage.setItem(STORAGE_KEY, next);
        applyTheme(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theme]);

  const icon = theme === "auto" ? "🖥" : theme === "dark" ? "🌙" : "☀️";
  return (
    <button
      onClick={cycle}
      className="text-xs px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
      title={`Theme: ${theme} (click to change)`}
    >
      {icon}
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
