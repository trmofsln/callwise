/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load({ credentials = { employeeId: "93634", token: "test.jwt.value" }, respond } = {}) {
  const calls = [], snapshots = [];
  const catalog = {};
  const compile = (file) => ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compile("lib/global-context-catalog.ts"), { exports: catalog });
  const exports = {};
  vm.runInNewContext(compile("lib/global-context.ts"), {
    exports, process: { env: { GLOBAL_CONTEXT_URL: "https://context.test/v1", GLOBAL_CONTEXT_FORWARDED_FOR: "203.0.113.7" } }, AbortSignal, URLSearchParams,
    require: (name) => name === "./sqlite" ? { getSharedCredentials: () => credentials, getAdminStore: () => ({ saveGlobalContext: (context) => snapshots.push(context) }) } : catalog,
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, options, body });
      const response = respond ? respond(url, body) : body ? { code: 200, data: { mapping_id: `map-${body.mapping_value}` } }
        : { code: 200, data: { kycdetails: { company_name: "Example", ak: credentials.token }, ActualData: { extra: true } } };
      return { ok: response.httpStatus ? response.httpStatus < 400 : true, status: response.httpStatus || 200, json: async () => response };
    },
  });
  return { ...exports, ...catalog, calls, snapshots };
}

test("uses stored credentials, requests all seven segments, chains mapping ID, and redacts secrets", async () => {
  const c = load();
  const [result] = await c.fetchGlobalContexts(["441"]);
  assert.equal(result.status, "success");
  assert.equal(c.calls[0].body.empid, 93634);
  assert.equal(c.calls[0].body.ak, "test.jwt.value");
  assert.equal(c.calls[0].body.mapping_value, "441");
  assert.equal(c.calls[0].body.mapping_type, 1);
  assert.equal(c.calls[0].body.source_id, 3);
  assert.equal(c.calls[0].body.data_segments, "kycdetails,connectdetails,ticketsdetails,BLdetails,activitydetails,duplicate_glids_details,ActualData");
  assert.match(c.calls[1].url, /mapping_id=map-441$/);
  assert.equal(c.calls[1].options.headers["X-Forwarded-For"], "203.0.113.7");
  assert.equal(c.calls[1].options.method, "GET");
  assert.equal(JSON.stringify(result).includes("test.jwt.value"), false);
  assert.equal(c.snapshots.length, 1);
});

test("keeps per-GLID results ordered and allows partial failures", async () => {
  const c = load({ respond: (_url, body) => body ? body.mapping_value === "2" ? { code: 401 } : { code: 200, data: { mapping_id: "one" } } : { code: 200, data: { ActualData: { extra_key: 0 } } } });
  const results = await c.fetchGlobalContexts(["1", "2"]);
  assert.equal(results[0].glid, "1");
  assert.equal(results[0].status, "success");
  assert.equal(results[1].status, "error");
  assert.match(results[1].error, /401/);
  assert.equal(c.snapshots.length, 2);
});

test("missing credentials make no external requests, and invalid mapping IDs stop the chain", async () => {
  const empty = load({ credentials: { employeeId: "", token: null } });
  assert.equal((await empty.fetchGlobalContexts(["1"]))[0].status, "not_configured");
  assert.equal(empty.calls.length, 0);
  const invalid = load({ respond: () => ({ code: 200, data: {} }) });
  assert.equal((await invalid.fetchGlobalContexts(["1"]))[0].status, "error");
  assert.equal(invalid.calls.length, 1);
});

test("finds segment data in nested responses and serialized Redis values, including false and zero", () => {
  const c = load();
  const data = { context: { "glid:441:ActualData": '{"active":false,"count":0}' } };
  const found = c.findContextSegment(data, "ActualData");
  assert.equal(found.active, false);
  assert.equal(found.count, 0);
  assert.equal(c.findContextSegment(data, "kycdetails"), undefined);
});
