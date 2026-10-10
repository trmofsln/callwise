import { kv } from "./kv";
import { runQuery } from "./redash";
import { classifySentiment, chatModel, NO_CONVERSATION, sarvamConfigured, SarvamError, sttModel, transcribe } from "./sarvam";
import { eventInstant, localParts, zonedInstant } from "./best-time-policy";
import { PART_OF_DAY_HOURS, type CallbackRequest, type ConversationSignals, type RecordingAnalysis, type RecordingStatus } from "./recording-types";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIN_SECONDS = 15;
const TIMEZONE = "Asia/Kolkata";

// ---------------------------------------------------------------- vendor sources
type Source = { kind: RecordingAnalysis["source_kind"]; allowed: boolean };

/** Classify a recording URL by vendor host. Only https URLs on known recording hosts are ever fetched. */
export function recordingSource(raw: string): Source {
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: "other", allowed: false }; }
  const host = url.hostname.toLowerCase();
  const extra = (process.env.RECORDING_EXTRA_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  const kind: Source["kind"] = host === "openapi.airtel.in" ? "airtel"
    : host === "storage.googleapis.com" ? "gcs"
    : /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host) ? "s3" : "other";
  return { kind, allowed: url.protocol === "https:" && (kind !== "other" || extra.includes(host)) };
}

function jsonHeaders(value: string | undefined): Record<string, string> | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)])) : null;
  } catch { return null; }
}

type Download = { ok: true; audio: Buffer } | { ok: false; status: RecordingStatus; detail: string };

async function fetchAudio(url: string, headers: Record<string, string>): Promise<Download> {
  let target = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!recordingSource(target).allowed && hop > 0) return { ok: false, status: "unsupported_source", detail: "The recording redirected to an unapproved host." };
    let response: Response;
    try { response = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
    catch { return { ok: false, status: "download_failed", detail: "The recording host did not respond." }; }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) { target = new URL(response.headers.get("location")!, target).toString(); continue; }
    if (response.status === 401) return { ok: false, status: "needs_credentials", detail: "This vendor requires credentials to download recordings." };
    if (response.status === 403) return { ok: false, status: "access_denied", detail: "The recording storage does not allow access from this server." };
    if (!response.ok) return { ok: false, status: "download_failed", detail: `The recording host returned HTTP ${response.status}.` };
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_AUDIO_BYTES) return { ok: false, status: "download_failed", detail: "The recording is larger than 25 MB." };
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length > MAX_AUDIO_BYTES) return { ok: false, status: "download_failed", detail: "The recording is larger than 25 MB." };
    if (audio.length < 1000) return { ok: false, status: "download_failed", detail: "The recording file is empty." };
    return { ok: true, audio };
  }
  return { ok: false, status: "download_failed", detail: "Too many redirects." };
}

/** Download a recording with the access method its vendor needs. */
export async function downloadRecording(url: string, callId: string): Promise<Download> {
  const source = recordingSource(url);
  // An internal signed-URL / proxy service, when configured, works for every vendor.
  const proxy = process.env.RECORDING_PROXY_URL?.trim();
  if (proxy) {
    const proxied = proxy.replaceAll("{url}", encodeURIComponent(url)).replaceAll("{callId}", encodeURIComponent(callId));
    const result = await fetchAudio(proxied, jsonHeaders(process.env.RECORDING_PROXY_HEADERS) ?? {});
    if (result.ok) return result;
  }
  if (!source.allowed) return { ok: false, status: "unsupported_source", detail: "The recording host is not on the approved list." };
  if (source.kind === "airtel") {
    const headers = jsonHeaders(process.env.AIRTEL_RECORDING_HEADERS);
    if (!headers) return { ok: false, status: "needs_credentials", detail: "Airtel recordings need Airtel API credentials (AIRTEL_RECORDING_HEADERS)." };
    return fetchAudio(url, headers);
  }
  if (source.kind === "gcs") {
    const token = process.env.GCS_RECORDING_BEARER_TOKEN?.trim();
    return fetchAudio(url, token ? { Authorization: `Bearer ${token}` } : {});
  }
  return fetchAudio(url, {});
}

// ---------------------------------------------------------------- cache
// One hash per seller (`rec:<glid>`), one field per call ID. Only the structured result is kept, never audio or transcript.
export const recordingKey = (glid: string) => `rec:${glid}`;

