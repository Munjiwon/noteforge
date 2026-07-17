# syntax=docker/dockerfile:1

# Single image that builds the monorepo and runs both the Next.js web app and
# the Yjs collab websocket server (they share one SQLite DB + AUTH_SECRET).
FROM node:20-slim AS base
# Prisma needs openssl at generate/runtime; ca-certificates for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- deps: install with the lockfile using only the manifests for caching ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/collab/package.json apps/collab/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci

# ---- build: generate Prisma client + build Next.js ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is only needed as a placeholder for `prisma generate`; the real
# value is injected at runtime. NEXT_PUBLIC_* is baked into the client bundle,
# so the collab websocket URL (reachable from the browser) must be set here.
ENV DATABASE_URL="file:/data/dev.db"
ENV NEXT_PUBLIC_COLLAB_URL="ws://localhost:1234"
RUN npm run db:generate --workspace=db
RUN npm run build --workspace=web

# ---- runner: the built app + node_modules + collab source ----
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000 1234
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
