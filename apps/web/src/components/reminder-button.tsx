"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { cancelReminder, setReminder } from "@/app/w/[slug]/actions";

export type PendingReminder = {
  id: string;
  dueAt: string;
  note: string | null;
  repeatRule?: string;
};

function nextMondayAt9(): Date {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  // Day-of-week: 0 (Sun) … 6 (Sat). Move to Monday.
  const offset = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + offset);
  return d;
}

function tomorrowAt9(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function inHours(hrs: number): Date {
  return new Date(Date.now() + hrs * 3600 * 1000);
}

function fmt(d: Date): string {
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? `today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";

export function ReminderButton({
  slug,
  pageId,
  pending,
}: {
  slug: string;
  pageId: string;
  pending: PendingReminder[];
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const schedule = (d: Date) => {
    setOpen(false);
    const rule = repeat;
    start(() => setReminder(slug, pageId, d.toISOString(), undefined, rule));
  };
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          "text-xs px-2 py-1 rounded border " +
          (pending.length > 0
            ? "bg-amber-50 border-amber-200 text-amber-700"
            : "border-gray-200 hover:bg-black/5")
        }
        title={
          pending.length > 0
            ? `${pending.length} reminder${pending.length === 1 ? "" : "s"} scheduled`
            : "Remind me"
        }
      >
        ⏰ Remind
        {pending.length > 0 && <span className="ml-1">({pending.length})</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white border border-gray-200 rounded-md shadow-lg w-[240px] p-2">
          <div className="text-[10px] uppercase text-gray-500 px-1 py-1">
            Remind me
          </div>
          <button
            onClick={() => schedule(inHours(1))}
            className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-black/5"
          >
            In 1 hour
          </button>
          <button
            onClick={() => schedule(tomorrowAt9())}
            className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-black/5"
          >
            Tomorrow 9am
          </button>
          <button
            onClick={() => schedule(nextMondayAt9())}
            className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-black/5"
          >
            Next Monday 9am
          </button>
          <div className="border-t border-gray-100 mt-1 pt-1">
            <label className="block text-[10px] text-gray-500 mb-0.5">
              Repeat
            </label>
            <select
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as Repeat)}
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-gray-400 mb-1"
            >
              <option value="none">Don't repeat</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <input
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-gray-400"
            />
            <button
              onClick={() => {
                if (!custom) return;
                const d = new Date(custom);
                if (Number.isNaN(d.getTime())) return;
                schedule(d);
              }}
              disabled={!custom}
              className="w-full mt-1 text-xs px-2 py-1 rounded bg-gray-900 text-white hover:opacity-90 disabled:opacity-40"
            >
              Schedule
            </button>
          </div>
          {pending.length > 0 && (
            <div className="border-t border-gray-100 mt-2 pt-1">
              <div className="text-[10px] uppercase text-gray-500 px-1 py-1">
                Pending
              </div>
              <ul className="space-y-1">
                {pending.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 text-xs px-1 group"
                  >
                    <span className="flex-1 truncate">
                      {fmt(new Date(r.dueAt))}
                      {r.repeatRule && r.repeatRule !== "none"
                        ? ` · ↻ ${r.repeatRule}`
                        : ""}
                      {r.note ? ` — ${r.note}` : ""}
                    </span>
                    <button
                      onClick={() =>
                        start(() => cancelReminder(slug, r.id))
                      }
                      className="text-gray-300 group-hover:text-red-500"
                      title="Cancel"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