export async function storedAnalyses(glids: string[]): Promise<Map<string, RecordingAnalysis[]>> {
  const out = new Map<string, RecordingAnalysis[]>();
  if (!glids.length) return out;
  try {
    const lists = await Promise.all(glids.map(glid => kv().hgetall<RecordingAnalysis>(recordingKey(glid))));
    glids.forEach((glid, i) => { const list = Object.values(lists[i]); if (list.length) out.set(glid, list); });
  } catch { /* cache unavailable: recommendations continue without conversation signals */ }
  for (const list of out.values()) list.sort((a, b) => (Date.parse(b.called_at ?? "") || 0) - (Date.parse(a.called_at ?? "") || 0));
  return out;
}

async function save(analysis: RecordingAnalysis) { await kv().hset(recordingKey(analysis.glid), analysis.call_id, analysis); }

// ---------------------------------------------------------------- analysis
type RecordingRow = { call_id: string; called_at: string | null; duration: number | null; vendor: string | null; url: string };

async function sellerRecordings(glid: string, limit: number): Promise<RecordingRow[]> {
  if (!/^[1-9]\d{0,18}$/.test(glid)) throw new Error("Invalid GLID.");
  const { rows } = await runQuery({
    dataSourceId: 13, maxAge: 0, queryIdEnv: "REDDASH_RECORDING_QUERY_ID",
    query: `SELECT click_to_call_id::bigint::text AS call_id, call_start_time AS called_at, call_duration AS duration, vendor, call_recording_url AS url
      FROM redash.click_to_call
      WHERE fk_glusr_usr_id = ${glid} AND COALESCE(call_recording_url, '') <> '' AND lower(status) = 'answered'
      ORDER BY call_start_time DESC NULLS LAST LIMIT ${Math.max(1, Math.min(limit, 25))}`,
  });
  return rows.map(r => ({ call_id: String(r.call_id), called_at: r.called_at ? String(r.called_at) : null, duration: r.duration === null || r.duration === undefined ? null : Number(r.duration), vendor: r.vendor ? String(r.vendor) : null, url: String(r.url) }));
}

async function analyzeOne(glid: string, row: RecordingRow): Promise<RecordingAnalysis> {
  const base: RecordingAnalysis = {
    call_id: row.call_id, glid, called_at: eventInstant(row.called_at, TIMEZONE), duration_seconds: row.duration, vendor: row.vendor,
    source_kind: recordingSource(row.url).kind, status: "analyzed", status_detail: null, result: null, language: null, transcript_chars: 0,
    stt_model: null, chat_model: null, analyzed_at: new Date().toISOString(),
  };
  if (row.duration !== null && row.duration < MIN_SECONDS) return { ...base, status: "too_short", status_detail: `Shorter than ${MIN_SECONDS} seconds.` };
  const download = await downloadRecording(row.url, row.call_id);
  if (!download.ok) return { ...base, status: download.status, status_detail: download.detail };
  try {
    const stt = await transcribe(download.audio);
    const transcript = stt.transcript.trim();
    const result = transcript.length < 15 ? NO_CONVERSATION : await classifySentiment(transcript, { calledOn: base.called_at ? callDay(base.called_at) : undefined });
    // The transcript itself is not stored; only the structured result is kept.
    return { ...base, result, language: stt.language, transcript_chars: transcript.length, stt_model: sttModel(), chat_model: transcript.length < 15 ? null : chatModel() };
  } catch (error) {
    return { ...base, status: "analysis_failed", status_detail: error instanceof SarvamError ? error.message : "Sarvam analysis failed." };
  }
}

const RETRY_AFTER_MS: Partial<Record<RecordingStatus, number>> = { needs_credentials: 6 * 3600_000, access_denied: 6 * 3600_000, download_failed: 3600_000, analysis_failed: 900_000 };

