// Site-wide password gate for hosted deployments. When SITE_PASSWORD is set, every page and API
// needs a signed session cookie (see proxy.ts). Locally, with no SITE_PASSWORD, the gate is off.
// The cookie is `<expiry ms>.<HMAC-SHA256(expiry)>`, keyed by SITE_SESSION_SECRET and the password,
// so changing either signs everyone out. Web Crypto only, so it runs in any runtime.

export const SITE_COOKIE = "site_session";
export const SITE_SESSION_SECONDS = 30 * 86_400;

export const siteAuthEnabled = () => !!process.env.SITE_PASSWORD;

const encoder = new TextEncoder();
async function hmac(message: string): Promise<string> {
  const secret = `${process.env.SITE_SESSION_SECRET ?? ""}\u0000${process.env.SITE_PASSWORD ?? ""}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(message))).toString("base64url");
}

/** Equal-time comparison of two strings of any length. */
export async function sameText(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async v => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(v)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function signSiteSession(now = Date.now()): Promise<string> {
  const expires = now + SITE_SESSION_SECONDS * 1000;
  return `${expires}.${await hmac(String(expires))}`;
}

export async function validSiteSession(value: string | undefined, now = Date.now()): Promise<boolean> {
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!match || Number(match[1]) <= now) return false;
  return sameText(match[2], await hmac(match[1]));
}

/** The caller's IP as seen by the platform (Vercel sets x-forwarded-for; the first entry is the client). */
export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for")?.split(",")[0] || headers.get("x-real-ip") || "local").trim().slice(0, 64);
}
