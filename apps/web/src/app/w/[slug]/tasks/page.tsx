import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";

type Task = {
  pageId: string;
  blockId: string | null;
  text: string;
  checked: boolean;
};

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const it of content) {
    if (
      it &&
      typeof it === "object" &&
      "text" in it &&
      typeof (it as { text: unknown }).text === "string"
    ) {
      parts.push((it as { text: string }).text);
    }
  }
  return parts.join("");
}

function collectTasks(json: string): Task[] {
  let blocks: unknown;
  try {
    blocks = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(blocks)) return [];
  const out: Task[] = [];
  const walk = (b: unknown) => {
    if (!b || typeof b !== "object") return;
    const node = b as {
      id?: string;
      type?: string;
      props?: Record<string, unknown>;
      content?: unknown;
      children?: unknown[];
    };
    if (node.type === "checkListItem") {
      const txt = inlineText(node.content).trim();
      if (txt) {
        out.push({
          pageId: "",
          blockId: typeof node.id === "string" ? node.id : null,
          text: txt,
          checked: !!node.props?.checked,
        });
      }
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  for (const b of blocks) walk(b);
  return out;
}

export default async function TasksPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { show?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const showAll = searchParams.show === "all";
  const pages = await prisma.page.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      deletedAt: null,
      isTemplate: false,
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, icon: true, kind: true, content: true },
  });

  type Group = {
    pageId: string;
    pageTitle: string;
    pageIcon: string | null;
    tasks: Task[];
    open: number;
    total: number;
  };
  const groups: Group[] = [];
  for (const p of pages) {
    if (!p.content) continue;
    const tasks = collectTasks(p.content).map((t) => ({ ...t, pageId: p.id }));
    if (tasks.length === 0) continue;
    const total = tasks.length;
    const open = tasks.filter((t) => !t.checked).length;
    if (!showAll && open === 0) continue;
    groups.push({
      pageId: p.id,
      pageTitle: p.title || "Untitled",
      pageIcon: p.icon,
      tasks: showAll ? tasks : tasks.filter((t) => !t.checked),
      open,
      total,
    });
  }
  // Sort by open task count desc
  groups.sort((a, b) => b.open - a.open || a.pageTitle.localeCompare(b.pageTitle));
  const totalOpen = groups.reduce((sum, g) => sum + g.open, 0);

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">✅ Tasks</h1>
          <p className="text-sm text-gray-500">
            {totalOpen} open task{totalOpen === 1 ? "" : "s"} across the workspace
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/w/${params.slug}/tasks${showAll ? "" : "?show=all"}`}
            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
          >
            {showAll ? "Show open only" : "Show all"}
          </Link>
          <Link
            href={`/w/${params.slug}`}
            className="text-xs text-gray-500 hover:text-gray-900"
          >
            ← Back
          </Link>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-gray-400">
          No checklists found. Use the slash menu &quot;/todo&quot; in any page
          to create one.
        </p>
      ) : (
        <ul className="space-y-4">
          {groups.map((g) => (
            <li key={g.pageId} className="border border-gray-200 rounded-md p-3">
              <Link
                href={`/w/${params.slug}/p/${g.pageId}`}
                className="flex items-center gap-2 text-sm font-medium text-gray-800 hover:underline mb-2"
              >
                <span>{g.pageIcon ?? "📄"}</span>
                <span className="flex-1 truncate">{g.pageTitle}</span>
                <span className="text-[11px] text-gray-400">
                  {g.open}/{g.total}
                </span>
              </Link>
              <ul className="space-y-1 ml-1">
                {g.tasks.map((t, i) => (
                  <li
                    key={(t.blockId ?? "i") + "-" + i}
                    className="flex items-start gap-2 text-sm"
                  >
                    <span
                      className={
                        "inline-flex items-center justify-center w-4 h-4 rounded border mt-0.5 " +
                        (t.checked
                          ? "bg-gray-900 border-gray-900 text-white text-[10px]"
                          : "border-gray-300")
                      }
                    >
                      {t.checked ? "✓" : ""}
                    </span>
                    <Link
                      href={`/w/${params.slug}/p/${g.pageId}${t.blockId ? `?b=${t.blockId}` : ""}`}
                      className={
                        "flex-1 hover:underline " +
                        (t.checked ? "line-through text-gray-400" : "text-gray-800")
                      }
                    >
                      {t.text}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
