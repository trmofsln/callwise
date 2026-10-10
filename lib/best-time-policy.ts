import type { CallWindow, PredictionContext, PredictionRoute, SchedulingSettings } from "./best-time-types";

// Configurable operating assumptions, not verified company policy.
export const DEFAULT_SCHEDULING: SchedulingSettings = {
  enabled: true, llmEnabled: true, timezone: "Asia/Kolkata", businessStartHour: 10,
  businessEndHour: 18, businessDays: [0, 1, 2, 3, 4, 5], horizonDays: 7,
  cooldownMinutes: 15, maxAttemptsPerDay: 3, maxAttemptsPerSequence: 10,
  sequenceDays: 7, minimumHistory: 10, llmDeadlineMs: 12000, llmMaxTools: 6, maxSlotsPerDay: 4,
};
export function validateSettings(value: unknown): SchedulingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Scheduling settings must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_SCHEDULING, key))) throw new Error("Unknown scheduling setting.");
  const result = { ...DEFAULT_SCHEDULING, ...input } as SchedulingSettings;
  for (const key of ["enabled", "llmEnabled"] as const) if (typeof result[key] !== "boolean") throw new Error(`${key} must be boolean.`);
  if (typeof result.timezone !== "string" || result.timezone.length > 80) throw new Error("Invalid timezone.");
  try { new Intl.DateTimeFormat("en", { timeZone: result.timezone }).format(); } catch { throw new Error("Invalid timezone."); }
  const ranges = { businessStartHour: [0,23], businessEndHour: [1,24], horizonDays: [1,14], cooldownMinutes: [15,1440], maxAttemptsPerDay: [1,10], maxAttemptsPerSequence: [1,30], sequenceDays: [1,30], minimumHistory: [5,100], llmDeadlineMs: [1000,30000], llmMaxTools: [1,6], maxSlotsPerDay: [3,4] };
  for (const [key, [min,max]] of Object.entries(ranges)) {
    const val = result[key as keyof typeof ranges];
    if (!Number.isInteger(val) || val < min || val > max) throw new Error(`Invalid ${key}.`);
  }
  if (result.businessStartHour >= result.businessEndHour) throw new Error("Business end must be after start.");
  if (!Array.isArray(result.businessDays) || !result.businessDays.length || result.businessDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("Business days use Monday=0 through Sunday=6.");
  result.businessDays = [...new Set(result.businessDays)];
  return result;
}
export function localParts(at: number | string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: (new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7 };
}
export function zonedInstant(date: string, hour: number, timezone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`) + hour*3600000;
  let guess = target;
  for (let i=0;i<4;i++) {
    const p = localParts(guess, timezone);
    const represented = Date.parse(`${p.date}T00:00:00Z`)+(p.hour*3600+p.minute*60+p.second)*1000;
    const delta = target-represented; guess += delta;
    if (!delta) return guess;
  }
  return guess;
}
export function eventInstant(value: string | null | undefined, timezone: string): string | null {
  if (!value) return null;
  try {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
    if(match && (Number(match[2])>23||Number(match[3])>59||Number(match[4]||0)>59)) return null;
    const at = match ? zonedInstant(match[1], Number(match[2]), timezone)+(Number(match[3])*60+Number(match[4]||0))*1000 : /^\d{4}-\d{2}-\d{2}$/.test(value)?zonedInstant(value,0,timezone):Date.parse(value);
    if(match && localParts(at,timezone).date!==match[1]) return null;
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  } catch {return null;}
}
export function contextConsistent(context: PredictionContext): boolean {
  if([context.prior_calls,context.recent_attempts,context.attempts_today].some(n=>!Number.isInteger(n)||n<0)) return false;
  if(context.recent_attempts>context.prior_calls || context.attempts_today>context.prior_calls) return false;
  if(context.last_call_at && (!context.prior_calls || !Number.isFinite(Date.parse(context.last_call_at)) || Date.parse(context.last_call_at)>Date.parse(context.as_of))) return false;
  return true;
}
export function eligibleRoute(context: PredictionContext, minimumHistory: number): PredictionRoute {
  if (context.history_status !== "verified" || !contextConsistent(context) || (context.prior_calls===0 && context.first_contact_verified!==true)) return "fallback";
  return context.prior_calls === 0 ? "cold_start" : context.prior_calls >= minimumHistory ? "history_aware" : "sparse_history";
}
/** Local hours [start, end) within which answered-before hours may extend the configured calling hours. */
export const ANSWERED_HOURS_LIMIT = [8, 21] as const;
/** Minimum minutes a window may start before it is too late to be useful (part-elapsed windows stay usable). */
export const MIN_USABLE_WINDOW_MINUTES = 20;
/**
 * Minimum wait before the next attempt. It no longer backs off by a fixed schedule: retry data
 * (lib/retry-ladder.ts) shows short intervals stay the most productive even after several misses,
 * so the ladder chooses the interval. This floor only honours what the client said on the last
 * analysed call and the configured minimum gap (settings.cooldownMinutes).
 */
export function dynamicGap(context: PredictionContext, settings: SchedulingSettings): { minutes: number; reason: string } {
  let minutes = 0, reason = "";
  const latest = context.conversation?.latest, recent = latest?.at && Date.parse(context.as_of) - Date.parse(latest.at) < 2 * 86_400_000;
  if (context.conversation?.recent_negative) { minutes = 1440; reason = "the last conversation was negative, so give them a day"; }
  else if (recent && latest!.sentiment === "busy_callback" && !context.conversation?.callback) { minutes = 120; reason = "they said they were busy on the last call"; }
  else if (recent && latest!.sentiment === "gatekeeper" && !context.conversation?.callback) { minutes = 120; reason = "the decision maker was unavailable on the last call"; }
  if (minutes < settings.cooldownMinutes) { minutes = settings.cooldownMinutes; reason = "configured minimum gap"; }
  return { minutes, reason };
}

export function candidateWindows(context: PredictionContext, settings: SchedulingSettings): CallWindow[] {
  if (!settings.enabled || context.do_not_call || context.history_status !== "verified" || !contextConsistent(context) || (!context.scheduling_calls && context.recent_attempts >= settings.maxAttemptsPerSequence)) return [];
  const now = Date.parse(context.as_of);
  if (!Number.isFinite(now)) throw new Error("Invalid prediction timestamp.");
  const today = localParts(now, context.timezone).date;
  const last = context.last_call_at ? Date.parse(context.last_call_at) : -Infinity;
  const earliest = Math.max(now+60000, last+dynamicGap(context,settings).minutes*60000, context.not_before?Date.parse(context.not_before):-Infinity);
  const hours = new Set(Array.from({length:settings.businessEndHour-settings.businessStartHour},(_,i)=>settings.businessStartHour+i));
  // Hours the seller answered before are added outside configured hours, but never before 8 AM or after 9 PM.
  for(const slot of context.seller_history?.slots||[]) if(slot.answered_calls>0&&slot.hour>=ANSWERED_HOURS_LIMIT[0]&&slot.hour<ANSWERED_HOURS_LIMIT[1]) hours.add(slot.hour);
  const sortedHours=[...hours].sort((a,b)=>a-b),dateAt=(offset:number)=>new Date(Date.parse(`${today}T00:00:00Z`)+offset*86400000).toISOString().slice(0,10);
  // Hard limits that apply to every window, including ones the client asked for.
  const allowed=(start:number,end:number,date:string,offset:number)=>{
    if(context.blocked_dates?.includes(date)||(offset===0&&context.attempts_today>=settings.maxAttemptsPerDay)||context.appointments.some(a=>start<Date.parse(a.end)&&end>Date.parse(a.start)))return false;
    if(context.scheduling_calls) {
      const lastAnswer=context.scheduling_calls.filter(c=>c.answered&&Date.parse(c.at)<start).at(-1);
      const since=Math.max(start-settings.sequenceDays*86400000,lastAnswer?Date.parse(lastAnswer.at)+1:-Infinity);
      if(context.scheduling_calls.filter(c=>Date.parse(c.at)>=since&&Date.parse(c.at)<start).length>=settings.maxAttemptsPerSequence)return false;
    }
    return true;
  };
  const window=(start:number,end:number,hour:number,requested=false):CallWindow=>({ id: new Date(start).toISOString(), start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone: context.timezone, score: null, score_target: null, support: 0, uncertainty: null, outside_configured_hours: hour<settings.businessStartHour||hour>=settings.businessEndHour, ...(requested?{requested_by_client:true}:{}) });
  const requested=requestedWindows(context,settings,{now,last,today,sortedHours,dateAt,allowed,window});
  const windows: CallWindow[] = [];
  for (let offset=0;offset<settings.horizonDays;offset++) {
    const date = dateAt(offset);
    const day = (new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7;
    if (!settings.businessDays.includes(day)) continue;
    for(const hour of sortedHours) {
      const hourStart = zonedInstant(date,hour,context.timezone), end = zonedInstant(date,hour+1,context.timezone);
      // A window already under way stays usable from the earliest allowed moment if enough of it remains.
      const start = Math.max(hourStart, Math.ceil(earliest/60000)*60000);
      if (end-start < MIN_USABLE_WINDOW_MINUTES*60000 || end<=hourStart || !allowed(start,end,date,offset)) continue;
      // Skip nonexistent local times around DST transitions, and hours a requested callback already covers.
      const p=localParts(hourStart,context.timezone); if(p.date!==date || p.hour!==hour) continue;
      if(requested.some(r=>start<Date.parse(r.end)&&end>Date.parse(r.start))) continue;
      windows.push(window(start,end,hour));
    }
  }
  return [...requested,...windows].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
}

type WindowTools={now:number;last:number;today:string;sortedHours:number[];dateAt:(offset:number)=>string;allowed:(start:number,end:number,date:string,offset:number)=>boolean;window:(start:number,end:number,hour:number,requested?:boolean)=>CallWindow};

/**
 * Windows for a callback the client asked for (from an analysed call). The client's own request
 * outranks configured calling hours and days and the dynamic wait, but never do-not-call,
 * appointments, attempt caps or the minimum gap floor. Only the part inside the planning horizon
 * is used; a request beyond it leaves the model to choose within the horizon.
 */
function requestedWindows(context:PredictionContext,settings:SchedulingSettings,{now,last,today,sortedHours,dateAt,allowed,window}:WindowTools):CallWindow[] {
  const cb=context.conversation?.callback;
  if(!cb)return [];
  const tz=context.timezone,horizonEnd=zonedInstant(dateAt(settings.horizonDays),0,tz);
  const floor=Math.ceil(Math.max(now+60000,last+settings.cooldownMinutes*60000)/60000)*60000;
  const from=Math.max(Date.parse(cb.at),floor),to=Math.min(cb.end?Date.parse(cb.end):Date.parse(cb.at)+3600000,horizonEnd);
  const offsetOf=(date:string)=>Math.round((Date.parse(`${date}T00:00:00Z`)-Date.parse(`${today}T00:00:00Z`))/86400000);
  const out:CallWindow[]=[];
  if(cb.precision==="day"||cb.precision==="on_or_after") {
    // A day without a time: the usual calling hours of that day, so the model picks the hour.
    // "After N days" moves to the first configured calling day; a named day is used as asked.
    for(let offset=0;offset<settings.horizonDays;offset++) {
      const date=dateAt(offset),day=(new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7;
      if(cb.precision==="on_or_after"&&!settings.businessDays.includes(day))continue;
      for(const hour of sortedHours) {
        const hourStart=zonedInstant(date,hour,tz),end=zonedInstant(date,hour+1,tz),start=Math.max(hourStart,from);
        if(hourStart<Date.parse(cb.at)||hourStart>=to||end-start<MIN_USABLE_WINDOW_MINUTES*60000)continue;
        if(allowed(start,end,date,offset))out.push(window(start,end,hour,true));
      }
      if(cb.precision==="on_or_after"&&out.length)break;
    }
    return out;
  }
  // A time or a part of the day: one-hour windows from the requested start until the range ends.
  for(let start=from;start<to;start+=3600000) {
    const end=Math.min(start+3600000,to),date=localParts(start,tz).date;
    if(end-start<MIN_USABLE_WINDOW_MINUTES*60000)continue;
    if(allowed(start,end,date,offsetOf(date)))out.push(window(start,end,localParts(start,tz).hour,true));
  }
  return out;
}
