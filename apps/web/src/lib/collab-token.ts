import { createHmac } from "node:crypto";

export type CollabTokenPayload = {
  uid: string;
  pid: string;
  exp: number; // unix seconds
  name: string;
  color: string;
};

function getSecret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.COLLAB_SECRET;
  if (!s) throw new Error("AUTH_SECRET (or COLLAB_SECRET) required");
  return s;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const pad = (s + "===").slice(0, s.length + ((4 - (s.length % 4)) % 4));
  return Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signCollabToken(payload: CollabTokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyCollabToken(token: string): CollabTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(createHmac("sha256", getSecret()).update(body).digest());
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as CollabTokenPayload;
    if (typeof payload.uid !== "string") return null;
    if (typeof payload.pid !== "string") return null;
    if (typeof payload.exp !== "number") return null;
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
