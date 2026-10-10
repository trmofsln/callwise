import { NextResponse } from "next/server";
import { RedashError } from "@/lib/redash";
import { SarvamError, sarvamConfigured } from "@/lib/sarvam";
import { analyzeSellerRecordings, storedAnalyses } from "@/lib/recordings";
import { parseGlids } from "@/lib/user-lookup";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Cached Sarvam analyses for one or more sellers. */
export async function GET(request: Request) {
  try {
    const glids = parseGlids(new URL(request.url).searchParams.get("glids") ?? "");
    const map = await storedAnalyses(glids);
    return NextResponse.json({ configured: sarvamConfigured(), analyses: Object.fromEntries(glids.map(g => [g, map.get(g) ?? []])) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
}

/** Analyse a seller's newest recorded calls with Sarvam AI (speech-to-text + sarvam-105b sentiment). */
export async function POST(request: Request) {
  const limited = await rateLimited(request, "recordings");
  if (limited) return limited;
  let body: { glid?: unknown; force?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  try {
    const [glid] = parseGlids(String(body.glid ?? ""));
    if (!glid) return NextResponse.json({ error: "Provide one GLID." }, { status: 400 });
    const result = await analyzeSellerRecordings(glid, { limit: 5, force: body.force === true });
    return NextResponse.json({ glid, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof RedashError ? error.status : error instanceof SarvamError ? 503 : 500;
    return NextResponse.json({ error: error instanceof RedashError || error instanceof SarvamError ? error.message : "Recording analysis failed." }, { status });
  }
}
