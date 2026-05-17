"use client";

export function MobileSidebarToggle() {
  return (
    <button
      onClick={() => window.dispatchEvent(new Event("sidebar-open"))}
      className="md:hidden fixed top-2 left-2 z-30 bg-white border border-gray-200 rounded px-2 py-1 text-xs shadow-sm"
      aria-label="Open sidebar"
    >
      ☰
    </button>
  );
}
