"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function WorkProjectNav({
  slug,
  projectKey,
  type,
}: {
  slug: string;
  projectKey: string;
  type: string;
}) {
  const pathname = usePathname();
  const base = `/w/${slug}/work/${projectKey}`;
  const tabs: { href: string; label: string }[] = [
    { href: `${base}/board`, label: "Board" },
    ...(type === "scrum" ? [{ href: `${base}/backlog`, label: "Backlog" }] : []),
    ...(type === "scrum" ? [{ href: `${base}/sprints`, label: "Sprints" }] : []),
    { href: `${base}/issues`, label: "Issues" },
    { href: `${base}/roadmap`, label: "Roadmap" },
    { href: `${base}/reports`, label: "Reports" },
    { href: `${base}/releases`, label: "Releases" },
    { href: `${base}/settings`, label: "Settings" },
  ];
  return (
    <nav className="flex gap-1 border-b border-gray-200 px-4">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`border-b-2 px-3 py-2 text-sm ${
              active
                ? "border-[rgb(var(--accent,99_102_241))] font-medium text-gray-900"
                : "border-transparent text-gray-500 hover:text-gray-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
