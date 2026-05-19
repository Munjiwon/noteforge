import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";

type Sort = "updated" | "created" | "title";

function applySort<T extends { updatedAt: Date; createdAt: Date; title: string }>(
  rows: T[],
  sort: Sort,
): T[] {
  const sorted = [...rows];
  if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === "created")
    sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  else sorted.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return sorted;
}

export default async function AllPages({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { sort?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const sort: Sort =
    searchParams.sort === "created" || searchParams.sort === "title"
      ? searchParams.sort
      : "updated";

  const pages = await prisma.page.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      deletedAt: null,
      isTemplate: false,
    },
    select: {
      id: true,
      title: true,
      icon: true,
      kind: true,
      createdAt: true,
      updatedAt: true,
      parentId: true,
      author: { select: { name: true, color: true } },
    },
  });
  const ordered = applySort(pages, sort);

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">📄 All pages</h1>
          <p className="text-sm text-gray-500">
            {pages.length} page{pages.length === 1 ? "" : "s"} in this workspace
          </p>
        </div>
        <Link
          href={`/w/${params.slug}`}
          className="text-xs text-gray-500 hover:text-gray-900"
        >
          ← Back
        </Link>
      </div>
      <div className="flex gap-1 mb-3 text-xs">
        {(["updated", "created", "title"] as const).map((s) => (
          <Link
            key={s}
            href={
              s === "updated"
                ? `/w/${params.slug}/all`
                : `/w/${params.slug}/all?sort=${s}`
            }
            className={
              "px-2 py-1 rounded " +
              (sort === s
                ? "bg-gray-900 text-white"
                : "hover:bg-black/5 text-gray-500")
            }
          >
            {s === "updated"
              ? "Last edited"
              : s === "created"
                ? "Newest"
                : "A → Z"}
          </Link>
        ))}
      </div>
      <ul className="border border-gray-200 rounded divide-y divide-gray-100">
        {ordered.map((p) => (
          <li key={p.id}>
            <Link
              href={`/w/${params.slug}/p/${p.id}`}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-black/5"
            >
              <span>{p.icon ?? (p.kind === "database" ? "📊" : "📄")}</span>
              <span className="flex-1 truncate">{p.title || "Untitled"}</span>
              {p.author && (
                <span className="text-[11px] text-gray-400">
                  {p.author.name}
                </span>
              )}
              <span className="text-[11px] text-gray-400 w-24 text-right">
                {sort === "created"
                  ? new Date(p.createdAt).toLocaleDateString()
                  : new Date(p.updatedAt).toLocaleDateString()}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
