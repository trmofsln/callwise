import type { Prediction } from "@/lib/best-time-types";
import type { RunStage, StageRecord } from "@/lib/pipeline-trace";
import type { AiRetryPlan } from "@/lib/retry-planner";
import type { UserLookup } from "@/lib/user-types";
import type { FlowGraph } from "./execution-flow-graph";
import type { SellerRow } from "./seller-model";

// Resolves each flowchart node and arrow against the actual response of this build (and, for the
// post-call branch, the AI retry plan the rep ran in this tab). Nothing here calls an API again.

export type RunStatus = "completed" | "skipped" | "unavailable" | "failed" | "not_run" | "offline" | "not_recorded";
export type NodeRun = { status: RunStatus; note: string; values: [string, string][]; ms?: number; startMs?: number };
export type EdgeRun = { active: boolean; note: string; sample?: unknown };
export type FlowRun = { nodes: Record<string, NodeRun>; edges: Record<string, EdgeRun>; recorded: boolean };

const tz = "Asia/Kolkata";
const when = (iso: string | null | undefined) => iso ? new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(/\b(am|pm)\b/, m => m.toUpperCase()) : "—";
const pct = (p: number) => `${Math.round(p * 100)}%`;
const STRATEGY_NODE: Record<Prediction["ranking_strategy"], string> = { seller_meetings: "rank_meetings", seller_answers: "rank_answers", canonical_model: "rank_canonical", generalized_model: "rank_general", operating_hours: "rank_hours" };

function stageRun(stages: Map<RunStage, StageRecord>, id: RunStage, values: [string, string][] = []): NodeRun {
  const s = stages.get(id);
  if (!s) return { status: "not_recorded", note: "This response has no execution record for this stage.", values };
  return { status: s.status, note: s.detail, values: [...values, ["Started", `${s.started_ms} ms after the request`], ["Took", `${s.duration_ms} ms`]], ms: s.duration_ms, startMs: s.started_ms };
}

