"use client";

import { useState, useTransition } from "react";
import { createPageFromTemplate } from "@/app/w/[slug]/actions";
import { PAGE_TEMPLATES } from "@/lib/page-templates";

export function TemplateGalleryButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex flex-col items-start gap-1 border border-gray-200 rounded-md px-3 py-3 hover:bg-black/5 hover:border-gray-300 text-left w-full"
      >
        <span className="text-xl">🧩</span>
        <span className="text-sm font-medium text-gray-800">From template</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-[12vh] p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="bg-white rounded-lg shadow-2xl w-[720px] max-w-[95vw] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold">New page from template</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-900"
              >
                ✕
              </button>
            </div>
            <ul className="grid grid-cols-2 gap-3 p-4 overflow-y-auto">
              {PAGE_TEMPLATES.map((tpl) => (
                <li key={tpl.id}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      start(() =>
                        createPageFromTemplate(slug, null, tpl.id),
                      );
                    }}
                    className="w-full text-left border border-gray-200 rounded-md p-3 hover:bg-black/5 hover:border-gray-300 flex gap-3"
                  >
                    <span className="text-2xl shrink-0">{tpl.icon}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-gray-900">
                        {tpl.name}
                      </span>
                      {tpl.description && (
                        <span className="block text-xs text-gray-500 line-clamp-2 mt-0.5">
                          {tpl.description}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
