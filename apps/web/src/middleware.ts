import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { nextUrl, auth: session } = req;
  const isAuthed = !!session?.user;
  const isAuthPage =
    nextUrl.pathname.startsWith("/login") || nextUrl.pathname.startsWith("/signup");

  const isPublicShare = nextUrl.pathname.startsWith("/share/");
  if (
    !isAuthed &&
    !isAuthPage &&
    !isPublicShare &&
    !nextUrl.pathname.startsWith("/api/auth")
  ) {
    const url = new URL("/login", nextUrl);
    return NextResponse.redirect(url);
  }
  if (isAuthed && isAuthPage) {
    return NextResponse.redirect(new URL("/", nextUrl));
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next|favicon.ico|.*\\..*).*)"],
};
