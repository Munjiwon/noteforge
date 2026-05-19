"use client";

import { useEffect, useState } from "react";

export function ReadAloudButton({
  getText,
}: {
  getText: () => string;
}) {
  const [speaking, setSpeaking] = useState(false);
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);
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
