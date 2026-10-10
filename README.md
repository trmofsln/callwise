# Callwise · Best Time to Call

A seller call-planning workspace with GLID lookup, interaction history, calling
windows, retry constraints, grounded Luna review, and an authenticated ML report.

## Getting started

```sh
npm install
npm run dev
```

Open http://localhost:3000. The redesigned workspace supports desktop and mobile;
`/admin` retains existing authentication and shared credentials.

Next.js 16.4.0 and React 19.3.0 are installed. The committed
`package-lock.json` records the resolved dependency versions. Use `npm ci`
for reproducible installs.

## Call queue workflow

The workspace (`/`) is built around one question: who should I call right now?

1. **Build a queue.** Enter up to 50 GLIDs. The last list is remembered in this browser and can be reloaded.
2. **Overview.** Sellers are grouped by status, compared against the current time and refreshed every 30 seconds:
   - **Call now:** the window is open or starts within 15 minutes.
   - **Later today.**
   - **Upcoming:** the next window is on a later day.
   - **No window:** blocked by calling rules, or there isn't enough data.

   The overview also shows the ERP call history of the sellers in the queue.
3. **Next best call.** This is the earliest due seller that hasn't been logged today. Ties go to the higher confidence level.
4. **Queue table.** Use the status tabs, search, and filters for assigned rep, confidence, ranking basis, last call outcome and "hide logged today". You can sort by best time, confidence, call history, most recent contact, or call → meeting rate.
5. **Seller drawer.** It has five tabs: calling plan, ERP call and meeting history, profile and assignment, Global Context, and outcomes.
6. **Log call outcome.** Record the outcome (answered, meeting booked, asked to call back, no answer, not interested), a note and an optional follow-up. Each save shows a toast with an Undo button.

### Backend data needed for further features

These are not shown, so the UI does not invent them:

| Feature | What the backend must provide |
|---|---|
| Writing call outcomes and follow-ups to the ERP | A write API. Until it exists, outcomes are stored only in the browser (`localStorage`, key `callwise.callLog.v1`), labelled as such, and they do not affect recommendations. |
| One-click calling | A phone number or a click-to-call endpoint. The drawer offers "Copy GLID" for the ERP dialler instead. |
| Answer probability and meeting probability | A validated, calibrated model. The current general model is a ranking proxy, so the UI shows evidence and a confidence level, not percentages. |
| A rep's own calls today, connection rate and meetings booked | A per-employee activity feed. The overview shows only the history of the sellers in the queue. |

## Developer mode

Raw API responses are hidden in the workspace. They cover the prediction, user lookup and Global Context JSON, raw records, internal IDs, raw model scores and the JSON download. To show them, sign in to `/admin`, open **Developer tools** and switch on **Show raw API responses in the workspace**. The switch is stored per browser in `localStorage` (`callwise.devMode`). It is a display setting, not access control: the API returns the same data either way.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Run the production build with `npm start` after `npm run build`.

## Redash backend

Add your Redash user API token to `REDDASH_API_KEY` in `.env`, then restart
the dev server. The variable names preserve the spelling in the Python sample.
The `.env` file is ignored by Git; `.env.example` contains placeholders only.

Send `POST /api/redash` with JSON:

```json
{
  "dataSourceId": 70,
  "query": "SELECT 1 AS connection_test",
  "maxAge": 0
}
```

The response is `{ "queryId": 123, "rows": [...] }`. `dataSourceId` defaults
to `REDASH_DATA_SOURCE_ID`; `maxAge` defaults to zero (fresh execution).
The first request creates a persistent query and writes its ID to
`REDDASH_ADHOC_QUERY_ID` in `.env`. Subsequent requests update and reuse it.
Jobs are polled once a second with a two-minute execution timeout.

Query creation requires a token with create/edit permissions. No query is
created until a token is configured and a request is sent. The API token stays
on the server. This endpoint currently has no application authentication;
keep it local until access control is added. On hosted deployments, configure
an existing query ID in the deployment environment; automatic ID persistence
requires a writable `.env` file. Requests are serialized within one server
process; multiple instances should use separate query IDs or a shared lock.

## User lookup

The homepage accepts up to 50 unique comma-separated GLIDs. `POST /api/users`
accepts `{ "glids": "123456,789012" }` and returns user profiles, missing IDs,
and source records. IDs are validated as positive integers before SQL is built.

User lookup uses source 13, `pg-main-prod-live`, configured separately via
`REDASH_USER_DATA_SOURCE_ID=13` and `REDDASH_USER_QUERY_ID`. Source 70 remains
the general Redash default. The user lookup creates its own persistent query.

Verified joins: `company.fk_glusr_usr_id` and `sts_company.sts_fk_glusr_id`
link to `glusr_usr.glusr_usr_id`. `sts_company.assignedto` links to
`employee.employeeid`, then `employee.fk_iil_vertical_id` links to
`iil_vertical.iil_vertical_id`. All five tables use the `redash` schema.
Company and STS rows are aggregated separately to avoid multiplying records.
Missing company, employee, or vertical records do not remove the user.

