"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Echo to the console so it survives the overlay closing in dev.
    // eslint-disable-next-line no-console
    console.error("[noteforge] route error:", error);
  }, [error]);
  return (
    <main className="min-h-[60vh] grid place-items-center p-8">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-3">🥲</div>
        <h1 className="text-lg font-semibold mb-2">Something went wrong.</h1>
        <p className="text-sm text-gray-600 mb-4">
          {error.message || "An unexpected error occurred while loading this page."}
        </p>
        {error.digest && (
          <p className="text-[10px] text-gray-400 mb-4">ref: {error.digest}</p>
        )}
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => reset()}
            className="text-xs px-3 py-1.5 rounded bg-gray-900 text-white hover:opacity-90"
          >
            Try again
          </button>
          <a
            href="/"
            className="text-xs px-3 py-1.5 rounded border border-gray-200 hover:bg-black/5"
          >
            Back home
          </a>
        </div>
      </div>
    </main>
  );
}
