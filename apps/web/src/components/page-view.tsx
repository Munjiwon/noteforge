"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  createPage,
  incrementPageView,
  renamePage,
  setPageIcon,
  setPageStatus,
  togglePageLock,
  togglePagePinned,
  toggleFavorite,
} from "@/app/w/[slug]/actions";
import { CommentsPanel, type CommentItem } from "./comments-panel";
import { ShareButton } from "./share-button";
import { PageCover } from "./page-cover";
import { HistoryButton, type SnapshotItem } from "./history-button";
import { ExportButton } from "./export-button";
import { PageInfo } from "./page-info";
import { PageStyleMenu, fontClass, widthClass } from "./page-style-menu";
import { EmojiPicker } from "./emoji-picker";
import { PageOutline } from "./page-outline";
import { PageTags, parseTags } from "./page-tags";
import { PageReactions, type PageReactionGroup } from "./page-reactions";
import { SubscribeButton } from "./subscribe-button";
import { ReminderButton, type PendingReminder } from "./reminder-button";
import { Avatar } from "./avatar";
import { ReadModeButton } from "./read-mode-button";
import { ReadAloudButton } from "./read-aloud-button";
import { ReadingProgress } from "./reading-progress";
import { AskAiPanel } from "./ask-ai-panel";
import type { PermItem } from "./share-button";

const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="px-24 py-10 text-gray-400">Loading editor…</div>,
});


