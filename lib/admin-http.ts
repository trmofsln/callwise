import { NextRequest, NextResponse } from "next/server";
import { AdminError, getAdminStore } from "./sqlite";

export const ADMIN_COOKIE = "admin_session";

export function checkOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  // NextURL rewrites loopback hosts to localhost. Compare the browser's origin
  // with the actual incoming Host so 127.0.0.1/IPv6 same-origin requests work.
  let expectedOrigin: string;
  try {
    const url = new URL(`${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid Host.");
    expectedOrigin = url.origin;
  } catch { throw new AdminError("This request must come from the admin app.", 403); }
  if ((origin && origin !== expectedOrigin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AdminError("This request must come from the admin app.", 403);
  }
}

export async function requireAdmin(request: NextRequest) {
  if (!await getAdminStore().authenticated(request.cookies.get(ADMIN_COOKIE)?.value)) throw new AdminError("Sign in to the admin panel.", 401);
}

export function adminError(error: unknown) {
  return NextResponse.json({ error: error instanceof AdminError ? error.message : "Could not process the admin request." }, {
    status: error instanceof AdminError ? error.status : 500,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readBody(request: NextRequest) {
  try { return await request.json(); }
  catch { throw new AdminError("Request body must be valid JSON."); }
}
