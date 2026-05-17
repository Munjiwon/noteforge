import path from "node:path";
import { mkdir } from "node:fs/promises";

export const UPLOAD_DIR = path.join(process.cwd(), ".uploads");

export async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

export function isSafeFilename(name: string) {
  return SAFE_NAME.test(name) && !name.includes("..");
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