export function resolveBestTimeRun(graph: FlowGraph, result: UserLookup, row: SellerRow): FlowRun {
  const stages = new Map((result.trace?.stages ?? []).map(s => [s.id, s]));
  const p = row.prediction, u = row.user, pl = p?.pipeline, conv = p?.conversation, f = p?.seller_factors;
  const nodes: Record<string, NodeRun> = {};
  const pasted = result.callContext;
  const ownPasted = pasted?.glid === row.glid ? pasted.analyses : [];
  const gctx = result.globalContexts?.find(g => g.glid === row.glid);
  const t = pl?.timings;

  nodes.in_glids = { ...stageRun(stages, "input", [["GLIDs in this queue", String(result.requestedGlids.length)], ["Seller shown", row.glid]]), status: "completed" };
  nodes.in_context = ownPasted.length ? { status: "completed", note: `${ownPasted.length} call(s) pasted for this seller.`, values: ownPasted.map((a, i) => [`Call ${i + 1}`, `${a.transcript_chars} characters · ${a.called_at ? when(a.called_at) : "no time"}`]) }
    : { status: "skipped", note: pasted ? `Pasted calls belong to GLID ${pasted.glid}, not this seller.` : "No previous call context was pasted for this build, so this branch did not run.", values: [] };
  nodes.in_settings = { status: "completed", note: "Read from the app store at the start of predictBatch.", values: [["Timezone", p?.timezone ?? tz], ...(p?.evidence.assumptions[1] ? [["Rules", p.evidence.assumptions[1]] as [string, string]] : [])] };
  nodes.redash = stageRun(stages, "redash_query", u ? [["This seller", "ERP user record found"], ["Calls in history", String(u.activity.metrics.callCount)], ["DSR meetings", String(u.activity.metrics.meetingCount)], ["Do-not-call mark", u.callPolicy?.doNotCallMarkedAt ? "present" : "none"]] : [["This seller", "No ERP user record"]]);
  const gRun = stageRun(stages, "global_context");
  nodes.gctx = gctx ? { ...gRun, status: gctx.status === "success" ? "completed" : gctx.status === "not_configured" ? "unavailable" : "failed", note: gctx.status === "success" ? `Returned for this seller. ${gRun.note}` : gctx.error ?? gRun.note } : gRun;
  const sRun = stageRun(stages, "sarvam_context", ownPasted.map((a, i) => [`Call ${i + 1}`, a.result ? `${a.result.sentiment.replace(/_/g, " ")} (${a.result.score >= 0 ? "+" : ""}${a.result.score})${a.result.callback.requested ? (a.result.callback.when_text ? ` · callback "${a.result.callback.when_text}"` : " · callback requested (no timing words captured)") : ""}` : `${a.status}: ${a.status_detail ?? ""}`] as [string, string]));
  nodes.sarvam_ctx = ownPasted.length ? sRun : { ...sRun, status: "skipped", note: pasted ? "Sarvam ran for another seller's pasted calls." : "Skipped: no previous call context was pasted.", values: [] };
  nodes.profiles = { ...stageRun(stages, "build_profiles"), ...(u ? {} : { status: "unavailable" as const, note: "No ERP user record for this GLID." }) };
  const analyses = u?.recordingAnalyses ?? [];
  nodes.attach = stageRun(stages, "attach_analyses", [["Analysed calls for this seller", String(analyses.filter(a => a.status === "analyzed").length)], ["From pasted context", String(analyses.filter(a => a.source_kind === "manual").length)], ["From recordings (cached)", String(analyses.filter(a => a.source_kind !== "manual").length)]]);

  if (!p) {
    for (const node of graph.nodes) if (!nodes[node.id]) nodes[node.id] = { status: "not_run", note: "No prediction was returned for this seller.", values: [] };
  } else {
    const c = pl?.context;
    nodes.history = c ? { status: c.history_status === "verified" ? "completed" : "failed", note: c.history_status === "verified" ? "History counted." : "History or contact restrictions could not be verified.", ms: t?.context_ms, values: [["Timed calls", String(c.timed_calls)], ["Answered", String(c.answered_calls)], ["Linked meetings", String(c.linked_meetings)], ["Hours with calls", String(c.hour_slots)]] } : { status: "not_recorded", note: "Prediction has no pipeline record.", values: [] };
    nodes.signals = conv ? { status: "completed", note: `${conv.analyzed} analysed call(s).`, values: [["Moods", Object.entries(conv.counts).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")], ["Latest", conv.latest ? `${conv.latest.sentiment.replace(/_/g, " ")} (${conv.latest.score})` : "—"], ["Callback", conv.callback ? `${conv.callback.label ?? when(conv.callback.at)} (${conv.callback.precision ?? "exact"})` : "none"], ["Asked not to call", conv.asked_not_to_call ? "yes" : "no"], ["Recent negative", conv.recent_negative ? "yes" : "no"]] }
      : { status: "skipped", note: "No analysed calls for this seller, so there are no conversation signals.", values: [] };
    nodes.factors = f ? { status: "completed", note: `Urgency: ${f.urgency.level.replace("_", " ")}.`, values: [["Stage", f.stages.join(", ").replace(/_/g, " ")], ["Segment", f.segment.vertical ?? "—"], ["Last successful meeting", f.last_successful_meeting ? `${f.last_successful_meeting.days_ago} days ago` : "none"], ["Urgency reasons", f.urgency.reasons.join("; ") || "none"]] }
      : { status: "skipped", note: "No profile or Global Context to derive factors from.", values: [] };
    nodes.context = c ? { status: "completed", note: c.do_not_call ? "Do-not-call: no window will be offered." : "Constraints collected.", values: [["Attempts today", String(c.attempts_today)], ["Attempts in sequence", String(c.recent_attempts)], ["Last call", when(c.last_call_at)], ["Appointments", String(c.appointments)], ["Do-not-call", c.do_not_call ? "yes" : "no"], ["Minimum wait", `${c.minimum_wait_minutes} min (${c.minimum_wait_reason})`], ["Earliest next call", when(c.not_before)]] } : { status: "not_recorded", note: "", values: [] };
    nodes.candidates = pl ? { status: pl.candidates.total ? "completed" : "failed", note: pl.candidates.total ? `${pl.candidates.total} allowed window(s).` : "No window passes the rules.", ms: t?.deterministic_ms, values: [["Allowed windows", String(pl.candidates.total)], ["Seller-requested windows", String(pl.candidates.requested)], ["Outside usual hours", String(pl.candidates.outside_usual_hours)]] } : { status: "not_recorded", note: "", values: [] };
    nodes.strategy = { status: "completed", note: `Chose ${p.ranking_strategy.replace(/_/g, " ")}.`, values: [["Ranking source", p.ranking_strategy.replace(/_/g, " ")], ["Model version", p.model_version]] };
    const taken = STRATEGY_NODE[p.ranking_strategy];
    for (const id of ["rank_meetings", "rank_answers", "rank_canonical", "rank_general", "rank_hours"]) {
      nodes[id] = id === "rank_canonical" ? { status: "unavailable", note: "No canonical model artifact exists.", values: [] }
        : id === taken ? { status: "completed", note: "This ranking source was used.", values: (p.ranked_windows.slice(0, 4).map((w, i) => [`#${i + 1} ${when(w.start)}`, w.ranking?.source === "generalized_model" ? `proxy ${(w.ranking.proxy_estimate ?? 0).toFixed(4)} · support ${w.support}` : `${w.ranking?.answered_calls ?? 0} answered · ${w.ranking?.linked_meetings ?? 0} meetings`]) as [string, string][]) }
        : { status: "skipped", note: "Not used for this seller.", values: [] };
    }
    const best = p.recommended_window;
    nodes.adjust = { status: best ? "completed" : "failed", note: best ? `Best: ${when(best.start)}.` : "No window.", values: [["Ranked windows", String(p.ranked_windows.length)], ["Seller-requested first", best?.ranking?.callback_request ? "yes" : "no"], ["Mood factor on best", best?.ranking?.sentiment_factor ? `×${best.ranking.sentiment_factor.toFixed(2)}` : "×1.00"]] };
    nodes.confidence = { status: "completed", note: p.confidence.reason, values: [["Level", p.confidence.level.replace("_", " ")]] };
    nodes.explain = { status: "completed", note: p.insight?.title ?? "", values: [["Title", p.insight?.title ?? "—"]] };
    nodes.retry = { status: p.retry_plan.ladder?.length ? "completed" : "skipped", note: p.retry_plan.ladder?.length ? `${p.retry_plan.ladder.length} retries planned.` : p.retry_plan.reason, values: (p.retry_plan.ladder ?? []).map(s => [`Retry ${s.retry}`, `${when(s.at)} · ${s.strategy.replace("_", " ")} · ${pct(s.p_answer)}`] as [string, string]) };
    const llm = p.llm_status;
    nodes.llm = { status: llm.status === "reviewed" ? "completed" : llm.status === "disabled" ? "skipped" : "failed", note: llm.status === "reviewed" ? "Reviewed; the plan matched the tool results." : `${llm.status}: ${llm.reason ?? ""}`, ms: t?.llm_ms, values: [["Model", llm.model], ["Tool calls", String(llm.tool_executions)], ["Latency", `${llm.latency_ms} ms`]] };
    nodes.validator = pl ? { status: "completed", note: pl.validation.replaced_with_rules ? `${pl.validation.errors} mismatch(es): the deterministic prediction was used.` : "Passed: shown plan equals the computed plan.", ms: t?.validate_ms, values: [["Errors", String(pl.validation.errors)]] } : { status: "not_recorded", note: "", values: [] };
    nodes.out = best ? { status: "completed", note: p.explanation, values: [["Best time", `${when(best.start)} – ${when(best.end).split(", ").pop()}`], ["Confidence", p.confidence.level.replace("_", " ")]] } : { status: "failed", note: p.explanation, values: [] };
  }

  const edges: Record<string, EdgeRun> = {};
  const executed = (id: string) => ["completed", "failed"].includes(nodes[id]?.status ?? "");
  for (const e of graph.edges) {
    const active = executed(e.from) && executed(e.to);
    edges[e.id] = { active, note: active ? "Used in this run." : "Not used in this run." };
  }
  // Representative payloads from this run: counts and field names, never raw personal data.
  if (u) {
    const bySource = (list: { source: string }[]) => list.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.source]: (acc[x.source] ?? 0) + 1 }), {});
    edges.e_redash_profiles.sample = { glid: row.glid, calls_by_table: bySource(u.activity.calls), meetings_by_table: bySource(u.activity.meetings), sales_meetings: u.activity.salesMeetings.length, other_tables: Object.fromEntries(Object.entries(u.activity.relatedRecords ?? {}).map(([k, v]) => [k, `${(v as unknown[]).length} rows`])), call_policy: { doNotCallMarkedAt: u.callPolicy?.doNotCallMarkedAt ? "set" : null } };
  }
  if (ownPasted.length) edges.e_sarvam_attach.sample = ownPasted.map(a => ({ called_at: a.called_at, status: a.status, result: a.result ? { sentiment: a.result.sentiment, score: a.result.score, callback: a.result.callback, key_points: a.result.key_points } : null }));
  if (p?.pipeline) edges.e_context_candidates.sample = p.pipeline.context;
  if (conv) edges.e_signals_context.sample = { analyzed: conv.analyzed, latest: conv.latest && { sentiment: conv.latest.sentiment, score: conv.latest.score }, callback: conv.callback, asked_not_to_call: !!conv.asked_not_to_call, recent_negative: conv.recent_negative };
  if (f) edges.e_factors_context.sample = { stage: f.stage, stages: f.stages, urgency: f.urgency, risk: f.risk };
  if (p) {
    edges.e_candidates_strategy.sample = p.pipeline?.candidates;
    const taken = STRATEGY_NODE[p.ranking_strategy];
    const toAdjust = graph.edges.find(e => e.from === taken && e.to === "adjust");
    if (toAdjust) edges[toAdjust.id].sample = p.ranked_windows.slice(0, 2).map(w => ({ start: w.start, ranking: w.ranking && { source: w.ranking.source, priority_score: w.ranking.priority_score, proxy_estimate: w.ranking.proxy_estimate, answered_calls: w.ranking.answered_calls, linked_meetings: w.ranking.linked_meetings, callback_request: w.ranking.callback_request } }));
    edges.e_validator_out.sample = { recommended_window: p.recommended_window && { start: p.recommended_window.start, end: p.recommended_window.end }, confidence: p.confidence.level, insight_title: p.insight?.title };
    edges.e_adjust_retry.sample = { anchor: p.recommended_window?.start ?? null };
    edges.e_llm_validator.sample = p.llm_status;
  }
  return { nodes, edges, recorded: !!result.trace };
}

