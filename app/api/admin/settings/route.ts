import { NextRequest, NextResponse } from "next/server";
import { getAdminStore } from "@/lib/sqlite";
import { adminError, checkOrigin, readBody, requireAdmin } from "@/lib/admin-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    return NextResponse.json(await getAdminStore().readSettings(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return adminError(error); }
}

export async function PUT(request: NextRequest) {
  try {
    checkOrigin(request);
    await requireAdmin(request);
    return NextResponse.json(await getAdminStore().saveSettings(await readBody(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return adminError(error); }
}
