import { NextRequest, NextResponse } from "next/server";
import { SITE_COOKIE, SITE_SESSION_SECONDS, sameText, signSiteSession, siteAuthEnabled } from "@/lib/site-auth";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookie = (request: NextRequest) => ({ httpOnly: true, sameSite: "lax" as const, secure: request.nextUrl.protocol === "https:", path: "/" });

export async function POST(request: NextRequest) {
  if (!siteAuthEnabled()) return NextResponse.json({ authenticated: true });
  const limited = await rateLimited(request, "login");
  if (limited) return limited;
  let password: unknown;
  try { ({ password } = await request.json()); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (typeof password !== "string" || password.length > 1024 || !(await sameText(password, process.env.SITE_PASSWORD!))) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const response = NextResponse.json({ authenticated: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SITE_COOKIE, await signSiteSession(), { ...cookie(request), maxAge: SITE_SESSION_SECONDS });
  return response;
}

export async function DELETE(request: NextRequest) {
  const response = NextResponse.json({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SITE_COOKIE, "", { ...cookie(request), maxAge: 0 });
  return response;
}