User creation is reported from `glusr_usr_membersince`; company creation is
reported separately from `company.creationdate`. User and company names are
not exposed in the current source schema. Employee names are available.

Each successful lookup saves every seller's profile and Global Context in the
app store for three days (`lookup:<lookup-id>:<glid>`), so the post-call retry
planner needs no second ERP query. The UI also offers JSON download. These
records include the fetched user, company, and STS records; employee output
includes only assignment-relevant fields. Hosted, the whole app sits behind the
site password (see Hosting).

## Calls and meetings

Each profile includes the latest call for this GLID by any employee, the latest
call involving its currently assigned employee, the latest DSR meeting, and
the latest successful DSR meeting. Calls combine `click_to_call` (linked by
GLID) and `sts_dsr_call` (linked through STS company). Historical calls by a
previous assignee remain in the full history but do not count as calls involving
the current assignee. Multiple source records can describe the same interaction.

Success follows `merp-go/src/cluster/multiModules/app/models/nsdTaskTracker/getMeetingData.go`
in the provided ERP repository: physical mode 0 with a non-null result other
than 9 is successful; video mode 1 additionally requires verification status 9.
Result 9 is Not Met. Null/unknown modes are not successful. This measures the
operational recorded-meeting proxy; canonical `meeting_done` equivalence is unverified.
Sales meetings are included separately without inferring their success.

All returned columns and linked history rows are included in the saved/downloaded
JSON. The UI initially displays the latest 20 rows per history and can show all.
Related records include meeting sessions, meeting trust scores, welcome meetings,
meeting authentication, and call feedback. No history limit is applied in SQL;
large GLID batches can take longer and generate large files.

The frontend does not show the last-login value. Activity metrics count unique
calls by non-empty UCID, falling back to source record IDs when UCID is missing.
Call-to-meeting conversion is the number of distinct fetched calls linked by
`sts_dsr_meeting.fk_sts_dsr_call_id` to at least one successful DSR meeting,
divided by unique fetched calls. Multiple successful meetings for one call count
once; unlinked meetings are excluded. Zero calls displays N/A. These metrics
cover all fetched history and do not infer conversions from nearby dates.

Event histories show date, start/recorded time, duration, employee, outcome,
purpose, and mode where available. Click-to-call durations are seconds; DSR
call records reuse that duration when UCID matches. Video meeting duration uses
`video_meet_duration_sec` or the start/end timestamp difference. Physical meeting
duration matches the ERP calculation: meeting entry minus authentication
verification for the highest authentication ID linked to the meeting's call.
Missing/invalid/negative durations are not invented. A recorded time is labelled
separately from a start time. All non-empty raw fields remain available under
All details, along with recording links when present.

## Admin panel and storage

Open `/admin`, create an admin password (at least 12 characters), then save the
one shared token, its employee ID, notes, and extra JSON configuration.
Leave the token input blank to preserve an existing token; use the removal
checkbox to explicitly clear it. The browser never receives the saved token.

Everything the app persists goes through one small key-value store
(`lib/kv.ts`): the hashed admin password, hashed expiring admin sessions, the
shared settings, calling settings, prediction history, Global Context
snapshots, cached Sarvam analyses, and each queue's saved seller records.

- **Hosted:** Upstash Redis over its REST API, used whenever
  `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`/
  `UPSTASH_REDIS_REST_TOKEN`) are set.
- **Local:** a `kv` table in `.data/app.sqlite` (Node's built-in `node:sqlite`,
  Node 24 or later). `SQLITE_DATABASE_PATH` overrides the path.

The shared token is encrypted with AES-256-GCM. The key is
`SETTINGS_ENCRYPTION_KEY` (32 random bytes, base64) when set, else the local
file `.data/app.sqlite.key`. Losing the key means the saved token cannot be
recovered. `.data/` and `.env*` are ignored by Git.

Server integrations read the configuration without an HTTP endpoint that
exposes the token:

```ts
import { getSharedCredentials } from "@/lib/sqlite";

const { token, employeeId, metadata } = await getSharedCredentials();
```

Admin APIs are `/api/admin/session` (GET status, POST setup/login, DELETE logout)
and `/api/admin/settings` (authenticated GET/PUT). Admin cookies are HttpOnly,
SameSite Strict, expire after eight hours, and use Secure on HTTPS. Mutations
reject cross-origin browser requests. The raw SQL endpoint `/api/redash` needs
an admin session.

## Hosting (Vercel)

The app runs on Vercel (region `bom1`, see `vercel.json`) with Upstash Redis
from the Vercel Marketplace for storage. Hosted-only settings:

| Variable | Purpose |
|---|---|
| `SITE_PASSWORD` | Turns on the site-wide password gate (`proxy.ts`): pages redirect to `/login`, APIs answer 401 without the signed session cookie. Unset locally, so the gate is off. |
| `SITE_SESSION_SECRET` | HMAC key for the 30-day site session cookie. Changing it, or the password, signs everyone out. |
| `SETTINGS_ENCRYPTION_KEY` | Encrypts the shared Global Context token. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Added by the Upstash integration. |