export function resolveRetryRun(graph: FlowGraph, row: SellerRow, plan: AiRetryPlan | undefined): FlowRun {
  const p = row.prediction, r = p?.retry_plan, ladder = r?.ladder ?? [];
  const nodes: Record<string, NodeRun> = {};
  const has = !!p && ladder.length > 0;
  const first = ladder[0];
  nodes.r_anchor = p?.recommended_window ? { status: "completed", note: "The best-time call is the anchor.", values: [["Anchor", when(p.recommended_window.start)]] } : { status: "skipped", note: "No best time, so no ladder.", values: [] };
  nodes.r_context = p?.pipeline ? { status: "completed", note: "Same context as the best-time flow.", values: [["Attempts today", String(p.pipeline.context.attempts_today)], ["Attempts in sequence", String(p.pipeline.context.recent_attempts)], ["Appointments", String(p.pipeline.context.appointments)]] } : { status: p ? "completed" : "not_run", note: "", values: [] };
  nodes.r_callback = p?.conversation?.callback ? { status: "completed", note: "A requested time constrains retries while it is open.", values: [["Requested", p.conversation.callback.label ?? when(p.conversation.callback.at)]] } : { status: "skipped", note: "No callback request from the seller.", values: [] };
  nodes.r_factors = p?.seller_factors ? { status: "completed", note: `Urgency ${p.seller_factors.urgency.level.replace("_", " ")}.`, values: [["Decay per day", p.seller_factors.urgency.level === "high" ? "0.75" : p.seller_factors.urgency.level === "give_space" ? "0.97" : "0.90"]] } : { status: "completed", note: "No factors: default decay 0.90.", values: [["Decay per day", "0.90"]] };
  nodes.r_train = { status: "offline", note: "Ran offline; its output is bundled with the app.", values: [["Source", r?.approach?.source ?? "ml/retry/retry-policy.json"]] };
  nodes.r_tables = { status: has ? "completed" : "not_run", note: "Loaded with the app.", values: [] };
  const stepRun = (status: RunStatus, note: string, values: [string, string][]): NodeRun => has ? { status, note, values } : { status: "not_run", note: r?.reason ?? "No retry ladder for this seller.", values: [] };
  nodes.r_misses = stepRun("completed", "Retry number of the first retry.", [["Misses before retry 1", String(first?.misses_before ?? "—")]]);
  nodes.r_project = stepRun("completed", `Ran ${ladder.length} time(s).`, ladder.map(s => [`Before retry ${s.retry}`, `misses ${s.misses_before}`]));
  nodes.r_floor = stepRun("completed", `Minimum wait ${r?.minimum_gap_minutes ?? "—"} min.`, [["Minimum wait", `${r?.minimum_gap_minutes ?? "—"} min`], ["Earliest retry", when(r?.earliest_retry_at)]]);
  nodes.r_windows = stepRun("completed", "Allowed windows found for each retry.", []);
  nodes.r_options = stepRun("completed", "Options compared at each step.", ladder.map(s => [`Retry ${s.retry} alternatives`, s.alternatives.map(a => `${a.label} ${pct(a.p_answer)}`).join(" · ") || "—"]));
  nodes.r_estimate = stepRun("completed", "Scores for the chosen options.", ladder.map(s => [`Retry ${s.retry}`, `answer ${pct(s.p_answer)} · meeting if answered ${pct(s.p_meeting_if_answered)} · ${s.bucket}`]));
  nodes.r_choose = stepRun("completed", `Reach by retry ${ladder.length}: ${ladder.length ? pct(ladder[ladder.length - 1].cumulative_reach) : "—"}.`, ladder.map(s => [`Retry ${s.retry}`, `${when(s.at)} · ${s.title}`]));
  nodes.r_out = stepRun("completed", r?.approach?.summary ?? "", [["Approach", r?.approach?.strategy.replace(/_/g, " ") ?? "—"], ...ladder.map(s => [`Retry ${s.retry}`, when(s.at)] as [string, string])]);

  const notRun = (note: string): NodeRun => ({ status: "not_run", note, values: [] });
  if (!plan) {
    for (const id of ["b_outcome", "b_lookup", "b_sarvam", "b_context", "b_shortlist", "b_llm", "b_guard", "b_ladder", "b_out"]) nodes[id] = notRun("Runs only when the rep logs an unsuccessful call and clicks Plan retry with AI (Outcomes tab). Not run for this seller in this tab yet.");
  } else {
    const res = plan.this_call?.result;
    nodes.b_outcome = { status: "completed", note: `Outcome: ${plan.outcome.replace("_", " ")}.`, values: [["Outcome", plan.outcome.replace("_", " ")], ["Transcript", plan.this_call?.transcript_chars ? `${plan.this_call.transcript_chars} characters` : "none"]] };
    nodes.b_lookup = { status: "completed", note: "Reads the saved lookup (a fresh ERP lookup only if it is missing; which path ran is not recorded).", values: [] };
    nodes.b_sarvam = plan.this_call?.chat_model ? { status: "completed", note: res?.summary ?? "", values: [["Sentiment", `${res?.sentiment.replace(/_/g, " ")} (${res?.score})`], ["Callback", res?.callback.requested ? res.callback.when_text ?? "requested" : "none"]] } : { status: "skipped", note: "No transcript: the logged outcome stood in.", values: [["From outcome", res?.sentiment.replace(/_/g, " ") ?? "—"]] };
    nodes.b_context = { status: "completed", note: `Minimum wait ${plan.minimum_gap_minutes ?? "—"} min (${plan.gap_reason ?? ""}).`, values: [] };
    nodes.b_shortlist = { status: plan.candidates.length ? "completed" : "failed", note: `${plan.candidates.length} option(s).`, values: plan.candidates.slice(0, 6).map(c => [c.label, `${c.strategy.replace("_", " ")} · answer ${pct(c.p_answer)} · impact ${c.impact}`]) };
    nodes.b_llm = plan.source === "llm" ? { status: "completed", note: plan.reason, values: [["Model", plan.model ?? "—"], ["Factors used", plan.factors_used.join(", ") || "—"]] } : { status: plan.llm_note ? "failed" : "skipped", note: plan.llm_note ?? "Not run.", values: [] };
    nodes.b_guard = { status: "completed", note: plan.source === "llm" ? "LLM choice accepted." : "Rules choice used.", values: [["Retry 1", when(plan.call_at)], ["Rules engine choice", plan.rules_choice ? when(plan.rules_choice.call_at) : "—"]] };
    nodes.b_ladder = { status: plan.ladder.length > 1 ? "completed" : "skipped", note: `${Math.max(0, plan.ladder.length - 1)} further retries.`, values: plan.ladder.slice(1).map(s => [`Retry ${s.retry}`, `${when(s.at)} · ${s.strategy.replace("_", " ")}`]) };
    nodes.b_out = { status: plan.call_at ? "completed" : "failed", note: plan.reason, values: [["Call again", when(plan.call_at)], ["Decided by", plan.source === "llm" ? plan.model ?? "LLM" : "rules engine"]] };
  }
  const edges: Record<string, EdgeRun> = {};
  const executed = (id: string) => ["completed", "failed", "offline"].includes(nodes[id]?.status ?? "");
  for (const e of graph.edges) edges[e.id] = { active: executed(e.from) && executed(e.to), note: executed(e.from) && executed(e.to) ? "Used." : "Not used in this run." };
  if (first) edges.r_e12.sample = ladder.map(s => ({ retry: s.retry, at: s.at, strategy: s.strategy, after_minutes: s.after_minutes, p_answer: s.p_answer, p_meeting_if_answered: s.p_meeting_if_answered }));
  if (plan) edges.b_e7.sample = plan.candidates.slice(0, 3).map(c => ({ id: c.id, strategy: c.strategy, minutes_after_call: c.minutes_after_call, answer_chance: c.p_answer, meeting_chance_if_answered: c.p_meeting_if_answered, impact_score: c.impact }));
  if (plan) edges.b_e10.sample = { call_at: plan.call_at, source: plan.source, ladder: plan.ladder.map(s => ({ retry: s.retry, at: s.at, strategy: s.strategy })) };
  return { nodes, edges, recorded: true };
}

