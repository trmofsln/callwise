import { createHash } from "node:crypto";
import { kv } from "./kv";
import { chatModel, classifySentiment, NO_CONVERSATION, sarvamConfigured, SarvamError } from "./sarvam";
import { eventInstant } from "./best-time-policy";
import { callDay } from "./recordings";
import type { RecordingAnalysis, SentimentResult } from "./recording-types";

// Previous-call context pasted by the user when building the queue. Recording audio is not always
// available, so transcripts or call notes typed in by the user are analysed by Sarvam instead and
// enter the calling plan exactly like analysed recordings. Nothing here is written to the seller's
// history: the context applies to the lookup it was sent with.

export const CALL_CONTEXT_LIMITS = { calls: 10, charsPerCall: 8000, totalChars: 40000 } as const;
const TIMEZONE = "Asia/Kolkata";

export type CallContextInput = { glid: string; calls: { text: string; at?: string | null }[] };

/** Validate the request body's call_context. Returns null when no transcript text was given. */
export function parseCallContext(input: unknown, glids: string[], asOf: string): CallContextInput | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("call_context must be an object.");
  const raw = input as { glid?: unknown; calls?: unknown };
  if (!Array.isArray(raw.calls)) throw new Error("call_context.calls must be a list.");
  const calls = raw.calls.map((call, index) => {
    const c = (call && typeof call === "object" ? call : {}) as { text?: unknown; at?: unknown };
    const text = typeof c.text === "string" ? c.text.replace(/\r\n/g, "\n").trim() : "";
    if (text.length > CALL_CONTEXT_LIMITS.charsPerCall) throw new Error(`Call ${index + 1} is longer than ${CALL_CONTEXT_LIMITS.charsPerCall} characters.`);
    let at: string | null = null;
    if (typeof c.at === "string" && c.at.trim()) {
      at = eventInstant(c.at.trim().slice(0, 16), TIMEZONE);
      if (!at) throw new Error(`Call ${index + 1} has an invalid date and time.`);
      if (Date.parse(at) > Date.parse(asOf) + 5 * 60_000) throw new Error(`Call ${index + 1} is dated in the future.`);
    }
    return { text, at };
  }).filter(c => c.text);
  if (!calls.length) return null;
  if (calls.length > CALL_CONTEXT_LIMITS.calls) throw new Error(`Provide at most ${CALL_CONTEXT_LIMITS.calls} calls.`);
  if (calls.reduce((n, c) => n + c.text.length, 0) > CALL_CONTEXT_LIMITS.totalChars) throw new Error(`Call context is longer than ${CALL_CONTEXT_LIMITS.totalChars} characters in total.`);
  const given = String(raw.glid ?? "").trim(), glid = !given ? glids[0] : /^\d{1,19}$/.test(given) ? BigInt(given).toString() : "";
  if (!glid || !glids.includes(glid)) throw new Error("Call context must belong to one of the GLIDs in the queue.");
  return { glid, calls };
}

// Keyed by a hash of the text and the call day, so re-building the same queue does not call Sarvam again.
// Only the structured result is kept, never the transcript.
export const transcriptKey = (hash: string) => `tx:${hash}`;
async function cached(hash: string): Promise<SentimentResult | null> {
  try { return await kv().get<SentimentResult>(transcriptKey(hash)); } catch { return null; }
}
async function remember(hash: string, result: SentimentResult) {
  try { await kv().set(transcriptKey(hash), result, 90 * 86_400); }
  catch { /* cache is optional */ }
}

/**
 * Analyse each pasted call with Sarvam (sentiment, summary, callback request, key points). Calls are
 * in order, Call 1 oldest. A call without a date is treated as just before the queue was built, one
 * minute apart, so "call me tomorrow" is read relative to today.
 */
export async function analyzeCallContext(context: CallContextInput, asOf: string): Promise<RecordingAnalysis[]> {
  const now = Date.parse(asOf), n = context.calls.length;
  const calls = context.calls.map((c, i) => ({ ...c, calledAt: c.at ?? new Date(now - (n - 1 - i) * 60_000).toISOString(), index: i }));
  const out: RecordingAnalysis[] = new Array(n);
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const call = calls[next++], day = callDay(call.calledAt, TIMEZONE);
      const hash = createHash("sha256").update(`${chatModel()}\n${day}\n${call.text}`).digest("hex");
      const base: RecordingAnalysis = {
        call_id: `manual-${hash.slice(0, 16)}`, glid: context.glid, called_at: call.calledAt, duration_seconds: null, vendor: `Call ${call.index + 1} · pasted transcript`,
        source_kind: "manual", status: "analyzed", status_detail: call.at ? null : "No call time given; treated as today.", result: null, language: null,
        transcript_chars: call.text.length, stt_model: null, chat_model: chatModel(), analyzed_at: new Date().toISOString(),
      };
      try {
        if (!sarvamConfigured()) throw new SarvamError("Set SARVAM_API_KEY in .env to analyse call context.");
        let result = await cached(hash);
        if (!result) {
          result = call.text.length < 15 ? NO_CONVERSATION : await classifySentiment(call.text, { calledOn: day });
          await remember(hash, result);
        }
        out[call.index] = { ...base, result };
      } catch (error) {
        out[call.index] = { ...base, status: "analysis_failed", status_detail: error instanceof SarvamError ? error.message : "Sarvam analysis failed." };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, n) }, worker));
  return out;
}
