"use client";

import { useEffect, useState } from "react";

export function ReadingProgress() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      // The page's main scroller is the <main> element from the workspace layout.
      const main = document.querySelector("main") as HTMLElement | null;
      const target = main ?? document.scrollingElement ?? document.documentElement;
      const max = (target?.scrollHeight ?? 0) - (target?.clientHeight ?? 0);
      const top = target?.scrollTop ?? 0;
      if (max <= 0) {
        setPct(0);
        return;
      }
      setPct(Math.min(100, Math.max(0, (top / max) * 100)));
    };
    onScroll();
    const main = document.querySelector("main");
    main?.addEventListener("scroll", onScroll);
    window.addEventListener("scroll", onScroll);
    return () => {
      main?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return (
    <div
      className="fixed top-0 left-0 h-0.5 bg-accent z-50 transition-[width] duration-100 no-print"
      style={{ width: `${pct}%` }}
      aria-hidden
    />
  );
}