/** Analyse the seller's most recent answered recordings that are not cached yet. */
export async function analyzeSellerRecordings(glid: string, { limit = 5, force = false } = {}): Promise<{ analyses: RecordingAnalysis[]; processed: number }> {
  if (!sarvamConfigured()) throw new SarvamError("Set SARVAM_API_KEY in .env to analyse recordings.");
  const cached = new Map(((await storedAnalyses([glid])).get(glid) ?? []).map(a => [a.call_id, a]));
  const rows = await sellerRecordings(glid, Math.max(limit * 2, 8));
  const now = Date.now();
  const todo = rows.filter(r => {
    const hit = cached.get(r.call_id);
    if (!hit || force) return true;
    const wait = RETRY_AFTER_MS[hit.status];
    return wait !== undefined && now - Date.parse(hit.analyzed_at) > wait;
  }).slice(0, limit);
  for (const row of todo) await save(await analyzeOne(glid, row));
  return { analyses: (await storedAnalyses([glid])).get(glid) ?? [], processed: todo.length };
}

// ---------------------------------------------------------------- signals for ranking and explanations
const WEEKDAY_INDEX: Record<string, number> = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
const DAY_MS = 86_400_000;

/** "Sat, 10 Oct 2026" in the calling timezone, given to Sarvam so a named date gets the right month and year. */
export function callDay(at: string, timezone = TIMEZONE): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(at));
}

export type CallbackWindow = { start: string; end: string; precision: "exact" | "range" | "day" | "on_or_after" };

/**
 * Resolve what the client said ("call me Sunday evening", "after 7:30 PM", "after five days",
 * "at 1 PM") to a local time range relative to the call it was said in. Returns null when the
 * request names no timing at all.
 */
export function resolveCallbackWindow(calledAt: string, cb: CallbackRequest, timezone: string): CallbackWindow | null {
  const calledMs = Date.parse(calledAt);
  if (!Number.isFinite(calledMs)) return null;
  const said = localParts(calledMs, timezone);
  const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
  const at = (date: string, minutes: number) => zonedInstant(date, 0, timezone) + minutes * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const hasDay = !!(cb.date || cb.after_days || cb.day || cb.relative);
  if (cb.after_minutes && !hasDay && !cb.local_time && !cb.part_of_day) {
    const start = calledMs + cb.after_minutes * 60_000;
    return { start: iso(start), end: iso(start + 3_600_000), precision: "exact" };
  }
  let date: string | null = null;
  // Soft deferrals open from a date onwards: the last three days of the month, the 1st of next month, next Monday.
  const [y, mo] = said.date.split("-").map(Number);
  const relative = cb.relative === "month_end" ? addDays(new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10), -3)
    : cb.relative === "next_month" ? new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)
    : cb.relative === "next_week" ? addDays(said.date, 7 - said.weekday) : null;
  if (cb.date) date = cb.date;
  else if (relative && !cb.after_days && !cb.day) date = relative < said.date ? said.date : relative;
  else if (cb.after_days) date = addDays(said.date, cb.after_days);
  else if (cb.day === "today") date = said.date;
  else if (cb.day === "tomorrow") date = addDays(said.date, 1);
  else if (cb.day) date = addDays(said.date, (((WEEKDAY_INDEX[cb.day] - said.weekday) % 7) + 7) % 7 || 7);
  // Clock range in minutes after local midnight.
  const part = cb.part_of_day ? PART_OF_DAY_HOURS[cb.part_of_day].map(h => h * 60) as [number, number] : null;
  let range: [number, number] | null = part;
  if (cb.local_time) {
    const [h, m] = cb.local_time.split(":").map(Number), t = h * 60 + m;
    range = cb.time_kind === "after" ? [t, Math.max(t + 120, part && part[1] > t ? part[1] : 0)]
      : cb.time_kind === "before" ? [Math.max(t - 180, part && part[0] < t ? part[0] : 9 * 60, 0), t]
      : [t, t + 60];
    if (range[1] <= range[0]) range = [t, t + 60];
  }
  if (!date) {
    if (!range) return null;
    // A time with no day means the same day if it is still ahead when said, otherwise the next day.
    date = at(said.date, range[1]) > calledMs ? said.date : addDays(said.date, 1);
  }
  if (range) return { start: iso(at(date, range[0])), end: iso(at(date, range[1])), precision: cb.local_time && cb.time_kind !== "after" && cb.time_kind !== "before" ? "exact" : "range" };
  const onOrAfter = (!!cb.after_days || !!relative) && !cb.day && !cb.date;
  return { start: iso(at(date, 0)), end: iso(at(addDays(date, onOrAfter ? 4 : 1), 0)), precision: onOrAfter ? "on_or_after" : "day" };
}

