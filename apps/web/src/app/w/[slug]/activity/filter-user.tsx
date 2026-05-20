"use client";

import { useRouter } from "next/navigation";

export function ActivityFilterUser({
  slug,
  users,
  current,
}: {
  slug: string;
  users: { id: string; name: string; color: string }[];
  current: string;
}) {
  const router = useRouter();
  return (
    <select
      defaultValue={current}
      onChange={(e) => {
        const v = e.target.value;
        const url = new URL(window.location.href);
        if (v) url.searchParams.set("user", v);
        else url.searchParams.delete("user");
        url.pathname = `/w/${slug}/activity`;
        router.push(url.pathname + url.search);
      }}
      className="border border-gray-200 rounded px-1 py-0.5 outline-none text-xs"
    >
      <option value="">All authors</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}
