import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { kv } from "./kv";

export class RedashError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
  }
}

type Row = Record<string, unknown>;
type Result = { data: { rows: Row[] } };
type Job = { id: string; status: number; query_result_id?: number; error?: string };
type ResponseBody = { id?: number; query_result?: Result; job?: Job };

// Serialize updates and executions because all calls share one persistent query.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Hosted, several server instances can run at once, so "update the saved query text, then execute it"
 * also holds a short shared lock per query ID. Redash captures the text when the job is queued, so the
 * lock is released as soon as the execute request returns, not when the query finishes.
 */
async function withQueryLock<T>(queryId: number, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const key = `redash:lock:${queryId}`, owner = randomUUID();
  while (!(await kv().setnx(key, owner, 30))) {
    if (signal.aborted) throw new RedashError("Redash query timed out waiting for another lookup.", 504);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  try { return await fn(); }
  finally { if (await kv().get(key) === owner) await kv().del(key); }
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new RedashError(`${name} must be a positive integer.`, 503);
  }
  return number;
}

type QueryIdEnv = "REDDASH_ADHOC_QUERY_ID" | "REDDASH_USER_QUERY_ID" | "REDDASH_TRAINING_QUERY_ID" | "REDDASH_RECORDING_QUERY_ID";

// PostgreSQL sources (default: 13 pg-main-prod-live, 21 mesh) run with a session statement timeout,
// because the replica's default (5 s) is too short for multi-seller lookups. Other engines (e.g. the
// ClickHouse source 70) do not accept this statement and are left unchanged.
export function withStatementTimeout(query: string, sourceId: number): string {
  const timeout = (process.env.REDASH_STATEMENT_TIMEOUT ?? "120s").trim();
  const postgres = new Set((process.env.REDASH_POSTGRES_SOURCE_IDS ?? "13,21").split(",").map(id => Number(id.trim())).filter(Number.isSafeInteger));
  if (!timeout || !postgres.has(sourceId)) return query;
  if (!/^\d+(ms|s|min)$/.test(timeout)) throw new RedashError("REDASH_STATEMENT_TIMEOUT must look like 120s, 90000ms or 2min.", 503);
  return `SET statement_timeout = '${timeout}';\n${query}`;
}

async function saveQueryId(id: number, envName: QueryIdEnv) {
  // Hosted deployments have a read-only filesystem: the ID must be set as an environment variable there.
  if (process.env.VERCEL) throw new Error("Read-only filesystem.");
  const envPath = path.join(process.cwd(), ".env");
  let contents: string;
  try {
    contents = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    contents = "";
  }
  const line = `${envName}=${id}`;
  const pattern = new RegExp(`^${envName}=.*$`, "m");
  contents = pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.trimEnd()}\n${line}\n`;
  await writeFile(envPath, contents, { mode: 0o600 });
}

export function runQuery(options: {
  query: string;
  dataSourceId?: number;
  maxAge?: number;
  queryIdEnv?: QueryIdEnv;
}): Promise<{ queryId: number; rows: Row[] }> {
  const task = queue.then(() => executeQuery(options));
  queue = task.catch(() => undefined);
  return task;
}

async function executeQuery({ query: rawQuery, dataSourceId, maxAge = 0, queryIdEnv = "REDDASH_ADHOC_QUERY_ID" }: {
  query: string;
  dataSourceId?: number;
  maxAge?: number;
  queryIdEnv?: QueryIdEnv;
}) {
  const apiKey = process.env.REDDASH_API_KEY?.trim();
  if (!apiKey) throw new RedashError("Set REDDASH_API_KEY in .env before running a query.", 503);
  const sourceId = dataSourceId ?? positiveInteger(process.env.REDASH_DATA_SOURCE_ID ?? "70", "REDASH_DATA_SOURCE_ID");
  const baseUrl = (process.env.REDASH_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new RedashError("Set REDASH_URL in .env before running a query.", 503);
  const query = withStatementTimeout(rawQuery, sourceId);
  // Leaves room for a full 120 s statement plus Redash queueing and result transfer.
  const signal = AbortSignal.timeout(170_000);

  async function request(endpoint: string, body?: Record<string, unknown>): Promise<ResponseBody> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/${endpoint}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        redirect: "error",
        signal,
      });
    } catch {
      throw new RedashError(signal.aborted ? "Redash query timed out." : "Could not connect to Redash.", signal.aborted ? 504 : 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RedashError(
        `Redash denied access (HTTP ${response.status}). Check the user API key's query permissions and access to data source ${sourceId}.`,
        response.status,
      );
    }
    if (!response.ok) throw new RedashError(`Redash request failed (HTTP ${response.status}).`);
    try {
      return await response.json();
    } catch {
      throw new RedashError("Redash returned an invalid JSON response.");
    }
  }

  const configuredId = process.env[queryIdEnv]?.trim();
  let queryId: number;
  let executed: ResponseBody;
  if (configuredId) {
    queryId = positiveInteger(configuredId, queryIdEnv);
    executed = await withQueryLock(queryId, signal, async () => {
      await request(`queries/${queryId}`, { query, data_source_id: sourceId });
      return request(`queries/${queryId}/results`, { max_age: maxAge });
    });
  } else {
    const created = await request("queries", {
      query,
      data_source_id: sourceId,
      name: queryIdEnv === "REDDASH_RECORDING_QUERY_ID" ? "hackathon-recording-lookup" : queryIdEnv === "REDDASH_TRAINING_QUERY_ID" ? "hackathon-best-time-training" : queryIdEnv === "REDDASH_USER_QUERY_ID" ? "hackathon-user-lookup" : process.env.REDASH_QUERY_NAME || "adhoc-hackathon",
    });
    if (!created.id || !Number.isSafeInteger(created.id) || created.id <= 0) {
      throw new RedashError("Redash did not return a valid query ID.");
    }
    queryId = created.id;
    process.env[queryIdEnv] = String(queryId);
    try {
      await saveQueryId(queryId, queryIdEnv);
    } catch {
      throw new RedashError(`Created Redash query ${queryId}, but could not save its ID. Set ${queryIdEnv}=${queryId} in your environment.`, 503);
    }
    executed = await request(`queries/${queryId}/results`, { max_age: maxAge });
  }

  function rows(result: Result) {
    if (!Array.isArray(result.data?.rows)) throw new RedashError("Redash returned invalid result rows.");
    return { queryId, rows: result.data.rows };
  }
  if (executed.query_result) return rows(executed.query_result);
  const jobId = executed.job?.id;
  if (!jobId) throw new RedashError("Redash did not return a result or job ID.");

  while (!signal.aborted) {
    const { job } = await request(`jobs/${encodeURIComponent(jobId)}`);
    if (!job) throw new RedashError("Redash returned an invalid job response.");
    if (job.status === 3) {
      if (!job.query_result_id) throw new RedashError("Redash job has no result ID.");
      const result = await request(`query_results/${job.query_result_id}`);
      if (!result.query_result) throw new RedashError("Redash returned no query result.");
      return rows(result.query_result);
    }
    if (job.status === 4 || job.status === 5) {
      throw new RedashError(job.status === 5 ? "Redash query was cancelled." : "Redash query failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new RedashError("Redash query timed out.", 504);
}
