"use client";

export function MobileSidebarToggle() {
  return (
    <button
      onClick={() => window.dispatchEvent(new Event("sidebar-open"))}
      className="md:hidden fixed top-3 left-3 z-30 bg-white/95 backdrop-blur border border-gray-200 rounded-full w-9 h-9 grid place-items-center text-sm shadow-md hover:shadow-lg"
      aria-label="Open sidebar"
    >
      ☰
    </button>
  );
}
