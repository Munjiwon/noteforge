"use client";

import { signOut } from "next-auth/react";
import { ThemeToggle } from "./theme-toggle";

export function UserMenu({ user }: { user: { name: string; color: string } }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-7 h-7 rounded-full grid place-items-center text-white text-xs font-medium"
        style={{ backgroundColor: user.color }}
      >
        {user.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 text-sm truncate">{user.name}</div>
      <ThemeToggle />
      <button
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="text-xs text-gray-500 hover:text-gray-900"
      >
        Sign out
      </button>
    </div>
  );
}
