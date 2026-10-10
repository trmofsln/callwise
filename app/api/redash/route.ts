import { NextRequest, NextResponse } from "next/server";
import { RedashError, runQuery } from "@/lib/redash";
import { adminError, checkOrigin, requireAdmin } from "@/lib/admin-http";

export const runtime = "nodejs";
export const maxDuration = 150;

// Raw SQL against Redash is an admin tool: it needs an admin session (the app itself never calls it).
export async function POST(request: NextRequest) {
  try { checkOrigin(request); await requireAdmin(request); } catch (error) { return adminError(error); }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }
  const { query, dataSourceId, maxAge = 0 } = body as Record<string, unknown>;
  if (typeof query !== "string" || !query.trim() || query.length > 100_000) {
    return NextResponse.json({ error: "query must be a non-empty SQL string of at most 100000 characters." }, { status: 400 });
  }
  if (dataSourceId !== undefined && (typeof dataSourceId !== "number" || !Number.isSafeInteger(dataSourceId) || dataSourceId <= 0)) {
    return NextResponse.json({ error: "dataSourceId must be a positive integer." }, { status: 400 });
  }
  if (typeof maxAge !== "number" || !Number.isSafeInteger(maxAge) || maxAge < 0) {
    return NextResponse.json({ error: "maxAge must be a non-negative integer." }, { status: 400 });
  }
  try {
    const result = await runQuery({ query, dataSourceId: dataSourceId as number | undefined, maxAge });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RedashError ? error.message : "Unexpected Redash backend error." },
      { status: error instanceof RedashError ? error.status : 500 },
    );
  }
}
