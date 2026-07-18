# NoteForge

Self-hosted, collaborative docs + JIRA-style work-management workspace.

## Stack
- Next.js 14 (App Router) + TypeScript + Tailwind
- BlockNote (block-based editor)
- Yjs + y-websocket (real-time collaboration)
- Prisma + SQLite (dev) / Postgres (prod)
- Auth.js (NextAuth v5) — email + password (credentials)

## Layout
```
apps/
  web/      Next.js app (UI + REST API)
  collab/   Yjs websocket server (port 1234)
packages/
  db/       Shared Prisma schema + client
```

## Run
Requires **Node 18.17+** (use nvm: `nvm use 18.17.1`).

```bash
# one-time setup
npm install
(cd packages/db && npx prisma db push)
node packages/db/seed.mjs   # optional: seed demo users

# two terminals
npm run dev:collab          # ws://localhost:1234
npm run dev:web             # http://localhost:3000
```

## Demo accounts (after seed)
- `alice@test.dev` / `password123` — owner of "Demo Team" workspace
- `bob@test.dev`   / `password123` — editor in same workspace

## Environment variables

Required (web):
- `AUTH_SECRET` — session signing key (also used to sign collab tokens)
- `DATABASE_URL` — Prisma connection string

Optional:
- `OPENAI_API_KEY` — enables real Chat Completions for the AI slash commands (otherwise placeholder output)
- `UPLOAD_BACKEND` — `local` (default) or `s3`. `s3` is reserved for future SDK wiring; currently falls back to local disk
- `COLLAB_PORT` (collab) — default 1234
- `COLLAB_DATA` (collab) — LevelDB persistence directory

## Features

### Pages & editor
- Page tree with nested sub-pages, icons (emoji picker with recent + categories + random), and cover images (Unsplash presets, gradients, uploads, top/center/bottom alignment)
- Page tags below the title
- BlockNote editor with custom blocks: math (KaTeX), callout, quote, embed, toggle, columns, table of contents, linked database embed
- Inline content: user / page / date mentions
- Block-anchored comments + 🔗 Copy block link (URL with `?b=blockId` scrolls to and highlights the block)
- Page styling: width (normal / wide / full), font (default / serif / mono), lock with optional expiry
- Page info panel (author, created, edited, words / word goal, sub-pages, comments, backlinks, views, recent activity)
- Snapshots: auto + manual; read-only history preview
- Markdown and HTML export per page; full workspace exports to a single Markdown file
- Breadcrumb, ancestor chain, and floating outline (auto TOC) on wide screens
- Print / save as PDF (`window.print` with print-only CSS)

### Databases
- Views: Table, Kanban, Gallery, Calendar (month / week), Timeline, List
- Property types: text, number (formats: integer / decimal / percent / currency / progress / rating), select, multi-select, status (grouped), date (short / long / relative), checkbox, url, email, phone, person, files, relation, rollup, formula (lightweight evaluator)
- Per-view filters and sorts; column show/hide/reorder; column descriptions; column type swaps (text-family, number↔text, select↔multi-select)
- Row search; row drag-and-drop sort; bulk select + delete; per-row peek modal vs open-as-full-page
- Group rows by select / status in Table view; group headers + counts
- Stats footer per column (Σ + average, distinct count, checked / total…)
- Kanban auto "+ Add option" column; Calendar "+ N more" overflow toggle
- Inline DB embed inside any page
- CSV export of the current view

### Collaboration & comments
- Real-time editing with Yjs over a signed-HMAC WebSocket; per-page room and DB-checked access
- Presence avatars + remote cursors, sync status pill (offline / connecting / syncing / synced)
- Page comments: threads, replies, resolve, edit, delete, reactions (👍 fast button + emoji picker), markdown rendering, attachments via `📎`, ↩ Quote
- Notifications: mention, thread reply, top-level comment-on-your-page; sidebar bell with pulse + 60s polling toast, inbox page with category / unread filters and Clear read

### Workspace
- Multiple workspaces per user, switcher (`⌘ ⇧ L`), workspace icon + color, settings page (rename, members, roles, invites, API tokens, danger-zone delete)
- Public share links (`/share/<token>`) with read-only viewer; per-page view count surfaced in the Share dialog
- Page-level permissions (view / comment / edit) + invite-existing-users-by-email; workspace-level invite tokens
- Audit log via PageActivity (create / rename / trash / restore / share / snapshot) — surfaced in Page info and `/activity`

### UX / system
- Sidebar: search + page filter, multi-select, drag-and-drop reorder/nest, favorites (manual order via localStorage), recents, trash with age + filter + auto-expire, page hover preview, mobile drawer
- Sidebar collapse / drag-to-resize on desktop
- Light / Dark / Auto theme (auto follows `prefers-color-scheme`)
- Korean / English UI toggle (sidebar labels)
- Keyboard shortcut sheet (`?`), Cmd+K / Cmd+P palette, Cmd+Shift+B favorite, Cmd+Shift+L workspace switcher

### REST API
- Personal access tokens issued from Settings → API tokens
- `GET /api/v1/pages?workspace=<slug>` — list pages
- `POST /api/v1/pages` — create a page
- Send as `Authorization: Bearer <token>`

## Known limits / future work
- Snapshot "restore" is preview-only (manual copy)
- SQLite for dev — switch `provider = "postgresql"` in `packages/db/prisma/schema.prisma` for prod
- Real WebSocket push for notifications is currently emulated with 60s polling; collab server channel reuse is a future task
- `UPLOAD_BACKEND=s3` is wired into the storage abstraction but the AWS SDK call itself is not implemented yet (falls back to local disk)
- Cell-level row history beyond `PageActivity` aggregate logs
