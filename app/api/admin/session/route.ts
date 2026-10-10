import { NextRequest, NextResponse } from "next/server";
import { getAdminStore } from "@/lib/sqlite";
import { ADMIN_COOKIE, adminError, checkOrigin, readBody } from "@/lib/admin-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const store = getAdminStore();
    return NextResponse.json({ configured: await store.isConfigured(), authenticated: await store.authenticated(request.cookies.get(ADMIN_COOKIE)?.value) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return adminError(error); }
}

export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    const body = await readBody(request);
    const store = getAdminStore();
    if (body?.action === "setup") await store.setup(body.password);
    const token = await store.login(body?.password);
    const response = NextResponse.json({ authenticated: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(ADMIN_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:", path: "/api", maxAge: 8 * 60 * 60 });
    return response;
  } catch (error) { return adminError(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    checkOrigin(request);
    await getAdminStore().logout(request.cookies.get(ADMIN_COOKIE)?.value);
    const response = NextResponse.json({ authenticated: false });
    response.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/api", maxAge: 0 });
    return response;
  } catch (error) { return adminError(error); }
}