With the gate on, routes that spend paid API calls are rate-limited per IP
(`lib/rate-limit.ts`). Redash, Sarvam, OpenRouter and Global Context keys stay
server-side; the browser never receives them. Model artifacts are read from
`models/live` (aggregate tables only), and recordings are converted with the
bundled `ffmpeg-static` binary.

## Global Context integration

Every user lookup also fetches Global Context for every requested GLID,
including GLIDs absent from the Redash user table. The admin API list includes
this integration. Its credentials come exclusively from the shared employee ID
and encrypted token saved in the admin settings.

1. POST `generateContextUID` with `mapping_type: 1`, the GLID as
   `mapping_value`, `source_id: 3`, stored `empid`/`ak`, and all segments.
2. Read `data.mapping_id`, then GET `x/getContext?mapping_id=...`.

The API base URL comes from the server setting `GLOBAL_CONTEXT_URL` (required),
and `GLOBAL_CONTEXT_FORWARDED_FOR`, when set, is sent as the `X-Forwarded-For`
header on both requests. Request bodies containing the token are never logged or
returned to the browser.

Segments from the supplied Global Context Keys PDF: `kycdetails`,
`connectdetails`, `ticketsdetails`, `BLdetails`, `activitydetails`,
`duplicate_glids_details`, `ActualData`. Segment/key casing and API spellings
are preserved. The PDF's attribute paths are catalogued in
`lib/global-context-catalog.ts`; the UI displays every returned key dynamically,
including additional fields and ActualData keys not documented in the PDF.
Some sheet rows have no attribute key; no API keys are invented for those rows.

`POST /api/global-context` accepts `{ "glids": "441,2890229" }` for standalone
context lookup. Each GLID has its own status, mapping ID, complete response,
data, and error. Missing configuration or API failures do not discard Redash
profiles. Four GLIDs run concurrently; each has a 45-second timeout and the
whole context batch has a two-minute deadline.

Responses are saved as 30-day snapshots in the app store, and included
in the combined user lookup JSON exports/downloads. The server helper
`getAdminStore().getLatestGlobalContext(glid)` retrieves the latest snapshot.
Saved responses redact `ak`/token/password/authorization fields and the exact
shared token if it appears in upstream data. No snapshots or credentials are
committed to Git.

## Best Time to Call

GLID lookups include calling recommendations and retry constraints in the UI and
downloaded JSON. `POST /api/predictions` accepts the same comma-separated GLIDs;
`/api/predictions/health` separates service health from model readiness. Authenticated
Admin settings add calling hours, timezone, cooldown and attempt limits. Defaults
are explicit operating assumptions, pending verified company policy.

Primary objective: completed meetings (`meeting_done`), overriding PS03's meeting-fixed
priority. The original 4,978-attempt hotlead pilot lacks canonical labels and
complete campaign prehistory. A separate **39,284-call general ERP experiment**
uses an explicitly named linked physical recorded-met proxy with time-only
predictors and locked temporal / observed-first-contact splits. `/admin` shows
its real offline results and supported-slot numerical inference demonstration.
Canonical recommendation probabilities remain null until approved canonical
artifacts are available; operating-hour suggestions are not a measured optimum.
GPT-6 Luna through OpenRouter now passes an actual authenticated tool review
after replacing the exhausted monthly-limit key with the user's working
reference credential. Provider failures retain the deterministic fallback.

Training stays offline with its own `REDDASH_TRAINING_QUERY_ID`. Portable reviewed
canonical artifacts load from `BTC_MODEL_DIRECTORY`; missing/proxy/unapproved or
uncalibrated artifacts are rejected. The app store preserves existing credentials/settings
and adds predictions/experiment metadata. No calls or production-table changes run.

See [results and blockers](docs/best-time-to-call/results.md),
[architecture](docs/best-time-to-call/architecture.md),
[reproduction commands](docs/best-time-to-call/reproduce.md),
[checklist](docs/best-time-to-call/checklist.md), and the
[one-slide presentation](docs/best-time-to-call/presentation.html).


Calling plans rank linked successful ERP meetings first, then the seller's answered-call history when meeting evidence is inconclusive. Known answered calls shorter than 20 seconds reduce priority; missing duration does not count as a short call. Inconclusive and new sellers use the supported general ERP time model for advisory ranking. DSR entry times are labelled approximate; unlinked successes are not assigned to a slot. Recommendations show one overall list of up to four ranked day-and-time alternatives, prioritizing supported preferred weekdays with fallback days allowed, separately from daily call-attempt limits. The retry card plans a later conditional attempt if the proposed call is unanswered and displays its exact delay and timestamp. Canonical meeting probabilities remain null for personal and proxy rankings. See docs/best-time-to-call/personal-ranking.md for thresholds and regression evidence.


The calling-plan model card names the engine used, its version and the top-choice score. Each slot also shows a numerical score. Personal history uses ranking points; the general ML model shows an explicitly labelled ERP proxy estimate and held-out ROC AUC/AUPRC. Approved canonical models show completed-meeting probabilities when available.
