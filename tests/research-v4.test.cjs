/* eslint-disable @typescript-eslint/no-require-imports -- Node test wrapper for research v4 Python checks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const python = process.env.BTC_PYTHON || (fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');
const probe = spawnSync(python, ['-c', 'import numpy, pandas, sklearn, scipy'], { encoding: 'utf8' });

test('research v4 label attribution, as-of history and metrics', { skip: probe.status !== 0 && `${python} lacks numpy/pandas/scikit-learn/scipy` }, () => {
  const result = spawnSync(python, ['-I', 'tests/research_v4_checks.py'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok test_labels/);
  assert.match(result.stdout, /ok test_history_is_strictly_prior/);
});

const liveModel = 'models/live/models/general_erp/model.json';
test('live general fallback is the research-v4 hour/day table; BTC_EXPERIMENT_DIRECTORY rolls back', { skip: !fs.existsSync(liveModel) && 'live artifact not installed (python -m ml.research.install_live)' }, async (t) => {
  const { loadServer } = require('../scripts/server-loader.cjs');
  const { DEFAULT_EXPERIMENT_DIRECTORY } = loadServer('lib/best-time-experiments.ts');
  const { loadGeneralizedModel } = loadServer('lib/best-time-generalized.ts');
  assert.equal(DEFAULT_EXPERIMENT_DIRECTORY, 'models/live');
  const previous = process.env.BTC_EXPERIMENT_DIRECTORY;
  t.after(() => { if (previous === undefined) delete process.env.BTC_EXPERIMENT_DIRECTORY; else process.env.BTC_EXPERIMENT_DIRECTORY = previous; });
  delete process.env.BTC_EXPERIMENT_DIRECTORY;
  const live = await loadGeneralizedModel();
  assert.equal(live.issue, null);
  assert.match(live.model.model_version, /^erp-outbound-observed-proxy-v4-/);
  assert.equal(live.model.family, 'hour_day');
  assert.equal(live.model.deployment.approved, false);
  assert.equal(live.model.label_kind, 'proxy');
  if (fs.existsSync('.data/btc-operational-v3/models/general_erp/model.json')) {
    process.env.BTC_EXPERIMENT_DIRECTORY = '.data/btc-operational-v3';
    const rollback = await loadGeneralizedModel();
    assert.equal(rollback.issue, null);
    assert.doesNotMatch(rollback.model.model_version, /-v4-/);
  }
});
