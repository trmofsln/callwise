import { NextResponse } from "next/server";
import { fetchGlobalContexts } from "@/lib/global-context";
import { parseGlids } from "@/lib/user-lookup";
import { RedashError } from "@/lib/redash";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 150;

export async function POST(request: Request) {
  const limited = await rateLimited(request, "lookup");
  if (limited) return limited;
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  try {
    const contexts = await fetchGlobalContexts(parseGlids(body?.glids));
    return NextResponse.json({ contexts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof RedashError ? error.message : "Could not fetch Global Context." }, { status: error instanceof RedashError ? error.status : 500 });
  }
}
