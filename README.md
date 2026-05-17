# Collab Notion

Self-hosted, collaborative Notion-style workspace.

## Stack
- Next.js 14 (App Router) + TypeScript + Tailwind
- BlockNote (Notion-style block editor)
- Yjs + y-websocket (real-time collaboration)
- Prisma + SQLite (dev) / Postgres (prod)
- Auth.js (NextAuth v5) credentials provider

## Layout
```
apps/
  web/      Next.js app (UI + API)
  collab/   Yjs websocket server (port 1234)
packages/
  db/       Shared Prisma schema + client
```

## Run
This project requires **Node 18.17+** (use nvm: `nvm use 18.17.1`).

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

## What works
- Sign up / sign in
- Workspaces (create, switch, invite link)
- Page tree with nested pages (create / rename / delete / icon / cover image)
- Favorites + Trash (soft delete, restore, permanent delete)
- Notion-style block editor (BlockNote): headings, lists, todos, code, math (KaTeX), callouts, quotes, embeds, toggles, file/image upload
- Real-time collab via Yjs (signed token + DB permission check)
- Presence avatars + remote cursors
- Comments on pages — threads, replies, resolve, edit/delete
- @mentions in comments and in the editor — autocompletes members and pages
- Notifications — bell in sidebar with unread count, mention + thread-reply events
- Global search palette (⌘K) — title + content
- Page version history — auto snapshots + manual save, read-only preview
- Public share links (`/share/<token>`) — read-only view for anonymous users
- Databases (kind: "database") with **Table / Kanban / Gallery** views
  - Property types: Text, Number, Select, Date, Checkbox, URL, Email
  - Filter / Sort rules per view
  - Kanban grouping by Select column with drag-and-drop
  - Gallery uses each row's page cover as thumbnail

## Known limits (MVP)
- No multi-select / person property type
- No timeline view
- Snapshot "restore" is preview-only (manual copy)
- SQLite for dev: switch `provider = "postgresql"` in `packages/db/prisma/schema.prisma` for prod
