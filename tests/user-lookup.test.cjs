/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");

function load(rows = []) {
  const exports = {};
  const activityExports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("lib/user-activity.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: activityExports });
  const saved = new Map();
  let query;
  class RedashError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const compiled = ts.transpileModule(fs.readFileSync("lib/user-lookup.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, process: { env: {}, cwd: () => process.cwd() },
    require: (name) => {
      if (name === "./redash") return { RedashError, runQuery: async (options) => { query = options; return { rows }; } };
      if (name === "./user-activity") return activityExports;
      if (name === "./global-context") return { fetchGlobalContexts: async () => [] };
      if (name === "./best-time-service") return { predictBatch: async () => [] };
      if (name === "./recordings") return { storedAnalyses: async () => new Map() };
      if (name === "./kv") return { kv: () => ({ set: async (key, value, ttl) => { saved.set(key, { value: JSON.parse(JSON.stringify(value)), ttl }); } }) };
      return require(name);
    },
  });
  return { ...exports, ...activityExports, saved: () => saved, query: () => query };
}

test("normalizes and deduplicates GLIDs without losing integer precision", () => {
  const c = load();
  assert.equal(JSON.stringify(c.parseGlids(" 00123,123,9007199254740993 ")), '["123","9007199254740993"]');
});

test("meeting success matches ERP rules for physical, video, null and Not Met outcomes", () => {
  const { isSuccessfulMeeting } = load();
  for (const [record, expected] of [
    [{ sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: 2 }, true],
    [{ sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: 9 }, false],
    [{ sts_dsr_meeting_mode: 1, sts_dsr_meeting_result: 1, sts_dsr_meeting_verify_status: 9 }, true],
    [{ sts_dsr_meeting_mode: 1, sts_dsr_meeting_result: 1, sts_dsr_meeting_verify_status: 1 }, false],
    [{ sts_dsr_meeting_mode: 1, sts_dsr_meeting_result: 9, sts_dsr_meeting_verify_status: 9 }, false],
    [{ sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: null }, false],
    [{ sts_dsr_meeting_mode: null, sts_dsr_meeting_result: 1 }, false],
  ]) assert.equal(isSuccessfulMeeting(record), expected);
});

test("selects latest dated calls separately for any and current assigned employees", () => {
  const activity = load().summarizeActivity({
    click_to_call: [
      { click_to_call_id: 1, fk_employeeid: 10, call_start_time: "2026-01-01T10:00:00", _employee_name: "Assigned" },
      { click_to_call_id: 2, fk_employeeid: 20, call_start_time: "2026-02-01T10:00:00" },
      { click_to_call_id: 3, fk_employeeid: 10, call_start_time: null },
    ],
    sts_dsr_meeting: [
      { sts_dsr_meeting_id: 1, sts_dsr_meeting_date: "2026-01-01", sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: 1 },
      { sts_dsr_meeting_id: 2, sts_dsr_meeting_date: "2026-02-01", sts_dsr_meeting_mode: 1, sts_dsr_meeting_result: 1, sts_dsr_meeting_verify_status: 0 },
    ],
  }, [{ record: { assignedto: 10 }, employee: null }]);
  assert.equal(activity.lastCall.id, "2");
  assert.equal(activity.lastAssignedEmployeeCall.id, "1");
  assert.equal(activity.lastMeeting.id, "2");
  assert.equal(activity.lastSuccessfulMeeting.id, "1");
  assert.equal(activity.calls.length, 3);
  assert.equal(activity.lastAssignedEmployeeCall.employeeName, "Assigned");
  assert.equal("_employee_name" in activity.lastAssignedEmployeeCall.record, false);
});

test("rejects invalid IDs and SQL injection", () => {
  const c = load();
  for (const value of ["", "1,", "0", "-1", "1.5", "1); DROP TABLE glusr_usr;--", "9223372036854775808"]) {
    assert.throws(() => c.parseGlids(value), { status: 400 });
  }
  assert.throws(() => c.parseGlids(Array.from({ length: 51 }, (_, i) => i + 1).join(",")), { status: 400 });
});

test("conversion deduplicates UCIDs and counts linked successful calls once", () => {
  const activity = load().summarizeActivity({
    click_to_call: [{ click_to_call_id: 1, ucid: "abc", call_duration: 90 }],
    sts_dsr_call: [
      { sts_dsr_call_id: 10, ucid: "abc" },
      { sts_dsr_call_id: 11, ucid: null },
      { sts_dsr_call_id: 12, ucid: "0" },
    ],
    sts_dsr_meeting: [
      { sts_dsr_meeting_id: 1, fk_sts_dsr_call_id: 10, sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: 1 },
      { sts_dsr_meeting_id: 2, fk_sts_dsr_call_id: 10, sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: 1 },
      { sts_dsr_meeting_id: 3, fk_sts_dsr_call_id: 11, sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: 9 },
      { sts_dsr_meeting_id: 4, fk_sts_dsr_call_id: 999, sts_dsr_meeting_mode: 0, sts_dsr_meeting_result: 1 },
    ],
  }, []);
  assert.equal(activity.metrics.callCount, 3);
  assert.equal(activity.metrics.meetingCount, 4);
  assert.equal(activity.metrics.successfulMeetingCount, 3);
  assert.equal(activity.metrics.convertedCallCount, 1);
  assert.ok(Math.abs(activity.metrics.callToMeetingPercent - 100 / 3) < 1e-10);
  assert.equal(activity.metrics.unlinkedSuccessfulMeetingCount, 1);
  assert.equal(activity.calls.find((call) => call.id === "10").durationSeconds, 90);
  assert.equal(load().summarizeActivity({}, []).metrics.callToMeetingPercent, null);
});

test("durations use actual timestamps and the latest linked ERP authentication", () => {
  const activity = load().summarizeActivity({
    sts_dsr_auth: [
      { sts_dsr_auth_id: 1, fk_sts_dsr_call_id: 10, auth_verification_time: "2026-01-01T10:00:00" },
      { sts_dsr_auth_id: 2, fk_sts_dsr_call_id: 10, auth_verification_time: "2026-01-01T10:05:00" },
    ],
    sts_dsr_meeting: [
      { sts_dsr_meeting_id: 1, fk_sts_dsr_call_id: 10, sts_dsr_meeting_mode: 0, sts_dsr_meeting_entrydate: "2026-01-01T10:15:00" },
      { sts_dsr_meeting_id: 2, sts_dsr_meeting_mode: 1, virtual_meet_start_time: "2026-01-01T10:00:00", virtual_meet_end_time: "2026-01-01T10:02:00" },
      { sts_dsr_meeting_id: 3, sts_dsr_meeting_mode: 1, video_meet_duration_sec: 0 },
      { sts_dsr_meeting_id: 4, sts_dsr_meeting_mode: 1, virtual_meet_start_time: "2026-01-01T10:02:00", virtual_meet_end_time: "2026-01-01T10:00:00" },
    ],
  }, []);
  const byId = new Map(activity.meetings.map((meeting) => [meeting.id, meeting]));
  assert.equal(byId.get("1").durationSeconds, 600);
  assert.equal(byId.get("1").startedAt, "2026-01-01T10:05:00");
  assert.equal(byId.get("2").durationSeconds, 120);
  assert.equal(byId.get("3").durationSeconds, 0);
  assert.equal(byId.get("4").durationSeconds, null);
});

test("builds the verified assignment chain using numeric literals", () => {
  const query = load().buildUserQuery(["123", "456"]);
  assert.match(query, /e.employeeid = s.assignedto/);
  assert.match(query, /v.iil_vertical_id = e.fk_iil_vertical_id/);
  assert.match(query, /IN \(123,456\)/);
  assert.match(query, /s.sts_fk_glusr_id = g.glusr_usr_id/);
});

test("retains requested order, reports missing IDs, and saves each returned seller for the retry planner", async () => {
  const c = load([{ glid: "123", glusr_usr: { glusr_usr_membersince: "2020-01-01", glusr_usr_custtype_name: "Buyer" }, company: [], assignments: [] }]);
  const result = await c.lookupUsers(["456", "123"]);
  assert.equal(result.users[0].glid, "123");
  assert.equal(result.users[0].createdAt, "2020-01-01");
  assert.equal(JSON.stringify(result.missingGlids), '["456"]');
  assert.deepEqual([...c.saved().keys()], [`lookup:${result.lookupId}:123`]);
  const record = c.saved().get(`lookup:${result.lookupId}:123`);
  assert.equal(JSON.stringify(record.value.user), JSON.stringify(result.users[0]));
  assert.equal(record.value.globalContext, null);
  assert.equal(record.ttl, 3 * 86_400);
  assert.equal(c.query().dataSourceId, 13);
  assert.equal(c.query().queryIdEnv, "REDDASH_USER_QUERY_ID");
});
