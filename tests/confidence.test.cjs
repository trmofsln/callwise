/* eslint-disable @typescript-eslint/no-require-imports -- Node server test harness. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('../scripts/server-loader.cjs');
const policy = loadServer('lib/best-time-policy.ts');
const service = loadServer('lib/best-time-service.ts');

const noModels = { history_aware: null, cold_start: null, issues: ['No approved artifact.'] };
function slot(hour, { calls = 6, answered = 0, meetings = 0, actual = calls, short = 0 } = {}) {
  return { hour, calls, answered_calls: answered, short_calls: short, known_answered_durations: answered, linked_meetings: meetings,
    converted_calls: meetings, actual_time_calls: actual, recorded_time_calls: calls - actual, actual_answered_calls: Math.min(answered, actual) };
}
function context(slots) {
  const sum = key => slots.reduce((n, s) => n + s[key], 0);
  return { context_id: 'confidence-test', glid: '123', as_of: '2026-10-05T03:30:00Z', timezone: 'Asia/Kolkata', history_status: 'verified',
    history_scope: 'test fixture only', first_contact_verified: true, prior_calls: sum('calls'), recent_attempts: 0, attempts_today: 0,
    last_call_at: null, last_unanswered_at: null, do_not_call: false, appointments: [], metadata: {}, issues: [], proxy_completed_meetings: sum('linked_meetings'),
    seller_history: { slots, timed_calls: sum('calls'), actual_time_calls: sum('actual_time_calls'), recorded_time_calls: sum('recorded_time_calls'),
      answered_calls: sum('answered_calls'), linked_meetings: sum('linked_meetings'), unlinked_meetings: 0, short_calls: 0 } };
}
const predict = c => service.deterministicPrediction(c, policy.DEFAULT_SCHEDULING, noModels);

test('meeting history with enough slot evidence at actual dial times is high', () => {
  const c = context([slot(11, { answered: 5, meetings: 2 })]);
  const p = predict(c);
  assert.equal(p.ranking_strategy, 'seller_meetings');
  assert.equal(p.confidence.level, 'high');
  assert.equal(p.confidence.calibrated, false);
  assert.match(p.confidence.reason, /2 linked meetings and 5 answered calls, 100% timed by actual dial starts/);
  assert.deepEqual(service.validatePrediction(p, c, policy.DEFAULT_SCHEDULING, noModels), []);
});

test('meeting history that relies mostly on approximate DSR times stays moderate', () => {
  const p = predict(context([slot(11, { answered: 5, meetings: 2, actual: 1 })]));
  assert.equal(p.ranking_strategy, 'seller_meetings');
  assert.equal(p.confidence.level, 'moderate');
  assert.match(p.confidence.reason, /approximate DSR entry times/);
});

test('meeting history spread thinly across slots stays moderate and says what high needs', () => {
  const p = predict(context([slot(11, { answered: 3, meetings: 1 }), slot(15, { answered: 3, meetings: 1 })]));
  assert.equal(p.ranking_strategy, 'seller_meetings');
  assert.equal(p.confidence.level, 'moderate');
  assert.match(p.confidence.reason, /High needs at least 2 linked meetings or 5 answered calls/);
});

test('answer-only history stays moderate however many answers there are', () => {
  const p = predict(context([slot(11, { calls: 20, answered: 18 })]));
  assert.equal(p.ranking_strategy, 'seller_answers');
  assert.equal(p.confidence.level, 'moderate');
});

test('strong meeting history at actual dial times is very high', () => {
  const four = predict(context([slot(11, { answered: 6, meetings: 4 })]));
  assert.equal(four.confidence.level, 'very_high');
  const answered = predict(context([slot(11, { calls: 12, answered: 10, meetings: 2 })]));
  assert.equal(answered.confidence.level, 'very_high');
  const mostlyTimed = predict(context([slot(11, { answered: 6, meetings: 4, actual: 4 })]));
  assert.equal(mostlyTimed.confidence.level, 'high');
  assert.match(mostlyTimed.confidence.reason, /Very high needs 4 linked meetings/);
});

test('no usable evidence and no model is insufficient', () => {
  const p = predict(context([]));
  assert.equal(p.ranking_strategy, 'operating_hours');
  assert.equal(p.confidence.level, 'insufficient');
});

test('insight gives a short headline and plain-language facts from history', () => {
  const p = predict(context([slot(11, { answered: 5, meetings: 2 })]));
  assert.match(p.insight.title, /^Books meetings around 11 AM$/);
  assert.ok(p.insight.title.length <= 40);
  assert.ok(p.insight.details.length >= 1 && p.insight.details.length <= 5);
  assert.match(p.insight.details[0], /answered 5 of 6 calls, and 2 meetings came from calls at this time/);
  const fresh = predict(context([]));
  assert.equal(fresh.insight.title, 'Fresh start: first open slot');
  const blocked = service.deterministicPrediction({ ...context([]), do_not_call: true }, policy.DEFAULT_SCHEDULING, noModels);
  assert.equal(blocked.insight.title, 'Calling paused for now');
});
