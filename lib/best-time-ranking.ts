import type { CallWindow, DayPreference, PredictionContext, RankingStrategy, SchedulingSettings, SellerSlot, WindowRanking } from "./best-time-types";
import { eligibleRoute, localParts } from "./best-time-policy";
import { chooseModel, scoreWindows, type ModelRegistry } from "./best-time-models";
import { scoreExperimentalClock } from "./best-time-experiments";

export function dayPreference(context:PredictionContext,settings:SchedulingSettings):DayPreference {
  const explicit=[...new Set((context.preferred_weekdays||[]).filter(d=>Number.isInteger(d)&&settings.businessDays.includes(d)))];
  if(explicit.length)return {basis:"explicit",weekdays:explicit,reason:"Known preferred weekdays are prioritized; other allowed days remain fallback alternatives."};
  const days=(context.seller_history?.days||[]).filter(d=>settings.businessDays.includes(d.weekday));
  const meetingSupport=days.reduce((n,d)=>n+d.converted_calls,0),answerSupport=days.reduce((n,d)=>n+d.answered_calls,0);
  const basis=meetingSupport>=2?"meeting_history":answerSupport>=3&&days.some(d=>d.answered_calls>=2)?"answer_history":"none";
  if(basis==="none")return {basis,weekdays:[],reason:"Weekday history is inconclusive; no preferred day is assumed."};
  const score=(d:typeof days[number])=>(basis==="meeting_history"?d.linked_meetings:d.answered_calls)*(1-(d.known_answered_durations?0.75*d.short_calls/d.known_answered_durations:0));
  const best=Math.max(...days.map(score));
  return {basis,weekdays:days.filter(d=>score(d)===best).map(d=>d.weekday),reason:`Weekdays with the most ${basis==="meeting_history"?"linked ERP meetings":"answered calls"} are prioritized after short-call discounts; this is observed history, not a declared availability preference.`};
}

