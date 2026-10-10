import { NextResponse } from "next/server";
import { RedashError } from "@/lib/redash";
import { parseRetryRequest, planRetryAfterCall } from "@/lib/retry-planner";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** Plan the retry after an unsuccessful call: Sarvam reads the transcript, sarvam-105b picks the time and explains it. */
export async function POST(request: Request) {
  const limited = await rateLimited(request, "retry");
  if (limited) return limited;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const asOf = new Date().toISOString();
  let input;
  try { input = parseRetryRequest(body, asOf); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 }); }
  try {
    return NextResponse.json(await planRetryAfterCall(input, asOf), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof RedashError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not plan the retry." }, { status });
  }
}
