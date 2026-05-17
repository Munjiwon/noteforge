// Minimal y-websocket-compatible collaboration server with LevelDB persistence.
// Rooms are scoped by `pageId` and a signed token is required to connect.
import http from "node:http";
import { createHmac } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { LeveldbPersistence } from "y-leveldb";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.COLLAB_PORT ?? 1234);
const PERSIST_DIR = process.env.COLLAB_DATA ?? "./data";

// Pick up env from monorepo locations so dev can use the same secret/db as the web app.
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, "../../..");
const candidates = [
  path.join(monorepoRoot, "apps/web/.env.local"),
  path.join(monorepoRoot, "apps/web/.env"),
  path.join(monorepoRoot, "packages/db/.env"),
  path.join(monorepoRoot, ".env.local"),
  path.join(monorepoRoot, ".env"),
];
for (const f of candidates) {
  try {
    const txt = fs.readFileSync(f, "utf8");
    for (const line of txt.split("\n")) {
      const m = /^([A-Z_]+)\s*=\s*"?([^"\n]+?)"?\s*$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const prisma = new PrismaClient();

const AUTH_SECRET = process.env.AUTH_SECRET ?? process.env.COLLAB_SECRET;
if (!AUTH_SECRET) {
  console.warn(
    "[collab] WARNING: AUTH_SECRET not set; rejecting all connections. Set AUTH_SECRET to enable.",
  );
}

function b64urlDecode(s) {
  const pad = (s + "===").slice(0, s.length + ((4 - (s.length % 4)) % 4));
  return Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function b64url(buf) {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function verifyToken(token) {
  if (!AUTH_SECRET || !token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(createHmac("sha256", AUTH_SECRET).update(body).digest());
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (typeof payload.uid !== "string") return null;
    if (typeof payload.pid !== "string") return null;
    if (typeof payload.exp !== "number") return null;
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function userCanAccessPage(userId, pageId) {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      workspaceId: true,
      deletedAt: true,
      workspace: {
        select: { members: { where: { userId }, select: { role: true } } },
      },
    },
  });
  if (!page || page.deletedAt) return null;
  if (page.workspace.members.length === 0) return null;
  return page.workspace.members[0].role;
}

const persistence = new LeveldbPersistence(PERSIST_DIR);
const docs = new Map(); // roomName -> { ydoc, awareness, conns:Set }

const messageSync = 0;
const messageAwareness = 1;

async function getOrCreateDoc(roomName) {
  let entry = docs.get(roomName);
  if (entry) return entry;

  // Load any prior state from leveldb.
  const ydoc = new Y.Doc();
  try {
    const persisted = await persistence.getYDoc(roomName);
    const update = Y.encodeStateAsUpdate(persisted);
    Y.applyUpdate(ydoc, update);
  } catch (e) {
    console.warn("[collab] no prior state for", roomName, e?.message);
  }

  const awareness = new awarenessProtocol.Awareness(ydoc);
  const conns = new Set();
  entry = { ydoc, awareness, conns };
  docs.set(roomName, entry);

  // Persist incremental updates (debounced).
  let pending = null;
  ydoc.on("update", (update) => {
    persistence.storeUpdate(roomName, update).catch((e) =>
      console.error("[collab] persist error", e),
    );
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      persistence.flushDocument(roomName).catch(() => {});
      pending = null;
    }, 5000);
  });
  return entry;
}

function send(ws, message) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(message, { binary: true });
  } catch (e) {
    ws.close();
  }
}

function broadcast(entry, message, exclude) {
  for (const c of entry.conns) {
    if (c !== exclude) send(c, message);
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("collab ok");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  // Path format: /<roomName>?token=...
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!roomName) {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token");
  const payload = verifyToken(token);
  if (!payload) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  if (payload.pid !== roomName) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  let role;
  try {
    role = await userCanAccessPage(payload.uid, roomName);
  } catch (e) {
    console.error("[collab] db check failed", e);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!role) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, { roomName, payload, role });
  });
});

wss.on("connection", async (ws, _req, { roomName }) => {
  ws.binaryType = "arraybuffer";
  const entry = await getOrCreateDoc(roomName);
  entry.conns.add(ws);

  // Send initial sync step 1
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, entry.ydoc);
    send(ws, encoding.toUint8Array(encoder));
  }
  // Send current awareness states
  {
    const states = entry.awareness.getStates();
    if (states.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(entry.awareness, Array.from(states.keys())),
      );
      send(ws, encoding.toUint8Array(encoder));
    }
  }

  const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(entry.awareness, changed),
    );
    const buf = encoding.toUint8Array(encoder);
    for (const c of entry.conns) if (c !== origin) send(c, buf);
  };
  entry.awareness.on("update", awarenessChangeHandler);

  const docUpdateHandler = (update, origin) => {
    if (origin === ws) return; // already broadcasted
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    const buf = encoding.toUint8Array(encoder);
    for (const c of entry.conns) if (c !== origin) send(c, buf);
  };
  entry.ydoc.on("update", docUpdateHandler);

  ws.on("message", (data) => {
    try {
      const message = new Uint8Array(data);
      const decoder = decoding.createDecoder(message);
      const encoder = encoding.createEncoder();
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case messageSync: {
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.readSyncMessage(decoder, encoder, entry.ydoc, ws);
          if (encoding.length(encoder) > 1) {
            send(ws, encoding.toUint8Array(encoder));
          }
          break;
        }
        case messageAwareness: {
          awarenessProtocol.applyAwarenessUpdate(
            entry.awareness,
            decoding.readVarUint8Array(decoder),
            ws,
          );
          break;
        }
      }
    } catch (e) {
      console.error("message handling error", e);
    }
  });

  const closeConn = () => {
    entry.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(
      entry.awareness,
      [entry.ydoc.clientID],
      null,
    );
    entry.ydoc.off("update", docUpdateHandler);
    entry.awareness.off("update", awarenessChangeHandler);
    if (entry.conns.size === 0) {
      // Keep doc loaded for a while; for now we keep in memory.
    }
  };

  ws.on("close", closeConn);
  ws.on("error", closeConn);
});

server.listen(PORT, () => {
  console.log(`[collab] listening on ws://localhost:${PORT}`);
});
