/* eslint-disable @typescript-eslint/no-require-imports -- Node server test harness. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('../scripts/server-loader.cjs');
const factors = loadServer('lib/seller-factors.ts');
const planner = loadServer('lib/retry-planner.ts');
const policy = loadServer('lib/best-time-policy.ts');
const retry = loadServer('lib/best-time-retry.ts');
const ladder = loadServer('lib/retry-ladder.ts');
const recordings = loadServer('lib/recordings.ts');
const sarvam = loadServer('lib/sarvam.ts');
const { predictionContext } = loadServer('lib/best-time-context.ts');

const TZ = 'Asia/Kolkata';
const AS_OF = '2026-10-05T08:30:00.000Z'; // Monday 14:00 IST
const days = (n) => new Date(Date.parse(AS_OF) - n * 86_400_000).toISOString();

function global(kyc = {}, tickets = {}) {
  return { glid: '1', status: 'success', mappingId: 'm', requestedSegments: [], fetchedAt: AS_OF, error: null, response: null, data: {
    kycdetails: { vertical_name: 'Furniture', customer_type: 'Paid', highest_service: 'MDC Pro', payment_plan: 'Annual', SERVICE_VINTAGE: '1 year 0 months and 0 days', high_churn: 'False', nach_status: [{ DIS_TEXT: 'Active' }], WIP_TICKET_BUCKET: [], customer_name: 'Someone', email1: 'x@y.z', ...kyc },
    activitydetails: { last_month: { bl_active_days: 6 }, top3mcat_data: [{ mcat_list: '[{"mcat_name": "Office Chair", "mcat_id": "1"},{"mcat_name": "Steel Almirah", "mcat_id": "2"}]' }] },
    ticketsdetails: { last_7_days: { irate_complaint_count: 0, negative_feedback_count: 0, ...tickets } },
  } };
}
function interaction(at, purpose, successful = null) { return { id: at, source: 'dsr', at, purpose, successful, mode: 'Physical', record: {} }; }
function user(calls = [], meetings = [], extra = {}) {
  return { glid: '1', createdAt: '2019-01-01', customerType: 'Paid', designation: null, lastLoginAt: null, glusr_usr: {}, company: [], assignments: [], historyFetched: true, callPolicy: { doNotCallMarkedAt: null },
    activity: { metrics: { callCount: calls.length, meetingCount: meetings.length, successfulMeetingCount: meetings.filter(m => m.successful).length, convertedCallCount: 0, callToMeetingPercent: null, unlinkedSuccessfulMeetingCount: 0 },
      lastCall: null, lastAssignedEmployeeCall: null, lastMeeting: meetings[0] ?? null, lastSuccessfulMeeting: meetings.find(m => m.successful) ?? null, calls, meetings, salesMeetings: [], relatedRecords: {}, successRule: '' }, ...extra };
}

test('seller factors read segment, lifecycle stage, last successful meeting and urgency without personal data', () => {
  const f = factors.sellerFactors(user([interaction(days(10), 'Upsell - fresh')], [interaction(days(12), 'Servicing', true)]), global(), AS_OF);
  assert.deepEqual(f.segment, { vertical: 'Furniture', products: ['Office Chair', 'Steel Almirah'], customer_type: 'Paid', service: 'MDC Pro', plan: 'Annual' });
  assert.deepEqual(f.stages, ['upsell']);
  assert.equal(f.service_days, 365);
  assert.equal(f.last_successful_meeting.days_ago, 12);
  assert.equal(f.urgency.level, 'normal');
  assert.ok(!JSON.stringify(f).includes('Someone') && !JSON.stringify(f).includes('x@y.z'));
  assert.equal(factors.vintageDays('0 year 2 months and 14 days'), 74);
  assert.equal(factors.vintageDays('7 Y 10 M'), 2855);

  const onboarding = factors.sellerFactors(user([interaction(days(3), 'Welcome call')]), global({ SERVICE_VINTAGE: '0 year 1 months and 2 days' }), AS_OF);
  assert.equal(onboarding.stage, 'new_onboarding');
  assert.equal(onboarding.urgency.level, 'high');
  assert.match(onboarding.urgency.reasons[0], /new onboarding \(32 days into the service\)/);

  const renewal = factors.sellerFactors(user(), global({ nach_status: [{ DIS_TEXT: 'Stopped - NACH Issues' }], high_churn: 'True' }), AS_OF);
  assert.ok(renewal.stages.includes('renewal'));
  assert.equal(renewal.risk.payment_issue, 'Stopped - NACH Issues');
  assert.deepEqual(renewal.urgency.reasons, ['renewal at risk (stopped - nach issues)', 'flagged as high churn risk']);

  const complaint = factors.sellerFactors(user(), global({ SERVICE_VINTAGE: '0 year 1 months and 0 days' }, { irate_complaint_count: 1 }), AS_OF);
  assert.equal(complaint.urgency.level, 'give_space');
  assert.equal(factors.retryDecay(complaint), 0.97);
  assert.equal(factors.retryDecay(onboarding), 0.75);
  assert.equal(factors.retryDecay(null), 0.9);
  assert.equal(factors.sellerFactors(undefined, undefined, AS_OF), null);
});

test('new sentiments: not the decision maker waits for them, and "do not call" stops calling', () => {
  assert.equal(sarvam.parseSentiment('{"sentiment":"gatekeeper","score":0,"summary":"Staff answered."}').sentiment, 'gatekeeper');
  const analysis = (sentiment) => ({ call_id: 'a', glid: '1', called_at: '2026-10-05T08:00:00.000Z', duration_seconds: 60, vendor: null, source_kind: 'manual', status: 'analyzed', status_detail: null,
    result: { sentiment, score: -0.2, summary: 's', callback: { requested: false, when_text: null, day: null, local_time: null }, meeting_intent: false, objections: [] }, language: null, transcript_chars: 10, stt_model: null, chat_model: 'x', analyzed_at: AS_OF });
  const gate = predictionContext('1', { ...user(), recordingAnalyses: [analysis('gatekeeper')] }, AS_OF, policy.DEFAULT_SCHEDULING);
  assert.deepEqual(policy.dynamicGap(gate, policy.DEFAULT_SCHEDULING), { minutes: 120, reason: 'the decision maker was unavailable on the last call' });
  const stop = predictionContext('1', { ...user(), recordingAnalyses: [analysis('do_not_call')] }, AS_OF, policy.DEFAULT_SCHEDULING);
  assert.equal(stop.do_not_call, true);
  assert.equal(stop.conversation.asked_not_to_call, true);
  assert.equal(policy.candidateWindows(stop, policy.DEFAULT_SCHEDULING).length, 0);
});

test('retry requests are validated', () => {
  const ok = planner.parseRetryRequest({ glid: '123', outcome: 'callback', transcript: ' hi \r\n there ', lookupId: '0e8b3f5e-1d2c-4a5b-9c8d-7e6f5a4b3c2d' }, AS_OF);
  assert.deepEqual(ok, { lookupId: '0e8b3f5e-1d2c-4a5b-9c8d-7e6f5a4b3c2d', glid: '123', outcome: 'callback', transcript: 'hi \n there', calledAt: AS_OF });
  assert.equal(planner.parseRetryRequest({ glid: '123', outcome: 'no_answer', lookupId: '../../etc/passwd' }, AS_OF).lookupId, null);
  assert.throws(() => planner.parseRetryRequest({ glid: 'abc', outcome: 'no_answer' }, AS_OF), /GLID/);
  assert.throws(() => planner.parseRetryRequest({ glid: '1', outcome: 'meeting_booked' }, AS_OF), /outcome/);
  assert.throws(() => planner.parseRetryRequest({ glid: '1', outcome: 'answered', transcript: 'x'.repeat(8001) }, AS_OF), /8000/);
  assert.throws(() => planner.parseRetryRequest({ glid: '1', outcome: 'answered', calledAt: '2026-10-09T00:00:00Z' }, AS_OF), /two days/);
});

function afterCall(outcome, callback, sellerUser = user(), g = global()) {
  const thisCall = planner.outcomeOnly(outcome, '1', AS_OF);
  if (callback) thisCall.result = { ...thisCall.result, sentiment: 'busy_callback', callback: { requested: true, when_text: 'kal subah 11 baje', day: 'tomorrow', local_time: '11:00', time_kind: 'at' } };
  const settings = { ...policy.DEFAULT_SCHEDULING, horizonDays: 7 };
  const context = planner.contextAfterCall(predictionContext('1', { ...sellerUser, recordingAnalyses: [thisCall] }, AS_OF, settings, g), AS_OF, outcome !== 'no_answer', settings);
  return { context, settings, ...planner.retryShortlist(context, settings, AS_OF) };
}
const ist = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

test('after an unanswered call the shortlist respects the dynamic wait; a requested callback leads it', () => {
  const missed = afterCall('no_answer');
  assert.equal(missed.context.last_unanswered_at, AS_OF);
  assert.equal(missed.context.attempts_today, 1);
  assert.ok(missed.candidates.length > 0 && missed.candidates.length <= 12);
  assert.ok(missed.candidates.every(c => Date.parse(c.start) >= Date.parse(AS_OF) + 15 * 60_000));
  assert.equal(missed.candidates.some(c => c.seller_requested), false);

  const asked = afterCall('callback', true);
  assert.equal(asked.rules.seller_requested, true);
  assert.equal(ist(asked.rules.start), 'Tue 11:00');
  assert.match(asked.rules.evidence, /asked/);
});

test('urgency changes the trade-off between a strong slot later and a weaker one sooner', () => {
  const w = (start, priority) => ({ id: start, start, end: start, timezone: TZ, score: null, support: 0, ranking: { source: 'seller_answers', priority_score: priority } });
  const soon = w('2026-10-05T11:30:00.000Z', 1000), later = w('2026-10-07T11:30:00.000Z', 1300); // today 5 PM vs Wednesday 5 PM, 30% stronger
  const best = (f) => { const impact = retry.retryImpact([soon, later], '2026-10-05', f); return impact(soon) >= impact(later) ? 'soon' : 'later'; };
  const urgent = factors.sellerFactors(user(), global({ SERVICE_VINTAGE: '0 year 0 months and 20 days' }), AS_OF);
  const calm = factors.sellerFactors(user(), global({}, { irate_complaint_count: 2 }), AS_OF);
  assert.equal(best(urgent), 'soon');
  assert.equal(best(null), 'later');
  assert.equal(best(calm), 'later');
  assert.match(retry.urgencyNote(urgent), /Retry sooner rather than later: new onboarding/);
  assert.match(retry.urgencyNote(calm), /Give the seller some space: 2 complaints/);
});

test("the LLM's choice must come from the shortlist, honour the seller's request and fall inside the window", () => {
  const { candidates } = afterCall('no_answer');
  // A slot lets the LLM choose the minute; an interval is fixed at its own time.
  const pick = candidates.find(c => c.strategy === 'best_slot' && Date.parse(c.end) - Date.parse(c.start) >= 30 * 60_000);
  const interval = candidates.find(c => c.strategy === 'interval');
  const fixed = planner.parseRetryChoice(JSON.stringify({ window_id: interval.id, time: '23:59', reason: 'Fifteen minutes after a miss is the strongest retry in the data.' }), candidates);
  assert.equal(fixed.call_at, interval.start);
  assert.equal(fixed.clamped, false);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.parse(pick.start) + 20 * 60_000));
  const ok = planner.parseRetryChoice(JSON.stringify({ window_id: pick.id, time, reason: 'They did not answer at lunch; this evening slot is when they usually pick up.', factors_used: ['answer_history', 'upsell stage'] }), candidates);
  assert.equal(ok.call_at, new Date(Date.parse(pick.start) + 20 * 60_000).toISOString());
  assert.equal(ok.clamped, false);
  assert.deepEqual(ok.factors_used, ['answer history', 'upsell stage']);
  const clamped = planner.parseRetryChoice(JSON.stringify({ window_id: pick.id, time: '03:00', reason: 'A reason that is long enough to keep.' }), candidates);
  assert.equal(clamped.call_at, pick.start);
  assert.equal(clamped.clamped, true);
  assert.throws(() => planner.parseRetryChoice(JSON.stringify({ window_id: '2030-01-01T00:00:00.000Z', time: '10:00', reason: 'A reason that is long enough to keep.' }), candidates), /outside the allowed shortlist/);
  assert.throws(() => planner.parseRetryChoice(JSON.stringify({ window_id: pick.id, reason: 'short' }), candidates), /no usable reason/);
  assert.throws(() => planner.parseRetryChoice('nothing', candidates), /no JSON/);
  // While the seller's requested time is ahead, the shortlist holds only options inside it; a forged outside option is rejected.
  const asked = afterCall('callback', true).candidates;
  assert.ok(asked.every(c => c.seller_requested));
  const other = { ...asked[0], id: '2026-10-05T12:00:00.000Z', start: '2026-10-05T12:00:00.000Z', end: '2026-10-05T13:00:00.000Z', seller_requested: false };
  asked.push(other);
  assert.throws(() => planner.parseRetryChoice(JSON.stringify({ window_id: other.id, time: '10:00', reason: 'Calling sooner keeps momentum with the seller.' }), asked), /ignored the time the seller asked for/);
});

test('the logged outcome stands in for a missing transcript', () => {
  assert.equal(planner.outcomeOnly('not_interested', '1', AS_OF).result.sentiment, 'not_interested');
  assert.equal(planner.outcomeOnly('callback', '1', AS_OF).result.sentiment, 'busy_callback');
  assert.equal(planner.outcomeOnly('no_answer', '1', AS_OF).result.sentiment, 'no_conversation');
  assert.equal(planner.outcomeOnly('answered', '1', AS_OF).chat_model, null);
  assert.equal(recordings.conversationSignals([planner.outcomeOnly('answered', '1', AS_OF)], AS_OF, TZ).latest.sentiment, 'neutral');
});

// Seller history helper: answered/unanswered calls at given local hours, a week before AS_OF.
function historyCalls(spec) {
  let id = 0;
  return spec.flatMap(([hour, answered, missed]) => [...Array(answered).fill(true), ...Array(missed).fill(false)].map(a => ({ id: String(++id), callKey: `call:${id}`, source: 'sts_dsr_call', startedAt: `2026-09-20T${String(hour).padStart(2, '0')}:05:00`, recordedAt: `2026-09-20T${String(hour).padStart(2, '0')}:06:00`, durationSeconds: a ? 90 : null, status: a ? 'Answered' : 'NotAnswered', record: { sts_dsr_call_result: a ? 2 : 1 } })));
}

test('retry data: short intervals win after a miss, answer chances fall with each miss, and the ladder explains itself', () => {
  const ctx = predictionContext('1', user(historyCalls([[11, 1, 6], [15, 1, 5], [17, 1, 4]])), AS_OF, policy.DEFAULT_SCHEDULING, global());
  const plan = ladder.retryLadder(ctx, '2026-10-05T09:30:00.000Z', policy.DEFAULT_SCHEDULING); // first call 3 PM IST
  assert.equal(ladder.sellerPropensity(ctx).tier, 'low');
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.steps[0].strategy, 'interval');
  assert.ok(plan.steps[0].after_minutes <= 45);
  assert.deepEqual(plan.steps.map(s => s.misses_before), [1, 2, 3, 4]);
  for (let i = 1; i < plan.steps.length; i++) {
    assert.ok(Date.parse(plan.steps[i].at) > Date.parse(plan.steps[i - 1].at));
    assert.ok(plan.steps[i].cumulative_reach > plan.steps[i - 1].cumulative_reach);
  }
  // The 3-a-day cap (first call + 2 retries) moves the third retry to another day.
  assert.notEqual(plan.steps[2].at.slice(0, 10), plan.steps[0].at.slice(0, 10));
  assert.equal(plan.steps[2].strategy, 'best_slot');
  assert.match(plan.steps[0].reason, /first retries made after \d+ minutes were answered \d+% in ERP data \(n=/);
  assert.match(plan.steps[0].evidence[0], /^Estimated answer chance \d+%: low-propensity sellers answer/);
  assert.match(plan.steps[0].evidence.find(e => e.startsWith('Compared')), /Compared: .+ \d+%/);
  assert.equal(plan.approach.strategy, 'interval_first');
  assert.match(plan.approach.pointers.join(' '), /answered 3 of 18 calls \(17%\), a low-propensity seller/);
  assert.match(plan.approach.pointers.join(' '), /led to a successful meeting 19%/);
});

test('retry estimates follow the data: 15 minutes beats an immediate redial and the next day, and later misses answer less', () => {
  const ctx = predictionContext('1', user(), AS_OF, policy.DEFAULT_SCHEDULING, global());
  const prop = ladder.sellerPropensity(ctx), from = Date.parse('2026-10-05T06:30:00.000Z'); // noon IST
  const at = (m) => ladder.estimateRetry(ctx, prop, 1, from, from + m * 60_000).p_answer;
  assert.ok(at(15) > at(5));
  assert.ok(at(15) > ladder.estimateRetry(ctx, prop, 1, from, from + 86_400_000).p_answer);
  assert.ok(ladder.estimateRetry(ctx, prop, 1, from, from + 15 * 60_000).p_answer > ladder.estimateRetry(ctx, prop, 4, from, from + 15 * 60_000).p_answer);
  assert.equal(ladder.retryBucket(from, from + 15 * 60_000, TZ), '15m');
  assert.equal(ladder.retryBucket(from, from + 26 * 3_600_000, TZ), 'next_day');
});

test('after a requested callback time the ladder retries at intervals inside it before anything else', () => {
  const asked = afterCall('callback', true);
  const plan = ladder.retryLadder(asked.context, asked.rules.start, asked.settings, { steps: 2, initialMisses: 2 });
  assert.ok(plan.steps.length >= 1);
  assert.equal(plan.steps[0].strategy, 'interval');
  assert.ok(Date.parse(plan.steps[0].at) < Date.parse('2026-10-06T06:30:00.000Z')); // still inside 11 AM to 12 PM
});

test('hours a seller answered before never extend calling past 9 PM or before 8 AM', () => {
  const ctx = predictionContext('1', user(historyCalls([[23, 3, 0], [7, 2, 0], [20, 2, 0]])), AS_OF, policy.DEFAULT_SCHEDULING, global());
  const hours = new Set(policy.candidateWindows(ctx, policy.DEFAULT_SCHEDULING).map(w => policy.localParts(w.start, TZ).hour));
  assert.ok(hours.has(20));
  assert.ok(!hours.has(23) && !hours.has(7));
});
