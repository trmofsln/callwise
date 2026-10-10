# Personal calling-slot ranking

The 141-call regression was caused by a blanket scheduling gate: a recent DSR row without an actual call-start timestamp changed the entire history status to missing. A successful database fetch now remains verified when timing is partial. Approximate DSR entry clocks are disclosed, never presented as actual starts or canonical completion probabilities.

The live hierarchy is:

1. At least two distinct calls linked to successful ERP meetings enable personal meeting ranking. Hours with more linked successes rank higher after the short-call discount; answered-call evidence breaks ties.
2. If meeting evidence is inconclusive, at least three historical answered calls with at least two in one hour enable personal answer-count ranking.
3. If both signals are inconclusive, use a supported approved canonical artifact if available, otherwise the frozen general ERP time model as advisory ranking. This also covers new sellers with a successful empty history fetch. The separate first-contact experiment remains unused because its locked test has zero positives and failed support.
4. If supported model artifacts are absent or invalid, return eligible configured-hour alternatives with explicit limited evidence.

Only known answered durations below 20 seconds count as short conversations. A slot's penalty is 0.75 times short answered calls / known answered durations; unknown duration is excluded from that denominator. Meeting counts and answered counts receive this discount before ranking. Personal ranking is an explicit historical heuristic, not a newly trained or calibrated probability model.

Meaningful call keys deduplicate C2C/DSR records; actual outbound C2C start times take precedence over DSR entry clocks. DSR Talked / Talked-and-appointment results supply answered evidence. Direct seller-filtered meeting links are preferred; reverse links are allowed when no direct link conflicts. Successful meetings with no usable call link cannot establish a clock slot. Incoming records are excluded from outbound slot evidence. A future actual start is not silently replaced by an entry clock.

Configured hours and historical answered hours are eligible candidates on allowed business days. Recommendations still respect DNC, failed history/contact-policy retrieval, cooldowns and appointments. A dated appointment with an unknown time excludes only its date; default times without dates do not create appointments. Attempt caps count recent attempts after confirmed contact, not lifetime calls, and future windows become eligible as old attempts leave the rolling lookback.

The API returns daily_windows with up to maxSlotsPerDay (3 or 4) slots per local date, ranked_windows ordered by overall priority and recommended_window as the best eligible choice. The UI restarts ranks at 1 each day and shows counts, short-call penalties and approximate timing. These are alternatives, separate from the configured maximum of three actual attempts per day.

The general artifact must match its frozen SHA, dataset identity, model card, locked-test identity and positive support/acceptance. Its target remains observed_linked_physical_recorded_met_within14days. Sparse weekdays back off to hour-pooled training evidence; calibration for this backoff is unverified. Personal and generalized rankings retain score:null and score_target:null. Separate proxy_estimate fields cannot enter the canonical probability path.

Live regression on 10 October 2026 fetched 141 observed calls, 14 successful ERP meetings and 8 converted linked calls. The top hour was 10-11 AM Asia/Kolkata, with 4 linked meetings, 15 answered calls, 51 outbound calls and 1 known answered conversation below 20 seconds. Six other successful meetings had no usable links and did not enter slot attribution. Four alternatives per day were 10-11 AM, 11 AM-noon, 3-4 PM and 4-5 PM; six eligible dates produced 24 alternatives. Some linked history uses approximate DSR entry times.

Verification: 47 automated tests pass, including the 141-call partial-timing regression, meeting-versus-answer priority, 20-second boundary, missing duration, UCID deduplication, reverse-link conflicts, outside-hours answered eligibility, three/four-slot limits, rolling retry budgets, DNC/fetch failure, generalized ranking and frozen-model tampering. Lint, TypeScript, production build, actual Python/Node artifact parity and 14 mocked routing/grounding cases pass. Isolated HTTP QA checks authentication, origin, masking, live Redash, persistence/export and batch prediction. Desktop and 390px mobile QA show four daily rows, six day groups, no overflow or console errors. The main server's actual Luna tool review passed with three tools; live Global Context retrieval succeeded.

Reports and screenshots containing the user-provided seller or profile remain ignored under .data/best-time-to-call/. Existing model weights and locked held-out evaluations were retained; no new test-set tuning or repeat final evaluation occurred.


## Retry and weekday correction

The latest correction supersedes the per-day presentation and pooled-only hour ranking above. The app now returns up to four choices in a single overall ranking, using supported weekday-and-hour evidence. Weekdays with the most linked ERP meetings (then answered calls when meeting evidence is inconclusive) are prioritized; explicit preferred weekdays take precedence when supplied. Other days remain fallback options. Observed weekday history is labelled as an observed pattern, not a proven seller availability preference.

The retry field previously copied recommended_window and hid after_minutes in the UI. It now represents a contingency after the proposed calling window: if that call is unanswered, wait at least the configured cooldown after its window ends and independently rank a later eligible window. The proposed attempt counts toward daily and unanswered-sequence budgets. The UI shows both the selected retry time and its explicit delay; lack of an eligible retry produces a reason and a visible minimum wait, rather than an empty timing field. The past unanswered call remains available in previous_unanswered_at.

For the supplied 121-call regression seller, Thursday has four linked ERP meeting records and is the strongest observed weekday. Thursday 11 AM-noon has two linked successes. The suggested contingency retry is Thursday 2-3 PM, two hours after the first window ends, with a configured one-hour minimum gap. The prior 141-call seller continues to receive a recommendation, now using Saturday-specific evidence and one overall list.

51 automated tests cover the original histories and the new independent retry, visible delay values, hypothetical attempt budgets, appointment conflicts, unavailable retry windows, weekday priority, explicit preferences, fallback days and overall caps. Existing trained artifacts and locked-test results are unchanged.
