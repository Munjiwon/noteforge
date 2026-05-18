// Minimal BlockNote-JSON <-> Markdown conversion.
// Not lossless, but good enough for export/import round-trips of common blocks.

type AnyBlock = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: AnyBlock[];
};

function inlineToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const node = c as { type?: string; text?: string; styles?: Record<string, unknown>; props?: Record<string, unknown> };
      if (node.type === "text" && typeof node.text === "string") {
        let t = node.text;
        const s = node.styles ?? {};
        if (s.code) t = "`" + t + "`";
        if (s.bold) t = "**" + t + "**";
        if (s.italic) t = "*" + t + "*";
        if (s.strike) t = "~~" + t + "~~";
        return t;
      }
      if (node.type === "link") {
        // BlockNote link wraps text children
        const inner = inlineToText(((node as unknown) as { content: unknown }).content);
        const href = (node.props as { href?: string } | undefined)?.href ?? "";
        return `[${inner}](${href})`;
      }
      if (node.type === "mention") {
        const p = node.props as { kind?: string; label?: string; id?: string } | undefined;
        if (p?.kind === "page") return `[${p.label ?? ""}](page:${p.id ?? ""})`;
        return `@${p?.label ?? ""}`;
      }
      return "";
    })
    .join("");
}

export function blocksToMarkdown(blocks: AnyBlock[], depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  let numCounter = 0;
  for (const b of blocks) {
    const text = inlineToText(b.content);
    switch (b.type) {
      case "heading": {
        const lvl = Math.min(3, Math.max(1, Number((b.props as { level?: number } | undefined)?.level ?? 1)));
        lines.push(`${"#".repeat(lvl)} ${text}`);
        break;
      }
      case "paragraph":
        lines.push(text);
        break;
      case "bulletListItem":
        lines.push(`${indent}- ${text}`);
        break;
      case "numberedListItem":
        numCounter += 1;
        lines.push(`${indent}${numCounter}. ${text}`);
        break;
      case "checkListItem": {
        const checked = (b.props as { checked?: boolean } | undefined)?.checked;
        lines.push(`${indent}- [${checked ? "x" : " "}] ${text}`);
        break;
      }
      case "codeBlock":
      case "code": {
        const lang = (b.props as { language?: string } | undefined)?.language ?? "";
        lines.push(`\`\`\`${lang}\n${text}\n\`\`\``);
        break;
      }
      case "quote":
        lines.push(`> ${text}`);
        break;
      case "callout": {
        const emoji = (b.props as { emoji?: string } | undefined)?.emoji ?? "💡";
        lines.push(`> ${emoji} ${text}`);
        break;
      }
      case "math": {
        const formula = (b.props as { formula?: string } | undefined)?.formula ?? "";
        lines.push(`$$\n${formula}\n$$`);
        break;
      }
      case "embed": {
        const url = (b.props as { url?: string } | undefined)?.url ?? "";
        lines.push(`[embed](${url})`);
        break;
      }
      case "image":
      case "file": {
        const url = (b.props as { url?: string } | undefined)?.url ?? "";
        const caption = (b.props as { caption?: string } | undefined)?.caption ?? "";
        lines.push(`![${caption}](${url})`);
        break;
      }
      case "toc":
        lines.push("[[toc]]");
        break;
      case "divider":
        lines.push("---");
        break;
      default:
        if (text) lines.push(text);
    }
    if (b.children?.length) {
      lines.push(blocksToMarkdown(b.children, depth + 1));
    }
    if (b.type !== "numberedListItem") numCounter = 0;
  }
  return lines.join("\n\n");
}

