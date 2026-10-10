import type { UserProfile } from "./user-types";
import type { GlobalContextResult } from "./global-context-catalog";
import type { CallWindow, Prediction, PredictionContext, SchedulingSettings, ScoringModel } from "./best-time-types";
import { getAdminStore } from "./sqlite";
import { candidateWindows, contextConsistent, dynamicGap, localParts, zonedInstant } from "./best-time-policy";
import { predictionContext } from "./best-time-context";
import { chooseModel, loadRegistry, type ModelRegistry } from "./best-time-models";
import { rankEligibleWindows } from "./best-time-ranking";
import { retryPlan } from "./best-time-retry";
import { reviewPrediction } from "./best-time-llm";

// Evidence-graded confidence on a four-step scale: insufficient < moderate < high < very_high.
// "high" and "very_high" are reserved for recommendations backed by this seller's own meeting history in
// the recommended slot. Model-ranked and answer-history plans are "moderate": the research-v4 evaluation
// found no within-seller timing gain for them (docs/best-time-to-call/research-v4).
export const CONFIDENCE_TIERS = {
  high: { minLinkedMeetings: 2, minAnsweredCalls: 5, minActualTimeShare: 0.5 },
  veryHigh: { minLinkedMeetings: 4, minMeetingsWithAnswers: 2, minAnsweredCalls: 10, minActualTimeShare: 0.8 },
} as const;
export function confidenceFor(strategy: Prediction["ranking_strategy"], recommended: CallWindow | null): Prediction["confidence"] {
  const r = recommended?.ranking;
  if (strategy === "canonical_model") return { level: "moderate", calibrated: true, reason: "Calibration was checked on held-out data; individual uncertainty remains unavailable." };
  if (strategy === "generalized_model") return { level: "moderate", calibrated: false, reason: "Ranked by the general model because this seller's own history is thin. The model ranks hours across all sellers and has not been shown to pick a better hour for an individual seller." };
  if (strategy === "seller_meetings" && r) {
    const meetings = r.linked_meetings, answered = r.answered_calls, share = r.actual_time_share ?? 0, h = CONFIDENCE_TIERS.high, v = CONFIDENCE_TIERS.veryHigh;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const evidence = `the recommended slot has ${plural(meetings, "linked meeting")} and ${plural(answered, "answered call")}, ${Math.round(share * 100)}% timed by actual dial starts`;
    const veryHigh = (meetings >= v.minLinkedMeetings || (meetings >= v.minMeetingsWithAnswers && answered >= v.minAnsweredCalls)) && share >= v.minActualTimeShare;
    if (veryHigh) return { level: "very_high", calibrated: false, reason: `Based on this seller's own meeting history: ${evidence}. This is a ranking, not a probability.` };
    if ((meetings >= h.minLinkedMeetings || answered >= h.minAnsweredCalls) && share >= h.minActualTimeShare)
      return { level: "high", calibrated: false, reason: `Based on this seller's own meeting history: ${evidence}. Very high needs ${v.minLinkedMeetings} linked meetings (or ${v.minMeetingsWithAnswers} meetings with ${v.minAnsweredCalls} answered calls) in the slot, at least ${v.minActualTimeShare * 100}% timed by actual dial starts.` };
    return { level: "moderate", calibrated: false, reason: `Based on this seller's meeting history, but ${evidence}${share >= h.minActualTimeShare ? "" : ", so it relies mostly on approximate DSR entry times"}. High needs at least ${h.minLinkedMeetings} linked meetings or ${h.minAnsweredCalls} answered calls in the slot, mostly at actual dial times.` };
  }
  if (strategy === "seller_answers") return { level: "moderate", calibrated: false, reason: "Ranked by when this seller has answered before. Answered hours are not the same as hours that lead to meetings, so confidence rises above moderate only once meeting history exists." };
  return { level: "insufficient", calibrated: false, reason: "No conclusive history or supported model is available." };
}

