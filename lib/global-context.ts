import { getAdminStore, getSharedCredentials } from "./sqlite";
import { GLOBAL_CONTEXT_SEGMENTS, type GlobalContextResult } from "./global-context-catalog";

class ContextError extends Error {}

function redact(value: unknown, token: string): unknown {
  if (typeof value === "string") return token ? value.replaceAll(token, "[REDACTED]") : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(ak|token|authorization|password)$/i.test(key) ? "[REDACTED]" : redact(item, token)]));
  return value;
}

function result(glid: string): GlobalContextResult {
  return { glid, status: "error", mappingId: null, requestedSegments: [...GLOBAL_CONTEXT_SEGMENTS], fetchedAt: new Date().toISOString(), data: null, response: null, error: null };
}

export async function fetchGlobalContexts(glids: string[]): Promise<GlobalContextResult[]> {
  let credentials;
  try { credentials = await getSharedCredentials(); }
  catch { return glids.map((glid) => ({ ...result(glid), error: "Could not read the shared credentials from the settings store." })); }
  if (!credentials.token || !credentials.employeeId) {
    return glids.map((glid) => ({ ...result(glid), status: "not_configured", error: "Save the shared JWT token and employee ID in Admin to fetch Global Context." }));
  }
  const employeeId = Number(credentials.employeeId);
  if (!Number.isSafeInteger(employeeId) || employeeId <= 0) {
    return glids.map((glid) => ({ ...result(glid), error: "The stored employee ID must be a positive safe integer for Global Context." }));
  }
  const base = (process.env.GLOBAL_CONTEXT_URL || "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(base)) {
    return glids.map((glid) => ({ ...result(glid), status: "not_configured", error: "Set GLOBAL_CONTEXT_URL on the server to fetch Global Context." }));
  }
  const token = credentials.token;
  const forwardedFor = process.env.GLOBAL_CONTEXT_FORWARDED_FOR?.trim();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}) };
  const deadline = AbortSignal.timeout(120_000);
  const output: GlobalContextResult[] = new Array(glids.length);
  let nextIndex = 0;

  async function fetchOne(glid: string): Promise<GlobalContextResult> {
    const context = result(glid);
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(45_000)]);
    async function request(endpoint: string, body?: Record<string, unknown>) {
      let response;
      try {
        response = await fetch(`${base}/${endpoint}`, { method: body ? "POST" : "GET", headers,
          body: body ? JSON.stringify(body) : undefined, cache: "no-store", redirect: "error", signal });
      } catch { throw new ContextError(signal.aborted ? "Global Context request timed out." : "Could not connect to Global Context."); }
      if (!response.ok) throw new ContextError(`Global Context ${body ? "generation" : "fetch"} failed (HTTP ${response.status}).`);
      let payload;
      try { payload = await response.json(); }
      catch { throw new ContextError("Global Context returned invalid JSON."); }
      if (payload && typeof payload === "object" && payload.code !== undefined && Number(payload.code) !== 200) {
        const code = Number(payload.code);
        throw new ContextError(Number.isFinite(code) ? `Global Context ${body ? "generation" : "fetch"} failed (code ${code}). Check the saved employee ID and JWT token.` : "Global Context returned an invalid response code.");
      }
      return payload;
    }
    try {
      const generated = await request("generateContextUID", {
        mapping_type: 1, mapping_value: glid, source_id: 3, empid: employeeId, ak: token,
        data_segments: GLOBAL_CONTEXT_SEGMENTS.join(","),
      });
      const mappingId = generated?.data?.mapping_id;
      if (typeof mappingId !== "string" || !mappingId.trim() || mappingId.length > 256) throw new ContextError("Global Context did not return a valid mapping ID.");
      context.mappingId = mappingId;
      const response = await request(`x/getContext?${new URLSearchParams({ mapping_id: mappingId })}`);
      context.response = redact(response, token);
      context.data = redact(response && typeof response === "object" && "data" in response ? response.data : response, token);
      context.status = "success";
    } catch (error) {
      context.error = error instanceof ContextError ? error.message : "Could not fetch Global Context.";
    }
    context.fetchedAt = new Date().toISOString();
    try { await getAdminStore().saveGlobalContext(context); }
    catch { context.error = context.error ? `${context.error} Its snapshot could not be saved.` : "Context fetched, but its snapshot could not be saved."; }
    return context;
  }

  await Promise.all(Array.from({ length: Math.min(4, glids.length) }, async () => {
    while (nextIndex < glids.length) {
      const index = nextIndex++;
      output[index] = await fetchOne(glids[index]);
    }
  }));
  return output;
}
