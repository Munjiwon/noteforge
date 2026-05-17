import { NextResponse } from "next/server";
import path from "node:path";
import { stat, readFile } from "node:fs/promises";
import { auth } from "@/lib/auth";
import { UPLOAD_DIR, isSafeFilename, mimeForExt } from "@/lib/uploads";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: { name: string } },
) {
  const session = await auth();
  if (!session?.user) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const name = params.name;
  if (!isSafeFilename(name)) {
    return new NextResponse("bad name", { status: 400 });
  }
  const full = path.join(UPLOAD_DIR, name);
  try {
    const s = await stat(full);
    if (!s.isFile()) return new NextResponse("not found", { status: 404 });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
  const data = await readFile(full);
  const ext = path.extname(name);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": mimeForExt(ext),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