const SENTIMENT_WORDS={enthusiastic:"enthusiastic",interested:"interested",curious:"curious",neutral:"neutral",busy_callback:"busy",gatekeeper:"not with the decision maker",do_not_call:"asked not to be called",hesitant:"hesitant",frustrated:"frustrated",not_interested:"not interested",no_conversation:"no conversation"} as const;
function moodPhrase(conv:PredictionContext["conversation"]):string{
  if(!conv?.analyzed)return "";
  const top=Object.entries(conv.counts).filter(([k])=>k!=="no_conversation").sort((a,b)=>b[1]-a[1])[0];
  if(!top)return "";
  const word=SENTIMENT_WORDS[top[0] as keyof typeof SENTIMENT_WORDS];
  const kind=conv.manual?"call":"recorded call";
  return conv.analyzed===1?`the last ${kind} sounded ${word}`:`recent ${kind}s sounded mostly ${word}`;
}
type CallbackUse="used"|"beyond_horizon"|"blocked"|null;
/** Whether the client's requested callback drives this plan, falls beyond the planning horizon, or is blocked by calling rules. */
export function callbackUse(context:PredictionContext,settings:SchedulingSettings,recommended:CallWindow|null):CallbackUse{
  const cb=context.conversation?.callback;
  if(!cb)return null;
  if(recommended?.ranking?.callback_request)return "used";
  const today=localParts(context.as_of,context.timezone).date;
  const horizonEnd=zonedInstant(new Date(Date.parse(`${today}T00:00:00Z`)+settings.horizonDays*86400000).toISOString().slice(0,10),0,context.timezone);
  return Date.parse(cb.at)>=horizonEnd?"beyond_horizon":"blocked";
}
function callbackSentence(context:PredictionContext,settings:SchedulingSettings,use:CallbackUse):string{
  const cb=context.conversation?.callback;
  if(!cb||!use)return "";
  const asked=`On the last call the client asked to be called back ${cb.label??"later"}${cb.text?` ("${cb.text}")`:""}`;
  if(use==="used")return `${asked}, so this plan calls at that time.`;
  if(use==="beyond_horizon")return `${asked}, which is beyond the ${plural(settings.horizonDays,"day")} being planned, so this is the best time within that period.`;
  return `${asked}, but calling rules block that time, so this is the next best time.`;
}
const WEEKDAY_PLURALS=["Mondays","Tuesdays","Wednesdays","Thursdays","Fridays","Saturdays","Sundays"];
const plural=(n:number,word:string)=>`${n} ${word}${n===1?"":"s"}`;
const listWords=(items:string[])=>items.length<=1?items.join(""):`${items.slice(0,-1).join(", ")} and ${items.at(-1)}`;