export function rankEligibleWindows(context:PredictionContext,eligible:CallWindow[],settings:SchedulingSettings,registry:ModelRegistry) {
  const history=context.seller_history,slots=new Map((history?.slots||[]).map(s=>[s.hour,s])),weekdaySlots=new Map((history?.weekday_slots||[]).map(s=>[`${s.weekday}:${s.hour}`,s])),preference=dayPreference(context,settings);
  const supportedDays=new Set((history?.days||[]).filter(d=>d.converted_calls>=2||d.answered_calls>=3).map(d=>d.weekday));
  const evidenceSlot=(w:CallWindow)=>{const p=localParts(w.start,context.timezone);return supportedDays.has(p.weekday)?weekdaySlots.get(`${p.weekday}:${p.hour}`):slots.get(p.hour);};
  const meetings=(history?.slots||[]).reduce((n,s)=>n+s.converted_calls,0)>=2;
  const answers=(history?.answered_calls||0)>=3&&(history?.slots||[]).some(s=>s.answered_calls>=2);
  let strategy:RankingStrategy=meetings?"seller_meetings":answers?"seller_answers":"operating_hours";
  let windows=eligible,modelVersion="operating-assumptions-v2",training=0,modelIssue:string|null=null;
  const desired=eligibleRoute(context,settings.minimumHistory),canonical=chooseModel(desired,registry);
  if((meetings||answers)&&eligible.some(w=>{const s=evidenceSlot(w);return s&&(s.answered_calls>0||s.linked_meetings>0);})){ 
    windows=eligible.filter(w=>{const s=evidenceSlot(w);return w.requested_by_client||s&&(s.answered_calls>0||s.linked_meetings>0);});
    modelVersion="seller-weekday-slot-evidence-v3";
  }else {
    strategy="operating_hours";
    if(canonical) {
      try{const scored=scoreWindows(context,eligible,canonical);if(scored.some(w=>w.score!==null)){windows=scored.filter(w=>w.score!==null||w.requested_by_client);strategy="canonical_model";modelVersion=canonical.model_version;training=canonical.evidence.training_attempts;}}catch(e){modelIssue=e instanceof Error?e.message:"Canonical scoring failed.";}
    }
    if(strategy==="operating_hours"&&registry.generalized&&eligible.length) {
      try {
        const model=registry.generalized,scored=new Map(scoreExperimentalClock(model,eligible,eligible.length,true).map(w=>[w.start,w]));
        if(scored.size) {
          windows=eligible.filter(w=>scored.has(w.start)||w.requested_by_client).map(w=>!scored.has(w.start)?w:({...w,support:scored.get(w.start)!.support,ranking:{source:"generalized_model",priority_score:scored.get(w.start)!.proxy_score,calls:0,answered_calls:0,linked_meetings:0,short_calls:0,short_call_penalty:0,time_basis:"model",proxy_estimate:scored.get(w.start)!.proxy_score,reason:model.smoothing.bins[`${localParts(w.start,w.timezone).weekday}:${localParts(w.start,w.timezone).hour}`]?.count>=5?"General model trained on outbound calls; this score concerns the ERP meeting proxy.":"Weekday support is sparse; the general model backs off to pooled training evidence for this hour. Calibration for this backoff is unverified."} as WindowRanking}));
          strategy="generalized_model";modelVersion=model.model_version;training=model.evidence.training_attempts;
        }
      }catch(e){modelIssue=e instanceof Error?e.message:"Generalized scoring failed.";}
    }
  }
  const describe=(s:SellerSlot|undefined):WindowRanking=>{
    const penalty=s&&s.known_answered_durations?0.75*s.short_calls/s.known_answered_durations:0;
    const answered=(s?.answered_calls||0)*(1-penalty),meeting=(s?.linked_meetings||0)*(1-penalty);
    const timed=(s?.actual_time_calls||0)+(s?.recorded_time_calls||0);
    return {actual_time_share:timed?(s!.actual_time_calls/timed):0,source:strategy,priority_score:strategy==="seller_meetings"?meeting*1e6+answered*1e3:strategy==="seller_answers"?answered*1e3:0,calls:s?.calls||0,answered_calls:s?.answered_calls||0,linked_meetings:s?.linked_meetings||0,short_calls:s?.short_calls||0,short_call_penalty:penalty,time_basis:s?.actual_time_calls&&s.recorded_time_calls?"mixed":s?.actual_time_calls?"actual_start":s?.recorded_time_calls?"recorded_time_proxy":"configured",proxy_estimate:null,reason:strategy==="seller_meetings"?"Linked successful ERP meetings first, then answered calls; known answered durations under 20 seconds reduce priority.":strategy==="seller_answers"?"Answered-call count, discounted for known conversations under 20 seconds; meeting evidence is inconclusive.":"Configured hours provide a final fallback while conclusive evidence is unavailable."};
  };
  windows=windows.map(w=>w.ranking?w:{...w,support:strategy.startsWith("seller_")?(evidenceSlot(w)?.calls||0):w.support,ranking:strategy==="canonical_model"?{...describe(undefined),source:"canonical_model",priority_score:w.score||0,time_basis:"model",reason:"Approved canonical model estimate."}:describe(evidenceSlot(w))});
  windows=windows.map(w=>({...w,ranking:{...w.ranking!,preferred_day:preference.weekdays.includes(localParts(w.start,w.timezone).weekday),evidence_scope:strategy==="seller_meetings"||strategy==="seller_answers"?(supportedDays.has(localParts(w.start,w.timezone).weekday)?"weekday_hour":"pooled_hour"):strategy==="operating_hours"?"configured":"model"}}));
  // Analysed-call signals (Sarvam AI): a callback the client asked for leads the ranking whatever the
  // model prefers (the model only picks the hour inside a requested day or part of the day, earliest
  // day first), and the average client sentiment at an hour scales this seller's history evidence.
  const conversation=context.conversation;
  windows=windows.map(w=>{
    const hour=localParts(w.start,w.timezone).hour,scoreAt=conversation?.hour_scores[String(hour)];
    const factor=scoreAt&&strategy.startsWith("seller_")?Math.max(0.7,Math.min(1.3,1+0.3*scoreAt.average)):1;
    const ranking=w.requested_by_client&&w.ranking!.priority_score===0&&!w.ranking!.calls?{...w.ranking!,reason:"The client asked to be called back at this time."}:w.ranking!;
    return {...w,ranking:{...ranking,priority_score:ranking.priority_score*factor,sentiment_factor:factor,callback_request:!!w.requested_by_client}};
  });
  const requestedDay=(w:CallWindow)=>w.ranking!.callback_request?Date.parse(localParts(w.start,w.timezone).date):0;
  windows.sort((a,b)=>Number(!!b.ranking!.callback_request)-Number(!!a.ranking!.callback_request)||requestedDay(a)-requestedDay(b)||Number(b.ranking!.preferred_day)-Number(a.ranking!.preferred_day)||(b.ranking!.priority_score-a.ranking!.priority_score)||(b.ranking!.answered_calls-a.ranking!.answered_calls)||Date.parse(a.start)-Date.parse(b.start));
  const counts=new Map<string,number>();
  const ranked=windows.filter(w=>{const date=localParts(w.start,w.timezone).date,count=counts.get(date)||0;if(count>=settings.maxSlotsPerDay)return false;counts.set(date,count+1);return true;}).slice(0,settings.maxSlotsPerDay);
  const daily=[...new Set(ranked.map(w=>localParts(w.start,w.timezone).date))].sort().map(date=>({date,timezone:context.timezone,windows:ranked.filter(w=>localParts(w.start,w.timezone).date===date)}));
  return {strategy,ranked,daily,desired,modelVersion,training,modelIssue,preference};
}
