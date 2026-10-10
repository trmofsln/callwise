/* eslint-disable @typescript-eslint/no-require-imports -- Offline, checkpointed Redash extraction. */
require('@next/env').loadEnvConfig(process.cwd());
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadServer } = require('./server-loader.cjs');
const { runQuery } = loadServer('lib/redash.ts');
// Dates/hours fixed before outcomes are inspected. This is a bounded pilot, not a population sample.
const dates = ['2026-05-05','2026-05-12','2026-05-19','2026-05-26','2026-06-02','2026-06-09','2026-06-16','2026-06-23',
  '2026-07-15','2026-07-22','2026-07-29','2026-08-05','2026-08-12',
  '2026-09-02','2026-09-09','2026-09-16','2026-09-23'];
function buildQuery(date, cap = 75) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(cap) || cap < 1 || cap > 200) throw new Error('Invalid bounded extraction arguments.');
  const tail = fs.readFileSync('ml/sql/pilot.sql', 'utf8').split('SELECT d.data_hotlead_disposition_dtlid')[1];
  return `WITH attempts AS (SELECT d.* FROM (VALUES (9),(11),(14),(16)) hours(hour)
    CROSS JOIN LATERAL (SELECT * FROM redash.data_hotlead_disposition_dtl x
      WHERE x.call_start_time >= TIMESTAMP '${date}' + hours.hour * INTERVAL '1 hour'
        AND x.call_start_time < TIMESTAMP '${date}' + (hours.hour+1) * INTERVAL '1 hour'
      ORDER BY md5(x.data_hotlead_disposition_dtlid::text || 'btc-seed-42') LIMIT ${cap}) d)
    SELECT d.data_hotlead_disposition_dtlid${tail}`;
}
async function main() {
  const args=process.argv.slice(2);
  if(args.length && (args.length!==2 || args[0]!=='--output')) throw new Error('Usage: node scripts/btc-extract.cjs [--output .data/new-run]');
  const root=args.length?args[1]:'.data/best-time-to-call';
  const directory = path.join(root,'raw'); fs.mkdirSync(directory, { recursive: true });
  const plan = JSON.stringify({ dates, hours: [9,11,14,16], per_hour_cap: 75, seed: 42, source: 13, sampling: 'hashed-ID order within fixed hour/date; population inference not established' }, null, 2);
  const planFile = path.join(root,'extraction-plan.json');
  if (fs.existsSync(planFile)) { if (fs.readFileSync(planFile,'utf8') !== plan) throw new Error('Extraction plan mismatch; use a new immutable run directory.'); }
  else fs.writeFileSync(planFile, plan, { flag: 'wx' });
  for (const date of dates) {
    const filename = path.join(directory, `${date}.json`);
    const query = buildQuery(date);
    if (fs.existsSync(filename)) {
      const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
      if(saved.query_sha256!==crypto.createHash('sha256').update(query).digest('hex')) throw new Error('Checkpoint query changed; use a new immutable output directory.');
      console.log(JSON.stringify({ date, status: 'checkpoint_reused' })); continue;
    }
    const start = Date.now();
    const result = await runQuery({ query, dataSourceId: 13, queryIdEnv: 'REDDASH_TRAINING_QUERY_ID' });
    const payload = { source: 13, extracted_at: new Date().toISOString(), query, query_sha256: crypto.createHash('sha256').update(query).digest('hex'), rows: result.rows };
    fs.writeFileSync(filename, JSON.stringify(payload), { mode: 0o600 });
    console.log(JSON.stringify({ date, rows: result.rows.length, elapsed_ms: Date.now()-start }));
  }
}
if (require.main === module) main().catch(e => { if (e.code === 'EEXIST') { console.error('Extraction plan exists; rerun with --resume to preserve it.'); } else console.error(e.message); process.exitCode = 1; });
module.exports = { buildQuery, dates };