/** Plain-language, positive 2–3 sentence summary of the seller's call behaviour, built only from fetched history. */
export function explainPrediction({context,settings,strategy,recommended,preference,stop}:{context:PredictionContext;settings:SchedulingSettings;strategy:Prediction["ranking_strategy"];recommended:CallWindow|null;preference:number[];stop:boolean}):string {
  const history=context.seller_history;
  const total=history?.timed_calls||context.prior_calls||0;
  const answered=history?.answered_calls||0;
  const converted=(history?.slots||[]).reduce((n,s)=>n+s.converted_calls,0);
  const pct=(n:number)=>total?Math.round(100*n/total):0;
  const tz=context.timezone;
  const time=(iso:string)=>new Intl.DateTimeFormat("en-IN",{timeZone:tz,hour:"numeric",minute:"2-digit",hour12:true}).format(new Date(iso)).toUpperCase();
  const day=(iso:string)=>new Intl.DateTimeFormat("en-IN",{timeZone:tz,weekday:"short",day:"numeric",month:"short"}).format(new Date(iso));
  const slot=recommended?`${day(recommended.start)}, ${time(recommended.start)} to ${time(recommended.end)}`:null;
  const days=preference.length&&preference.length<7?` on ${listWords(preference.map(d=>WEEKDAY_PLURALS[d]))}`:"";
  const numbers=!total?"":!history?`There ${total===1?"is":"are"} ${plural(total,"call")} on record with this seller.`:total?`They answered ${answered} of ${plural(total,"call")} (${pct(answered)}%), and ${converted?`${plural(converted,"call")} turned into meetings (${pct(converted)}% meeting conversion)`:"no call has turned into a meeting yet, so there is room to set one up"}.`:"";
  const conv=context.conversation,mood=moodPhrase(conv);
  const told=numbers&&mood?numbers.replace(/\.$/,`, and ${mood}.`):numbers||(mood?`${mood.charAt(0).toUpperCase()}${mood.slice(1)}.`:"");
  if(stop)return `Calling is paused for this seller for now because of a do-not-call mark or the attempt limit.${numbers?` ${numbers}`:""} We will suggest a time again as soon as calling is allowed.`;
  if(context.history_status!=="verified"||!recommended)return `We could not load enough of this seller's call history to pick a time just yet.${numbers?` ${numbers}`:""} Refresh in a moment and a calling time will appear here.`;
  const use=callbackUse(context,settings,recommended),asked=callbackSentence(context,settings,use);
  if(use==="used")return `${asked}${told?` ${told}`:""} Best time to call: ${slot}.`;
  const note=asked?` ${asked}`:"";
  if(strategy==="seller_meetings")return `This seller responds well and books meetings around ${time(recommended.start)}${days}. ${told}${note} Best time to call: ${slot}.`;
  if(strategy==="seller_answers")return `This seller is most responsive around ${time(recommended.start)}${days}. ${told}${note} Best time to call: ${slot}.`;
  if(strategy==="generalized_model"||strategy==="canonical_model")return `${total?`This seller is still building a calling pattern with us. ${told}`:`This is a fresh seller with no calls on record yet, so it is a clean start.${told?` ${told}`:""}`}${note} Based on past calls with similar sellers, the strongest slot is ${slot}.`;
  return `${total?`This seller does not have a clear calling pattern yet. ${told}`:`There is no call history with this seller yet, so it is a fresh start.${told?` ${told}`:""}`}${note} The first open slot within calling hours (${settings.businessStartHour}:00 to ${settings.businessEndHour}:00) is ${slot}.`;
}

const WEEKDAY_NAMES=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
function clock(iso:string,tz:string,short=false){
  const parts=new Intl.DateTimeFormat("en-IN",{timeZone:tz,hour:"numeric",minute:"2-digit",hour12:true}).format(new Date(iso)).toUpperCase();
  return short?parts.replace(":00",""):parts;
}
function dayLabel(iso:string,tz:string){return new Intl.DateTimeFormat("en-IN",{timeZone:tz,weekday:"short",day:"numeric",month:"short"}).format(new Date(iso));}