/** Grounded reasons for the final output, split by where each reason comes from. */
export function bestTimeReasons(row: SellerRow): { title: string; items: string[] }[] {
  const p = row.prediction;
  if (!p) return [{ title: "Limitation", items: ["No prediction was returned for this seller."] }];
  const conv = p.conversation, best = p.recommended_window, pl = p.pipeline;
  const evidence: string[] = [];
  if (conv?.callback) evidence.push(`The seller asked to be called back ${conv.callback.label ?? when(conv.callback.at)}${conv.callback.text ? ` ("${conv.callback.text}")` : ""}. ${best?.ranking?.callback_request ? "That window is the best time." : "It is outside what this plan can use (beyond the planning days or blocked), so the best time within them is shown."}`);
  if (conv?.asked_not_to_call) evidence.push("The latest analysed call asked not to be called again, so calling is paused.");
  if (conv?.latest) evidence.push(`Latest analysed call: ${conv.latest.sentiment.replace(/_/g, " ")} (score ${conv.latest.score}).`);
  if (!evidence.length) evidence.push("No transcript or recording evidence was available for this seller.");
  const model: string[] = [];
  if (p.ranking_strategy === "generalized_model" && best?.ranking) model.push(`General model (hour × day v4): calibrated proxy score ${(best.ranking.proxy_estimate ?? 0).toFixed(4)} for this weekday and hour, from ${best.support.toLocaleString("en-IN")} training calls.`);
  else if (p.ranking_strategy === "seller_meetings" || p.ranking_strategy === "seller_answers") model.push(`No ML model was needed: this seller's own history ranked the hours (best slot: ${best?.ranking?.answered_calls ?? 0} answered, ${best?.ranking?.linked_meetings ?? 0} linked meetings).`);
  else model.push("No model or seller evidence applied; the earliest allowed window is offered.");
  if (best?.ranking?.sentiment_factor && best.ranking.sentiment_factor !== 1) model.push(`Mood of earlier calls at this hour scaled its score ×${best.ranking.sentiment_factor.toFixed(2)}.`);
  const rules: string[] = [];
  if (pl) {
    rules.push(`${pl.candidates.total} window(s) passed the calling rules${pl.candidates.requested ? `, ${pl.candidates.requested} of them requested by the seller` : ""}.`);
    rules.push(`Minimum wait ${pl.context.minimum_wait_minutes} min (${pl.context.minimum_wait_reason}); earliest next call ${when(pl.context.not_before)}.`);
    if (pl.context.appointments) rules.push(`${pl.context.appointments} booked appointment(s) blocked overlapping windows.`);
    if (pl.context.do_not_call) rules.push("Do-not-call blocks every window.");
  }
  const decision = best ? [`${when(best.start)} – ${when(best.end).split(", ").pop()} · ${p.confidence.level.replace("_", " ")} confidence.`, p.explanation] : [p.explanation];
  return [{ title: "Evidence from calls (Sarvam)", items: evidence }, { title: "Model and ranking", items: model }, { title: "Business rules applied", items: rules.length ? rules : ["Not recorded for this response."] }, { title: "Final decision", items: decision }];
}

export function retryReasons(row: SellerRow, plan: AiRetryPlan | undefined): { title: string; items: string[] }[] {
  const r = row.prediction?.retry_plan;
  const out: { title: string; items: string[] }[] = [];
  if (r?.ladder?.length) out.push({ title: "Before calling: retry ladder", items: [...r.ladder.map(s => `Retry ${s.retry} · ${when(s.at)} · ${s.title}: ${s.reason}`), ...(r.approach ? [r.approach.summary] : [])] });
  else out.push({ title: "Before calling", items: [r?.reason ?? "No retry plan."] });
  if (r?.approach) out.push({ title: "Data behind the approach", items: r.approach.pointers.slice(0, 4) });
  out.push({ title: "After an unsuccessful call", items: plan ? [`Retry 1: ${when(plan.call_at)} — ${plan.reason}`, `Decided by ${plan.source === "llm" ? plan.model : "the rules engine"}${plan.llm_note ? ` (${plan.llm_note})` : ""}.`] : ["Not run yet for this seller. Log an unsuccessful call and click Plan retry with AI to see this path."] });
  return out;
}
