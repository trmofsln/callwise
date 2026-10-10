import { randomUUID } from "node:crypto";
import type { UserProfile } from "./user-types";
import type { PredictionContext, SchedulingSettings } from "./best-time-types";
import { dynamicGap, eventInstant, localParts } from "./best-time-policy";
import { sellerHistory } from "./best-time-history";
import { conversationSignals } from "./recordings";
import { sellerFactors } from "./seller-factors";
import type { GlobalContextResult } from "./global-context-catalog";

export function predictionContext(glid: string, user: UserProfile | undefined, asOf: string, settings: SchedulingSettings, global?: GlobalContextResult): PredictionContext {
  const now=Date.parse(asOf),{history,calls}=sellerHistory(user,asOf,settings.timezone);
  const issues=["Meeting history uses the ERP success proxy; canonical meeting_done labels are unavailable.","Timezone is configured; database timestamps have no timezone."];
  if(history.recorded_time_calls)issues.push(`${history.recorded_time_calls} calls use DSR entry times as approximate historical slots; actual call starts are unavailable.`);
  if(history.unlinked_meetings)issues.push(`${history.unlinked_meetings} successful meetings lack a usable call link and do not influence time-slot attribution.`);
  const count=user?.activity.metrics.callCount||0;
  if(count>calls.length)issues.push("Incoming, untimed, or future records are excluded from outbound slot attribution.");
  const last=calls.at(-1),lastActual=calls.filter(c=>c.actual).at(-1),lastAnswer=calls.filter(c=>c.answered).at(-1);
  const since=Math.max(now-settings.sequenceDays*86400000,lastAnswer?Date.parse(lastAnswer.at)+1:-Infinity);
  const today=localParts(now,settings.timezone).date;
  const appointments:PredictionContext["appointments"]=[],blockedDates=new Set<string>();
  for(const call of user?.activity.calls||[]) {
    if(String(call.record.sts_dsr_app_status)!=="0")continue;
    const date=String(call.record.sts_dsr_app_date||"").slice(0,10),time=String(call.record.sts_dsr_app_time||"");
    // A default time without a date is not an appointment.
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<today)continue;
    const start=/^\d{2}:\d{2}(:\d{2})?$/.test(time)?eventInstant(`${date}T${time}`,settings.timezone):null;
    if(!start){blockedDates.add(date);issues.push(`Appointment time is unknown on ${date}; that date is excluded.`);continue;}
    if(Date.parse(start)+3600000>now)appointments.push({start,end:new Date(Date.parse(start)+3600000).toISOString()});
  }
  const policy=user?.callPolicy,dnc=eventInstant(policy?.doNotCallMarkedAt,settings.timezone),doNotCall=!!dnc&&Date.parse(dnc)<=now;
  if(!policy)issues.push("Contact restrictions could not be verified; recommendations are withheld.");
  if(doNotCall)issues.push("A known do-not-call marker blocks calling recommendations.");
  const context:PredictionContext={context_id:randomUUID(),glid,as_of:asOf,timezone:settings.timezone,
    history_status:user?.historyFetched===true&&!!policy?"verified":"missing",
    history_scope:"Fetched source-13 outbound/DSR history; DSR entry clocks are approximate and lifetime coverage remains unverified.",first_contact_verified:false,
    prior_calls:Math.max(count,calls.length),recent_attempts:calls.filter(c=>Date.parse(c.at)>=since).length,
    attempts_today:calls.filter(c=>localParts(c.at,settings.timezone).date===today).length,
    last_call_at:lastActual?.at||null,last_unanswered_at:last?.unanswered?last.at:null,
    not_before:null,
    scheduling_calls:calls.map(c=>({at:c.at,answered:c.answered})),seller_history:history,blocked_dates:[...blockedDates],
    do_not_call:doNotCall,appointments,metadata:user?.createdAt&&eventInstant(user.createdAt,settings.timezone)?{account_created_at:eventInstant(user.createdAt,settings.timezone)!}:{},
    issues:[...new Set(issues)],proxy_completed_meetings:user?.activity.metrics.successfulMeetingCount||0,
    conversation:conversationSignals(user?.recordingAnalyses,asOf,settings.timezone)};
  context.seller_factors=sellerFactors(user,global,asOf,context.conversation);
  // A client who asked, on their latest call, never to be called again is treated like a do-not-call mark.
  if(context.conversation?.asked_not_to_call&&!context.do_not_call){context.do_not_call=true;context.issues.push("On the latest analysed call the client asked not to be called again; calling is paused.");}
  // The gap after the latest contact of any kind (including DSR-only entries and pasted call
  // transcripts) is dynamic, not a fixed cooldown.
  const talked=context.conversation?.latest?.at?Date.parse(context.conversation.latest.at):NaN;
  const contact=Math.max(last?Date.parse(last.at):-Infinity,Number.isFinite(talked)&&talked<=now?talked:-Infinity);
  if(Number.isFinite(contact))context.not_before=new Date(contact+dynamicGap(context,settings).minutes*60000).toISOString();
  return context;
}
