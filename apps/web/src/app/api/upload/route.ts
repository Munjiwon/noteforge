import { NextResponse } from "next/server";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { auth } from "@/lib/auth";
import {
  UPLOAD_DIR,
  ensureUploadDir,
  MAX_UPLOAD_BYTES,
  isAllowedExt,
} from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file") as
    | (Blob & { name?: string; size?: number; type?: string })
    | null;
  if (!file || typeof (file as any).arrayBuffer !== "function") {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  const size = file.size ?? 0;
  if (size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` },
      { status: 413 },
    );
  }

  await ensureUploadDir();

  const origName = file.name ?? "file";
  const ext = path.extname(origName).toLowerCase().slice(0, 16);
  if (!isAllowedExt(ext)) {
    return NextResponse.json(
      { error: `file type "${ext}" not allowed` },
      { status: 415 },
    );
  }
  const stored = `${randomBytes(10).toString("hex")}${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(UPLOAD_DIR, stored), buf);

  return NextResponse.json({
    url: `/api/files/${stored}`,
    name: origName,
    size,
    type: file.type ?? "application/octet-stream",
  });
}
