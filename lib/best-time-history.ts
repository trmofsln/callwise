import type { Interaction, UserProfile } from "./user-types";
import type { SellerHistory, SellerSlot } from "./best-time-types";
import { eventInstant, localParts } from "./best-time-policy";

export type HistoricalCall = { key: string; at: string; actual: boolean; answered: boolean; unanswered: boolean; duration: number | null; click: boolean };
function outcome(call: Interaction) {
  const status=String(call.status||"").toLowerCase().replace(/[^a-z]/g,"");
  if(status==="answered")return {answered:true,unanswered:false};
  if(status==="notanswered")return {answered:false,unanswered:true};
  // ERP DSR result: 2=Talked, 3=Talked and appointment, 1/4=Not talked.
  const result=String(call.record.sts_dsr_call_result??"");
  return {answered:["2","3"].includes(result),unanswered:["1","4"].includes(result)};
}
export function sellerHistory(user: UserProfile | undefined, asOf: string, timezone: string): { history: SellerHistory; calls: HistoricalCall[] } {
  const now=Date.parse(asOf),unique=new Map<string,HistoricalCall>(),dsr=new Map<string,string>();
  for(const call of user?.activity.calls||[]) {
    if(call.source==="sts_dsr_call")dsr.set(call.id,call.callKey);
    // Incoming calls do not establish an outbound calling window.
    if(call.source==="click_to_call" && String(call.record.flag_in_out||call.mode||"").toLowerCase()==="incoming")continue;
    const start=eventInstant(call.startedAt,timezone),recorded=eventInstant(call.recordedAt,timezone);
    const actual=!!start && Date.parse(start)<now;
    const at=actual?start:!start&&recorded&&Date.parse(recorded)<now?recorded:null;
    if(!at)continue;
    const rawDuration=call.durationSeconds??call.record.call_duration;
    const duration=rawDuration===null||rawDuration===undefined||rawDuration===""?null:Number(rawDuration);
    const current:HistoricalCall={key:call.callKey,at,actual,click:call.source==="click_to_call",...outcome(call),duration:duration!==null&&Number.isFinite(duration)&&duration>=0?duration:null};
    const previous=unique.get(call.callKey);
    if(!previous || (current.actual&&!previous.actual) || (current.actual===previous.actual&&current.click&&!previous.click))unique.set(call.callKey,current);
  }
  const slots=new Map<number,SellerSlot>(),weekdaySlots=new Map<string,SellerSlot&{weekday:number}>(),converted=new Map<string,Set<string>>();
  const slot=(hour:number)=>{let s=slots.get(hour);if(!s){s={hour,calls:0,answered_calls:0,short_calls:0,known_answered_durations:0,linked_meetings:0,converted_calls:0,actual_time_calls:0,recorded_time_calls:0,actual_answered_calls:0};slots.set(hour,s);}return s;};
  const weekdaySlot=(weekday:number,hour:number)=>{const key=`${weekday}:${hour}`;let s=weekdaySlots.get(key);if(!s){s={...slot(hour),calls:0,answered_calls:0,short_calls:0,known_answered_durations:0,linked_meetings:0,converted_calls:0,actual_time_calls:0,recorded_time_calls:0,actual_answered_calls:0,weekday};weekdaySlots.set(key,s);}return s;};
  const calls=[...unique.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  for(const call of calls) {
    const p=localParts(call.at,timezone);
    for(const s of [slot(p.hour),weekdaySlot(p.weekday,p.hour)]) {s.calls++;
    if(call.actual)s.actual_time_calls++;else s.recorded_time_calls++;
    if(call.answered){s.answered_calls++;if(call.actual)s.actual_answered_calls++;if(call.duration!==null){s.known_answered_durations++;if(call.duration<20)s.short_calls++;}}
    }
  }
  const meetings=new Set<string>();let unlinked=0;
  for(const meeting of user?.activity.meetings||[]) {
    if(!meeting.successful || meetings.has(meeting.id))continue;
    const recorded=eventInstant(meeting.recordedAt||meeting.at,timezone);
    if(!recorded || Date.parse(recorded)>=now)continue;
    meetings.add(meeting.id);
    const forward=String(meeting.record.fk_sts_dsr_call_id??"");
    let key=dsr.get(forward);
    if(!key && (!forward||forward==="0")) {
      const reverse=(user?.activity.calls||[]).find(c=>c.source==="sts_dsr_call"&&String(c.record.fk_sts_dsr_meeting_id??"")===meeting.id);
      if(reverse)key=reverse.callKey;
    }
    const call=key?unique.get(key):undefined;
    if(!call || (call.actual&&Date.parse(recorded)<Date.parse(call.at))){unlinked++;continue;}
    const p=localParts(call.at,timezone);
    for(const [key,s] of [[`hour:${p.hour}`,slot(p.hour)],[`day:${p.weekday}:${p.hour}`,weekdaySlot(p.weekday,p.hour)]] as const) {
      s.linked_meetings++;const keys=converted.get(key)||new Set<string>();keys.add(call.key);converted.set(key,keys);s.converted_calls=keys.size;
    }
  }
  const values=[...slots.values()].sort((a,b)=>a.hour-b.hour);
  const weekdayValues=[...weekdaySlots.values()].sort((a,b)=>a.weekday-b.weekday||a.hour-b.hour);
  const days=[...new Set(weekdayValues.map(s=>s.weekday))].map(weekday=>{
    const totals={weekday,calls:0,answered_calls:0,short_calls:0,known_answered_durations:0,linked_meetings:0,converted_calls:0,actual_time_calls:0,recorded_time_calls:0,actual_answered_calls:0};
    for(const s of weekdayValues.filter(s=>s.weekday===weekday))for(const key of ["calls","answered_calls","short_calls","known_answered_durations","linked_meetings","converted_calls","actual_time_calls","recorded_time_calls","actual_answered_calls"] as const)totals[key]+=s[key];
    return totals;
  });
  return {calls,history:{slots:values,weekday_slots:weekdayValues,days,timed_calls:calls.length,actual_time_calls:calls.filter(c=>c.actual).length,recorded_time_calls:calls.filter(c=>!c.actual).length,answered_calls:values.reduce((n,s)=>n+s.answered_calls,0),linked_meetings:values.reduce((n,s)=>n+s.linked_meetings,0),unlinked_meetings:unlinked,short_calls:values.reduce((n,s)=>n+s.short_calls,0)}};
}
