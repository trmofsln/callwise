import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CALLBACK_DAYS, PARTS_OF_DAY, SENTIMENTS, type CallbackRequest, type Sentiment, type SentimentResult } from "./recording-types";

// Sarvam AI (hackathon sponsor): speech-to-text for call recordings, and sentiment, summary and
// callback extraction with sarvam-105b for recordings and pasted transcripts. Server-side only;
// the key never reaches the browser.

export { SENTIMENTS } from "./recording-types";
export type { Sentiment, SentimentResult } from "./recording-types";

export class SarvamError extends Error {}

const BASE = () => (process.env.SARVAM_BASE_URL || "https://api.sarvam.ai").replace(/\/$/, "");
function key(): string {
  const value = process.env.SARVAM_API_KEY?.trim();
  if (!value) throw new SarvamError("Set SARVAM_API_KEY in .env to analyse recordings.");
  return value;
}
export function sarvamConfigured(): boolean { return !!process.env.SARVAM_API_KEY?.trim(); }
export const chatModel = () => process.env.SARVAM_CHAT_MODEL || "sarvam-105b";
export const sttModel = () => process.env.SARVAM_STT_MODEL || "saaras:v4";

// FFMPEG_PATH, else the bundled ffmpeg-static binary (hosted deployments have no system ffmpeg), else ffmpeg on PATH.
function ffmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundled = path.join(/*turbopackIgnore: true*/ process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  return existsSync(bundled) ? bundled : "ffmpeg";
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d).slice(0, 500); });
    child.on("error", () => reject(new SarvamError("ffmpeg is required to prepare recordings for speech-to-text.")));
    child.on("close", (code) => code === 0 ? resolve() : reject(new SarvamError(`Audio conversion failed (${stderr.trim().slice(0, 160) || code}).`)));
  });
}

