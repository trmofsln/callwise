/* eslint-disable @typescript-eslint/no-require-imports -- Read-only, bounded audit CLI. */
require('@next/env').loadEnvConfig(process.cwd());
const fs = require('node:fs');
const path = require('node:path');
const { loadServer } = require('./server-loader.cjs');
const { runQuery } = loadServer('lib/redash.ts');
async function main() {
  const dir = '.data/best-time-to-call'; fs.mkdirSync(dir, { recursive: true });
  const mode = process.argv[2] || 'schema';
  const queryFile = process.argv[3];
  const source = Number(process.argv[4] || 13);
  if (process.env.BTC_QUERY_DIAGNOSTIC === '1') {
    const nativeFetch = global.fetch;
    global.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (String(args[0]).includes('/jobs/')) {
        const payload = await response.clone().json().catch(() => ({}));
        if (payload.job?.error) fs.writeFileSync(path.join(dir, 'query-diagnostic.json'), JSON.stringify({error:payload.job.error}));
      }
      return response;
    };
  }
  if (mode === 'query') {
    if (!queryFile) throw new Error('Usage: node scripts/btc-audit.cjs query query.sql [source] [output-name]');
    const query = fs.readFileSync(queryFile, 'utf8');
    if (!/^\s*(?:EXPLAIN\s+(?:\([^)]*\)\s*)?)?(SELECT|WITH)\b/i.test(query) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|COPY|CREATE|ANALYZE)\b/i.test(query)) throw new Error('Only read-only SELECT/WITH or non-executing EXPLAIN queries are allowed.');
    const result = await runQuery({ query, dataSourceId: source, queryIdEnv: 'REDDASH_TRAINING_QUERY_ID' });
    const output = path.join(dir, path.basename(process.argv[5] || 'audit-result.json'));
    fs.writeFileSync(output, JSON.stringify({ source, extracted_at: new Date().toISOString(), query, ...result }), { mode: 0o600 });
    console.log(JSON.stringify({ source, query_id: result.queryId, rows: result.rows.length, output }));
    return;
  }
  const key = process.env.REDDASH_API_KEY?.trim();
  if (!key) throw new Error('REDDASH_API_KEY unavailable.');
  const base = (process.env.REDASH_URL || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('REDASH_URL unavailable.');
  const listResponse = await fetch(`${base}/api/data_sources`, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!listResponse.ok) throw new Error(`Source inventory HTTP ${listResponse.status}.`);
  const sourceList = await listResponse.json();
  const accessible = Array.isArray(sourceList) ? sourceList : sourceList.results || [];
  fs.writeFileSync(path.join(dir, 'accessible-sources.json'), JSON.stringify(accessible.map(s => ({ id: s.id, name: s.name, type: s.type })), null, 2));
  const sources = accessible.map(s => s.id);
  const report = { audited_at: new Date().toISOString(), sources: [] };
  for (const id of sources) {
    try {
      const response = await fetch(`${base}/api/data_sources/${id}/schema`, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok) { report.sources.push({ id, status: response.status }); continue; }
      const schema = await response.json();
      if (schema.job) { report.sources.push({ id, status: 'schema_refresh_pending' }); continue; }
      fs.writeFileSync(path.join(dir, `schema-${id}.json`), JSON.stringify(schema), { mode: 0o600 });
      const tables = schema.schema || schema;
      report.sources.push({ id, status: 'ok', table_count: Array.isArray(tables) ? tables.length : null, canonical_candidates: Array.isArray(tables) ? tables.filter(t => /call_master/.test(t.name) || (t.columns || []).some(c => /^meeting_(done|fixed)$/.test(typeof c === 'string' ? c : c.name))).map(t => t.name) : [] });
    } catch { report.sources.push({ id, status: 'network_or_timeout' }); }
  }
  fs.writeFileSync(path.join(dir, 'live-schema-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
