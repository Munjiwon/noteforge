"use client";

import { useEffect, useState } from "react";
import { PeekModal } from "./peek-modal";

export function GlobalPeek() {
  const [pageId, setPageId] = useState<string | null>(null);
  useEffect(() => {
    const onPeek = (e: Event) => {
      const detail = (e as CustomEvent<{ pageId?: string }>).detail;
      if (detail?.pageId) setPageId(detail.pageId);
    };
    window.addEventListener("noteforge:peek", onPeek as EventListener);
    return () =>
      window.removeEventListener("noteforge:peek", onPeek as EventListener);
  }, []);
  return <PeekModal pageId={pageId} onClose={() => setPageId(null)} />;
}