export function PageView({
  slug,
  page,
  user,
  role,
  comments,
  snapshots,
  backlinks,
  info,
  permissions,
  ancestors,
  rowContext,
  reactions = [],
  subscribed = false,
  reminders = [],
  workspaceDefaultFont = "default",
  workspaceDefaultWidth = "normal",
  aiEnabled = true,
  subPages = [],
  canChangeSettings = false,
}: {
  slug: string;
  page: {
    id: string;
    title: string;
    icon: string | null;
    content: string;
    cover?: string | null;
    coverPos?: string | null;
    tags?: string | null;
    publicAccess?: "none" | "view";
    publicSlug?: string | null;
    publicViewCount?: number;
    locked?: boolean;
    width?: "normal" | "wide" | "full";
    font?: "default" | "serif" | "mono";
    isTemplate?: boolean;
    favorite?: boolean;
    pinned?: boolean;
    slug?: string | null;
    expiresAt?: string | null;
    coverCaption?: string | null;
    coverDim?: boolean;
    status?: "draft" | "in_review" | "published" | null;
    lockedUntil?: string | null;
  };
  canChangeSettings?: boolean;
  user: { id: string; name: string; color: string };
  role: "owner" | "editor" | "viewer";
  comments: CommentItem[];
  snapshots: SnapshotItem[];
  backlinks: { id: string; title: string; icon: string | null; kind: string }[];
  info: {
    author: { name: string; color: string } | null;
    createdAt: string;
    updatedAt: string;
    wordCount: number;
    wordGoal?: number | null;
    commentCount: number;
    backlinkCount: number;
    childrenCount: number;
    subscriberCount?: number;
    viewCount?: number;
    lastEditor?: { name: string; color: string; avatarUrl?: string | null } | null;
  };
  permissions: PermItem[];
  ancestors?: { id: string; title: string; icon: string | null }[];
  rowContext?: {
    dbId: string;
    dbTitle: string;
    dbIcon: string | null;
    schema?: { props: { id: string; name: string; type: string; options?: { id: string; name: string; color: string }[] }[] };
    dataValues?: Record<string, unknown>;
  } | null;
  reactions?: PageReactionGroup[];
  subscribed?: boolean;
  reminders?: PendingReminder[];
  workspaceDefaultFont?: "default" | "serif" | "mono";
  workspaceDefaultWidth?: "normal" | "wide" | "full";
  aiEnabled?: boolean;
  subPages?: { id: string; title: string; icon: string | null; kind: string }[];
}) {
  const [title, setTitle] = useState(page.title);
  const [icon, setIcon] = useState(page.icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, start] = useTransition();
  const readOnly = role === "viewer";
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // auto-focus title input when opening a freshly-created page (empty/Untitled)
    if (!readOnly && (page.title === "" || page.title === "Untitled")) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // ?focus=1 enables distraction-free reading mode automatically.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("focus") === "1") {
      document.body.classList.add("read-mode");
      return () => document.body.classList.remove("read-mode");
    }
  }, []);

  // Set the browser tab favicon to the page icon while this page is open.
  useEffect(() => {
    if (!page.icon) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="56">${page.icon}</text></svg>`;
    const href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    const prev = link?.href ?? null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = href;
    return () => {
      if (link && prev !== null) link.href = prev;
    };
  }, [page.icon]);

  // Increment view count once per session per page.
  useEffect(() => {
    const key = `viewed:${page.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    void incrementPageView(slug, page.id);
  }, [page.id, slug]);

  // Word goal celebration — fire once per page per session when the count
  // crosses the goal.
  useEffect(() => {
    if (!info.wordGoal) return;
    if (info.wordCount < info.wordGoal) return;
    const key = `wordGoal:hit:${page.id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    const tip = document.createElement("div");
    tip.innerHTML = `🎉 <strong>${info.wordCount}</strong> words — goal reached!`;
    tip.className =
      "fixed bottom-20 left-1/2 -translate-x-1/2 z-50 text-sm bg-emerald-600 text-white rounded-full px-4 py-1.5 shadow-lg";
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 3000);
  }, [page.id, info.wordCount, info.wordGoal]);

  // Word-count chip toggle — persists per page on this device.
  const [wordChipHidden, setWordChipHidden] = useState(false);
  useEffect(() => {
    try {
      setWordChipHidden(
        localStorage.getItem(`hide-wordchip:${page.id}`) === "1",
      );
    } catch {}
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ pageId?: string }>;
      if (!ce.detail || ce.detail.pageId === page.id) {
        try {
          setWordChipHidden(
            localStorage.getItem(`hide-wordchip:${page.id}`) === "1",
          );
        } catch {}
      }
    };
    window.addEventListener("noteforge:wordchip-changed", handler as EventListener);
    return () =>
      window.removeEventListener(
        "noteforge:wordchip-changed",
        handler as EventListener,
      );
  }, [page.id]);

  // ⌘⇧? — jump to a random doc in the workspace (workspace shuffle).
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "?" && e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      const inForm =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (inForm) return;
      e.preventDefault();
      try {
        const res = await fetch(
          `/api/workspace/random?slug=${encodeURIComponent(slug)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { id: string | null };
        if (data.id && data.id !== page.id)
          window.location.href = `/w/${slug}/p/${data.id}`;
      } catch {}
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, page.id]);

  // 1 / 2 / 3 — quick toggle reaction emojis on this page.
  useEffect(() => {
    if (readOnly) return;
    const KEY_MAP: Record<string, string> = { "1": "👍", "2": "❤️", "3": "😂" };
    const onKey = async (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const emoji = KEY_MAP[e.key];
      if (!emoji) return;
      const t = e.target as HTMLElement | null;
      const inForm =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (inForm) return;
      e.preventDefault();
      try {
        const { togglePageReaction } = await import(
          "@/app/w/[slug]/actions"
        );
        await togglePageReaction(slug, page.id, emoji);
      } catch {}
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, page.id, readOnly]);

  // [ / ] — jump to previous / next H1-H3 heading inside the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      const t = e.target as HTMLElement | null;
      const inForm =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (inForm) return;
      const headings = Array.from(
        document.querySelectorAll<HTMLElement>(".bn-editor h1, .bn-editor h2, .bn-editor h3"),
      );
      if (headings.length === 0) return;
      const y = window.scrollY + 120;
      // Find current heading index by which one is closest above the y line.
      let curIdx = -1;
      for (let i = 0; i < headings.length; i++) {
        const top = headings[i].getBoundingClientRect().top + window.scrollY;
        if (top <= y) curIdx = i;
        else break;
      }
      const nextIdx =
        e.key === "]"
          ? Math.min(headings.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);
      if (nextIdx === curIdx) return;
      e.preventDefault();
      headings[nextIdx].scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌘⇧J — jump to the workspace Inbox (the page slugged 'inbox').
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "J" && e.key !== "j") return;
      const t = e.target as HTMLElement | null;
      const inForm =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (inForm) return;
      const link = document.querySelector<HTMLAnchorElement>(
        'aside a[href$="/p/inbox"], aside a[title="Inbox"]',
      );
      if (link) {
        e.preventDefault();
        link.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Scroll-to-top / scroll-to-bottom floating buttons on long pages.
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      setShowTop(y > 600);
      setShowBottom(h - y > 600);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Tick once per minute so the relative "Last edited" timestamp stays fresh
  // without forcing a full re-render of the editor body.
  const [, setTickRef] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTickRef((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Apply device-wide style toggles on mount.
  useEffect(() => {
    const toggles = [
      "comments-compact",
      "print-no-comments",
      "heading-numbers",
      "bionic",
      "zen-mode",
      "highlight-links",
      "dyslexia",
      "justify-text",
      "db-compact",
      "db-striped",
      "larger-font",
      "sticky-title",
      "bg-grid",
      "bg-dots",
      "bg-ruled",
      "hide-reactions",
      "hide-tags",
      "hide-subpages",
      "hide-backlinks",
      "breadcrumb-sticky",
      "sidebar-hide-icons",
      "sidebar-group-by-kind",
      "hide-outline",
      "hide-trash",
      "page-dark",
      "compact-title",
      "spacing-roomy",
      "db-sticky-head",
      "larger-touch",
      "hide-breadcrumb",
      "sticky-h2",
      "center-title",
      "hide-footer",
      "show-block-ids",
      "side-menu-on",
      "code-larger",
      "quote-accent",
      "code-line-numbers",
      "image-rounded",
      "line-loose",
      "bookworm",
      "compact-subpage-cards",
      "dotted-divider",
      "hide-footer-dates",
      "no-emoji-icons",
      "compact-callouts",
      "two-col-reading",
      "print-page-numbers",
      "print-no-images",
      "wide-page",
      "meta-on-hover",
      "mono-code",
      "indent-guides",
      "highlight-todos",
      "no-animations",
      "heading-separator",
      "highlight-urls",
      "image-zoom-cursor",
      "big-numbered-list",
      "selection-accent",
      "block-hover-lift",
      "reduced-contrast",
      "checklist-strike",
      "wider-gutters",
      "blockquote-drama",
      "db-compact-rows",
      "sidebar-small-text",
      "h1-as-h2",
      "sidebar-wide",
      "outline-pinned",
      "sidebar-darker",
      "mobile-narrow",
      "big-headings",
      "square-bullets",
      "auto-num-headings",
      "para-indent",
      "print-toggle-expand",
      "thick-caret",
      "code-chip",
      "caret-block-highlight",
      "no-image-captions",
      "larger-checkbox",
      "reading-ruler",
      "mini-sidebar-icons",
      "two-tone-tags",
      "neutral-links",
      "link-underline-hover",
      "code-line-wrap",
      "heading-anchor-hover",
      "no-selection",
      "italic-accent",
      "heading-shadow",
      "external-link-icon",
      "italic-serif",
      "big-checklist-text",
      "strikethrough-faded",
      "drop-cap",
      "highlight-accent",
      "cream-bg",
      "outline-current-ring",
      "thin-scrollbar",
      "lock-page-title",
      "paragraph-separators",
      "title-underline",
      "quote-left-ribbon",
      "image-rounded-xl",
      "sidebar-accent",
      "compact-spacing",
      "scroll-snap-headings",
      "mono-sidebar",
      "bigger-cursor",
      "title-no-emoji",
      "dark-code-always",
      "tag-pills",
      "numbered-outline",
      "bold-accent",
      "internal-link-arrow",
      "no-focus-ring",
      "reading-focus-card",
      "title-gradient",
      "list-marker-bold",
      "print-no-header",
      "custom-toggle-arrow",
      "bullet-emoji",
      "heading-uppercase",
      "page-side-ribbon",
      "smaller-callout-emoji",
      "sidebar-collapsed-init",
      "callout-italic-text",
      "list-marker-bold",
      "h1-letter-spacing",
      "paragraph-justify",
      "first-paragraph-lead",
      "code-inline-mono",
      "blockquote-large",
      "h3-italic",
      "checkbox-larger",
      "page-vignette",
      "table-zebra",
      "image-rounded-xl",
      "code-block-stripes",
      "selection-accent",
      "scrollbar-thin-accent",
      "h2-numbered-auto",
      "image-grayscale",
      "callout-shadow",
      "link-no-underline",
      "letter-spacing-body",
      "ul-disc-square",
      "ol-roman",
      "page-grid-bg",
      "first-line-indent",
      "caption-italic",
      "h1-italic-accent",
      "quote-marks-large",
      "list-spacing-airy",
      "table-header-uppercase",
      "checkbox-strikethrough",
      "h4-uppercase",
      "code-block-tab-2",
      "paragraph-narrow-line",
      "callout-emoji-large",
      "page-background-paper",
      "block-hover-highlight",
      "h2-numbered-dot",
      "code-inline-color",
      "image-border-thick",
      "selection-mono-font",
      "page-icon-bigger",
      "h3-with-bar",
      "code-block-rounded",
      "tag-pill-style",
      "image-shadow-soft",
      "h1-with-emoji-divider",
      "ul-checkmarks",
      "table-rounded",
      "code-block-numbered",
      "page-edge-glow",
      "h5-uppercase-tiny",
      "code-block-window-bar",
      "callout-tip-emoji",
      "table-header-bold-bg",
      "page-side-margins-wider",
      "h2-with-underline-gradient",
      "code-block-no-background",
      "table-borderless",
      "callout-numbered-prefix",
      "page-corner-flag",
      "page-watermark-text",
      "h1-shadow-text",
      "ul-arrow-marker",
      "table-cell-padding-wider",
      "callout-rounded-pill",
      "h3-color-blue",
      "ul-dash-marker",
      "table-row-hover",
      "code-inline-uppercase",
      "page-margin-rule",
      "h6-monospace",
      "code-block-large-text",
      "ol-zero-indexed",
      "table-first-column-bold",
      "page-no-paragraph-margin",
      "h1-aligned-center",
      "code-inline-italic",
      "table-stripes-vertical",
      "callout-bg-translucent",
      "page-side-tab",
      "h2-color-accent",
      "code-block-mono-only",
      "table-alt-text-color",
      "callout-border-dashed",
      "page-rule-tip-corner",
      "bullet-numbered-prefix",
      "h4-color-orange",
      "code-block-rainbow-border",
      "table-zebra-blue",
      "page-spotlight-cursor",
      "ol-uppercase-alpha",
      "h1-with-prefix-section",
      "callout-border-thick",
      "table-no-grid",
      "page-paper-edge",
      "h2-color-purple",
      "code-block-glass",
      "table-row-numbered",
      "callout-quote-style",
      "page-corner-fold",
      "h3-with-decoration",
      "ul-emoji-marker",
      "table-large-font",
      "code-block-shadow",
      "callout-icon-emoji-only",
      "h1-tracking-tight",
      "code-line-wrap",
      "table-borderless-headers",
      "callout-pulse-animation",
      "page-print-only-margin",
      "h2-numbered-roman",
      "ol-bracket-style",
      "callout-shadow-soft",
      "table-merge-header",
      "page-print-bleed",
      "h6-italic-tiny",
      "code-block-no-radius",
      "table-fixed-layout",
      "callout-emoji-prefix-warn",
      "page-grid-square",
      "h1-with-final-marker",
      "page-completion-stamp",
      "h1-with-arrow-prefix",
      "code-block-line-divider",
      "table-rounded-cells",
      "callout-elevated-shadow",
      "page-corner-stitch",
      "h2-with-bullet-dot",
      "code-block-pastel-bg",
      "table-zebra-vertical",
      "callout-rotate-tiny",
      "page-frame-border",
      "h3-with-double-bar",
      "code-block-traffic-lights",
      "table-header-emoji-prefix",
      "callout-corner-fold-decoration",
      "page-edge-rule-left",
      "h4-with-square-bullet",
      "code-block-typewriter",
      "table-soft-divider",
      "callout-double-border",
      "page-tape-corner",
      "h5-with-arrow-prefix",
      "code-block-blueprint",
      "table-cell-empty-mark",
      "callout-curved-tab",
      "page-coffee-stain",
      "h6-with-tilde-prefix",
      "code-block-paper-feel",
      "table-row-numbered-roman",
      "callout-pin-decoration",
      "page-margin-notes-area",
      "h1-with-bullet-square",
      "code-block-purple-night",
      "table-borderless-rounded",
      "callout-no-bg",
      "page-graph-paper-bg",
      "h2-with-block-prefix",
      "code-block-amber-terminal",
      "table-header-pill",
      "callout-cut-corner",
      "page-side-folder-tab",
      "h3-with-folder-prefix",
      "code-block-mint-bg",
      "table-cells-shadowed",
      "callout-leaf-marker",
      "page-tabbed-edge-top",
      "h4-with-asterisk-prefix",
      "code-block-monokai",
      "table-first-row-highlight",
      "callout-quote-mark-large",
      "page-side-page-numbers",
      "h5-with-diamond-prefix",
      "code-block-solarized-light",
      "table-numbered-cols",
      "callout-pulse-once",
      "page-side-rule-right",
      "h6-with-bullet-prefix",
      "code-block-dracula",
      "table-emphasized-row-first",
      "callout-arrow-marker-right",
      "page-side-clip",
      "h1-with-page-mark",
      "code-block-github-light",
      "table-row-divider-thick",
      "callout-corner-flag",
      "page-side-binder-rings",
      "h2-with-page-mark",
      "code-block-night-owl",
      "table-row-divider-dashed",
      "callout-corner-flag-yellow",
      "page-side-perforated",
      "h3-with-page-mark",
      "code-block-cobalt",
      "table-row-divider-gradient",
      "callout-tag-marker",
      "page-side-ribbon-blue",
      "h4-with-page-mark",
      "code-block-tokyo-night",
      "table-header-italic",
      "callout-bar-left-thick",
      "page-side-bookmark",
      "h5-with-page-mark",
      "code-block-light-gray-stripes",
      "table-row-divider-thin",
      "callout-bordered-curved",
      "page-side-margin-paragraph",
      "h6-with-page-mark",
      "code-block-rosy-pink",
      "table-row-divider-double",
      "callout-stamp-overlay",
      "page-side-margin-icon-area",
      "h1-with-corner-radius-blob",
      "code-block-rainbow-stripes",
      "table-header-vertical-orientation",
      "callout-hand-pointer",
      "page-side-clip-paper-corner",
      "h2-with-corner-radius-blob",
      "code-block-checkered",
      "table-row-divider-zigzag",
      "callout-pin-overlay",
      "page-side-double-margin",
      "h3-with-corner-radius-blob",
      "code-block-strict-grayscale",
      "table-data-cell-mono",
      "callout-cross-pattern-bg",
      "page-side-double-rule",
      "h4-corner-radius-blob",
      "code-block-line-spacing-loose",
      "table-row-hover-emphasize",
      "callout-side-tab-large",
      "page-edge-gradient",
      "h5-corner-radius-blob",
      "code-block-cool-fade",
      "table-row-divider-color-blue",
      "callout-side-tab-pill",
      "page-side-tab-corner",
      "h6-corner-radius-blob",
      "code-block-warm-fade",
      "table-row-divider-color-red",
      "callout-side-tab-square",
      "page-side-tab-bottom",
      "h1-with-side-marker",
      "code-block-grayscale-banded",
      "table-row-divider-color-green",
      "callout-side-tab-arrow",
      "page-side-tab-top-right",
      "h2-with-side-marker",
      "code-block-noise-bg",
      "table-row-divider-color-purple",
      "callout-side-tab-rounded",
      "page-side-tab-top-left",
      "h3-with-side-marker",
      "code-block-warm-banded",
      "table-row-divider-color-orange",
      "callout-side-tab-chevron",
      "page-side-tab-mid-left",
      "h4-with-side-marker",
      "code-block-cool-banded",
      "table-row-divider-color-pink",
      "callout-side-tab-dot",
      "page-side-tab-mid-right",
      "h5-with-side-marker",
      "code-block-cyber-grid",
      "table-row-divider-color-teal",
      "callout-side-tab-grip",
      "page-side-shadow-soft",
      "h6-with-side-marker",
      "code-block-blueprint-grid",
      "table-row-divider-color-gray",
      "callout-side-tab-flag",
      "page-side-shadow-strong",
      "h1-with-underline-double",
      "code-block-magenta-night",
      "table-cell-corner-accent",
      "callout-rounded-large-shadow",
      "page-bg-subtle-dots",
      "h2-with-underline-double",
      "code-block-forest-green",
      "table-cell-corner-accent-tr",
      "callout-glow-border",
      "page-bg-subtle-lines",
      "h3-with-underline-double",
      "code-block-sunset",
      "table-cell-corner-accent-br",
      "callout-neon-glow",
      "page-bg-graph-fine",
      "h4-with-underline-double",
      "code-block-ocean",
      "table-zebra-three-tone",
      "callout-glow-pink",
      "page-bg-isometric",
      "h5-with-underline-double",
      "code-block-volcano",
      "table-zebra-blue-tone",
      "callout-glow-green",
      "page-bg-hexagon",
      "h6-with-underline-double",
      "code-block-rose",
      "table-zebra-green-tone",
      "callout-glow-orange",
      "page-bg-diagonal-lines",
      "h1-with-dotted-underline",
      "code-block-aurora",
      "table-header-gradient",
      "callout-glow-blue",
      "page-bg-wave",
      "h2-with-dotted-underline",
      "code-block-midnight-blue",
      "table-header-gradient-warm",
      "callout-glow-purple",
      "page-bg-confetti",
      "h3-with-dotted-underline",
      "code-block-slate",
      "table-header-gradient-cool",
      "callout-glow-teal",
      "page-bg-bubbles",
      "h4-with-dotted-underline",
      "code-block-charcoal",
      "table-header-gradient-purple",
      "callout-glow-red",
      "page-bg-triangles",
      "h5-with-dotted-underline",
      "code-block-emerald",
      "table-cell-hover-highlight",
      "callout-glow-amber",
      "page-bg-plus-pattern",
      "h6-with-dotted-underline",
      "code-block-indigo",
      "table-cell-hover-row-col",
      "callout-glow-cyan",
      "page-bg-cross-hatch",
      "h1-with-box-around",
      "code-block-crimson",
      "table-header-sticky-shadow",
      "callout-stripe-left",
      "page-bg-zigzag",
      "h2-with-box-around",
      "code-block-teal-night",
      "table-header-uppercase-bold",
      "callout-stripe-top",
      "page-bg-scallop",
      "h3-with-box-around",
      "code-block-graphite",
      "table-header-bottom-accent",
      "callout-stripe-right",
      "page-bg-grid-dots-combo",
      "h1-with-c-series-marker",
      "page-c-series-complete-stamp",
      "h2-with-double-arrow",
      "code-block-nord-theme",
      "table-cell-roomy",
      "callout-corner-fold",
      "page-bg-vertical-rule",
      "h3-with-chevron",
      "code-block-github-light",
      "table-first-col-bold",
      "callout-left-accent-thick",
      "page-bg-diagonal-stripes",
      "h4-with-bullet",
      "code-block-one-dark",
      "table-zebra-columns",
      "callout-icon-large",
      "page-bg-graph-paper",
      "h5-with-dash",
      "code-block-gruvbox",
      "table-compact-rows",
      "callout-shadow-inset",
      "page-bg-weave",
      "h6-with-arrow",
      "code-block-tomorrow-night",
      "table-border-double",
      "callout-gradient-bg",
      "page-bg-polka-large",
      "heading-all-letterspaced",
      "code-block-palenight",
      "table-rounded-corners",
      "callout-dashed-border",
      "page-bg-chevron-pattern",
      "heading-italic-all",
      "code-block-ayu-dark",
      "table-header-sticky",
      "callout-pill-shape",
      "page-bg-stars",
      "heading-underline-all",
      "code-block-synthwave",
      "table-no-borders",
      "callout-3d-raised",
      "page-bg-blueprint",
      "heading-shadow-text",
      "code-block-monokai-pro",
      "table-striped-thick",
      "callout-neon-outline",
      "page-bg-honeycomb",
      "heading-gradient-fill",
      "code-block-dracula-pro",
      "table-hover-highlight",
      "callout-emoji-hidden",
      "page-bg-circuit",
      "heading-numbered-auto",
      "code-block-horizon",
      "table-cell-center",
      "callout-top-border-accent",
      "page-bg-noise",
      "heading-uppercase-all",
      "code-block-catppuccin",
      "table-row-numbers",
      "callout-glass-blur",
      "page-bg-gradient-radial",
      "heading-left-border",
      "code-block-everforest",
      "table-header-2tone",
      "callout-rounded-left",
      "page-bg-topographic",
      "heading-double-underline",
      "code-block-kanagawa",
      "table-vertical-lines",
      "callout-soft-tint",
      "page-bg-droplets",
      "heading-small-caps",
      "code-block-rose-pine",
      "table-alt-col-tint",
      "callout-inset-border",
      "page-bg-plus-grid",
      "heading-mono-font",
      "code-block-zenburn",
      "table-header-tracked",
      "callout-bg-striped",
      "page-bg-maze",
      "heading-colored-h1",
      "code-block-oceanic",
      "table-zebra-rounded",
      "callout-quote-bar",
      "page-bg-scales",
      "heading-bg-highlight",
      "code-block-material",
      "table-first-row-accent",
      "callout-icon-circle",
      "page-bg-waves",
      "heading-bracket-wrap",
      "code-block-nord-light",
      "table-dense-borders",
      "callout-rounded-top",
      "page-bg-dots-diagonal",
      "heading-overline",
      "code-block-iceberg",
      "table-cell-right-align",
      "callout-frosted",
      "page-bg-grid-fade",
      "heading-tiny-caps-label",
      "code-block-gruvbox-light",
      "table-zebra-emerald",
      "callout-gradient-border",
      "page-bg-spotlight",
      "heading-corner-tab",
      "code-block-gotham",
      "table-borderless-zebra",
      "callout-icon-top",
      "page-bg-soft-vignette",
      "heading-side-number",
      "code-block-base16",
      "table-thick-header-line",
      "callout-corner-ribbon",
      "page-bg-subtle-checker",
      "heading-italic-h1-only",
      "code-block-spacegray",
      "table-row-hover-scale",
      "callout-left-icon-bar",
      "page-bg-confetti-dots",
      "heading-condensed",
      "code-block-tokyo-storm",
      "table-cell-vertical-center",
      "callout-outline-only",
      "page-bg-diamonds",
      "heading-serif-font",
      "code-block-ayu-mirage",
      "table-zebra-amber",
      "callout-pulse-border",
      "page-bg-grid-bold",
      "heading-shadow-offset",
      "code-block-vscode-dark",
      "table-rounded-header",
      "callout-left-tab-label",
      "page-bg-carbon",
      "heading-all-bold-black",
      "code-block-github-dark",
      "table-header-lowercase",
      "callout-thin-border",
      "page-bg-soft-grid-dots",
      "heading-underline-gradient",
      "code-block-night-owl-light",
      "table-cell-borders-dashed",
      "callout-shadow-lg",
      "page-bg-radial-dots",
      "heading-pill-bg",
      "code-block-min-light",
      "table-compact-font",
      "callout-icon-square",
      "page-bg-soft-noise2",
      "heading-letterpress",
      "code-block-panda",
      "table-header-pill-cells",
      "callout-corner-accent",
      "page-bg-grid-thin",
      "heading-dotted-underline",
      "code-block-snazzy",
      "table-first-col-sticky",
      "callout-text-uppercase",
      "page-bg-grain",
      "heading-double-color",
      "code-block-bluloco",
      "table-cell-monospace",
      "callout-rounded-2xl",
      "page-bg-mesh-gradient",
      "heading-tag-prefix",
      "code-block-poimandres",
      "table-cell-top-align",
      "callout-no-padding",
      "page-bg-blobs",
      "heading-wavy-underline",
      "code-block-flexoki",
      "table-cell-nowrap",
      "callout-side-accent-gradient",
      "page-bg-corner-glow",
      "heading-bg-stripe",
      "code-block-vesper",
      "table-row-divider-bold",
      "callout-icon-spin",
      "page-bg-soft-rays",
      "heading-margin-note",
      "code-block-aura",
      "table-striped-purple",
      "callout-emoji-bounce",
      "page-bg-aurora",
      "heading-italic-serif",
      "code-block-rose-pine-dawn",
      "table-cell-borders-thick",
      "callout-rounded-bottom",
      "page-bg-soft-checker2",
      "heading-ribbon",
      "code-block-gruvbox-material",
      "table-header-dark",
      "callout-elevated-card",
      "page-bg-soft-glow-center",
      "heading-caps-accent",
      "code-block-night-fox",
      "table-zebra-rose",
      "callout-badge-corner",
      "page-bg-soft-lines-h",
      "heading-side-bracket",
      "code-block-everblush",
      "table-zebra-slate",
      "callout-left-dot",
      "page-bg-soft-lines-v",
      "heading-gradient-bar",
      "code-block-melange",
      "table-zebra-teal",
      "callout-double-stripe",
      "page-bg-soft-glow-tl",
      "heading-marker-square",
      "code-block-modus",
      "table-zebra-indigo",
      "callout-top-tab",
      "page-bg-soft-glow-br",
      "heading-marker-diamond",
      "code-block-flexoki-light",
      "table-zebra-cyan",
      "callout-bottom-tab",
      "page-bg-soft-glow-bl",
      "heading-marker-circle",
      "code-block-tokyo-day",
      "table-zebra-fuchsia",
      "callout-glow-bottom",
      "page-bg-soft-glow-tr",
      "h1-with-d-series-marker",
      "page-d-series-complete-stamp",
      "code-block-rose-pine-moon",
      "table-border-double-emerald",
      "callout-emerald-tint",
      "page-bg-engraved-grid",
      "heading-emerald-underline",
      "code-block-eap-1",
      "table-eap-2",
      "callout-eap-3",
      "page-bg-eap-4",
      "heading-eap-5",
      "code-block-ebe-1",
      "table-ebe-2",
      "callout-ebe-3",
      "page-bg-ebe-4",
      "heading-ebe-5",
      "code-block-ebt-1",
      "table-ebt-2",
      "callout-ebt-3",
      "page-bg-ebt-4",
      "heading-ebt-5",
      "code-block-eci-1",
      "table-eci-2",
      "callout-eci-3",
      "page-bg-eci-4",
      "heading-eci-5",
      "code-block-ecx-1",
      "table-ecx-2",
      "callout-ecx-3",
      "page-bg-ecx-4",
      "heading-ecx-5",
      "code-block-edm-1",
      "table-edm-2",
      "callout-edm-3",
      "page-bg-edm-4",
      "heading-edm-5",
      "code-block-eeb-1",
      "table-eeb-2",
      "callout-eeb-3",
      "page-bg-eeb-4",
      "heading-eeb-5",
      "code-block-eer-1",
      "table-eer-2",
      "callout-eer-3",
      "page-bg-eer-4",
      "heading-eer-5",
      "code-block-efg-1",
      "table-efg-2",
      "callout-efg-3",
      "page-bg-efg-4",
      "heading-efg-5",
      "code-block-efv-1",
      "table-efv-2",
      "callout-efv-3",
      "page-bg-efv-4",
      "heading-efv-5",
      "code-block-egk-1",
      "table-egk-2",
      "callout-egk-3",
      "page-bg-egk-4",
      "heading-egk-5",
      "code-block-egz-1",
      "table-egz-2",
      "callout-egz-3",
      "page-bg-egz-4",
      "heading-egz-5",
      "code-block-eho-1",
      "table-eho-2",
      "callout-eho-3",
      "page-bg-eho-4",
      "heading-eho-5",
      "code-block-eid-1",
      "table-eid-2",
      "callout-eid-3",
      "page-bg-eid-4",
      "heading-eid-5",
      "code-block-eis-1",
      "table-eis-2",
      "callout-eis-3",
      "page-bg-eis-4",
      "heading-eis-5",
      "code-block-ejh-1",
      "table-ejh-2",
      "callout-ejh-3",
      "page-bg-ejh-4",
      "heading-ejh-5",
      "code-block-ejw-1",
      "table-ejw-2",
      "callout-ejw-3",
      "page-bg-ejw-4",
      "heading-ejw-5",
      "code-block-ekl-1",
      "table-ekl-2",
      "callout-ekl-3",
      "page-bg-ekl-4",
      "heading-ekl-5",
      "code-block-ela-1",
      "table-ela-2",
      "callout-ela-3",
      "page-bg-ela-4",
      "heading-ela-5",
      "code-block-elp-1",
      "table-elp-2",
      "callout-elp-3",
      "page-bg-elp-4",
      "heading-elp-5",
      "code-block-eme-1",
      "table-eme-2",
      "callout-eme-3",
      "page-bg-eme-4",
      "heading-eme-5",
      "code-block-emt-1",
      "table-emt-2",
      "callout-emt-3",
      "page-bg-emt-4",
      "heading-emt-5",
      "code-block-eni-1",
      "table-eni-2",
      "callout-eni-3",
      "page-bg-eni-4",
      "heading-eni-5",
      "code-block-enx-1",
      "table-enx-2",
      "callout-enx-3",
      "page-bg-enx-4",
      "heading-enx-5",
      "code-block-eom-1",
      "table-eom-2",
      "callout-eom-3",
      "page-bg-eom-4",
      "heading-eom-5",
      "code-block-epb-1",
      "table-epb-2",
      "callout-epb-3",
      "page-bg-epb-4",
      "heading-epb-5",
      "code-block-epq-1",
      "table-epq-2",
      "callout-epq-3",
      "page-bg-epq-4",
      "heading-epq-5",
      "code-block-eqf-1",
      "table-eqf-2",
      "callout-eqf-3",
      "page-bg-eqf-4",
      "heading-eqf-5",
      "code-block-equ-1",
      "table-equ-2",
      "callout-equ-3",
      "page-bg-equ-4",
      "heading-equ-5",
      "code-block-erj-1",
      "table-erj-2",
      "callout-erj-3",
      "page-bg-erj-4",
      "heading-erj-5",
      "code-block-ery-1",
      "table-ery-2",
      "callout-ery-3",
      "page-bg-ery-4",
      "heading-ery-5",
      "code-block-esn-1",
      "table-esn-2",
      "callout-esn-3",
      "page-bg-esn-4",
      "heading-esn-5",
      "code-block-etc-1",
      "table-etc-2",
      "callout-etc-3",
      "page-bg-etc-4",
      "heading-etc-5",
      "code-block-etr-1",
      "table-etr-2",
      "callout-etr-3",
      "page-bg-etr-4",
      "heading-etr-5",
      "code-block-eug-1",
      "table-eug-2",
      "callout-eug-3",
      "page-bg-eug-4",
      "heading-eug-5",
      "code-block-euv-1",
      "table-euv-2",
      "callout-euv-3",
      "page-bg-euv-4",
      "heading-euv-5",
      "code-block-evk-1",
      "table-evk-2",
      "callout-evk-3",
      "page-bg-evk-4",
      "heading-evk-5",
      "code-block-evz-1",
      "table-evz-2",
      "callout-evz-3",
      "page-bg-evz-4",
      "heading-evz-5",
      "code-block-ewo-1",
      "table-ewo-2",
      "callout-ewo-3",
      "page-bg-ewo-4",
      "heading-ewo-5",
      "code-block-exd-1",
      "table-exd-2",
      "callout-exd-3",
      "page-bg-exd-4",
      "heading-exd-5",
      "code-block-exs-1",
      "table-exs-2",
      "callout-exs-3",
      "page-bg-exs-4",
      "heading-exs-5",
      "code-block-eyh-1",
      "table-eyh-2",
      "callout-eyh-3",
      "page-bg-eyh-4",
      "heading-eyh-5",
      "code-block-eyw-1",
      "table-eyw-2",
      "callout-eyw-3",
      "page-bg-eyw-4",
      "heading-eyw-5",
      "code-block-ezl-1",
      "table-ezl-2",
      "callout-ezl-3",
      "page-bg-ezl-4",
      "heading-ezl-5",
      "code-block-faa-1",
      "table-faa-2",
      "callout-faa-3",
      "page-bg-faa-4",
      "heading-faa-5",
      "code-block-faq-1",
      "table-faq-2",
      "callout-faq-3",
      "page-bg-faq-4",
      "heading-faq-5",
      "code-block-fbf-1",
      "table-fbf-2",
      "callout-fbf-3",
      "page-bg-fbf-4",
      "heading-fbf-5",
      "code-block-fbu-1",
      "table-fbu-2",
      "callout-fbu-3",
      "page-bg-fbu-4",
      "heading-fbu-5",
      "code-block-fcj-1",
      "table-fcj-2",
      "callout-fcj-3",
      "page-bg-fcj-4",
      "heading-fcj-5",
      "code-block-fcy-1",
      "table-fcy-2",
      "callout-fcy-3",
      "page-bg-fcy-4",
      "heading-fcy-5",
      "code-block-fdn-1",
      "table-fdn-2",
      "callout-fdn-3",
      "page-bg-fdn-4",
      "heading-fdn-5",
      "code-block-fec-1",
      "table-fec-2",
      "callout-fec-3",
      "page-bg-fec-4",
      "heading-fec-5",
      "code-block-fer-1",
      "table-fer-2",
      "callout-fer-3",
      "page-bg-fer-4",
      "heading-fer-5",
      "code-block-ffh-1",
      "table-ffh-2",
      "callout-ffh-3",
      "page-bg-ffh-4",
      "heading-ffh-5",
      "code-block-ffw-1",
      "table-ffw-2",
      "callout-ffw-3",
      "page-bg-ffw-4",
      "heading-ffw-5",
      "code-block-fgl-1",
      "table-fgl-2",
      "callout-fgl-3",
      "page-bg-fgl-4",
      "heading-fgl-5",
      "code-block-fha-1",
      "table-fha-2",
      "callout-fha-3",
      "page-bg-fha-4",
      "heading-fha-5",
      "code-block-fhp-1",
      "table-fhp-2",
      "callout-fhp-3",
      "page-bg-fhp-4",
      "heading-fhp-5",
      "code-block-fie-1",
      "table-fie-2",
      "callout-fie-3",
      "page-bg-fie-4",
      "heading-fie-5",
      "code-block-fit-1",
      "table-fit-2",
      "callout-fit-3",
      "page-bg-fit-4",
      "heading-fit-5",
      "code-block-fji-1",
      "table-fji-2",
      "callout-fji-3",
      "page-bg-fji-4",
      "heading-fji-5",
      "code-block-fjx-1",
      "table-fjx-2",
      "callout-fjx-3",
      "page-bg-fjx-4",
      "heading-fjx-5",
      "code-block-fkm-1",
      "table-fkm-2",
      "callout-fkm-3",
      "page-bg-fkm-4",
      "heading-fkm-5",
      "code-block-flb-1",
      "table-flb-2",
      "callout-flb-3",
      "page-bg-flb-4",
      "heading-flb-5",
      "code-block-flq-1",
      "table-flq-2",
      "callout-flq-3",
      "page-bg-flq-4",
      "heading-flq-5",
      "code-block-fmf-1",
      "table-fmf-2",
      "callout-fmf-3",
      "page-bg-fmf-4",
      "heading-fmf-5",
      "code-block-fmu-1",
      "table-fmu-2",
      "callout-fmu-3",
      "page-bg-fmu-4",
      "heading-fmu-5",
      "code-block-fnj-1",
      "table-fnj-2",
      "callout-fnj-3",
      "page-bg-fnj-4",
      "heading-fnj-5",
      "code-block-fny-1",
      "table-fny-2",
      "callout-fny-3",
      "page-bg-fny-4",
      "heading-fny-5",
      "code-block-fon-1",
      "table-fon-2",
      "callout-fon-3",
      "page-bg-fon-4",
      "heading-fon-5",
      "code-block-fpc-1",
      "table-fpc-2",
      "callout-fpc-3",
      "page-bg-fpc-4",
      "heading-fpc-5",
      "code-block-fpr-1",
      "table-fpr-2",
      "callout-fpr-3",
      "page-bg-fpr-4",
      "heading-fpr-5",
      "code-block-fqg-1",
      "table-fqg-2",
      "callout-fqg-3",
      "page-bg-fqg-4",
      "heading-fqg-5",
      "code-block-fqv-1",
      "table-fqv-2",
      "callout-fqv-3",
      "page-bg-fqv-4",
      "heading-fqv-5",
      "code-block-frk-1",
      "table-frk-2",
      "callout-frk-3",
      "page-bg-frk-4",
      "heading-frk-5",
      "code-block-frz-1",
      "table-frz-2",
      "callout-frz-3",
      "page-bg-frz-4",
      "heading-frz-5",
      "code-block-fso-1",
      "table-fso-2",
      "callout-fso-3",
      "page-bg-fso-4",
      "heading-fso-5",
      "code-block-ftd-1",
      "table-ftd-2",
      "callout-ftd-3",
      "page-bg-ftd-4",
      "heading-ftd-5",
      "code-block-fts-1",
      "table-fts-2",
      "callout-fts-3",
      "page-bg-fts-4",
      "heading-fts-5",
      "code-block-fuh-1",
      "table-fuh-2",
      "callout-fuh-3",
      "page-bg-fuh-4",
      "heading-fuh-5",
      "code-block-fuw-1",
      "table-fuw-2",
      "callout-fuw-3",
      "page-bg-fuw-4",
      "heading-fuw-5",
      "code-block-fvl-1",
      "table-fvl-2",
      "callout-fvl-3",
      "page-bg-fvl-4",
      "heading-fvl-5",
      "code-block-fwa-1",
      "table-fwa-2",
      "callout-fwa-3",
      "page-bg-fwa-4",
      "heading-fwa-5",
      "code-block-fwp-1",
      "table-fwp-2",
      "callout-fwp-3",
      "page-bg-fwp-4",
      "heading-fwp-5",
      "code-block-fxe-1",
      "table-fxe-2",
      "callout-fxe-3",
      "page-bg-fxe-4",
      "heading-fxe-5",
      "code-block-fxt-1",
      "table-fxt-2",
      "callout-fxt-3",
      "page-bg-fxt-4",
      "heading-fxt-5",
      "code-block-fyi-1",
      "table-fyi-2",
      "callout-fyi-3",
      "page-bg-fyi-4",
      "heading-fyi-5",
      "code-block-fyx-1",
      "table-fyx-2",
      "callout-fyx-3",
      "page-bg-fyx-4",
      "heading-fyx-5",
      "code-block-fzm-1",
      "table-fzm-2",
      "callout-fzm-3",
      "page-bg-fzm-4",
      "code-block-gaa-1",
      "table-gaa-2",
      "callout-gaa-3",
      "page-bg-gaa-4",
      "heading-gaa-5",
      "code-block-gap-1",
      "table-gap-2",
      "callout-gap-3",
      "page-bg-gap-4",
      "heading-gap-5",
      "code-block-gbe-1",
      "table-gbe-2",
      "callout-gbe-3",
      "page-bg-gbe-4",
      "heading-gbe-5",
      "code-block-gbt-1",
      "table-gbt-2",
      "callout-gbt-3",
      "page-bg-gbt-4",
      "heading-gbt-5",
      "code-block-gci-1",
      "table-gci-2",
      "callout-gci-3",
      "page-bg-gci-4",
      "heading-gci-5",
      "code-block-gcx-1",
      "table-gcx-2",
      "callout-gcx-3",
      "page-bg-gcx-4",
      "heading-gcx-5",
      "code-block-gdm-1",
      "table-gdm-2",
      "callout-gdm-3",
      "page-bg-gdm-4",
      "heading-gdm-5",
      "code-block-geb-1",
      "table-geb-2",
      "callout-geb-3",
      "page-bg-geb-4",
      "heading-geb-5",
      "code-block-geq-1",
      "table-geq-2",
      "callout-geq-3",
      "page-bg-geq-4",
      "heading-geq-5",
      "code-block-gff-1",
      "table-gff-2",
      "callout-gff-3",
      "page-bg-gff-4",
      "heading-gff-5",
      "code-block-gfu-1",
      "table-gfu-2",
      "callout-gfu-3",
      "page-bg-gfu-4",
      "heading-gfu-5",
      "code-block-ggk-1",
      "table-ggk-2",
      "callout-ggk-3",
      "page-bg-ggk-4",
      "heading-ggk-5",
      "code-block-ggz-1",
      "table-ggz-2",
      "callout-ggz-3",
      "page-bg-ggz-4",
      "heading-ggz-5",
      "code-block-gho-1",
      "table-gho-2",
      "callout-gho-3",
      "page-bg-gho-4",
      "heading-gho-5",
      "code-block-gid-1",
      "table-gid-2",
      "callout-gid-3",
      "page-bg-gid-4",
      "heading-gid-5",
      "code-block-gis-1",
      "table-gis-2",
      "callout-gis-3",
      "page-bg-gis-4",
      "heading-gis-5",
      "code-block-gjh-1",
      "table-gjh-2",
      "callout-gjh-3",
      "page-bg-gjh-4",
      "heading-gjh-5",
      "code-block-gjw-1",
      "table-gjw-2",
      "callout-gjw-3",
      "page-bg-gjw-4",
      "heading-gjw-5",
      "code-block-gkl-1",
      "table-gkl-2",
      "callout-gkl-3",
      "page-bg-gkl-4",
      "heading-gkl-5",
      "code-block-gla-1",
      "table-gla-2",
      "callout-gla-3",
      "page-bg-gla-4",
      "heading-gla-5",
      "code-block-glp-1",
      "table-glp-2",
      "callout-glp-3",
      "page-bg-glp-4",
      "heading-glp-5",
      "code-block-gme-1",
      "table-gme-2",
      "callout-gme-3",
      "page-bg-gme-4",
      "heading-gme-5",
      "code-block-gmt-1",
      "table-gmt-2",
      "callout-gmt-3",
      "page-bg-gmt-4",
      "heading-gmt-5",
      "code-block-gni-1",
      "table-gni-2",
      "callout-gni-3",
      "page-bg-gni-4",
      "heading-gni-5",
      "code-block-gnx-1",
      "table-gnx-2",
      "callout-gnx-3",
      "page-bg-gnx-4",
      "heading-gnx-5",
      "code-block-gom-1",
      "table-gom-2",
      "callout-gom-3",
      "page-bg-gom-4",
      "heading-gom-5",
      "code-block-gpb-1",
      "table-gpb-2",
      "callout-gpb-3",
      "page-bg-gpb-4",
      "heading-gpb-5",
      "code-block-gpq-1",
      "table-gpq-2",
      "callout-gpq-3",
      "page-bg-gpq-4",
      "heading-gpq-5",
      "code-block-gqf-1",
      "table-gqf-2",
      "callout-gqf-3",
      "page-bg-gqf-4",
      "heading-gqf-5",
      "code-block-gqu-1",
      "table-gqu-2",
      "callout-gqu-3",
      "page-bg-gqu-4",
      "heading-gqu-5",
      "code-block-grj-1",
      "table-grj-2",
      "callout-grj-3",
      "page-bg-grj-4",
      "heading-grj-5",
      "code-block-gry-1",
      "table-gry-2",
      "callout-gry-3",
      "page-bg-gry-4",
      "heading-gry-5",
      "code-block-gsn-1",
      "table-gsn-2",
      "callout-gsn-3",
      "page-bg-gsn-4",
      "heading-gsn-5",
      "code-block-gtc-1",
      "table-gtc-2",
      "callout-gtc-3",
      "page-bg-gtc-4",
      "heading-gtc-5",
      "code-block-gtr-1",
      "table-gtr-2",
      "callout-gtr-3",
      "page-bg-gtr-4",
      "heading-gtr-5",
      "code-block-gug-1",
      "table-gug-2",
      "callout-gug-3",
      "page-bg-gug-4",
      "heading-gug-5",
      "code-block-guv-1",
      "table-guv-2",
      "callout-guv-3",
      "page-bg-guv-4",
      "heading-guv-5",
      "code-block-gvk-1",
      "table-gvk-2",
      "callout-gvk-3",
      "page-bg-gvk-4",
      "heading-gvk-5",
      "code-block-gvz-1",
      "table-gvz-2",
      "callout-gvz-3",
      "page-bg-gvz-4",
      "heading-gvz-5",
      "code-block-gwo-1",
      "table-gwo-2",
      "callout-gwo-3",
      "page-bg-gwo-4",
      "heading-gwo-5",
      "code-block-gxd-1",
      "table-gxd-2",
      "callout-gxd-3",
      "page-bg-gxd-4",
      "heading-gxd-5",
      "code-block-gxs-1",
      "table-gxs-2",
      "callout-gxs-3",
      "page-bg-gxs-4",
      "heading-gxs-5",
      "code-block-gyh-1",
      "table-gyh-2",
      "callout-gyh-3",
      "page-bg-gyh-4",
      "heading-gyh-5",
      "code-block-gyw-1",
      "table-gyw-2",
      "callout-gyw-3",
      "page-bg-gyw-4",
      "heading-gyw-5",
      "code-block-gzl-1",
      "table-gzl-2",
      "callout-gzl-3",
      "page-bg-gzl-4",
      "heading-gzl-5",
      "code-block-haa-1",
      "table-haa-2",
      "callout-haa-3",
      "page-bg-haa-4",
      "heading-haa-5",
      "code-block-hap-1",
      "table-hap-2",
      "callout-hap-3",
      "page-bg-hap-4",
      "heading-hap-5",
      "code-block-hbe-1",
      "table-hbe-2",
      "callout-hbe-3",
      "page-bg-hbe-4",
      "heading-hbe-5",
      "code-block-hbt-1",
      "table-hbt-2",
      "callout-hbt-3",
      "page-bg-hbt-4",
      "heading-hbt-5",
      "code-block-hci-1",
      "table-hci-2",
      "callout-hci-3",
      "page-bg-hci-4",
      "heading-hci-5",
      "code-block-hcx-1",
      "table-hcx-2",
      "callout-hcx-3",
      "page-bg-hcx-4",
      "heading-hcx-5",
      "code-block-hdm-1",
      "table-hdm-2",
      "callout-hdm-3",
      "page-bg-hdm-4",
      "heading-hdm-5",
      "code-block-heb-1",
      "table-heb-2",
      "callout-heb-3",
      "page-bg-heb-4",
      "heading-heb-5",
      "code-block-heq-1",
      "table-heq-2",
      "callout-heq-3",
      "page-bg-heq-4",
      "heading-heq-5",
      "code-block-hff-1",
      "table-hff-2",
      "callout-hff-3",
      "page-bg-hff-4",
      "heading-hff-5",
      "code-block-hfu-1",
      "table-hfu-2",
      "callout-hfu-3",
      "page-bg-hfu-4",
      "heading-hfu-5",
      "code-block-hgj-1",
      "table-hgj-2",
      "callout-hgj-3",
      "page-bg-hgj-4",
      "heading-hgj-5",
      "code-block-hgy-1",
      "table-hgy-2",
      "callout-hgy-3",
      "page-bg-hgy-4",
      "heading-hgy-5",
      "code-block-hho-1",
      "table-hho-2",
      "callout-hho-3",
      "page-bg-hho-4",
      "heading-hho-5",
      "code-block-hid-1",
      "table-hid-2",
      "callout-hid-3",
      "page-bg-hid-4",
      "heading-hid-5",
      "code-block-his-1",
      "table-his-2",
      "callout-his-3",
      "page-bg-his-4",
      "heading-his-5",
      "code-block-hjh-1",
      "table-hjh-2",
      "callout-hjh-3",
      "page-bg-hjh-4",
      "heading-hjh-5",
      "code-block-hjw-1",
      "table-hjw-2",
      "callout-hjw-3",
      "page-bg-hjw-4",
      "heading-hjw-5",
      "code-block-hkl-1",
      "table-hkl-2",
      "callout-hkl-3",
      "page-bg-hkl-4",
      "heading-hkl-5",
      "code-block-hla-1",
      "table-hla-2",
      "callout-hla-3",
      "page-bg-hla-4",
      "heading-hla-5",
      "code-block-hlp-1",
      "table-hlp-2",
      "callout-hlp-3",
      "page-bg-hlp-4",
      "heading-hlp-5",
      "code-block-hme-1",
      "table-hme-2",
      "callout-hme-3",
      "page-bg-hme-4",
      "heading-hme-5",
      "code-block-hmt-1",
      "table-hmt-2",
      "callout-hmt-3",
      "page-bg-hmt-4",
      "heading-hmt-5",
      "code-block-hni-1",
      "table-hni-2",
      "callout-hni-3",
      "page-bg-hni-4",
      "heading-hni-5",
      "code-block-hnx-1",
      "table-hnx-2",
      "callout-hnx-3",
      "page-bg-hnx-4",
      "heading-hnx-5",
      "code-block-hom-1",
      "table-hom-2",
      "callout-hom-3",
      "page-bg-hom-4",
      "heading-hom-5",
      "code-block-hpb-1",
      "table-hpb-2",
      "callout-hpb-3",
      "page-bg-hpb-4",
      "heading-hpb-5",
      "code-block-hpq-1",
      "table-hpq-2",
      "callout-hpq-3",
      "page-bg-hpq-4",
      "heading-hpq-5",
      "code-block-hqf-1",
      "table-hqf-2",
      "callout-hqf-3",
      "page-bg-hqf-4",
      "heading-hqf-5",
      "code-block-hqu-1",
      "table-hqu-2",
      "callout-hqu-3",
      "page-bg-hqu-4",
      "heading-hqu-5",
      "code-block-hrj-1",
      "table-hrj-2",
      "callout-hrj-3",
      "page-bg-hrj-4",
      "heading-hrj-5",
      "code-block-hry-1",
      "table-hry-2",
      "callout-hry-3",
      "page-bg-hry-4",
      "heading-hry-5",
      "code-block-hsn-1",
      "table-hsn-2",
      "callout-hsn-3",
      "page-bg-hsn-4",
      "heading-hsn-5",
      "code-block-htc-1",
      "table-htc-2",
      "callout-htc-3",
      "page-bg-htc-4",
      "heading-htc-5",
      "code-block-hts-1",
      "table-hts-2",
      "callout-hts-3",
      "page-bg-hts-4",
      "heading-hts-5",
      "code-block-huh-1",
      "table-huh-2",
      "callout-huh-3",
      "page-bg-huh-4",
      "heading-huh-5",
      "code-block-huw-1",
      "table-huw-2",
      "callout-huw-3",
      "page-bg-huw-4",
      "heading-huw-5",
      "code-block-hvl-1",
      "table-hvl-2",
      "callout-hvl-3",
      "page-bg-hvl-4",
      "heading-hvl-5",
      "code-block-hwa-1",
      "table-hwa-2",
      "callout-hwa-3",
      "page-bg-hwa-4",
      "heading-hwa-5",
      "code-block-hwp-1",
      "table-hwp-2",
      "callout-hwp-3",
      "page-bg-hwp-4",
      "heading-hwp-5",
      "code-block-hxe-1",
      "table-hxe-2",
      "callout-hxe-3",
      "page-bg-hxe-4",
      "heading-hxe-5",
      "code-block-hxt-1",
      "table-hxt-2",
      "callout-hxt-3",
      "page-bg-hxt-4",
      "heading-hxt-5",
      "code-block-hyi-1",
      "table-hyi-2",
      "callout-hyi-3",
      "page-bg-hyi-4",
      "heading-hyi-5",
      "code-block-hyx-1",
      "table-hyx-2",
      "callout-hyx-3",
      "page-bg-hyx-4",
      "heading-hyx-5",
      "code-block-hzm-1",
      "table-hzm-2",
      "callout-hzm-3",
      "page-bg-hzm-4",
      "code-block-iaa-1",
      "table-iaa-2",
      "callout-iaa-3",
      "page-bg-iaa-4",
      "heading-iaa-5",
      "code-block-iap-1",
      "table-iap-2",
      "callout-iap-3",
      "page-bg-iap-4",
      "heading-iap-5",
      "code-block-ibe-1",
      "table-ibe-2",
      "callout-ibe-3",
      "page-bg-ibe-4",
      "heading-ibe-5",
      "code-block-ibt-1",
      "table-ibt-2",
      "callout-ibt-3",
      "page-bg-ibt-4",
      "heading-ibt-5",
      "code-block-ici-1",
      "table-ici-2",
      "callout-ici-3",
      "page-bg-ici-4",
      "heading-ici-5",
      "code-block-icx-1",
      "table-icx-2",
      "callout-icx-3",
      "page-bg-icx-4",
      "heading-icx-5",
      "code-block-idm-1",
      "table-idm-2",
      "callout-idm-3",
      "page-bg-idm-4",
      "heading-idm-5",
      "code-block-ieb-1",
      "table-ieb-2",
      "callout-ieb-3",
      "page-bg-ieb-4",
      "heading-ieb-5",
      "code-block-ieq-1",
      "table-ieq-2",
      "callout-ieq-3",
      "page-bg-ieq-4",
      "heading-ieq-5",
      "code-block-iff-1",
      "table-iff-2",
      "callout-iff-3",
      "page-bg-iff-4",
      "heading-iff-5",
      "code-block-ifu-1",
      "table-ifu-2",
      "callout-ifu-3",
      "page-bg-ifu-4",
      "heading-ifu-5",
      "code-block-igk-1",
      "table-igk-2",
      "callout-igk-3",
      "page-bg-igk-4",
      "heading-igk-5",
      "code-block-igz-1",
      "table-igz-2",
      "callout-igz-3",
      "page-bg-igz-4",
      "heading-igz-5",
      "code-block-iho-1",
      "table-iho-2",
      "callout-iho-3",
      "page-bg-iho-4",
      "heading-iho-5",
      "code-block-iid-1",
      "table-iid-2",
      "callout-iid-3",
      "page-bg-iid-4",
      "heading-iid-5",
      "code-block-iit-1",
      "table-iit-2",
      "callout-iit-3",
      "page-bg-iit-4",
      "heading-iit-5",
      "code-block-iji-1",
      "table-iji-2",
      "callout-iji-3",
      "page-bg-iji-4",
      "heading-iji-5",
      "code-block-ijx-1",
      "table-ijx-2",
      "callout-ijx-3",
      "page-bg-ijx-4",
      "heading-ijx-5",
      "code-block-ikm-1",
      "table-ikm-2",
      "callout-ikm-3",
      "page-bg-ikm-4",
      "heading-ikm-5",
      "code-block-ilb-1",
      "table-ilb-2",
      "callout-ilb-3",
      "page-bg-ilb-4",
      "heading-ilb-5",
      "code-block-ilq-1",
      "table-ilq-2",
      "callout-ilq-3",
      "page-bg-ilq-4",
      "heading-ilq-5",
      "code-block-imf-1",
      "table-imf-2",
      "callout-imf-3",
      "page-bg-imf-4",
      "heading-imf-5",
      "code-block-imu-1",
      "table-imu-2",
      "callout-imu-3",
      "page-bg-imu-4",
      "heading-imu-5",
      "code-block-inj-1",
      "table-inj-2",
      "callout-inj-3",
      "page-bg-inj-4",
      "heading-inj-5",
      "code-block-iny-1",
      "table-iny-2",
      "callout-iny-3",
      "page-bg-iny-4",
      "heading-iny-5",
      "code-block-ion-1",
      "table-ion-2",
      "callout-ion-3",
      "page-bg-ion-4",
      "heading-ion-5",
      "code-block-ipc-1",
      "table-ipc-2",
      "callout-ipc-3",
      "page-bg-ipc-4",
      "heading-ipc-5",
      "code-block-ipr-1",
      "table-ipr-2",
      "callout-ipr-3",
      "page-bg-ipr-4",
      "heading-ipr-5",
      "code-block-iqg-1",
      "table-iqg-2",
      "callout-iqg-3",
      "page-bg-iqg-4",
      "heading-iqg-5",
      "code-block-iqv-1",
      "table-iqv-2",
      "callout-iqv-3",
      "page-bg-iqv-4",
      "heading-iqv-5",
      "code-block-irk-1",
      "table-irk-2",
      "callout-irk-3",
      "page-bg-irk-4",
      "heading-irk-5",
      "code-block-irz-1",
      "table-irz-2",
      "callout-irz-3",
      "page-bg-irz-4",
      "heading-irz-5",
      "code-block-iso-1",
      "table-iso-2",
      "callout-iso-3",
      "page-bg-iso-4",
      "heading-iso-5",
      "code-block-itd-1",
      "table-itd-2",
      "callout-itd-3",
      "page-bg-itd-4",
      "heading-itd-5",
      "code-block-its-1",
      "table-its-2",
      "callout-its-3",
      "page-bg-its-4",
      "heading-its-5",
      "code-block-iuh-1",
      "table-iuh-2",
      "callout-iuh-3",
      "page-bg-iuh-4",
      "heading-iuh-5",
      "code-block-iuw-1",
      "table-iuw-2",
      "callout-iuw-3",
      "page-bg-iuw-4",
      "heading-iuw-5",
      "code-block-ivl-1",
      "table-ivl-2",
      "callout-ivl-3",
      "page-bg-ivl-4",
      "heading-ivl-5",
      "code-block-iwa-1",
      "table-iwa-2",
      "callout-iwa-3",
      "page-bg-iwa-4",
      "heading-iwa-5",
      "code-block-iwp-1",
      "table-iwp-2",
      "callout-iwp-3",
      "page-bg-iwp-4",
      "heading-iwp-5",
      "code-block-ixe-1",
      "table-ixe-2",
      "callout-ixe-3",
      "page-bg-ixe-4",
      "heading-ixe-5",
      "code-block-ixt-1",
      "table-ixt-2",
      "callout-ixt-3",
      "page-bg-ixt-4",
      "heading-ixt-5",
      "code-block-iyi-1",
      "table-iyi-2",
      "callout-iyi-3",
      "page-bg-iyi-4",
      "heading-iyi-5",
      "code-block-iyx-1",
      "table-iyx-2",
      "callout-iyx-3",
      "page-bg-iyx-4",
      "heading-iyx-5",
      "code-block-izm-1",
      "table-izm-2",
      "callout-izm-3",
      "page-bg-izm-4",
      "code-block-jaa-1",
      "table-jaa-2",
      "callout-jaa-3",
      "page-bg-jaa-4",
      "heading-jaa-5",
      "code-block-jap-1",
      "table-jap-2",
      "callout-jap-3",
      "page-bg-jap-4",
      "heading-jap-5",
      "code-block-jbe-1",
      "table-jbe-2",
      "callout-jbe-3",
      "page-bg-jbe-4",
      "heading-jbe-5",
      "code-block-jbt-1",
      "table-jbt-2",
      "callout-jbt-3",
      "page-bg-jbt-4",
      "heading-jbt-5",
      "code-block-jci-1",
      "table-jci-2",
      "callout-jci-3",
      "page-bg-jci-4",
      "heading-jci-5",
      "code-block-jcx-1",
      "table-jcx-2",
      "callout-jcx-3",
      "page-bg-jcx-4",
      "heading-jcx-5",
      "code-block-jdm-1",
      "table-jdm-2",
      "callout-jdm-3",
      "page-bg-jdm-4",
      "heading-jdm-5",
      "code-block-jeb-1",
      "table-jeb-2",
      "callout-jeb-3",
      "page-bg-jeb-4",
      "heading-jeb-5",
      "code-block-jeq-1",
      "table-jeq-2",
      "callout-jeq-3",
      "page-bg-jeq-4",
      "heading-jeq-5",
      "code-block-jff-1",
      "table-jff-2",
      "callout-jff-3",
      "page-bg-jff-4",
      "heading-jff-5",
      "code-block-jfu-1",
      "table-jfu-2",
      "callout-jfu-3",
      "page-bg-jfu-4",
      "heading-jfu-5",
      "code-block-jgj-1",
      "table-jgj-2",
      "callout-jgj-3",
      "page-bg-jgj-4",
      "heading-jgj-5",
      "code-block-jgy-1",
      "table-jgy-2",
      "callout-jgy-3",
      "page-bg-jgy-4",
      "heading-jgy-5",
      "code-block-jhn-1",
      "table-jhn-2",
      "callout-jhn-3",
      "page-bg-jhn-4",
      "heading-jhn-5",
      "code-block-jic-1",
      "table-jic-2",
      "callout-jic-3",
      "page-bg-jic-4",
      "heading-jic-5",
      "code-block-jir-1",
      "table-jir-2",
      "callout-jir-3",
      "page-bg-jir-4",
      "heading-jir-5",
      "code-block-jjg-1",
      "table-jjg-2",
      "callout-jjg-3",
      "page-bg-jjg-4",
      "heading-jjg-5",
      "code-block-jjw-1",
      "table-jjw-2",
      "callout-jjw-3",
      "page-bg-jjw-4",
      "heading-jjw-5",
      "code-block-jkl-1",
      "table-jkl-2",
      "callout-jkl-3",
      "page-bg-jkl-4",
      "heading-jkl-5",
      "code-block-jla-1",
      "table-jla-2",
      "callout-jla-3",
      "page-bg-jla-4",
      "heading-jla-5",
    ];
    try {
      for (const k of toggles) {
        if (localStorage.getItem(`noteforge:${k}`) === "1")
          document.body.classList.add(k);
      }
    } catch {}
    // ⌘⇧F — toggle focus mode (only the caret's block fully opaque).
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "F" && e.key !== "f") return;
      e.preventDefault();
      document.body.classList.toggle("focus-mode");
    };
    // While focus-mode is active, mark the .bn-block under the caret so the
    // CSS rule can dim the rest. BlockNote doesn't expose a 'current block'
    // class itself, so we listen to selectionchange and walk up.
    const onSel = () => {
      if (!document.body.classList.contains("focus-mode")) return;
      const sel = document.getSelection?.();
      const node = sel?.focusNode;
      const el =
        node && node.nodeType === Node.TEXT_NODE
          ? (node.parentElement as HTMLElement | null)
          : (node as HTMLElement | null);
      const block = el?.closest?.(".bn-block") as HTMLElement | null;
      document
        .querySelectorAll(".bn-block.nf-focused")
        .forEach((b) => b.classList.remove("nf-focused"));
      block?.classList.add("nf-focused");
    };
    // Print page numbers — @page rules can't be scoped by body class in CSS,
    // so inject/remove a dedicated <style> when the toggle flips.
    const STYLE_ID = "nf-print-pagenum-style";
    const syncPrintPageNum = () => {
      const wants = document.body.classList.contains("print-page-numbers");
      const existing = document.getElementById(STYLE_ID);
      if (wants && !existing) {
        const s = document.createElement("style");
        s.id = STYLE_ID;
        s.textContent =
          '@media print{@page{margin-bottom:18mm;@bottom-center{content:"Page " counter(page) " of " counter(pages);font-size:9pt;color:#666;}}}';
        document.head.appendChild(s);
      } else if (!wants && existing) {
        existing.remove();
      }
    };
    // Highlight TODOs — wrap TODO/FIXME/XXX/HACK/NOTE in <mark.nf-todo>.
    // CSS can't match text content, so we walk text nodes when the toggle flips.
    const TODO_RE = /\b(TODO|FIXME|XXX|HACK|NOTE)\b/g;
    const syncTodoMarks = () => {
      document.querySelectorAll("mark.nf-todo").forEach((m) => {
        const t = document.createTextNode(m.textContent || "");
        m.replaceWith(t);
        m.parentElement?.normalize();
      });
      if (!document.body.classList.contains("highlight-todos")) return;
      const editor = document.querySelector(".bn-editor");
      if (!editor) return;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          if ((n.parentElement as Element | null)?.tagName === "MARK")
            return NodeFilter.FILTER_REJECT;
          return TODO_RE.test(n.textContent || "")
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      const targets: Text[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) targets.push(node as Text);
      for (const t of targets) {
        const text = t.textContent || "";
        const frag = document.createDocumentFragment();
        const re = new RegExp(TODO_RE.source, "g");
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m.index > last)
            frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          const mark = document.createElement("mark");
          mark.className = "nf-todo";
          mark.textContent = m[0];
          frag.appendChild(mark);
          last = m.index + m[0].length;
        }
        if (last < text.length)
          frag.appendChild(document.createTextNode(text.slice(last)));
        t.parentNode?.replaceChild(frag, t);
      }
    };
    const syncAll = () => {
      syncPrintPageNum();
      syncTodoMarks();
    };
    syncAll();
    const bodyObserver = new MutationObserver(syncAll);
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSel);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("selectionchange", onSel);
      bodyObserver.disconnect();
    };
  }, []);

  // Resume reading — remember scroll position per page, restore on next visit.
  useEffect(() => {
    const key = `scroll:${page.id}`;
    try {
      const v = localStorage.getItem(key);
      if (v && !window.location.hash) {
        const y = parseInt(v, 10);
        if (Number.isFinite(y) && y > 50) {
          requestAnimationFrame(() => window.scrollTo({ top: y }));
        }
      }
    } catch {}
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          localStorage.setItem(key, String(Math.round(window.scrollY)));
        } catch {}
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, [page.id]);

  // Reading streak — increments by 1 each calendar day this page is visited.
  const [streakDays, setStreakDays] = useState<number>(0);
  useEffect(() => {
    const key = `streak:${page.id}`;
    try {
      const raw = localStorage.getItem(key);
      const today = new Date();
      const ymd = today.toISOString().slice(0, 10);
      let next = { lastDate: ymd, count: 1 };
      if (raw) {
        const cur = JSON.parse(raw) as { lastDate: string; count: number };
        if (cur.lastDate === ymd) {
          next = cur; // same day; no bump
        } else {
          const prev = new Date(cur.lastDate);
          const diffDays = Math.round(
            (today.getTime() - prev.getTime()) / 86_400_000,
          );
          next = {
            lastDate: ymd,
            count: diffDays === 1 ? cur.count + 1 : 1,
          };
        }
      }
      localStorage.setItem(key, JSON.stringify(next));
      setStreakDays(next.count);
    } catch {}
  }, [page.id]);

  // "Last viewed" tooltip — store first time the user opens this page on this
  // device and show it on the title hover. Also push to a 'recents' list the
  // sidebar can render so navigation feels persistent across refreshes.
  const [lastViewed, setLastViewed] = useState<string | null>(null);
  useEffect(() => {
    const key = `lastViewed:${page.id}`;
    try {
      const prev = localStorage.getItem(key);
      if (prev) setLastViewed(prev);
      localStorage.setItem(key, new Date().toISOString());
    } catch {}
    try {
      const k = "noteforge:recents";
      const arr: { id: string; title: string; icon: string | null; slug: string; ts: number }[] =
        JSON.parse(localStorage.getItem(k) || "[]");
      const next = [
        { id: page.id, title: page.title || "Untitled", icon: page.icon, slug, ts: Date.now() },
        ...arr.filter((x) => x.id !== page.id),
      ].slice(0, 12);
      localStorage.setItem(k, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent("noteforge:recents-changed"));
    } catch {}
  }, [page.id, page.title, page.icon, slug]);

  // ⌘⇧. — wrap the current selection in an Editor-style blockquote prefix.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key !== "." && e.key !== ">") return;
      const sel = window.getSelection?.();
      const text = sel?.toString().trim();
      if (!text) return;
      e.preventDefault();
      try {
        document.execCommand("insertText", false, `> ${text}\n`);
      } catch {}
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-scroll to anchored block (?b) or comment (?c)
  useEffect(() => {
    const u = new URL(window.location.href);
    const b = u.searchParams.get("b");
    const c = u.searchParams.get("c");
    const targetSelector = b
      ? `[data-id="${b}"]`
      : c
      ? `[data-comment-id="${c}"]`
      : null;
    if (!targetSelector) return;
    let attempts = 0;
    const tick = () => {
      const el = document.querySelector(targetSelector) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-blue-300", "rounded");
        setTimeout(() => el.classList.remove("ring-2", "ring-blue-300", "rounded"), 2500);
        return;
      }
      attempts++;
      if (attempts < 20) setTimeout(tick, 200);
    };
    tick();
  }, [page.id]);

  const width =
    page.width && page.width !== "normal"
      ? page.width
      : workspaceDefaultWidth ?? "normal";
  // page.font="default" means "follow workspace default"
  const effFont =
    page.font && page.font !== "default" ? page.font : workspaceDefaultFont;
  const font = effFont ?? "default";
  return (
    <div className={fontClass(font)}>
<div data-page-outline>
        <PageOutline content={page.content} />
      </div>
      <PageCover
        slug={slug}
        pageId={page.id}
        cover={page.cover ?? null}
        coverPos={
          page.coverPos === "top" || page.coverPos === "bottom"
            ? page.coverPos
            : "center"
        }
        caption={page.coverCaption ?? null}
        dim={page.coverDim ?? false}
        readOnly={readOnly}
      />
      <div className={`${widthClass(width)} mx-auto px-12 md:px-24 py-10`}>
        {rowContext && (
          <div className="mb-2 no-print">
            <a
              href={`/w/${slug}/p/${rowContext.dbId}`}
              className="text-xs text-gray-500 inline-flex items-center gap-1 hover:text-gray-900"
            >
              <span>{rowContext.dbIcon ?? "📊"}</span>
              <span>Row in {rowContext.dbTitle || "Untitled database"}</span>
            </a>
            {rowContext.schema && rowContext.dataValues && (
              <div className="mt-1 flex flex-wrap gap-1">
                {rowContext.schema.props
                  .filter((p) => p.id !== "p_title")
                  .slice(0, 6)
                  .map((p) => {
                    const v = rowContext.dataValues![p.id];
                    if (v === null || v === undefined || v === "") return null;
                    let display: React.ReactNode = String(v);
                    if (p.type === "select" || p.type === "status") {
                      const opt = p.options?.find((o) => o.id === v);
                      if (!opt) return null;
                      display = (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[10px]"
                          style={{ background: opt.color }}
                        >
                          {opt.name}
                        </span>
                      );
                    } else if (p.type === "checkbox") {
                      display = v ? "☑" : "☐";
                    } else if (p.type === "multi_select" && Array.isArray(v)) {
                      display = (
                        <span className="flex flex-wrap gap-0.5">
                          {(v as string[]).map((id) => {
                            const opt = p.options?.find((o) => o.id === id);
                            return opt ? (
                              <span
                                key={id}
                                className="inline-block px-1.5 py-0.5 rounded text-[10px]"
                                style={{ background: opt.color }}
                              >
                                {opt.name}
                              </span>
                            ) : null;
                          })}
                        </span>
                      );
                    }
                    return (
                      <span
                        key={p.id}
                        className="inline-flex items-center gap-1 text-[11px] text-gray-600"
                      >
                        <span className="text-gray-400">{p.name}:</span>
                        {display}
                      </span>
                    );
                  })}
              </div>
            )}
          </div>
        )}
        {ancestors && ancestors.length > 0 && (
          <nav className="nf-breadcrumb mb-2 flex items-center gap-1 text-xs text-gray-500 no-print">
            {ancestors.map((a) => (
              <span key={a.id} className="inline-flex items-center gap-1">
                <a
                  href={`/w/${slug}/p/${a.id}`}
                  className="hover:text-gray-900 inline-flex items-center gap-1"
                >
                  <span>{a.icon ?? "📄"}</span>
                  <span className="truncate max-w-[160px]">{a.title || "Untitled"}</span>
                </a>
                <span className="text-gray-300">/</span>
              </span>
            ))}
          </nav>
        )}
        {page.locked ? (
          (() => {
            const until = page.lockedUntil ? new Date(page.lockedUntil) : null;
            const remainingMs = until ? until.getTime() - Date.now() : null;
            let chip: string | null = null;
            if (remainingMs !== null && remainingMs > 0) {
              const totalMin = Math.floor(remainingMs / 60_000);
              if (totalMin < 60) chip = `${totalMin}m 남음`;
              else if (totalMin < 60 * 24) chip = `${Math.floor(totalMin / 60)}h ${totalMin % 60}m 남음`;
              else chip = `${Math.floor(totalMin / (60 * 24))}d 남음`;
            }
            const tip = until ? `Locked until ${until.toLocaleString()}` : "Page is locked";
            return (
              <div
                className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1 inline-flex items-center gap-2"
                title={tip}
              >
                <span>🔒 Page locked — read-only</span>
                {chip ? (
                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                    {chip}
                  </span>
                ) : null}
                {canChangeSettings && (
                  <button
                    onClick={() => start(() => togglePageLock(slug, page.id))}
                    className="text-amber-900 hover:underline"
                  >
                    Unlock
                  </button>
                )}
              </div>
            );
          })()
        ) : readOnly ? (
          <div className="mb-3 text-xs text-gray-600 bg-gray-100 border border-gray-200 rounded px-3 py-1 inline-flex items-center gap-1">
            👁 Read-only view
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-1.5 mb-2 no-print">
          {backlinks.length > 0 && (
            <a
              href="#backlinks"
              onClick={(e) => {
                e.preventDefault();
                document
                  .querySelector("[data-page-backlinks]")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 text-gray-600"
              title={`${backlinks.length} backlink${backlinks.length === 1 ? "" : "s"}`}
            >
              🔗 {backlinks.length}
            </a>
          )}
          {info.commentCount > 0 && (
            <a
              href="#comments"
              onClick={(e) => {
                e.preventDefault();
                document
                  .querySelector("[data-comments-panel]")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5 text-gray-600"
              title={`${info.commentCount} comment${info.commentCount === 1 ? "" : "s"}`}
            >
              💬 {info.commentCount}
            </a>
          )}
          {info.subscriberCount && info.subscriberCount > 0 ? (
            <span
              className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-600"
              title={`${info.subscriberCount} subscriber${info.subscriberCount === 1 ? "" : "s"} will be notified on edits`}
            >
              🔔 {info.subscriberCount}
            </span>
          ) : null}
          <ReadModeButton />
          <ReadAloudButton getText={() => extractText(page.content, title)} />
          <button
            onClick={() => window.print()}
            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-black/5"
            title="Print or save as PDF (⌘P → 'Save as PDF' destination)"
          >
            🖨 Print / PDF
          </button>
          <PageInfo info={info} workspaceSlug={slug} />
          <SubscribeButton slug={slug} pageId={page.id} subscribed={subscribed} />
          <ReminderButton slug={slug} pageId={page.id} pending={reminders} />
          <ExportButton slug={slug} pageId={page.id} title={page.title} />
          <PageStyleMenu
            slug={slug}
            pageId={page.id}
            width={width}
            font={font}
            locked={page.locked ?? false}
            isTemplate={page.isTemplate ?? false}
            customSlug={page.slug ?? null}
            expiresAt={page.expiresAt ?? null}
            pinned={page.pinned ?? false}
            status={page.status ?? null}
            wordGoal={info.wordGoal}
            canEdit={canChangeSettings}
          />
          <HistoryButton
            slug={slug}
            pageId={page.id}
            snapshots={snapshots}
            currentContent={page.content}
            canEdit={!readOnly}
          />
          <ShareButton
            slug={slug}
            pageId={page.id}
            initialAccess={page.publicAccess ?? "none"}
            initialPublicSlug={page.publicSlug ?? null}
            initialPermissions={permissions}
            publicViewCount={page.publicViewCount}
            customSlug={page.slug ?? null}
            canEdit={!readOnly}
          />
        </div>
      <div className="relative flex items-center gap-2 mb-2">
        <button
          className="text-4xl leading-none hover:bg-black/5 rounded px-1 nf-page-icon"
          onClick={() => setPickerOpen((o) => !o)}
          disabled={readOnly}
          aria-label="change icon"
        >
          {icon ?? "📄"}
        </button>
        {pickerOpen && (
          <EmojiPicker
            onPick={(e) => {
              setIcon(e);
              start(() => setPageIcon(slug, page.id, e));
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      <div className="flex items-center gap-2 mb-3 nf-page-title">
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== page.title) start(() => renamePage(slug, page.id, title));
          }}
          disabled={readOnly}
          placeholder="Untitled"
          title={
            lastViewed
              ? `Last viewed ${new Date(lastViewed).toLocaleString()}`
              : "First time viewing on this device"
          }
          className="flex-1 text-4xl font-bold outline-none bg-transparent placeholder-gray-300"
        />
        {page.status && (
          <button
            onClick={() => {
              if (readOnly) return;
              const next =
                page.status === "draft"
                  ? "in_review"
                  : page.status === "in_review"
                    ? "published"
                    : null;
              start(() => setPageStatus(slug, page.id, next));
            }}
            disabled={readOnly}
            title={readOnly ? undefined : "Click to advance status"}
            className={
              "text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border " +
              (page.status === "published"
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : page.status === "in_review"
                  ? "bg-amber-50 border-amber-200 text-amber-700"
                  : "bg-gray-100 border-gray-200 text-gray-600") +
              (readOnly ? "" : " hover:opacity-80")
            }
          >
            {page.status === "in_review"
              ? "In review"
              : page.status === "published"
                ? "Published"
                : "Draft"}
          </button>
        )}
        {info.viewCount && info.viewCount >= 50 && (
          <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border bg-orange-50 border-orange-200 text-orange-700">
            🔥 Popular · {info.viewCount}
          </span>
        )}
        {info.childrenCount > 0 && (
          <span
            className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border bg-gray-50 border-gray-200 text-gray-600"
            title={`${info.childrenCount} sub-pages`}
          >
            📁 {info.childrenCount}
          </span>
        )}
        {!readOnly && (
          <button
            onClick={() => start(() => toggleFavorite(slug, page.id))}
            className="text-2xl text-gray-300 hover:text-yellow-500 transition leading-none"
            title={page.favorite ? "Unfavorite" : "Favorite (Cmd+Shift+B)"}
          >
            {page.favorite ? "★" : "☆"}
          </button>
        )}
        {!readOnly && canChangeSettings && (
          <button
            onClick={() => start(() => togglePagePinned(slug, page.id))}
            className={
              "text-lg leading-none transition " +
              (page.pinned
                ? "text-blue-600 hover:opacity-80"
                : "text-gray-300 hover:text-blue-500")
            }
            title={page.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
          >
            📌
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-400 mb-1">
        {info.author && <span>by {info.author.name}</span>}
        <span title={new Date(info.updatedAt).toLocaleString()}>
          · Last edited {relTime(info.updatedAt)}
        </span>
        {info.lastEditor &&
          info.lastEditor.name !== info.author?.name && (
            <span className="inline-flex items-center gap-1">
              · by{" "}
              <Avatar user={info.lastEditor} size="xs" />
              {info.lastEditor.name}
            </span>
          )}
        {!wordChipHidden && (
          <span className="nf-word-chip" data-page-id={page.id}>
            ⏱ {Math.max(1, Math.round(info.wordCount / 200))} min read · {info.wordCount.toLocaleString()} words
          </span>
        )}
        {streakDays >= 2 && (
          <span
            className="nf-word-chip text-orange-600"
            title={`You've visited this page ${streakDays} days in a row`}
          >
            · 🔥 {streakDays} day streak
          </span>
        )}
        {info.wordGoal && info.wordGoal > 0 && (
          <span
            className="nf-word-chip flex items-center gap-1"
            title={`${info.wordCount.toLocaleString()} / ${info.wordGoal.toLocaleString()} words`}
          >
            <span className="text-gray-400">·</span>
            <span className="inline-block w-20 h-1.5 rounded-full bg-gray-200 overflow-hidden">
              <span
                className={
                  "block h-full " +
                  (info.wordCount >= info.wordGoal
                    ? "bg-emerald-500"
                    : "bg-blue-500")
                }
                style={{
                  width: `${Math.min(100, Math.round((info.wordCount / info.wordGoal) * 100))}%`,
                }}
              />
            </span>
            <span>
              {Math.min(100, Math.round((info.wordCount / info.wordGoal) * 100))}%
              {info.wordCount >= info.wordGoal ? " 🎉" : ""}
            </span>
          </span>
        )}
      </div>
      <div data-page-reactions>
        <PageReactions
          slug={slug}
          pageId={page.id}
          groups={reactions}
          readOnly={readOnly}
        />
      </div>
      <div data-page-tags>
        <PageTags
          slug={slug}
          pageId={page.id}
          initial={parseTags(page.tags ?? null)}
          readOnly={readOnly}
        />
      </div>
      {subPages.length > 0 && (
        <div data-page-subpages>
          <SubPagesSection slug={slug} pageId={page.id} subPages={subPages} readOnly={readOnly} />
        </div>
      )}
      <Editor
        pageId={page.id}
        slug={slug}
        initialContent={page.content}
        user={user}
        readOnly={readOnly}
        aiEnabled={aiEnabled}
      />
        {backlinks.length > 0 && (
          <div data-page-backlinks>
            <BacklinksSection slug={slug} backlinks={backlinks} />
          </div>
        )}
        <CommentsPanel
          slug={slug}
          pageId={page.id}
          comments={comments}
          currentUserId={user.id}
          readOnly={readOnly}
        />
        <footer className="nf-page-footer mt-12 pt-4 border-t border-gray-100 text-[10px] text-gray-400 flex flex-wrap gap-3 no-print">
          <span data-footer-date>Created {new Date(info.createdAt).toLocaleString()}</span>
          <span data-footer-date>· Updated {new Date(info.updatedAt).toLocaleString()}</span>
          <span>· {info.wordCount.toLocaleString()} words</span>
          <span>· {page.content.length.toLocaleString()} chars</span>
          <button
            onClick={() => {
              const url = window.location.href.split("?")[0];
              void navigator.clipboard?.writeText(url).then(() => {
                const tip = document.createElement("div");
                tip.textContent = "Link copied";
                tip.className =
                  "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-gray-900 text-white rounded-full px-3 py-1 shadow";
                document.body.appendChild(tip);
                setTimeout(() => tip.remove(), 1200);
              });
            }}
            className="ml-auto text-gray-500 hover:text-gray-900"
          >
            🔗 Copy link
          </button>
        </footer>
      </div>
      <SiblingNav slug={slug} pageId={page.id} />
      <ReadingProgress />
      {showTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-20 right-5 z-30 text-xs bg-gray-900 text-white rounded-full px-3 py-1.5 shadow-lg hover:opacity-90 no-print"
          title="Scroll to top"
        >
          ↑ Top
        </button>
      )}
      {showBottom && (
        <button
          onClick={() =>
            window.scrollTo({
              top: document.documentElement.scrollHeight,
              behavior: "smooth",
            })
          }
          className="fixed bottom-32 right-5 z-30 text-xs bg-gray-700 text-white rounded-full px-3 py-1.5 shadow-lg hover:opacity-90 no-print"
          title="Scroll to bottom"
        >
          ↓ Bottom
        </button>
      )}
      {aiEnabled && (
        <AskAiPanel slug={slug} getPageText={() => extractText(page.content, title)} />
      )}
      <ActivityLogModal pageId={page.id} />
    </div>
  );
}

function BacklinksSection({
  slug,
  backlinks,
}: {
  slug: string;
  backlinks: { id: string; title: string; icon: string | null; kind: string }[];
}) {
  const [sort, setSort] = useState<"original" | "alpha">("original");
  const sorted =
    sort === "alpha"
      ? [...backlinks].sort((a, b) =>
          (a.title || "Untitled").localeCompare(b.title || "Untitled"),
        )
      : backlinks;
  return (
    <section className="mt-10 border-t border-gray-200 pt-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center">
        Backlinks
        <span className="ml-2 text-xs text-gray-400">{backlinks.length}</span>
        <button
          onClick={() => setSort((s) => (s === "original" ? "alpha" : "original"))}
          className="ml-auto text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-700"
        >
          {sort === "alpha" ? "A → Z ▾" : "Original ▾"}
        </button>
      </h2>
      <ul className="space-y-1">
        {sorted.map((b) => (
          <li key={b.id}>
            <a
              href={`/w/${slug}/p/${b.id}`}
              className="flex items-center gap-2 text-sm text-gray-700 hover:bg-black/5 rounded px-2 py-1"
            >
              <span>{b.icon ?? (b.kind === "database" ? "📊" : "📄")}</span>
              <span className="truncate">{b.title || "Untitled"}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubPagesSection({
  slug,
  pageId,
  subPages,
  readOnly,
}: {
  slug: string;
  pageId: string;
  subPages: { id: string; title: string; icon: string | null; kind: string }[];
  readOnly: boolean;
}) {
  const [sort, setSort] = useState<"original" | "alpha">("original");
  const [, startTx] = useTransition();
  const sorted =
    sort === "alpha"
      ? [...subPages].sort((a, b) =>
          (a.title || "Untitled").localeCompare(b.title || "Untitled"),
        )
      : subPages;
  return (
    <details className="mb-3 border border-gray-100 rounded-md">
      <summary className="cursor-pointer px-3 py-1.5 text-xs uppercase tracking-wide text-gray-500 list-none flex items-center gap-1">
        <span className="text-gray-400">▸</span>
        Sub-pages
        <span className="text-gray-400 ml-1">({subPages.length})</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSort(sort === "original" ? "alpha" : "original");
          }}
          className="ml-auto text-[10px] normal-case tracking-normal text-gray-400 hover:text-gray-700"
        >
          {sort === "original" ? "Order ▾" : "A → Z ▾"}
        </button>
      </summary>
      <ul className="px-2 pb-2 grid sm:grid-cols-2 gap-1">
        {sorted.map((sp) => (
          <li key={sp.id}>
            <a
              href={`/w/${slug}/p/${sp.id}`}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm text-gray-800 hover:bg-black/5"
            >
              <span>{sp.icon ?? (sp.kind === "database" ? "📊" : "📄")}</span>
              <span className="truncate flex-1">{sp.title || "Untitled"}</span>
            </a>
          </li>
        ))}
        {!readOnly && (
          <li>
            <button
              onClick={() => startTx(() => createPage(slug, pageId))}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm text-gray-500 hover:bg-black/5 w-full text-left"
            >
              <span>+</span>
              <span>Add sub-page</span>
            </button>
          </li>
        )}
      </ul>
    </details>
  );
}

function SiblingNav({ slug, pageId }: { slug: string; pageId: string }) {
  type Sib = { id: string; title: string; icon: string | null } | null;
  const [data, setData] = useState<{ prev: Sib; next: Sib; total: number; index: number } | null>(null);
  useEffect(() => {
    fetch(`/api/workspace/siblings?slug=${slug}&page=${pageId}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData(null));
  }, [slug, pageId]);
  if (!data || data.total < 2) return null;
  return (
    <nav className="max-w-3xl mx-auto px-24 mt-8 flex items-stretch gap-2 text-xs no-print">
      {data.prev ? (
        <a
          href={`/w/${slug}/p/${data.prev.id}`}
          className="flex-1 min-w-0 px-3 py-2 rounded border border-gray-200 hover:bg-black/5 truncate"
          title={data.prev.title}
        >
          <span className="text-gray-400">← prev sibling</span>
          <span className="block truncate text-gray-700">
            {data.prev.icon ?? "📄"} {data.prev.title || "Untitled"}
          </span>
        </a>
      ) : (
        <span className="flex-1" />
      )}
      <span className="text-[10px] text-gray-400 self-center px-2">
        {data.index + 1} / {data.total}
      </span>
      {data.next ? (
        <a
          href={`/w/${slug}/p/${data.next.id}`}
          className="flex-1 min-w-0 px-3 py-2 rounded border border-gray-200 hover:bg-black/5 truncate text-right"
          title={data.next.title}
        >
          <span className="text-gray-400">next sibling →</span>
          <span className="block truncate text-gray-700">
            {data.next.icon ?? "📄"} {data.next.title || "Untitled"}
          </span>
        </a>
      ) : (
        <span className="flex-1" />
      )}
    </nav>
  );
}

export function ActivityLogModal({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  type Item = {
    id: string;
    action: string;
    meta: string | null;
    createdAt: string;
    user: { id: string; name: string; color: string } | null;
  };
  const [rows, setRows] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ pageId?: string }>;
      if (!ce.detail || ce.detail.pageId !== pageId) return;
      setOpen(true);
      setLoading(true);
      fetch(`/api/page/${pageId}/activity`)
        .then((r) => r.json())
        .then((d) => setRows((d as { activities?: Item[] }).activities ?? []))
        .catch(() => setRows([]))
        .finally(() => setLoading(false));
    };
    window.addEventListener("noteforge:open-activity", handler);
    return () =>
      window.removeEventListener("noteforge:open-activity", handler);
  }, [pageId]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-20 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-[520px] max-w-[95vw] p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">📜 Activity log</h3>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-900">
            ✕
          </button>
        </div>
        {loading ? (
          <p className="text-xs text-gray-500 py-6 text-center">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-gray-500 py-6 text-center">No activity yet.</p>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto text-xs space-y-1.5">
            {rows.map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-2 px-2 py-1 rounded hover:bg-black/5"
              >
                <span
                  className="inline-block w-5 h-5 rounded-full mt-0.5 shrink-0"
                  style={{ background: a.user?.color ?? "#9ca3af" }}
                  title={a.user?.name ?? "system"}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-gray-700">
                    <span className="font-medium">
                      {a.user?.name ?? "Someone"}
                    </span>{" "}
                    · {a.action}
                  </div>
                  {a.meta && (
                    <div className="text-[10px] text-gray-500 truncate">
                      {a.meta}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-gray-400 shrink-0">
                  {relTime(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 30) return `${Math.floor(s / (86400 * 7))}w ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  return `${Math.floor(s / (86400 * 365))}y ago`;
}

function extractText(json: string, fallbackTitle: string): string {
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return fallbackTitle;
    const parts: string[] = [fallbackTitle];
    const walk = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const node = b as { content?: unknown; children?: unknown };
      const c = node.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (
            it &&
            typeof it === "object" &&
            "text" in it &&
            typeof (it as { text: unknown }).text === "string"
          ) {
            parts.push((it as { text: string }).text);
          }
        }
      }
      if (Array.isArray(node.children)) for (const ch of node.children) walk(ch);
    };
    for (const b of blocks) walk(b);
    return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return fallbackTitle;
  }
}
