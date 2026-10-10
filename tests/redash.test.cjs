/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness for the transpiled server module. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function client(responses, env = {}) {
  const calls = [];
  const memory = new Map();
  const memoryKv = {
    get: async (key) => memory.get(key) ?? null,
    setnx: async (key, value) => memory.has(key) ? false : (memory.set(key, value), true),
    del: async (key) => { memory.delete(key); },
  };
  let saved = "";
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync("lib/redash.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require: (name) => name === "./kv" ? { kv: () => memoryKv } : name === "node:fs/promises" ? {
      readFile: async () => "REDDASH_API_KEY=secret\nREDDASH_ADHOC_QUERY_ID=\n",
      writeFile: async (_path, contents) => { saved = contents; },
    } : require(name),
    process: { env: { REDDASH_API_KEY: "secret", REDASH_URL: "https://redash.test", ...env }, cwd: () => process.cwd() },
    AbortSignal,
    setTimeout: (callback) => callback(),
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      const response = responses.shift();
      assert.ok(response, "Unexpected Redash request");
      return { ok: true, status: 200, json: async () => response, ...response };
    },
  });
  return { ...exports, calls, saved: () => saved };
}

test("creates a query, persists the ID without changing the key, and reuses it", async () => {
  const result = { query_result: { data: { rows: [{ amount: 10 }] } } };
  const c = client([{ id: 123 }, result, {}, result]);
  const first = await c.runQuery({ query: "SELECT 1" });
  assert.equal(first.queryId, 123);
  assert.equal(first.rows[0].amount, 10);
  assert.match(c.saved(), /REDDASH_ADHOC_QUERY_ID=123/);
  assert.match(c.saved(), /REDDASH_API_KEY=secret/);
  await c.runQuery({ query: "SELECT 2" });
  assert.match(c.calls[2].url, /queries\/123$/);
  assert.equal(c.calls[0].headers.Authorization, "Key secret");
});

test("updates the configured query and polls until rows are available", async () => {
  const c = client([{}, { job: { id: "job-1" } }, { job: { status: 2 } },
    { job: { status: 3, query_result_id: 42 } }, { query_result: { data: { rows: [] } } }],
  { REDDASH_ADHOC_QUERY_ID: "7" });
  const result = await c.runQuery({ query: "SELECT 1", dataSourceId: 31, maxAge: 60 });
  assert.equal(result.queryId, 7);
  assert.equal(result.rows.length, 0);
  assert.equal(JSON.parse(c.calls[1].body).max_age, 60);
  assert.match(c.calls[4].url, /query_results\/42$/);
});

test("rejects missing credentials without making requests", async () => {
  const c = client([], { REDDASH_API_KEY: "" });
  await assert.rejects(c.runQuery({ query: "SELECT 1" }), { status: 503 });
  assert.equal(c.calls.length, 0);
});

test("training extraction creates its own persistent query instead of updating interactive queries", async () => {
  const result = { query_result: { data: { rows: [] } } };
  const c = client([{ id: 321 }, result], { REDDASH_ADHOC_QUERY_ID: "77", REDDASH_USER_QUERY_ID: "88" });
  await c.runQuery({ query: "SELECT 1", dataSourceId: 13, queryIdEnv: "REDDASH_TRAINING_QUERY_ID" });
  assert.match(c.calls[0].url, /\/queries$/);
  assert.equal(JSON.parse(c.calls[0].body).name, "hackathon-best-time-training");
  assert.match(c.calls[1].url, /queries\/321\/results$/);
  assert.match(c.saved(), /REDDASH_TRAINING_QUERY_ID=321/);
  assert.ok(!c.calls.some(call => /queries\/(77|88)/.test(call.url)));
});

test("stops after an update fails and does not expose upstream response contents", async () => {
  const c = client([{ ok: false, status: 403 }], { REDDASH_ADHOC_QUERY_ID: "7" });
  await assert.rejects(c.runQuery({ query: "SELECT 1" }), /HTTP 403/);
  assert.equal(c.calls.length, 1);
});

test("handles failed and cancelled jobs", async () => {
  for (const status of [4, 5]) {
    const c = client([{}, { job: { id: "job-1" } }, { job: { status, error: "private SQL details" } }],
      { REDDASH_ADHOC_QUERY_ID: "7" });
    await assert.rejects(c.runQuery({ query: "SELECT 1" }), status === 4 ? /query failed/ : /query was cancelled/);
  }
});

test("PostgreSQL sources get a 120 s session statement timeout; other sources are unchanged", async () => {
  const result = { query_result: { data: { rows: [] } } };
  const pg = client([{}, result], { REDDASH_ADHOC_QUERY_ID: "7" });
  await pg.runQuery({ query: "SELECT 1", dataSourceId: 13 });
  assert.equal(JSON.parse(pg.calls[0].body).query, "SET statement_timeout = '120s';\nSELECT 1");
  const clickhouse = client([{}, result], { REDDASH_ADHOC_QUERY_ID: "7" });
  await clickhouse.runQuery({ query: "SELECT 1", dataSourceId: 70 });
  assert.equal(JSON.parse(clickhouse.calls[0].body).query, "SELECT 1");
  const custom = client([{}, result], { REDDASH_ADHOC_QUERY_ID: "7", REDASH_STATEMENT_TIMEOUT: "90s", REDASH_POSTGRES_SOURCE_IDS: "31" });
  await custom.runQuery({ query: "SELECT 1", dataSourceId: 31 });
  assert.equal(JSON.parse(custom.calls[0].body).query, "SET statement_timeout = '90s';\nSELECT 1");
  const invalid = client([], { REDASH_STATEMENT_TIMEOUT: "120 seconds; DROP" });
  await assert.rejects(invalid.runQuery({ query: "SELECT 1", dataSourceId: 13 }), /REDASH_STATEMENT_TIMEOUT/);
});
