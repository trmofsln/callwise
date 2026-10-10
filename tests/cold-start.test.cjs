/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

test("cold-start eligibility, time safety, splits, metrics, validation-only calibration and frozen evaluation", () => {
  const executable = process.env.BEST_TIME_PYTHON || (process.platform === "win32" ? "py" : "python3");
  const args = executable === "py" ? ["-3.14", "tests/cold-start-checks.py"] : ["tests/cold-start-checks.py"];
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 120000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
