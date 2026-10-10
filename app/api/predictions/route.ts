import { NextResponse } from "next/server";
import { lookupUsers, parseGlids } from "@/lib/user-lookup";
import { RedashError } from "@/lib/redash";
import { rateLimited } from "@/lib/rate-limit";

export const runtime="nodejs";
export const maxDuration=180;
export async function POST(request: Request) {
  const limited=await rateLimited(request,"lookup");
  if(limited) return limited;
  try {
    const body=await request.json().catch(()=>{throw new RedashError("Request body must be valid JSON.",400);});
    const lookup=await lookupUsers(parseGlids(body?.glids));
    return NextResponse.json({lookup_id:lookup.lookupId,as_of:lookup.fetchedAt,predictions:lookup.predictions},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    return NextResponse.json({error:error instanceof RedashError?error.message:"Could not produce calling recommendations."},{status:error instanceof RedashError?error.status:500});
  }
}
