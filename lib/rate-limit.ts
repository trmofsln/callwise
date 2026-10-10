import { NextResponse } from "next/server";
import { kv } from "./kv";
import { clientIp } from "./site-auth";

// Fixed-window limits per client IP on the routes that spend paid API calls (Redash, Sarvam,
// OpenRouter). Only enforced when the site gate is on (hosted); a storage failure never blocks a request.
const LIMITS = {
  queue: { limit: 60, windowSeconds: 3600 },     // build call queue
  retry: { limit: 120, windowSeconds: 3600 },    // AI retry after a call
  recordings: { limit: 40, windowSeconds: 3600 },// Sarvam speech-to-text
  lookup: { limit: 60, windowSeconds: 3600 },    // other ERP lookups
  login: { limit: 10, windowSeconds: 900 },      // password attempts
} as const;
export type RateBucket = keyof typeof LIMITS;

/** Returns a 429 response when the caller is over the limit, else null. */
export async function rateLimited(request: Request, bucket: RateBucket): Promise<NextResponse | null> {
  if (!process.env.SITE_PASSWORD) return null;
  const { limit, windowSeconds } = LIMITS[bucket];
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  let count: number;
  try { count = await kv().incr(`rl:${bucket}:${clientIp(request.headers)}:${window}`, windowSeconds); }
  catch { return null; }
  if (count <= limit) return null;
  const retryAfter = (window + 1) * windowSeconds - Math.floor(Date.now() / 1000);
  return NextResponse.json({ error: `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` }, { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } });
}
