# Retry ladder: interval or next best slot?

After an unanswered call there are two ways to retry: call again after a short **interval**
(+15, +30 … minutes) while the seller may still be near the phone, or wait for the seller's
**next best slot** later that day or on another day. The right choice differs by seller and by
case. Callwise decides it step by step from ERP retry data, for up to four retries.

## The data

`ml/research/retry_policy.py` reads the pseudonymised research-v4 extract. It covers 930,997
outbound click-to-call rows for 208,572 sellers, 11 Aug – 3 Oct 2026, plus DSR meetings. It writes
aggregates only to `ml/retry/retry-policy.json`.

A *retry* is a call whose previous call to the same seller was unanswered, within 7 days.
That gives 415,399 retries. *Meeting* means a successful ERP meeting (physical, or verified video)
within 14 days.

### Answer rate of the next attempt, by wait and by how many misses came before

| Wait after the miss | 1st retry | 2nd retry | 3rd retry | 4th+ retry |
|---|---|---|---|---|
| 5 min (instant redial) | 33.6% | 28.7% | 22.6% | 14.9% |
| **15 min** | **47.3%** | **38.8%** | **34.3%** | **22.0%** |
| 30 min | 42.2% | 34.6% | 28.4% | 19.3% |
| 60 min | 37.7% | 31.4% | 24.3% | 18.5% |
| 2 h | 38.9% | 30.2% | 23.6% | 15.7% |
| 4 h | 36.0% | 27.3% | 25.3% | 13.8% |
| Next day | 32.7% | 23.6% | 19.5% | 13.3% |

The 1st-retry rates at 15 min, 5 min and next day rest on 7,008, 52,845 and 37,570 retries.

### Sellers differ

Sellers are grouped by their answer rate on earlier calls:

| Seller tier | Answer rate after 15 min | Answer rate next day |
|---|---|---|
| Low (< 25%) | 21.7% | 12.8% |
| Mid (25–50%) | 37.4% | 27.8% |
| High (≥ 50%) | 52.1% | 49.8% |

For low- and mid-propensity sellers, a short interval matters a lot. For high-propensity sellers,
timing barely changes the answer rate, so a strong slot can win.

### Waiting costs meetings, not just answers

When a retry is answered, the share that led to a successful meeting within 14 days falls with
the wait:

| Wait before the answered retry | Led to a meeting |
|---|---|
| 15–45 min | 19–20% |
| 60 min | 14% |
| Next day | 12% |
| 2–3 days | 9% |
| 4–7 days | 8% |

The pattern holds over whole sequences: when the first retry came within 1–4 hours, 73% of
sequences reached the seller and 12.9% ended in a meeting. When it came the next day, 58% reached
the seller and 7.6% ended in a meeting.

### Hour of the retry

Answer rate relative to the average hour: 8 PM ×1.33, 7 PM ×1.07, 9 AM ×0.86, 10 AM ×0.94.

## How the ladder decides

For each retry after a missed attempt, every allowed option is scored:

- every interval of +15, +30, +45, +60, +90, +120, +180 or +240 minutes that lands inside calling
  hours;
- every allowed slot over the next few days.

Each option's score is the expected meetings per attempt:

```
P(answer) × P(meeting | answered) × urgency discount per day of delay
```

P(answer) multiplies four parts, all shown in the UI as proof:

1. the seller tier's rate for that wait;
2. the adjustment for which retry this is;
3. the hour factor;
4. this seller's own answer rate at that hour, shrunk toward their average with 5 pseudo-calls
   and capped at ×0.7–1.4.

The urgency discount depends on the seller factors:

| Seller situation | Discount per day of delay |
|---|---|
| New onboarding, renewal or churn risk | 25% |
| Complaints or a negative last call (give space) | 3% |
| Otherwise | 10% |

The best option is chosen. The engine then plans the next retry as if that one were missed too,
up to four retries.

The limits are hard rules, and the ladder never breaks them:

- calling hours (answered-before hours may extend them, but only between 8 AM and 9 PM);
- business days and appointments;
- at most `maxAttemptsPerDay` attempts a day, and the 7-day sequence cap;
- do-not-call marks;
- a minimum wait set by what the seller said: 2 h if busy or the decision maker was away, 1 day
  after a negative call.

**A time the seller asked for** comes first. The first retry goes to that time. While the requested
range lasts, later retries stay inside it, usually at short intervals.

After an unsuccessful call is logged, the AI retry planner (sarvam-105b) chooses retry 1 from this
data-scored shortlist and explains the choice. The ladder then plans retries 2–4 from that time.

## Caveat

These are observational associations. Reps chose when to retry, so some of the effect may reflect
their judgement. The ladder uses them to rank options and shows the numbers, not as guaranteed
outcomes. A randomised pilot of interval vs. slot retries would measure the causal lift.
