#!/bin/bash
set -e

# Persisted state lives on volumes.
mkdir -p /data /data/collab /app/apps/web/.uploads

# Apply the Prisma schema to the SQLite DB (idempotent — safe every start).
echo "[entrypoint] applying database schema…"
npm run db:push --workspace=db

# Optionally seed demo data (alice@test.dev / bob@test.dev, password123).
if [ "$SEED" = "1" ]; then
  echo "[entrypoint] seeding demo data…"
  node packages/db/seed.mjs || echo "[entrypoint] seed skipped/failed (continuing)"
fi

# Start the collab websocket server in the background.
echo "[entrypoint] starting collab server on :${COLLAB_PORT:-1234}…"
node apps/collab/src/server.mjs &
COLLAB_PID=$!

# Forward termination to both processes.
trap 'kill $COLLAB_PID 2>/dev/null; exit 0' TERM INT

# Start the Next.js web server in the foreground (PID 1 replacement).
echo "[entrypoint] starting web server on :3000…"
npm run start --workspace=web &
WEB_PID=$!

# Exit if either process dies.
wait -n "$COLLAB_PID" "$WEB_PID"
EXIT=$?
echo "[entrypoint] a process exited ($EXIT); shutting down."
kill $COLLAB_PID $WEB_PID 2>/dev/null || true
exit $EXIT
