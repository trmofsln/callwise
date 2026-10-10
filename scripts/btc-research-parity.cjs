/* eslint-disable @typescript-eslint/no-require-imports -- Research v4: JS/Python scoring parity for clock artifacts. */
// Scores every weekday:hour window of one week with the app's own scoreExperimentalClock
// (poolHours=true) and compares against the Python research scorer for the same artifact.
// Covers the frozen general_erp model and the research-v4 retrained hour_day export.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { loadServer } = require('./server-loader.cjs');
const { scoreExperimentalClock } = loadServer('lib/best-time-experiments.ts');

const python = process.env.BTC_PYTHON || '.venv/bin/python';
const artifacts = [
  ['frozen_general_erp', '.data/btc-operational-v3/models/general_erp/model.json'],
  ['research_v4_hour_day_export_all', '.data/btc-research-v4/models/hour-day-app-export.json'],
  ['research_v4_hour_day_export_channel', '.data/btc-research-v4/models/channel/hour-day-app-export.json'],
];
// 2026-09-14 is a Monday; Asia/Kolkata has no DST, so +05:30 offsets are exact.
const windows = [];
for (let day = 0; day < 7; day++) for (let hour = 0; hour < 24; hour++) {
  const date = new Date(Date.UTC(2026, 8, 14 + day, hour, 0, 0) - 330 * 60_000);
  windows.push({ start: date.toISOString(), end: new Date(date.getTime() + 3_600_000).toISOString(), timezone: 'Asia/Kolkata', weekday: day, hour });
}
const checks = [];
for (const [name, file] of artifacts) {
  if (!fs.existsSync(file)) { checks.push({ name, status: 'missing' }); continue; }
  const model = JSON.parse(fs.readFileSync(file, 'utf8'));
  const js = scoreExperimentalClock(model, windows, windows.length, true);
  const py = spawnSync(python, ['-c', [
    'import json,sys',
    'from pathlib import Path',
    'from ml.research.models import FrozenGeneral',
    'import pandas as pd',
    'v=json.load(sys.stdin)',
    'm=FrozenGeneral(Path(v["file"]))',
    'df=pd.DataFrame(v["windows"])',
    'print(json.dumps(list(m.predict(df))))',
  ].join('\n')], { input: JSON.stringify({ file, windows }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(py.status, 0, py.stderr);
  const expected = JSON.parse(py.stdout);
  const byStart = new Map(js.map(row => [row.start, row.proxy_score]));
  let maximum = 0, dropped = 0;
  windows.forEach((w, i) => {
    if (!byStart.has(w.start)) { dropped++; return; }
    maximum = Math.max(maximum, Math.abs(byStart.get(w.start) - expected[i]));
  });
  assert.ok(maximum < 1e-12, `${name}: max difference ${maximum}`);
  checks.push({ name, model_version: model.model_version, windows: windows.length, scored_by_app: js.length,
    app_dropped_unsupported: dropped, maximum_difference: maximum, status: 'passed' });
}
const result = { checked_at: new Date().toISOString(), kind: 'research_v4_js_python_clock_parity', checks };
fs.mkdirSync('.data/btc-research-v4/models', { recursive: true });
fs.writeFileSync('.data/btc-research-v4/models/parity.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
