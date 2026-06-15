"use client";

import { useEffect, useState } from "react";

export function ReadAloudButton({
  getText,
}: {
  getText: () => string;
}) {
  const [speaking, setSpeaking] = useState(false);
  // Decide support only after mount: the server (and the first client render)
  // must render identically, or hydration desyncs the whole toolbar. Checking
  // `window` during render makes server output null but client output a button.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    return () => {
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);
  const supported =
    mounted && typeof window !== "undefined" && "speechSynthesis" in window;
  if (!supported) return null;
  const stop = () => {
    window.speechSynthesis.cancel();
    setSpeaking(false);
  };
  const speak = () => {
    const text = getText();
    if (!text.trim()) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
    setSpeaking(true);
  };
  return (
    <button
      onClick={speaking ? stop : speak}
      className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
      title={speaking ? "Stop reading" : "Read this page aloud"}
    >
      {speaking ? "■ Stop" : "🔊 Read"}
    </button>
  );
}
