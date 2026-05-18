"use client";

type AnyBlock = {
  id?: string;
  type?: string;
  content?: unknown;
  children?: AnyBlock[];
  props?: Record<string, unknown>;
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

type FlatBlock = { id: string; type: string; text: string; depth: number };

function flatten(json: string): FlatBlock[] {
  let blocks: AnyBlock[] = [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) blocks = parsed as AnyBlock[];
  } catch {
    return [];
  }
  const out: FlatBlock[] = [];
  const walk = (b: AnyBlock, depth: number) => {
    out.push({
      id: b.id ?? Math.random().toString(36).slice(2),
      type: b.type ?? "paragraph",
      text: inlineText(b.content).trim(),
      depth,
    });
    if (Array.isArray(b.children)) {
      for (const c of b.children) walk(c, depth + 1);
    }
  };
  for (const b of blocks) walk(b, 0);
  return out;
}

// Pair blocks between old and new by exact (depth+text) match first; remaining
// blocks fall through in order.
function diff(oldB: FlatBlock[], newB: FlatBlock[]) {
  const newIdx = new Map<string, number[]>();
  newB.forEach((b, i) => {
    const k = `${b.depth}|${b.text}`;
    if (!newIdx.has(k)) newIdx.set(k, []);
    newIdx.get(k)!.push(i);
  });
  const consumed = new Set<number>();
  type Row = {
    kind: "same" | "changed" | "removed" | "added";
    old?: FlatBlock;
    next?: FlatBlock;
  };
  const rows: Row[] = [];
  let cursor = 0;
  for (const o of oldB) {
    const key = `${o.depth}|${o.text}`;
    const list = newIdx.get(key);
    let matchedTo: number | null = null;
    if (list) {
      for (const idx of list) {
        if (idx >= cursor && !consumed.has(idx)) {
          matchedTo = idx;
          break;
        }
      }
    }
    if (matchedTo !== null) {
      // Emit any new blocks between cursor and matchedTo as added
      for (let j = cursor; j < matchedTo; j++) {
        if (consumed.has(j)) continue;
        rows.push({ kind: "added", next: newB[j] });
        consumed.add(j);
      }
      rows.push({ kind: "same", old: o, next: newB[matchedTo] });
      consumed.add(matchedTo);
      cursor = matchedTo + 1;
    } else {
      rows.push({ kind: "removed", old: o });
    }
  }
  for (let j = cursor; j < newB.length; j++) {
    if (consumed.has(j)) continue;
    rows.push({ kind: "added", next: newB[j] });
  }
  return rows;
}

export function SnapshotDiff({
  oldContent,
  newContent,
}: {
  oldContent: string;
  newContent: string;
}) {
  const o = flatten(oldContent);
  const n = flatten(newContent);
  const rows = diff(o, n);

  const added = rows.filter((r) => r.kind === "added").length;
  const removed = rows.filter((r) => r.kind === "removed").length;

  return (
    <div>
      <div className="text-[11px] text-gray-500 mb-3 flex gap-3">
        <span className="text-green-700">+{added} added</span>
        <span className="text-red-700">−{removed} removed</span>
      </div>
      <ul className="space-y-1 text-sm">
        {rows.map((r, i) => {
          if (r.kind === "same") {
            return (
              <li
                key={i}
                style={{ paddingLeft: `${(r.old?.depth ?? 0) * 16}px` }}
                className="text-gray-500"
              >
                {r.old?.text || <span className="text-gray-300">(empty)</span>}
              </li>
            );
          }
          if (r.kind === "added") {
            return (
              <li
                key={i}
                style={{ paddingLeft: `${(r.next?.depth ?? 0) * 16}px` }}
                className="text-green-800 bg-green-50 px-2 py-0.5 rounded"
              >
                + {r.next?.text || <span className="opacity-50">(empty)</span>}
              </li>
            );
          }
          return (
            <li
              key={i}
              style={{ paddingLeft: `${(r.old?.depth ?? 0) * 16}px` }}
              className="text-red-800 bg-red-50 px-2 py-0.5 rounded line-through"
            >
              − {r.old?.text || <span className="opacity-50 no-underline">(empty)</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
