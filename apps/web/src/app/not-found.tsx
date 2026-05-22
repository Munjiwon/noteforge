import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-[60vh] grid place-items-center p-8">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-3">📭</div>
        <h1 className="text-lg font-semibold mb-2">Page not found</h1>
        <p className="text-sm text-gray-600 mb-4">
          That page may have been moved or deleted. Check the URL, or jump back
          to a place you know.
        </p>
        <div className="flex items-center justify-center gap-2">
          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded bg-gray-900 text-white hover:opacity-90"
          >
            Back home
          </Link>
        </div>
      </div>
    </main>
  );
}