export function markdownToBlocks(md: string): AnyBlock[] {
  const out: AnyBlock[] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    // code fence
    if (trimmed.startsWith("```")) {
      const lang = trimmed.replace(/^```/, "").trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push({
        type: "codeBlock",
        props: { language: lang || "text" },
        content: [{ type: "text", text: buf.join("\n"), styles: {} }],
      });
      continue;
    }
    // math
    if (trimmed === "$$") {
      const buf: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push({
        type: "math",
        props: { formula: buf.join("\n"), display: true },
        content: [],
      });
      continue;
    }
    // divider
    if (/^\s*---+\s*$/.test(line)) {
      // BlockNote doesn't have a native divider type in defaults; render as paragraph with em-dash
      out.push({ type: "paragraph", content: [{ type: "text", text: "———", styles: {} }] });
      i++;
      continue;
    }
    // heading
    const h = /^(\s*)(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({
        type: "heading",
        props: { level: h[2].length },
        content: textRun(h[3]),
      });
      i++;
      continue;
    }
    // task list
    const tl = /^(\s*)- \[( |x|X)\]\s+(.*)$/.exec(line);
    if (tl) {
      out.push({
        type: "checkListItem",
        props: { checked: tl[2].toLowerCase() === "x" },
        content: textRun(tl[3]),
      });
      i++;
      continue;
    }
    // bullet list
    const bl = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bl) {
      out.push({
        type: "bulletListItem",
        content: textRun(bl[2]),
      });
      i++;
      continue;
    }
    // numbered list
    const nl = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (nl) {
      out.push({
        type: "numberedListItem",
        content: textRun(nl[2]),
      });
      i++;
      continue;
    }
    // quote / callout
    const q = /^>\s*(.*)$/.exec(line);
    if (q) {
      out.push({ type: "quote", content: textRun(q[1]) });
      i++;
      continue;
    }
    // image / link-as-image
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) {
      out.push({
        type: "image",
        props: { url: img[2], caption: img[1] },
        content: [],
      });
      i++;
      continue;
    }
    // toc marker
    if (trimmed === "[[toc]]") {
      out.push({ type: "toc", content: [] });
      i++;
      continue;
    }
    // blank line — collapse
    if (line.trim() === "") {
      i++;
      continue;
    }
    // paragraph (may consume continuation lines)
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push({ type: "paragraph", content: textRun(para.join(" ")) });
  }
  return out;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMdToHtml(s: string): string {
  return escHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function blocksToHtml(blocks: AnyBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const text = inlineToText(b.content);
    switch (b.type) {
      case "heading": {
        const lvl = Math.min(3, Math.max(1, Number((b.props as { level?: number } | undefined)?.level ?? 1)));
        out.push(`<h${lvl}>${inlineMdToHtml(text)}</h${lvl}>`);
        break;
      }
      case "paragraph":
        out.push(`<p>${inlineMdToHtml(text)}</p>`);
        break;
      case "bulletListItem":
        out.push(`<ul><li>${inlineMdToHtml(text)}</li></ul>`);
        break;
      case "numberedListItem":
        out.push(`<ol><li>${inlineMdToHtml(text)}</li></ol>`);
        break;
      case "checkListItem": {
        const checked = (b.props as { checked?: boolean } | undefined)?.checked;
        out.push(`<p><label><input type="checkbox" ${checked ? "checked" : ""} disabled /> ${inlineMdToHtml(text)}</label></p>`);
        break;
      }
      case "codeBlock":
      case "code": {
        const lang = (b.props as { language?: string } | undefined)?.language ?? "";
        out.push(`<pre><code class="language-${escHtml(lang)}">${escHtml(text)}</code></pre>`);
        break;
      }
      case "quote":
        out.push(`<blockquote>${inlineMdToHtml(text)}</blockquote>`);
        break;
      case "callout": {
        const emoji = (b.props as { emoji?: string } | undefined)?.emoji ?? "💡";
        out.push(`<aside class="callout">${escHtml(emoji)} ${inlineMdToHtml(text)}</aside>`);
        break;
      }
      case "image":
      case "file": {
        const url = (b.props as { url?: string } | undefined)?.url ?? "";
        const caption = (b.props as { caption?: string } | undefined)?.caption ?? "";
        out.push(`<figure><img src="${escHtml(url)}" alt="${escHtml(caption)}" /><figcaption>${escHtml(caption)}</figcaption></figure>`);
        break;
      }
      case "divider":
        out.push("<hr />");
        break;
      default:
        if (text) out.push(`<p>${inlineMdToHtml(text)}</p>`);
    }
    if (b.children?.length) out.push(blocksToHtml(b.children));
  }
  return out.join("\n");
}

function isBlockStart(line: string): boolean {
  const t = line.trimStart();
  return (
    t.startsWith("# ") ||
    t.startsWith("## ") ||
    t.startsWith("### ") ||
    t.startsWith("- ") ||
    t.startsWith("* ") ||
    /^\d+\.\s/.test(t) ||
    t.startsWith("> ") ||
    t.startsWith("```") ||
    t === "$$" ||
    /^---+$/.test(t)
  );
}

function textRun(s: string): AnyBlock["content"] {
  if (!s) return [];
  // Very light inline parsing: bold/italic/code/link
  const parts: { type: "text"; text: string; styles: Record<string, boolean> }[] = [];
  let rest = s;
  // Greedy simple pass
  const re =
    /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`)/;
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) {
      parts.push({ type: "text", text: rest, styles: {} });
      break;
    }
    if (m.index > 0) {
      parts.push({ type: "text", text: rest.slice(0, m.index), styles: {} });
    }
    const token = m[0];
    if (token.startsWith("**") || token.startsWith("__")) {
      parts.push({ type: "text", text: m[2] ?? m[3] ?? "", styles: { bold: true } });
    } else if (token.startsWith("*") || token.startsWith("_")) {
      parts.push({ type: "text", text: m[4] ?? m[5] ?? "", styles: { italic: true } });
    } else if (token.startsWith("`")) {
      parts.push({ type: "text", text: m[6] ?? "", styles: { code: true } });
    }
    rest = rest.slice(m.index + token.length);
  }
  return parts;
}
