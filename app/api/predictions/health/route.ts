import { NextResponse } from "next/server";
import { loadRegistry } from "@/lib/best-time-models";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET() {
  const registry=await loadRegistry();
  return NextResponse.json({status:"ok",primary_target:"meeting_done",models_ready:!!registry.history_aware&&!!registry.cold_start,history_model_ready:!!registry.history_aware,cold_start_model_ready:!!registry.cold_start,generalized_ranking_ready:!!registry.generalized,personal_history_ranking_ready:true,mode:"shadow_recommendations_only"},{headers:{"Cache-Control":"no-store"}});
}
