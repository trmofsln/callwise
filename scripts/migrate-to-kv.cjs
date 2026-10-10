/* eslint-disable @typescript-eslint/no-require-imports -- One-time Node migration script. */
// Copies the app's earlier SQLite tables (.data/app.sqlite) into the key-value store used now:
// Upstash Redis when KV_REST_API_URL/KV_REST_API_TOKEN are set, else the local kv table.
// Moves the admin password hash, shared settings (token re-encrypted with SETTINGS_ENCRYPTION_KEY
// when set), calling settings and cached Sarvam analyses. Prints counts only, never values.
//   node scripts/migrate-to-kv.cjs [path/to/app.sqlite]
require("@next/env").loadEnvConfig(process.cwd());
const fs = require("node:fs");
const path = require("node:path");
const { createDecipheriv } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { loadServer } = require("./server-loader.cjs");

const { kv, kvBackend } = loadServer("lib/kv.ts");
const { AdminStore } = loadServer("lib/sqlite.ts");

async function main() {
  const file = path.resolve(process.argv[2] || process.env.SQLITE_DATABASE_PATH || ".data/app.sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const store = kv(), counts = { target: kvBackend() };

  if (has("admin_account")) {
    const row = db.prepare("SELECT password_salt, password_hash, created_at FROM admin_account WHERE id = 1").get();
    if (row) { await store.set("admin:account", { ...row }); counts.admin_account = 1; }
  }
  if (has("shared_settings")) {
    const row = db.prepare("SELECT employee_id, token_encrypted, notes, metadata_json FROM shared_settings WHERE id = 1").get();
    if (row) {
      let token = "";
      if (row.token_encrypted) {
        const key = fs.readFileSync(`${file}.key`);
        const [iv, tag, encrypted] = row.token_encrypted.split(".").map((value) => Buffer.from(value, "base64"));
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        token = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      }
      await new AdminStore(store).saveSettings({ employeeId: row.employee_id, token, notes: row.notes, metadata: JSON.parse(row.metadata_json) });
      counts.shared_settings = 1;
      counts.token = token ? "re-encrypted" : "none";
    }
  }
  if (has("prediction_settings")) {
    const row = db.prepare("SELECT settings_json FROM prediction_settings WHERE id = 1").get();
    if (row) { await new AdminStore(store).savePredictionSettings(JSON.parse(row.settings_json)); counts.prediction_settings = 1; }
  }
  if (has("recording_analyses")) {
    const rows = db.prepare("SELECT call_id, glid, payload_json FROM recording_analyses").all();
    for (const row of rows) await store.hset(`rec:${row.glid}`, row.call_id, JSON.parse(row.payload_json));
    counts.recording_analyses = rows.length;
  }
  if (has("transcript_analyses")) {
    const rows = db.prepare("SELECT hash, payload_json FROM transcript_analyses").all();
    for (const row of rows) await store.set(`tx:${row.hash}`, JSON.parse(row.payload_json), 90 * 86_400);
    counts.transcript_analyses = rows.length;
  }
  db.close();
  console.log(JSON.stringify(counts));
}

main().catch((error) => { console.error(`Migration failed: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; });
