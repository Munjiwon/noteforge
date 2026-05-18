import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

// 5MB cap on response body to keep memory bounded.
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 5000;

function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Block obvious SSRF targets: localhost, private ranges, link-local, etc.
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      host.startsWith("10.") ||
      host.startsWith("127.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    ) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

function pickMeta(html: string, name: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const m = re.exec(html);
  return m ? m[1] : null;
}

function pickTitle(html: string): string | null {
  const m = /<title>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({}, { status: 401 });

  const raw = req.nextUrl.searchParams.get("url") ?? "";
  const u = safeUrl(raw);
  if (!u) return NextResponse.json({}, { status: 400 });

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(u.toString(), {
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; NoteForgeBot/1.0)",
        accept: "text/html,*/*;q=0.5",
      },
      redirect: "follow",
    });
    clearTimeout(to);
    if (!res.ok) {
      return NextResponse.json({ title: u.host, domain: u.host });
    }
    const reader = res.body?.getReader();
    if (!reader) return NextResponse.json({ title: u.host, domain: u.host });
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total >= MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        break;
      }
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    const title =
      pickMeta(html, "og:title") ??
      pickMeta(html, "twitter:title") ??
      pickTitle(html);
    const description =
      pickMeta(html, "og:description") ??
      pickMeta(html, "twitter:description") ??
      pickMeta(html, "description");
    let image =
      pickMeta(html, "og:image") ??
      pickMeta(html, "twitter:image");
    // Resolve relative image URLs.
    if (image && !/^https?:\/\//i.test(image)) {
      try {
        image = new URL(image, u).toString();
      } catch {}
    }
    return NextResponse.json({
      title: title?.slice(0, 200) ?? null,
      description: description?.slice(0, 400) ?? null,
      image: image ?? null,
      domain: u.host,
    });
  } catch {
    return NextResponse.json({ title: u.host, domain: u.host });
  }
}
