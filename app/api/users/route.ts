import { NextResponse } from "next/server";
import { RedashError } from "@/lib/redash";
import { lookupUsers, parseGlids } from "@/lib/user-lookup";
import { analyzeCallContext, parseCallContext } from "@/lib/call-context";
import { PipelineTrace } from "@/lib/pipeline-trace";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  const limited = await rateLimited(request, "queue");
  if (limited) return limited;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  let glids: string[], pasted: ReturnType<typeof parseCallContext>;
  try {
    glids = parseGlids(body?.glids);
    pasted = parseCallContext(body?.call_context, glids, new Date().toISOString());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request." }, { status: 400 });
  }
  try {
    const trace = new PipelineTrace();
    trace.mark("input", "completed", `${glids.length} GLID(s)${pasted ? ` · ${pasted.calls.length} pasted call(s) for GLID ${pasted.glid}` : " · no previous call context"}`);
    // Optional previous-call transcripts are analysed by Sarvam while the ERP history loads.
    let callContext: Promise<{ glid: string; analyses: Awaited<ReturnType<typeof analyzeCallContext>> }> | undefined;
    if (pasted) callContext = trace.time("sarvam_context", () => analyzeCallContext(pasted!, new Date().toISOString()), a => `${a.filter(x => x.status === "analyzed").length} of ${a.length} pasted call(s) analysed`).then(analyses => ({ glid: pasted!.glid, analyses }));
    else trace.mark("sarvam_context", "skipped", "No previous call context was pasted, so Sarvam was not called");
    const result = await lookupUsers(glids, { callContext, trace });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof RedashError ? error.message : "Could not fetch and save user information." }, {
      status: error instanceof RedashError ? error.status : 500,
    });
  }
}