/** Plain-language description of a resolved callback, e.g. "today after 7:30 PM" or "Sun, 11 Oct evening (4 PM to 8 PM)". */
export function callbackLabel(window: CallbackWindow, cb: CallbackRequest, timezone: string, asOf?: string): string {
  const dated = new Intl.DateTimeFormat("en-IN", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(new Date(window.start));
  const ahead = asOf ? Math.round((Date.parse(`${localParts(window.start, timezone).date}T00:00:00Z`) - Date.parse(`${localParts(asOf, timezone).date}T00:00:00Z`)) / DAY_MS) : null;
  const day = ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : dated;
  const clock = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).toUpperCase().replace(":00", "");
  if (window.precision === "exact") return `${day} at ${clock(window.start)}`;
  if (window.precision === "on_or_after") return cb.relative && !cb.after_days ? `${cb.relative.replace("_", " ")} (from ${dated})` : `after ${cb.after_days} day${cb.after_days === 1 ? "" : "s"} (from ${dated})`;
  if (window.precision === "day") return day;
  if (cb.local_time && cb.time_kind === "after") return `${day} after ${clock(window.start)}`;
  if (cb.local_time && cb.time_kind === "before") return `${day} before ${clock(window.end)}`;
  return `${day} ${cb.part_of_day ? `${cb.part_of_day} ` : ""}(${clock(window.start)} to ${clock(window.end)})`;
}

export function conversationSignals(analyses: RecordingAnalysis[] | undefined, asOf: string, timezone: string): ConversationSignals | null {
  const done = (analyses ?? []).filter(a => a.status === "analyzed" && a.result).sort((a, b) => (Date.parse(b.called_at ?? "") || 0) - (Date.parse(a.called_at ?? "") || 0));
  if (!done.length) return null;
  const now = Date.parse(asOf);
  const counts: ConversationSignals["counts"] = {};
  const hours = new Map<number, { calls: number; total: number }>();
  let total = 0, scored = 0;
  for (const a of done) {
    const r = a.result!;
    counts[r.sentiment] = (counts[r.sentiment] ?? 0) + 1;
    if (r.sentiment !== "no_conversation") { total += r.score; scored++; }
    if (a.called_at && r.sentiment !== "no_conversation") {
      const hour = localParts(a.called_at, timezone).hour, h = hours.get(hour) ?? { calls: 0, total: 0 };
      h.calls++; h.total += r.score; hours.set(hour, h);
    }
  }
  // Only the client's latest real conversation decides the callback: a later call supersedes an older request.
  let callback: ConversationSignals["callback"] = null;
  const talk = done.find(a => a.result!.sentiment !== "no_conversation");
  if (talk?.called_at && talk.result!.callback.requested && now - Date.parse(talk.called_at) < 30 * DAY_MS) {
    const cb = talk.result!.callback, window = resolveCallbackWindow(talk.called_at, cb, timezone);
    if (window && Date.parse(window.end) > now) callback = { at: window.start, end: window.end, precision: window.precision, label: callbackLabel(window, cb, timezone, asOf), text: cb.when_text, requested_on: talk.called_at };
  }
  const latest = done[0];
  return {
    analyzed: done.length, manual: done.filter(a => a.source_kind === "manual").length, counts, average_score: scored ? Math.round((total / scored) * 100) / 100 : null,
    latest: { sentiment: latest.result!.sentiment, score: latest.result!.score, summary: latest.result!.summary, at: latest.called_at, ...(latest.result!.key_points?.length ? { key_points: latest.result!.key_points } : {}) },
    // Meeting intent counts only from the last 30 days: an old "yes, visit me" is no longer a live signal.
    callback, meeting_intent: done.some(a => a.result!.meeting_intent && !!a.called_at && now - Date.parse(a.called_at) < 30 * DAY_MS),
    hour_scores: Object.fromEntries([...hours.entries()].map(([h, v]) => [String(h), { calls: v.calls, average: Math.round((v.total / v.calls) * 100) / 100 }])),
    asked_not_to_call: talk?.result!.sentiment === "do_not_call",
    recent_negative: !!latest.called_at && now - Date.parse(latest.called_at) < 14 * 86_400_000 && (latest.result!.sentiment === "do_not_call" || latest.result!.sentiment === "not_interested" || latest.result!.sentiment === "frustrated"),
  };
}
