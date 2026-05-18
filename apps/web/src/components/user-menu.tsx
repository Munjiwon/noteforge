"use client";

import { useState, useTransition } from "react";
import { signOut } from "next-auth/react";
import { ThemeToggle } from "./theme-toggle";
import { updateUserProfile } from "@/app/notification-actions";
import { useLang } from "@/lib/i18n";

const COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#0ea5e9", "#111827",
];

export function UserMenu({ user }: { user: { name: string; color: string } }) {
  const [editing, setEditing] = useState(false);
  const [lang, setLang] = useLang();
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setEditing(true)}
        className="w-7 h-7 rounded-full grid place-items-center text-white text-xs font-medium hover:ring-2 hover:ring-gray-300"
        style={{ backgroundColor: user.color }}
        title="Edit profile"
      >
        {user.name.slice(0, 1).toUpperCase()}
      </button>
      <button
        onClick={() => setEditing(true)}
        className="flex-1 text-sm truncate text-left hover:underline"
      >
        {user.name}
      </button>
      <button
        onClick={() => setLang(lang === "en" ? "ko" : "en")}
        className="text-[10px] text-gray-500 hover:text-gray-900 uppercase"
        title="Toggle language"
      >
        {lang}
      </button>
      <ThemeToggle />
      <button
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="text-xs text-gray-500 hover:text-gray-900"
      >
        Sign out
      </button>
      {editing && <ProfileEditor user={user} onClose={() => setEditing(false)} />}
    </div>
  );
}

function ProfileEditor({
  user,
  onClose,
}: {
  user: { name: string; color: string };
  onClose: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [, start] = useTransition();
  const save = () => {
    start(async () => {
      await updateUserProfile(name, color);
      onClose();
    });
  };
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[360px] max-w-[92vw] p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">Profile</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900">✕</button>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <div
            className="w-12 h-12 rounded-full grid place-items-center text-white text-lg font-medium"
            style={{ background: color }}
          >
            {(name || "U").slice(0, 1).toUpperCase()}
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm outline-none focus:border-gray-400"
          />
        </div>
        <div className="flex items-center gap-1 mb-3">
          <span className="text-xs text-gray-500 mr-1">Color:</span>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={
                "w-5 h-5 rounded-full border-2 " +
                (color === c ? "border-gray-900" : "border-transparent")
              }
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="text-xs text-gray-500 hover:text-gray-900 px-2 py-1"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!name.trim()}
            className="text-xs px-3 py-1 rounded bg-gray-900 text-white disabled:opacity-30"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
