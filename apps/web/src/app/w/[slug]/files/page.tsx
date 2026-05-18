import Link from "next/link";
import { requireWorkspaceMember } from "@/lib/workspace";
import { prisma } from "db";

type FileRef = {
  url: string;
  name: string;
  blockType: string;
  pageId: string;
  pageTitle: string;
  pageIcon: string | null;
};

function classify(ext: string): "image" | "audio" | "video" | "doc" | "other" {
  const e = ext.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(e)) return "image";
  if (/\.(mp3|wav|m4a|webm|ogg)$/.test(e)) return "audio";
  if (/\.(mp4|mov|webm)$/.test(e)) return "video";
  if (/\.(pdf|md|csv|txt|json|zip)$/.test(e)) return "doc";
  return "other";
}

function extractFiles(content: string, page: { id: string; title: string; icon: string | null }): FileRef[] {
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(blocks)) return [];
  const out: FileRef[] = [];
  const walk = (b: unknown) => {
    if (!b || typeof b !== "object") return;
    const node = b as {
      type?: string;
      props?: Record<string, unknown>;
      children?: unknown[];
    };
    const p = node.props ?? {};
    const candidates = ["url", "src", "href"];
    for (const k of candidates) {
      const v = p[k];
      if (typeof v === "string" && v.startsWith("/api/files/")) {
        const fname =
          (typeof p.name === "string" && p.name) ||
          v.split("/").pop() ||
          "file";
        out.push({
          url: v,
          name: fname,
          blockType: node.type ?? "block",
          pageId: page.id,
          pageTitle: page.title || "Untitled",
          pageIcon: page.icon,
        });
      }
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  for (const b of blocks) walk(b);
  return out;
}

export default async function FilesPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { kind?: string };
}) {
  const ctx = await requireWorkspaceMember(params.slug);
  const pages = await prisma.page.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      deletedAt: null,
    },
    select: { id: true, title: true, icon: true, content: true, cover: true },
  });

  // Pull files from block content + page covers.
  const seen = new Set<string>();
  const all: FileRef[] = [];
  for (const p of pages) {
    for (const f of extractFiles(p.content, p)) {
      if (seen.has(f.url + "::" + f.pageId)) continue;
      seen.add(f.url + "::" + f.pageId);
      all.push(f);
    }
    if (p.cover && p.cover.startsWith("/api/files/")) {
      const key = p.cover + "::" + p.id;
      if (!seen.has(key)) {
        seen.add(key);
        all.push({
          url: p.cover,
          name: p.cover.split("/").pop() ?? "cover",
          blockType: "cover",
          pageId: p.id,
          pageTitle: p.title || "Untitled",
          pageIcon: p.icon,
        });
      }
    }
  }

  const kind = searchParams.kind ?? "all";
  const filtered =
    kind === "all"
      ? all
      : all.filter((f) => classify(f.name) === (kind as never));

  const counts = {
    all: all.length,
    image: all.filter((f) => classify(f.name) === "image").length,
    audio: all.filter((f) => classify(f.name) === "audio").length,
    video: all.filter((f) => classify(f.name) === "video").length,
    doc: all.filter((f) => classify(f.name) === "doc").length,
    other: all.filter((f) => classify(f.name) === "other").length,
  };

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">📁 Files</h1>
          <p className="text-sm text-gray-500">
            Every uploaded image, audio, and document across the workspace.
          </p>
        </div>
        <Link
          href={`/w/${params.slug}`}
          className="text-xs text-gray-500 hover:text-gray-900"
        >
          ← Back
        </Link>
      </div>
      <div className="flex gap-1 mb-4 text-xs">
        {(["all", "image", "audio", "video", "doc", "other"] as const).map((k) => (
          <Link
            key={k}
            href={`/w/${params.slug}/files${k === "all" ? "" : `?kind=${k}`}`}
            className={
              "px-2 py-1 rounded " +
              (kind === k
                ? "bg-gray-900 text-white"
                : "hover:bg-black/5 text-gray-500")
            }
          >
            {k} · {counts[k]}
          </Link>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400">
          No files yet. Drag files into any page or use the slash menu.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          {filtered.map((f) => {
            const c = classify(f.name);
            return (
              <a
                key={f.url + ":" + f.pageId}
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="block border border-gray-200 rounded-md overflow-hidden hover:border-gray-300 bg-white"
                title={`${f.name} — on ${f.pageTitle}`}
              >
                {c === "image" ? (
                  <img
                    src={f.url}
                    alt={f.name}
                    className="w-full h-32 object-cover bg-gray-100"
                  />
                ) : c === "video" ? (
                  <video
                    src={f.url}
                    className="w-full h-32 object-cover bg-black"
                    muted
                  />
                ) : (
                  <div className="w-full h-32 flex items-center justify-center text-3xl bg-gray-50">
                    {c === "audio"
                      ? "🎵"
                      : c === "doc"
                        ? "📄"
                        : "📦"}
                  </div>
                )}
                <div className="px-2 py-1.5 border-t border-gray-100">
                  <div className="text-xs truncate text-gray-800">{f.name}</div>
                  <Link
                    href={`/w/${params.slug}/p/${f.pageId}`}
                    className="text-[10px] text-gray-400 truncate hover:underline block"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {f.pageIcon ?? "📄"} {f.pageTitle}
                  </Link>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
