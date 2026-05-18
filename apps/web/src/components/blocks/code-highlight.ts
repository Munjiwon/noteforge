// Lightweight Shiki-based syntax highlighter that decorates the <pre><code>
// blocks BlockNote already renders. Loads Shiki lazily so the editor bundle
// stays small.

import type { Highlighter } from "shiki";

let pending: Promise<Highlighter> | null = null;
let cached: Highlighter | null = null;

const LOAD_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "html",
  "css",
  "python",
  "java",
  "go",
  "rust",
  "sql",
  "bash",
  "shell",
  "yaml",
  "markdown",
  "ruby",
  "php",
  "c",
  "cpp",
];

export async function getHighlighter(): Promise<Highlighter> {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    const shiki = await import("shiki");
    const hl = await shiki.createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: LOAD_LANGS,
    });
    cached = hl;
    return hl;
  })();
  return pending;
}

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  md: "markdown",
  yml: "yaml",
  "c++": "cpp",
  cs: "csharp",
};

function pickLang(raw: string | null | undefined, supported: string[]): string {
  if (!raw) return "plaintext";
  const lc = raw.toLowerCase();
  const resolved = ALIASES[lc] ?? lc;
  return supported.includes(resolved) ? resolved : "plaintext";
}

// Apply highlighting to every <pre><code> under root. Caches the last
// highlighted text per element so we don't redo identical work.
const APPLIED = new WeakMap<HTMLElement, string>();

export async function highlightAll(root: HTMLElement): Promise<void> {
  const codes = root.querySelectorAll<HTMLElement>("pre code, pre.bn-code-block, code.bn-code-block");
  if (codes.length === 0) return;
  const hl = await getHighlighter();
  const supported = hl.getLoadedLanguages();
  codes.forEach((code) => {
    // Look up language from a class like "language-ts" or BlockNote data attr
    const langAttr =
      code.getAttribute("data-language") ??
      Array.from(code.classList)
        .find((c) => c.startsWith("language-"))
        ?.slice("language-".length) ??
      code.closest("pre")?.getAttribute("data-language") ??
      "plaintext";
    const lang = pickLang(langAttr, supported);
    const text = code.textContent ?? "";
    const key = `${lang}::${text}`;
    if (APPLIED.get(code) === key) return;
    if (!text.trim()) return;
    try {
      const html = hl.codeToHtml(text, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      });
      // Replace the <pre>...</pre> innerHTML with shiki's rendered <pre>
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const shikiPre = wrapper.querySelector("pre");
      const pre = code.closest("pre");
      if (shikiPre && pre) {
        // Preserve any BlockNote data-id / data-content-type attrs.
        for (const attr of Array.from(pre.attributes)) {
          if (attr.name.startsWith("data-") && !shikiPre.hasAttribute(attr.name)) {
            shikiPre.setAttribute(attr.name, attr.value);
          }
        }
        shikiPre.classList.add("nf-shiki");
        pre.replaceWith(shikiPre);
        const newCode = shikiPre.querySelector("code");
        if (newCode) APPLIED.set(newCode as HTMLElement, key);
      } else {
        APPLIED.set(code, key);
      }
    } catch {
      // ignore — lang not supported
    }
  });
}
