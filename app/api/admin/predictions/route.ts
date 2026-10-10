import { NextRequest, NextResponse } from "next/server";
import { getAdminStore } from "@/lib/sqlite";
import { adminError, checkOrigin, readBody, requireAdmin } from "@/lib/admin-http";
import { llmConfigStatus } from "@/lib/best-time-llm";
import { loadRegistry } from "@/lib/best-time-models";

export const runtime="nodejs";
export const dynamic="force-dynamic";
async function status() {
  const registry=await loadRegistry();
  return {settings:await getAdminStore().readPredictionSettings(),llm:llmConfigStatus(),models:{history_aware:registry.history_aware?.model_version||null,cold_start:registry.cold_start?.model_version||null,generalized:registry.generalized?.model_version||null,issues:registry.issues},objective:"meeting_done",deployment:"shadow_recommendations_only"};
}
export async function GET(request: NextRequest) {
  try {await requireAdmin(request);return NextResponse.json(await status(),{headers:{"Cache-Control":"no-store"}});} catch(error) {return adminError(error);}
}
export async function PUT(request: NextRequest) {
  try {checkOrigin(request);await requireAdmin(request);await getAdminStore().savePredictionSettings(await readBody(request));return NextResponse.json(await status(),{headers:{"Cache-Control":"no-store"}});} catch(error) {return adminError(error);}
}
