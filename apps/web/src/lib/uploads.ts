import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const UPLOAD_DIR = path.join(process.cwd(), ".uploads");
export const UPLOAD_BACKEND = (process.env.UPLOAD_BACKEND ?? "local") as
  | "local"
  | "s3";

export async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

/**
 * Store an uploaded buffer and return a URL the client can use to fetch it.
 * Defaults to the local-disk backend. When UPLOAD_BACKEND=s3 is configured
 * the s3 branch should upload to the configured bucket; until that's wired,
 * we fall back to local storage so dev environments keep working.
 */
export async function storeUpload(
  storedName: string,
  buffer: Buffer,
): Promise<string> {
  if (UPLOAD_BACKEND === "s3") {
    // TODO: AWS SDK integration. Falling back to local-disk for now.
    console.warn(
      "[uploads] UPLOAD_BACKEND=s3 is set but no S3 client is wired; storing locally.",
    );
  }
  await ensureUploadDir();
  await writeFile(path.join(UPLOAD_DIR, storedName), buffer);
  return `/api/files/${storedName}`;
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

// Extensions we refuse to store (server-side execution risk or bookmarklet abuse).
const DENY_EXT = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".tsx",
  ".sh",
  ".bash",
  ".bat",
  ".cmd",
  ".ps1",
  ".exe",
  ".com",
  ".dll",
  ".so",
  ".dylib",
  ".php",
  ".rb",
  ".py",
  ".pyc",
]);

export function isAllowedExt(ext: string): boolean {
  return !DENY_EXT.has(ext.toLowerCase());
}
