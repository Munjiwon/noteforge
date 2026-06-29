import Link from "next/link";

// Pages that @-mention this issue, derived from the issue cuid appearing in
// their BlockNote content (mirrors the page-backlink behavior).
export function IssueReferencedBy({
  slug,
  pages,
}: {
  slug: string;
  pages: { id: string; title: string; icon: string | null; kind: string }[];
}) {
  if (pages.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-3">
      <div className="mb-2 text-xs font-medium text-gray-500">Referenced by ({pages.length})</div>
      <ul className="space-y-1">
        {pages.map((p) => (
          <li key={p.id}>
            <Link
              href={`/w/${slug}/p/${p.id}`}
              className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-black/5"
            >
              <span>{p.icon ?? (p.kind === "database" ? "📊" : "📄")}</span>
              <span className="truncate">{p.title || "Untitled"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