/** Split audio into 16 kHz mono chunks under Sarvam's ~30 s synchronous limit and transcribe them in parallel. */
export async function transcribe(audio: Buffer, { segmentSeconds = 25, maxSeconds = 600 } = {}): Promise<{ transcript: string; language: string | null; seconds: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "callwise-rec-"));
  try {
    await writeFile(path.join(dir, "input"), audio);
    await run(ffmpeg(), ["-y", "-loglevel", "error", "-i", path.join(dir, "input"), "-t", String(maxSeconds), "-ac", "1", "-ar", "16000",
      "-f", "segment", "-segment_time", String(segmentSeconds), path.join(dir, "seg%03d.wav")]);
    const segments = (await readdir(dir)).filter(f => f.startsWith("seg")).sort();
    if (!segments.length) throw new SarvamError("The recording contains no decodable audio.");
    const results: { transcript: string; language: string | null }[] = new Array(segments.length);
    let next = 0;
    const worker = async () => {
      while (next < segments.length) {
        const index = next++;
        const form = new FormData();
        form.append("model", sttModel());
        form.append("language_code", "unknown");
        form.append("file", new Blob([new Uint8Array(await readFile(path.join(dir, segments[index])))], { type: "audio/wav" }), segments[index]);
        const response = await fetch(`${BASE()}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": key() }, body: form, signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new SarvamError(`Sarvam speech-to-text failed (HTTP ${response.status}).`);
        const body = await response.json() as { transcript?: string; language_code?: string | null };
        results[index] = { transcript: String(body.transcript ?? "").trim(), language: body.language_code ?? null };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, segments.length) }, worker));
    const languages = results.map(r => r.language).filter(Boolean) as string[];
    return { transcript: results.map(r => r.transcript).filter(Boolean).join(" "), language: languages[0] ?? null, seconds: segments.length * segmentSeconds };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SYSTEM_PROMPT = [
  "You analyse B2B sales calls (often Hindi and English mixed) between an IndiaMART representative and a seller, the client.",
  "The input is a call transcript or a representative's notes about the call. Judge the CLIENT's attitude only, never the representative's.",
  "Reply with one compact JSON object and nothing else, with exactly these keys:",
  '{"sentiment": one of "enthusiastic","interested","curious","neutral","busy_callback","gatekeeper","hesitant","frustrated","not_interested","do_not_call","no_conversation",',
  ' "score": number from -1 (very negative) to 1 (very positive),',
  ' "summary": one or two short English sentences on what was discussed and how the client responded (no names, phone numbers or company names),',
  ' "callback": {"requested": true/false, "when_text": the client\'s words about timing or null,',
  '   "day": "today","tomorrow" or a weekday name in lowercase, or null,',
  '   "date": "YYYY-MM-DD" only if the client named a calendar date, else null,',
  '   "after_days": whole number of days for relative days like "after five days" (5), "day after tomorrow"/"parso" (2), "next week" (7), else null,',
  '   "after_minutes": whole number for "after two hours" (120) or "in 30 minutes" (30), else null,',
  '   "local_time": "HH:MM" 24-hour clock time if one was named, else null,',
  '   "time_kind": "at" for a time to call, "after" for "after 7:30 PM", "before" for "before 1 PM", or null,',
  '   "part_of_day": "morning","afternoon","evening" or "night" if said ("shaam" = evening, "subah" = morning, "dopahar" = afternoon), else null,',
  '   "relative": "month_end" for "month end"/"mahine ke end mein", "next_month" for "next month"/"agle mahine", "next_week" for "next week"/"agle hafte", else null},',
  ' "meeting_intent": true if the client agreed to or asked for a meeting or visit, else false,',
  ' "objections": up to 3 short strings,',
  ' "key_points": up to 4 short strings with other useful facts (requirement, product, quantity, decision maker, documents or quotation asked for, preferred language)}',
  "Never compute dates yourself beyond copying a named calendar date; extract the pieces as said. Use 24-hour time: \"7:30 baje shaam\" is 19:30, \"1 baje dopahar\" is 13:00.",
  "\"kal\" means tomorrow (day \"tomorrow\", after_days null); \"parso\" means after_days 2. Fill day OR after_days OR date, never more than one.",
  "A soft deferral (\"month end\", \"next month\", \"next week\") is also a callback request: set requested true and fill relative.",
  "Only the client's words count: the representative's pitch or claims are not the client's interest.",
  "Definitions: enthusiastic = keen and ready to proceed; interested = positive and wants details; curious = open, asking questions;",
  "neutral = polite, no clear direction; busy_callback = busy now or asked to be called at another time;",
  "gatekeeper = someone other than the decision maker answered (staff, family) and the owner was unavailable; hesitant = unsure, price or value concerns;",
  "frustrated = irritated or complaining; not_interested = declined; do_not_call = explicitly asked never to be called again;",
  "no_conversation = voicemail, silence, wrong number, or the client never speaks.",
].join("\n");

const EMPTY_CALLBACK: CallbackRequest = { requested: false, when_text: null, day: null, date: null, after_days: null, after_minutes: null, local_time: null, time_kind: null, part_of_day: null, relative: null };

/** Validate and normalise the model's JSON so nothing outside the contract reaches the app. */
export function parseSentiment(content: string): SentimentResult {
  const start = content.indexOf("{"), end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SarvamError("Sarvam returned no JSON.");
  const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  const sentiment = SENTIMENTS.includes(raw.sentiment as Sentiment) ? raw.sentiment as Sentiment : null;
  if (!sentiment) throw new SarvamError("Sarvam returned an unknown sentiment.");
  const score = Math.max(-1, Math.min(1, Number(raw.score)));
  const cb = (raw.callback && typeof raw.callback === "object" ? raw.callback : {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  const oneOf = <T extends string>(value: unknown, list: readonly T[]) => typeof value === "string" && list.includes(value.toLowerCase() as T) ? value.toLowerCase() as T : null;
  const whole = (value: unknown, max: number) => { const n = Number(value); return value !== null && value !== "" && Number.isInteger(n) && n > 0 && n <= max ? n : null; };
  const time = typeof cb.local_time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(cb.local_time) ? cb.local_time : null;
  const date = typeof cb.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cb.date) && !Number.isNaN(Date.parse(`${cb.date}T00:00:00Z`)) ? cb.date : null;
  const list = (value: unknown, count: number, max: number) => Array.isArray(value) ? value.map(o => text(o, max)).filter(Boolean).slice(0, count) : [];
  return {
    sentiment,
    score: Number.isFinite(score) ? Math.round(score * 100) / 100 : 0,
    summary: text(raw.summary, 320) || "No summary returned.",
    callback: {
      ...EMPTY_CALLBACK, requested: cb.requested === true, when_text: text(cb.when_text, 120) || null,
      day: oneOf(cb.day, CALLBACK_DAYS), date, after_days: whole(cb.after_days, 60), after_minutes: whole(cb.after_minutes, 24 * 60),
      local_time: time, time_kind: time ? oneOf(cb.time_kind, ["at", "after", "before"] as const) ?? "at" : null, part_of_day: oneOf(cb.part_of_day, PARTS_OF_DAY),
      relative: oneOf(cb.relative, ["month_end", "next_month", "next_week"] as const),
    },
    meeting_intent: raw.meeting_intent === true,
    objections: list(raw.objections, 3, 80),
    key_points: list(raw.key_points, 4, 120),
  };
}

export const NO_CONVERSATION: SentimentResult = { sentiment: "no_conversation", score: 0, summary: "No clear conversation was captured.", callback: EMPTY_CALLBACK, meeting_intent: false, objections: [], key_points: [] };

/** One JSON-mode chat completion with sarvam-105b. Returns the raw message content. */
export async function sarvamJson(system: string, user: string, { maxTokens = 700, timeoutMs = 60_000 } = {}): Promise<string> {
  const response = await fetch(`${BASE()}/v1/chat/completions`, {
    method: "POST",
    headers: { "api-subscription-key": key(), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      // Reasoning is off: with it on, sarvam-105b can spend the whole token budget before answering.
      model: chatModel(), reasoning_effort: null, temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!response.ok) throw new SarvamError(`Sarvam chat failed (HTTP ${response.status}).`);
  const body = await response.json() as { choices?: { message?: { content?: string | null } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

/** Classify one call. `calledOn` (e.g. "Sat, 10 Oct 2026") lets the model copy a named date with the right month and year. */
export async function classifySentiment(transcript: string, { calledOn }: { calledOn?: string } = {}): Promise<SentimentResult> {
  return parseSentiment(await sarvamJson(SYSTEM_PROMPT, `${calledOn ? `The call took place on ${calledOn}.\n` : ""}Transcript:\n${transcript.slice(0, 12000)}`));
}
