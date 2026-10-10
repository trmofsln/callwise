import { NextResponse, type NextRequest } from "next/server";
import { SITE_COOKIE, siteAuthEnabled, validSiteSession } from "./lib/site-auth";

// Site password gate (hosted only; off when SITE_PASSWORD is unset). Pages redirect to /login,
// APIs answer 401. The login page and its API stay open; static assets are excluded by the matcher.
export async function proxy(request: NextRequest) {
  if (!siteAuthEnabled()) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (pathname === "/login" || pathname === "/api/site-login") return NextResponse.next();
  if (await validSiteSession(request.cookies.get(SITE_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in to Callwise first." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|robots.txt).*)"],
};
