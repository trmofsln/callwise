import type { CallWindow, Prediction, PredictionContext, SchedulingSettings } from "./best-time-types";
import { contextConsistent, dynamicGap, localParts } from "./best-time-policy";
import { retryDecay, stageLabel, type SellerFactors } from "./seller-factors";
import { projectMiss, RETRY_INTERVALS, retryLadder, stepWindow } from "./retry-ladder";

export function strength(window: CallWindow): number {
  const r = window.ranking;
  if (window.score !== null) return window.score;
  if (r?.source === "generalized_model") return r.proxy_estimate ?? r.priority_score;
  return r?.priority_score ?? 0;
}

/**
 * Plan the next attempt if the recommended call goes unanswered. The wait is dynamic (it backs off
 * with consecutive misses and reacts to what the client said), a callback time the client asked for
 * wins, and otherwise the retry is the moment with the highest business impact: slot strength for
 * this seller, discounted per day of delay. The discount follows the seller's business factors:
 * 25% a day when momentum or a deadline matters (new onboarding, renewal, churn risk), 3% when the
 * seller needs space (complaints, a negative call), 10% otherwise. A retry may start part-way into a strong hour.
 */
export function retryImpact(windows:CallWindow[],today:string,factors:SellerFactors|null|undefined):(w:CallWindow)=>number {
  const best=Math.max(0,...windows.map(strength)),decay=retryDecay(factors);
  return (w:CallWindow)=>{
    const days=Math.max(0,(Date.parse(localParts(w.start,w.timezone).date)-Date.parse(today))/86400000);
    return (best>0?strength(w)/best:1)*decay**days;
  };
}
/** Plain words for why the seller's factors change how soon to retry. */
export function urgencyNote(factors:SellerFactors|null|undefined):string {
  if(!factors)return "";
  const u=factors.urgency;
  if(u.level==="high")return ` Retry sooner rather than later: ${u.reasons.join(", ")}.`;
  if(u.level==="give_space")return ` Give the seller some space: ${u.reasons.join(", ")}.`;
  return ` This is a ${stageLabel(factors.stage)} seller, so the strongest slot is preferred over calling sooner.`;
}
export function retryPlan(context:PredictionContext,recommended:CallWindow|null,settings:SchedulingSettings):Prediction["retry_plan"] {
  const stopCondition=`Alternatives are not a call quota: allow at most ${settings.maxAttemptsPerDay} actual attempts per day and ${settings.maxAttemptsPerSequence} in a ${settings.sequenceDays}-day unanswered sequence; stop on do-not-call or confirmed contact and respect appointments.`;
  const base:Prediction["retry_plan"]={status:"not_needed",after_minutes:null,next_call_at:null,next_window:null,attempt_number:context.recent_attempts+1,maximum_attempts:settings.maxAttemptsPerSequence,stop_condition:stopCondition,considered_delays_minutes:[15,45,120,240,1440],rule_assessment:"unverified_keep_for_pilot",anchor_kind:null,anchor_at:null,minimum_gap_minutes:settings.cooldownMinutes,earliest_retry_at:null,reason:"A retry can be planned once an eligible next calling window exists.",previous_unanswered_at:context.last_unanswered_at};
  if(context.do_not_call)return {...base,status:"stop",reason:"Do-not-call blocks both the initial call and retries."};
  if(context.history_status!=="verified"||!contextConsistent(context))return {...base,status:"insufficient_data",reason:"History or contact restrictions could not be verified."};
  if(!recommended)return {...base,status:context.recent_attempts>=settings.maxAttemptsPerSequence?"stop":"not_needed",reason:settings.enabled?"No eligible initial window; no retry time can be scheduled.":"Calling recommendations are disabled."};
  // The planned call happens at the start of the recommended window; the ladder plans up to four
  // retries from it, choosing interval or best slot at each step from retry data (lib/retry-ladder.ts).
  const ladder=retryLadder(context,recommended.start,settings);
  const first=ladder.steps[0];
  if(!first)return {...base,status:"postpone",anchor_kind:"recommended_call_start",anchor_at:recommended.start,ladder:[],approach:null,reason:`If the call goes unanswered: ${ladder.stop??"no retry fits the calling rules."}`};
  const gap=dynamicGap(projectMiss(context,recommended.start,settings),settings);
  const postpone=localParts(first.at,context.timezone).date!==localParts(recommended.start,context.timezone).date;
  return {...base,status:postpone?"postpone":"retry",anchor_kind:"recommended_call_start",anchor_at:recommended.start,minimum_gap_minutes:gap.minutes,earliest_retry_at:new Date(Date.parse(recommended.start)+gap.minutes*60000).toISOString(),
    next_call_at:first.at,next_window:stepWindow(first,context.timezone),after_minutes:first.after_minutes,attempt_number:context.recent_attempts+2,considered_delays_minutes:[...RETRY_INTERVALS],
    ladder:ladder.steps,approach:ladder.approach,
    reason:`If the call goes unanswered, ${first.strategy==="interval"?`retry ${first.after_minutes} minutes later`:first.strategy==="seller_requested"?"retry at the time the seller asked for":"retry at the next best slot"}: ${first.reason} ${ladder.approach?.summary??""}`.trim()};
}
