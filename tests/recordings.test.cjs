/* eslint-disable @typescript-eslint/no-require-imports -- Node server test harness. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('../scripts/server-loader.cjs');
const recordings = loadServer('lib/recordings.ts');
const sarvam = loadServer('lib/sarvam.ts');
const policy = loadServer('lib/best-time-policy.ts');
const service = loadServer('lib/best-time-service.ts');
const callContext = loadServer('lib/call-context.ts');

const noModels = { history_aware: null, cold_start: null, issues: ['No approved artifact.'] };
const TZ = 'Asia/Kolkata';

test('recording URLs are routed by vendor and only https known hosts are allowed', () => {
  assert.deepEqual(recordings.recordingSource('https://openapi.airtel.in/gateway/airtel-xchange/x'), { kind: 'airtel', allowed: true });
  assert.deepEqual(recordings.recordingSource('https://storage.googleapis.com/b/o.mp3'), { kind: 'gcs', allowed: true });
  assert.deepEqual(recordings.recordingSource('https://squadiq-call-recs.s3.amazonaws.com/a.mp3'), { kind: 's3', allowed: true });
  assert.equal(recordings.recordingSource('http://openapi.airtel.in/x').allowed, false);
  assert.equal(recordings.recordingSource('https://169.254.169.254/latest').allowed, false);
  assert.equal(recordings.recordingSource('not a url').allowed, false);
});

test('Airtel recordings without configured credentials are reported, not fetched', async () => {
  const previous = process.env.AIRTEL_RECORDING_HEADERS;
  delete process.env.AIRTEL_RECORDING_HEADERS;
  const result = await recordings.downloadRecording('https://openapi.airtel.in/gateway/x', '1');
  if (previous !== undefined) process.env.AIRTEL_RECORDING_HEADERS = previous;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_credentials');
});

test('Sarvam output is validated and normalised, including how the client asked to be called back', () => {
  const r = sarvam.parseSentiment('noise {"sentiment":"busy_callback","score":3,"summary":"  Client was busy.  ","callback":{"requested":true,"when_text":"call after 7:30 in the evening","local_time":"19:30","time_kind":"After","part_of_day":"evening","day":"Sunday","after_days":"x"},"meeting_intent":false,"objections":["a","b","c","d"],"key_points":["Needs 500 units","Wants a quotation"]} trailing');
  assert.equal(r.sentiment, 'busy_callback');
  assert.equal(r.score, 1);
  assert.equal(r.summary, 'Client was busy.');
  assert.deepEqual(r.callback, { requested: true, when_text: 'call after 7:30 in the evening', day: 'sunday', date: null, after_days: null, after_minutes: null, local_time: '19:30', time_kind: 'after', part_of_day: 'evening', relative: null });
  assert.equal(r.objections.length, 3);
  assert.deepEqual(r.key_points, ['Needs 500 units', 'Wants a quotation']);
  const later = sarvam.parseSentiment('{"sentiment":"neutral","score":0,"summary":"x","callback":{"requested":true,"local_time":"25:99","after_days":5,"date":"2026-13-45"}}').callback;
  assert.equal(later.local_time, null);
  assert.equal(later.time_kind, null);
  assert.equal(later.after_days, 5);
  assert.equal(later.date, null);
  assert.equal(sarvam.parseSentiment('{"sentiment":"neutral","score":0,"summary":"x","callback":{"requested":true,"local_time":"13:00"}}').callback.time_kind, 'at');
  assert.throws(() => sarvam.parseSentiment('{"sentiment":"ecstatic","score":1}'));
  assert.throws(() => sarvam.parseSentiment('no json'));
});

const cbReq = (fields) => ({ requested: true, when_text: null, day: null, date: null, after_days: null, after_minutes: null, local_time: null, time_kind: null, part_of_day: null, relative: null, ...fields });

test('callback requests resolve to local time ranges relative to the call they were made in', () => {
  // Monday 5 Oct 2026, 10:00 IST
  const said = '2026-10-05T04:30:00.000Z', w = (fields) => recordings.resolveCallbackWindow(said, cbReq(fields), TZ);
  assert.deepEqual(w({ day: 'tomorrow', local_time: '16:00', time_kind: 'at' }), { start: '2026-10-06T10:30:00.000Z', end: '2026-10-06T11:30:00.000Z', precision: 'exact' });
  assert.deepEqual(w({ day: 'sunday', part_of_day: 'evening' }), { start: '2026-10-11T10:30:00.000Z', end: '2026-10-11T14:30:00.000Z', precision: 'range' });
  assert.deepEqual(w({ local_time: '19:30', time_kind: 'after' }), { start: '2026-10-05T14:00:00.000Z', end: '2026-10-05T16:00:00.000Z', precision: 'range' });
  assert.deepEqual(w({ local_time: '13:00', time_kind: 'before' }), { start: '2026-10-05T04:30:00.000Z', end: '2026-10-05T07:30:00.000Z', precision: 'range' });
  assert.equal(w({ local_time: '09:00', time_kind: 'at' }).start, '2026-10-06T03:30:00.000Z'); // 9 AM already passed: next day
  assert.deepEqual(w({ after_days: 5 }), { start: '2026-10-09T18:30:00.000Z', end: '2026-10-13T18:30:00.000Z', precision: 'on_or_after' });
  assert.deepEqual(w({ day: 'thursday' }), { start: '2026-10-07T18:30:00.000Z', end: '2026-10-08T18:30:00.000Z', precision: 'day' });
  assert.deepEqual(w({ after_minutes: 120 }), { start: '2026-10-05T06:30:00.000Z', end: '2026-10-05T07:30:00.000Z', precision: 'exact' });
  assert.equal(w({}), null);
  // Soft deferrals: "month end" opens three days before the month ends, "next month" on the 1st, "next week" next Monday.
  assert.deepEqual(w({ relative: 'month_end' }), { start: '2026-10-28T18:30:00.000Z', end: '2026-11-01T18:30:00.000Z', precision: 'on_or_after' });
  assert.equal(w({ relative: 'next_month' }).start, '2026-10-31T18:30:00.000Z');
  assert.equal(w({ relative: 'next_week' }).start, '2026-10-11T18:30:00.000Z');
  assert.equal(recordings.callbackLabel(w({ relative: 'month_end' }), cbReq({ relative: 'month_end' }), TZ), 'month end (from Thu, 29 Oct)');
  const window = w({ day: 'sunday', local_time: '19:30', time_kind: 'after' });
  assert.equal(recordings.callbackLabel(window, cbReq({ local_time: '19:30', time_kind: 'after' }), TZ), 'Sun, 11 Oct after 7:30 PM');
  assert.equal(recordings.callbackLabel(w({ after_days: 5 }), cbReq({ after_days: 5 }), TZ), 'after 5 days (from Sat, 10 Oct)');
});

function analysis(id, at, sentiment, score, callback = cbReq({ requested: false })) {
  return { call_id: id, glid: '1', called_at: at, duration_seconds: 60, vendor: 'Airtel', source_kind: 'airtel', status: 'analyzed', status_detail: null,
    result: { sentiment, score, summary: `${sentiment} call.`, callback, meeting_intent: sentiment === 'enthusiastic', objections: [] },
    language: 'hi-IN', transcript_chars: 400, stt_model: 'saaras:v4', chat_model: 'sarvam-105b', analyzed_at: at };
}

test('conversation signals summarise analysed calls and keep only future callbacks', () => {
  const asOf = '2026-10-05T05:00:00.000Z';
  const list = [
    analysis('1', '2026-10-01T05:30:00.000Z', 'interested', 0.6),
    analysis('2', '2026-10-05T04:30:00.000Z', 'busy_callback', -0.1, cbReq({ when_text: 'kal 4 baje', local_time: '16:00', time_kind: 'at', day: 'tomorrow' })),
    { ...analysis('3', '2026-10-03T05:30:00.000Z', 'neutral', 0), status: 'needs_credentials', result: null },
  ];
  const s = recordings.conversationSignals(list, asOf, TZ);
  assert.equal(s.analyzed, 2);
  assert.deepEqual(s.counts, { busy_callback: 1, interested: 1 });
  assert.equal(s.latest.sentiment, 'busy_callback');
  assert.equal(s.callback.at, '2026-10-06T10:30:00.000Z');
  assert.equal(s.recent_negative, false);
  assert.equal(recordings.conversationSignals([], asOf, TZ), null);
  assert.equal(s.callback.precision, 'exact');
  assert.equal(s.callback.label, 'tomorrow at 4 PM');
  // A later real conversation supersedes an older callback request.
  const superseded = recordings.conversationSignals([...list, analysis('4', '2026-10-05T04:45:00.000Z', 'interested', 0.5)], asOf, TZ);
  assert.equal(superseded.callback, null);
  const negative = recordings.conversationSignals([analysis('9', '2026-10-04T05:30:00.000Z', 'not_interested', -0.9)], asOf, TZ);
  assert.equal(negative.recent_negative, true);
});

function baseContext(extra = {}) {
  return { context_id: 'rec-test', glid: '1', as_of: '2026-10-05T03:30:00Z', timezone: TZ, history_status: 'verified', history_scope: 'test',
    first_contact_verified: true, prior_calls: 3, recent_attempts: 1, attempts_today: 0, last_call_at: '2026-10-04T05:00:00Z', last_unanswered_at: null,
    do_not_call: false, appointments: [], metadata: {}, issues: [], proxy_completed_meetings: 0, ...extra };
}

test('the minimum wait is a floor set by what the client said; the retry ladder chooses intervals from data', () => {
  const s = policy.DEFAULT_SCHEDULING;
  const calls = n => Array.from({ length: n }, (_, i) => ({ at: `2026-10-0${i + 1}T05:00:00Z`, answered: false }));
  // Misses no longer back off on a fixed schedule: retry data shows short intervals stay the most productive.
  assert.deepEqual([1, 2, 3, 4, 5].map(n => policy.dynamicGap(baseContext({ scheduling_calls: calls(n) }), s).minutes), [15, 15, 15, 15, 15]);
  const busy = { analyzed: 1, counts: { busy_callback: 1 }, average_score: 0, latest: { sentiment: 'busy_callback', score: 0, summary: '', at: '2026-10-05T03:00:00Z' }, callback: null, meeting_intent: false, hour_scores: {}, recent_negative: false };
  assert.deepEqual(policy.dynamicGap(baseContext({ conversation: busy }), s), { minutes: 120, reason: 'they said they were busy on the last call' });
  assert.equal(policy.dynamicGap(baseContext({ conversation: { ...busy, recent_negative: true } }), s).minutes, 1440);
  assert.deepEqual(policy.dynamicGap(baseContext(), { ...s, cooldownMinutes: 90 }), { minutes: 90, reason: 'configured minimum gap' });
});

// Plans built end to end from analysed calls: analyses -> signals -> context -> plan. Monday 5 Oct 2026, 09:00 IST.
const AS_OF = '2026-10-05T03:30:00.000Z';
function planFor(callback, { settings = {}, sentiment = 'busy_callback', calledAt = '2026-10-05T03:00:00.000Z', manual = true } = {}) {
  const a = { ...analysis('m1', calledAt, sentiment, 0.1, cbReq(callback)), source_kind: manual ? 'manual' : 'airtel' };
  const conversation = recordings.conversationSignals([a], AS_OF, TZ);
  const c = baseContext({ as_of: AS_OF, conversation });
  const s = { ...policy.DEFAULT_SCHEDULING, ...settings };
  const p = service.deterministicPrediction(c, s, noModels);
  assert.deepEqual(service.validatePrediction(p, c, s, noModels), []);
  return { p, c, conversation };
}
const ist = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

test('a specific callback time inside the horizon is the best time, whatever the model prefers', () => {
  const { p, conversation } = planFor({ when_text: 'kal 4 baje', day: 'tomorrow', local_time: '16:00', time_kind: 'at' });
  assert.equal(p.recommended_window.start, '2026-10-06T10:30:00.000Z');
  assert.equal(p.recommended_window.ranking.callback_request, true);
  assert.equal(p.confidence.level, 'very_high');
  assert.equal(p.insight.title, 'Asked for a call at 4 PM');
  assert.match(p.explanation, /^On the last call the client asked to be called back tomorrow at 4 PM \("kal 4 baje"\), so this plan calls at that time\./);
  assert.ok(p.insight.details.some(d => /Sarvam AI read 1 call transcript/.test(d)));
  assert.deepEqual(p.conversation, conversation);
});

test('a requested Sunday evening is honoured outside configured days and hours; the model picks the hour', () => {
  const { p } = planFor({ when_text: 'Sunday shaam ko', day: 'sunday', part_of_day: 'evening' });
  assert.match(ist(p.recommended_window.start), /^Sun (16|17|18|19):00$/);
  assert.ok(p.ranked_windows.every(w => /^Sun (16|17|18|19):00$/.test(ist(w.start)) && w.ranking.callback_request));
  assert.equal(p.recommended_window.outside_configured_hours, ist(p.recommended_window.start) >= 'Sun 18:00');
  assert.equal(p.confidence.level, 'high');
  assert.match(p.insight.title, /^Asked for a call Sun, 11 Oct evening$/);
});

test('"after 7:30 PM" starts the plan at 7:30 PM that evening', () => {
  const { p } = planFor({ when_text: 'after 7:30 PM', local_time: '19:30', time_kind: 'after' });
  assert.equal(ist(p.recommended_window.start), 'Mon 19:30');
  assert.equal(p.ranked_windows[1] && ist(p.ranked_windows[1].start), 'Mon 20:30');
  // If unanswered, the retry stays inside what the client asked for.
  // Data-driven ladder: +30 min lands on 8 PM, where retries are answered 1.33x the average hour; it stays inside the requested range.
  assert.equal(ist(p.retry_plan.next_call_at), 'Mon 20:00');
  assert.equal(p.retry_plan.ladder[0].after_minutes, 30);
  // While the requested range (7:30 to 9:30 PM) lasts, retries stay inside it; the 3-a-day cap then moves the next one to tomorrow's best slot.
  assert.deepEqual(p.retry_plan.ladder.map(step => [ist(step.at), step.strategy]).slice(0, 3), [['Mon 20:00', 'interval'], ['Mon 20:15', 'interval'], ['Tue 12:00', 'best_slot']]);
});

test('a callback beyond the planning horizon leaves the model to choose within it and says so', () => {
  const { p } = planFor({ when_text: 'paanch din baad', after_days: 5 }, { settings: { horizonDays: 2 } });
  assert.equal(p.recommended_window.ranking.callback_request, false);
  assert.ok(Date.parse(p.recommended_window.start) < Date.parse('2026-10-06T18:30:00.000Z'));
  assert.match(p.explanation, /asked to be called back after 5 days \(from Sat, 10 Oct\) \("paanch din baad"\), which is beyond the 2 days being planned, so this is the best time within that period\./);
  assert.notEqual(p.confidence.level, 'very_high');
  // With a long enough horizon, the first configured calling day from day 5 is used.
  const { p: wide } = planFor({ after_days: 5 }, { settings: { horizonDays: 7 } });
  assert.equal(ist(wide.recommended_window.start).slice(0, 3), 'Sat');
  assert.equal(wide.recommended_window.ranking.callback_request, true);
});

test('pasted call context is validated and belongs to a GLID in the queue', () => {
  const asOf = '2026-10-05T03:30:00.000Z', glids = ['111', '222'];
  assert.equal(callContext.parseCallContext(undefined, glids, asOf), null);
  assert.equal(callContext.parseCallContext({ calls: [{ text: '   ' }] }, glids, asOf), null);
  assert.deepEqual(callContext.parseCallContext({ calls: [{ text: ' Call me at 4 ' }, { text: 'x', at: '2026-10-04T18:00' }] }, glids, asOf), { glid: '111', calls: [{ text: 'Call me at 4', at: null }, { text: 'x', at: '2026-10-04T12:30:00.000Z' }] });
  assert.equal(callContext.parseCallContext({ glid: '0222', calls: [{ text: 'hi' }] }, glids, asOf).glid, '222');
  assert.throws(() => callContext.parseCallContext({ glid: '333', calls: [{ text: 'hi' }] }, glids, asOf), /one of the GLIDs/);
  assert.throws(() => callContext.parseCallContext({ calls: [{ text: 'hi', at: '2026-10-06T10:00' }] }, glids, asOf), /future/);
  assert.throws(() => callContext.parseCallContext({ calls: Array.from({ length: 11 }, () => ({ text: 'hi' })) }, glids, asOf), /at most 10/);
  assert.throws(() => callContext.parseCallContext({ calls: [{ text: 'x'.repeat(8001) }] }, glids, asOf), /longer than/);
});

test('pasted calls without a key are reported as failed analyses, in order, dated just before the lookup', async () => {
  const previous = process.env.SARVAM_API_KEY;
  delete process.env.SARVAM_API_KEY;
  try {
    const out = await callContext.analyzeCallContext({ glid: '1', calls: [{ text: 'first call', at: null }, { text: 'second call', at: null }] }, '2026-10-05T03:30:00.000Z');
    assert.deepEqual(out.map(a => [a.status, a.source_kind, a.called_at, a.vendor]), [
      ['analysis_failed', 'manual', '2026-10-05T03:29:00.000Z', 'Call 1 · pasted transcript'],
      ['analysis_failed', 'manual', '2026-10-05T03:30:00.000Z', 'Call 2 · pasted transcript'],
    ]);
  } finally { if (previous !== undefined) process.env.SARVAM_API_KEY = previous; }
});

test('windows already under way stay usable when enough of the hour remains', () => {
  const c = baseContext({ as_of: '2026-10-05T05:40:00Z', last_call_at: null, prior_calls: 0, recent_attempts: 0 }); // 11:10 IST
  const first = policy.candidateWindows(c, policy.DEFAULT_SCHEDULING)[0];
  assert.equal(first.start, '2026-10-05T05:41:00.000Z'); // 11:11 IST, part-way into the 11:00 hour
  assert.equal(first.end, '2026-10-05T06:30:00.000Z');
  const late = policy.candidateWindows(baseContext({ as_of: '2026-10-05T06:15:00Z', last_call_at: null, prior_calls: 0, recent_attempts: 0 }), policy.DEFAULT_SCHEDULING)[0];
  assert.equal(late.start, '2026-10-05T06:30:00.000Z'); // only 14 minutes of the 11:00 hour left, so 12:00 is next
});