/** Short headline and 3–5 plain-language facts for the "Why this time" panel. Every fact comes from fetched history. */
export function buildInsight({context,settings,strategy,recommended,stop,retry,training}:{context:PredictionContext;settings:SchedulingSettings;strategy:Prediction["ranking_strategy"];recommended:CallWindow|null;stop:boolean;retry:Prediction["retry_plan"];training:number}):Prediction["insight"] {
  const tz=context.timezone,history=context.seller_history,r=recommended?.ranking;
  if(stop)return {title:"Calling paused for now",details:["This seller has a do-not-call mark or has reached the attempt limit for this sequence.","A new calling time will appear here as soon as calling is allowed again."]};
  if(context.history_status!=="verified"||!recommended)return {title:"Waiting for call history",details:["The seller's call history or contact restrictions could not be loaded, so no time is suggested yet.","Refresh the queue in a moment to try again."]};
  const hour=clock(recommended.start,tz,true),range=`${clock(recommended.start,tz)} to ${clock(recommended.end,tz)}`;
  const cb=context.conversation?.callback,use=callbackUse(context,settings,recommended),callbackSlot=use==="used";
  const title=callbackSlot?(!cb!.precision||cb!.precision==="exact"?`Asked for a call at ${hour}`:`Asked for a call ${(cb!.label??"").replace(/\s*\(.*\)$/,"")}`):strategy==="seller_meetings"?`Books meetings around ${hour}`:strategy==="seller_answers"?`Picks up around ${hour}`:strategy==="generalized_model"||strategy==="canonical_model"?`Best bet: the ${hour} slot`:"Fresh start: first open slot";
  const details:string[]=[];
  if((strategy==="seller_meetings"||strategy==="seller_answers")&&r){
    details.push(`In the ${range} slot they answered ${r.answered_calls} of ${plural(r.calls,"call")}${r.linked_meetings?`, and ${plural(r.linked_meetings,"meeting")} came from calls at this time`:""}${r.evidence_scope==="pooled_hour"?" (counted across all weekdays)":""}.`);
  } else if(strategy==="generalized_model"||strategy==="canonical_model"){
    details.push(`This seller's own history is still thin, so the slot comes from ${training.toLocaleString("en-IN")} past ERP calls across all sellers, where this hour has ${recommended.support.toLocaleString("en-IN")} calls behind it.`);
  } else details.push(`No conclusive history yet, so the first open slot within calling hours is offered.`);
  const conv=context.conversation;
  if(conv?.analyzed){
    const parts=Object.entries(conv.counts).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${n} ${SENTIMENT_WORDS[k as keyof typeof SENTIMENT_WORDS]}`);
    const manual=conv.manual??0,heard=manual===conv.analyzed?`read ${plural(conv.analyzed,"call transcript")}`:manual?`analysed ${plural(conv.analyzed,"call")}`:`listened to ${plural(conv.analyzed,"recorded call")}`;
    details.push(`Sarvam AI ${heard}: ${listWords(parts)}${conv.latest?`. Latest: ${conv.latest.summary.replace(/\.$/,"")}`:""}.`);
    // The explanation already states the callback request; repeat it here only when it could not be used.
    if(cb&&use!=="used")details.push(callbackSentence(context,settings,use));
    if(conv.latest?.key_points?.length)details.push(`Also discussed: ${listWords(conv.latest.key_points.map(k=>k.replace(/\.$/,"")))}.`);
    if(!cb&&conv.recent_negative)details.push("Their most recent recorded call sounded negative, so the next attempt waits at least a day.");
  }
  const days=(history?.days||[]).filter(d=>d.answered_calls>0).sort((a,b)=>b.answered_calls-a.answered_calls||a.weekday-b.weekday);
  if(days.length)details.push(`Their best day so far is ${WEEKDAY_NAMES[days[0].weekday]} with ${plural(days[0].answered_calls,"answered call")}${days[1]?`, followed by ${WEEKDAY_NAMES[days[1].weekday]} (${days[1].answered_calls})`:""}.`);
  if(history?.short_calls)details.push(`${plural(history.short_calls,"answered call")} lasted under 20 seconds, so those count for less when ranking times.`);
  if(context.last_call_at){
    const localDay=(iso:string)=>Date.parse(`${new Intl.DateTimeFormat("en-CA",{timeZone:tz}).format(new Date(iso))}T00:00:00Z`);
    const daysAgo=Math.max(0,Math.round((localDay(context.as_of)-localDay(context.last_call_at))/86_400_000));
    details.push(`The last call was ${daysAgo===0?"today":daysAgo===1?"yesterday":`${daysAgo} days ago`}${context.last_unanswered_at&&context.last_unanswered_at===context.last_call_at?" and went unanswered":""}.`);
  }
  if(retry.next_call_at)details.push(`If they don't pick up, try again ${dayLabel(retry.next_call_at,tz)} at ${clock(retry.next_call_at,tz)}.`);
  else if(retry.status==="stop")details.push("No further retry is planned after this attempt because of the attempt limits.");
  return {title,details:details.slice(0,5)};
}

/** A callback time the client asked for in a recorded call is direct evidence for that slot. */
function withConversation(confidence:Prediction["confidence"],recommended:CallWindow|null,context:PredictionContext):Prediction["confidence"]{
  const cb=context.conversation?.callback;
  if(!recommended?.ranking?.callback_request||!cb)return confidence;
  // A specific time the client named is the strongest evidence there is; a day or part of the day is strong.
  const level=!cb.precision||cb.precision==="exact"?"very_high":"high";
  if(confidence.level==="very_high"||confidence.level===level)return confidence;
  return {...confidence,level,reason:`The client asked to be called back ${cb.label??"at this time"} on their last call (analysed by Sarvam AI)${level==="high"?"; the model picks the hour inside that request":""}. This is the client's own request, not a probability.`};
}

export function deterministicPrediction(context: PredictionContext, settings: SchedulingSettings, registry: ModelRegistry): Prediction {
  const consistent=contextConsistent(context),rank=rankEligibleWindows(context,candidateWindows(context,settings),settings,registry);
  const {strategy,ranked,daily,modelVersion,training,modelIssue}=rank,recommended=ranked[0]||null;
  const canonical=strategy==="canonical_model",personal=strategy==="seller_meetings"||strategy==="seller_answers",general=strategy==="generalized_model";
  const route=personal?"personal_history":general?"generalized":canonical?rank.desired:"fallback";
  const selectedModel=canonical?chooseModel(rank.desired,registry):general?registry.generalized:null;
  const families={logistic:"Logistic regression",hour_day:"Smoothed hour/day",cohort_hour_day:"Cohort hour/day"};
  const scoringModel:ScoringModel={
    name:personal?(strategy==="seller_meetings"?"Seller weekday/hour meeting history":"Seller weekday/hour answer history"):selectedModel?`${general?"General ERP":rank.desired.replaceAll("_"," ")} / ${families[selectedModel.family]}`:"Configured calling rules",
    kind:personal?"history_heuristic":selectedModel?"trained_ml":"operating_rules",family:selectedModel?.family||null,version:modelVersion,training_attempts:training,
    target:canonical?"meeting_done":general?registry.generalized!.trained_target:null,evaluation:general?registry.generalized?.evaluation||null:null,
    description:personal?"Uses observed meeting and answer counts with short-call discounts; the score is ranking points.":general?"The model estimates linked ERP physical meeting records within 14 days; scores describe this proxy outcome.":canonical?"The model estimates canonical completed-meeting probability.":"Uses configured calling hours and contact constraints; a numerical model score is unavailable."
  };
  const capped=context.recent_attempts>=settings.maxAttemptsPerSequence;
  const stop=context.do_not_call||(capped&&!recommended&&context.history_status==="verified");
  const retry=retryPlan(context,recommended,settings);
  const explanation=explainPrediction({context,settings,strategy,recommended,preference:rank.preference.weekdays,stop});
  const insight=buildInsight({context,settings,strategy,recommended,stop,retry,training});
  const issues=[...context.issues,...(!consistent?["Contradictory history counts; recommendations are withheld."]:[]),...(general?["General model scores concern observed linked ERP physical meeting records; hour-pooled weekday backoff has unverified calibration."]:[]),...(!canonical?registry.issues:[]),...(modelIssue?[modelIssue]:[])];
  const selectedTool=personal?"score_personal_history_windows":general?"score_generalized_windows":canonical?(rank.desired==="history_aware"?"score_history_windows":rank.desired==="cold_start"?"score_cold_start_windows":"score_sparse_history_windows"):"score_cohort_fallback";
  return {glid:context.glid,as_of:context.as_of,timezone:context.timezone,prediction_route:route,model_version:modelVersion,primary_target:"meeting_done",scoring_model:scoringModel,
    recommended_window:recommended,ranked_windows:ranked,daily_windows:daily,ranking_strategy:strategy,ranking_scope:"overall",day_preference:rank.preference,
    retry_plan:retry,
    confidence:withConversation(confidenceFor(strategy,recommended),recommended,context),
    evidence:{prior_calls:context.prior_calls,proxy_completed_meetings:context.proxy_completed_meetings,canonical_completed_meetings:null,history_status:context.history_status,history_scope:context.history_scope,training_attempts:training,label_kind:canonical?"canonical":personal||general?"proxy":"unavailable",data_quality:issues,assumptions:[`Timezone ${context.timezone} is configured.`,`Calling hours ${settings.businessStartHour}:00-${settings.businessEndHour}:00 and a ${settings.cooldownMinutes}-minute cooldown are configurable; historical answered hours are also considered.`,"Supported weekday-and-hour history ranks slots; sparse weekdays back off to pooled hours. Observed day patterns do not guarantee future availability.","Known answered durations under 20 seconds receive a penalty of 75% times their fraction among known answered durations; missing durations are not short calls.","Employee capacity/contact preferences have no verified feed.","15-minute retry buckets have no identified causal completed-meeting comparison."]},
    explanation,insight,conversation:context.conversation??null,seller_factors:context.seller_factors??null,selected_tool:selectedTool,selected_model_version:modelVersion,routing_reason:stop?"blocked_by_constraints":context.history_status!=="verified"?"history_unavailable":strategy,
    validation_status:stop?"blocked":personal||general||canonical?"passed":"insufficient_support",validation_issues:issues,
    llm_status:{status:"disabled",reason:null,model:process.env.OPENROUTER_MODEL||"openai/gpt-6-luna",tool_executions:0,latency_ms:0,input_tokens:0,output_tokens:0,cost:null}};
}
export function validatePrediction(prediction: Prediction, context: PredictionContext, settings: SchedulingSettings, registry: ModelRegistry): string[] {
  const errors:string[]=[],eligible=new Map(candidateWindows(context,settings).map(w=>[w.id,w])),expected=deterministicPrediction(context,settings,registry),days=new Map<string,number>();
  if(prediction.glid!==context.glid||prediction.as_of!==context.as_of||prediction.timezone!==context.timezone||prediction.primary_target!=="meeting_done")errors.push("Identity/target mismatch.");
  for(const window of prediction.ranked_windows) {
    const original=eligible.get(window.id),date=localParts(window.start,context.timezone).date;days.set(date,(days.get(date)||0)+1);
    if(!original||window.start!==original.start||window.end!==original.end||window.timezone!==context.timezone)errors.push("Ineligible window.");
    if(window.score!==null&&(!Number.isFinite(window.score)||window.score<0||window.score>1))errors.push("Invalid probability.");
  }
  if([...days.values()].some(n=>n>settings.maxSlotsPerDay))errors.push("Too many ranked windows in one day.");
  if(prediction.ranked_windows.length>settings.maxSlotsPerDay)errors.push("Too many overall ranked windows.");
  if(new Set(prediction.ranked_windows.map(w=>w.id)).size!==prediction.ranked_windows.length)errors.push("Duplicate windows.");
  for(const key of ["ranked_windows","daily_windows","ranking_strategy","ranking_scope","day_preference","recommended_window","retry_plan","model_version","scoring_model","selected_model_version","prediction_route","selected_tool","explanation","insight","conversation","seller_factors","confidence","evidence","validation_status","validation_issues","routing_reason"] as const)if(JSON.stringify(prediction[key])!==JSON.stringify(expected[key]))errors.push(`Deterministic ${key} mismatch.`);
  return errors;
}
export async function predictBatch(glids: string[], users: UserProfile[], asOf=new Date().toISOString(), options:{skipLlm?:boolean;globalContexts?:GlobalContextResult[]}={}): Promise<Prediction[]> {
  const store=getAdminStore(),settings=await store.readPredictionSettings(),registry=await loadRegistry();
  for(const route of ["history_aware","cold_start"] as const) if(registry[route]) {
    const model=registry[route]!;
    await store.registerModel(model.model_version,route,{dataset_sha256:model.dataset_sha256,split_sha256:model.split_sha256,label_kind:model.label_kind,evidence:model.evidence,deployment:model.deployment});
  }
  const results:Prediction[]=new Array(glids.length);let next=0;
  const batchDeadline=Date.now()+20000;
  await Promise.all(Array.from({length:Math.min(4,glids.length)},async()=>{
    while(next<glids.length) {
      const t0=Date.now(),index=next++,glid=glids[index],context=predictionContext(glid,users.find(u=>u.glid===glid),asOf,settings,options.globalContexts?.find(g=>g.glid===glid));
      const tContext=Date.now();
      let prediction=deterministicPrediction(context,settings,registry);
      const tRules=Date.now();
      const execute=(tool:string)=>{
        if(tool==="get_prediction_context") return {context_id:context.context_id,as_of:context.as_of,history_status:context.history_status,prior_calls:context.prior_calls,eligible_tool:prediction.selected_tool,issues:context.issues,conversation:context.conversation?{analyzed:context.conversation.analyzed,counts:context.conversation.counts,average_score:context.conversation.average_score,latest_sentiment:context.conversation.latest?.sentiment??null,callback_at:context.conversation.callback?.at??null,callback:context.conversation.callback?{label:context.conversation.callback.label??null,precision:context.conversation.callback.precision??"exact",used_in_plan:callbackUse(context,settings,prediction.recommended_window)}:null,meeting_intent:context.conversation.meeting_intent,pasted_transcripts:context.conversation.manual??0,source:"Sarvam AI analysis of call recordings and pasted call transcripts"}:null,seller_factors:context.seller_factors?{lifecycle_stage:context.seller_factors.stage,stages:context.seller_factors.stages,industry_segment:context.seller_factors.segment.vertical,last_successful_meeting_days_ago:context.seller_factors.last_successful_meeting?.days_ago??null,retry_urgency:context.seller_factors.urgency}:null};
        if(tool===prediction.selected_tool) return {model_version:prediction.model_version,scoring_model:prediction.scoring_model,ranking_strategy:prediction.ranking_strategy,windows:prediction.ranked_windows.slice(0,4),day_preference:prediction.day_preference,retry_plan:prediction.retry_plan,explanation:prediction.explanation,route:prediction.prediction_route,routing_reason:prediction.routing_reason};
        if(tool==="score_retry_plan") return prediction.retry_plan;
        if(tool==="validate_prediction") return {validation_status:prediction.validation_status,validation_issues:prediction.validation_issues,programmatic_errors:validatePrediction(prediction,context,settings,registry),selected_tool:prediction.selected_tool,selected_model_version:prediction.selected_model_version,routing_reason:prediction.routing_reason,explanation:prediction.explanation};
        throw new Error("Unknown/ineligible prediction tool.");
      };
      const llmAttempted=!options.skipLlm && Date.now()<batchDeadline;
      if(!options.skipLlm && Date.now()<batchDeadline) prediction=await reviewPrediction(prediction,context,{...settings,llmDeadlineMs:Math.max(1000,Math.min(settings.llmDeadlineMs,batchDeadline-Date.now()))},execute);
      else if(!options.skipLlm) prediction.llm_status={...prediction.llm_status,status:"fallback",reason:"Batch explanation deadline reached."};
      const tLlm=Date.now();
      const errors=validatePrediction(prediction,context,settings,registry);
      if(errors.length) {const llm=prediction.llm_status;prediction=deterministicPrediction(context,settings,registry);prediction.llm_status={...llm,status:"fallback",reason:"Independent recommendation validation failed."};}
      // Facts for the execution-flow view, from values already computed (a pure re-run of candidateWindows only).
      const windows=candidateWindows(context,settings),gap=dynamicGap(context,settings),h=context.seller_history;
      prediction.pipeline={timings:{context_ms:tContext-t0,deterministic_ms:tRules-tContext,llm_ms:tLlm-tRules,validate_ms:Date.now()-tLlm},
        context:{history_status:context.history_status,prior_calls:context.prior_calls,recent_attempts:context.recent_attempts,attempts_today:context.attempts_today,last_call_at:context.last_call_at,not_before:context.not_before??null,
          appointments:context.appointments.length,blocked_dates:context.blocked_dates?.length??0,do_not_call:context.do_not_call,timed_calls:h?.timed_calls??0,answered_calls:h?.answered_calls??0,linked_meetings:h?.linked_meetings??0,hour_slots:h?.slots.length??0,
          analysed_calls:context.conversation?.analyzed??0,minimum_wait_minutes:gap.minutes,minimum_wait_reason:gap.reason},
        candidates:{total:windows.length,requested:windows.filter(w=>w.requested_by_client).length,outside_usual_hours:windows.filter(w=>w.outside_configured_hours).length},
        llm_attempted:llmAttempted,validation:{errors:errors.length,replaced_with_rules:errors.length>0}};
      await store.savePrediction(prediction);results[index]=prediction;
    }
  }));
  return results;
}
