import { NextRequest, NextResponse } from "next/server";
import { adminError, requireAdmin } from "@/lib/admin-http";
import { getAdminStore } from "@/lib/sqlite";
import { readExperimentReport } from "@/lib/best-time-experiments";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request: NextRequest) {
  try { await requireAdmin(request);return NextResponse.json(await readExperimentReport(await getAdminStore().readPredictionSettings()),{headers:{"Cache-Control":"no-store"}}); }
  catch(error) {return adminError(error);}
}
