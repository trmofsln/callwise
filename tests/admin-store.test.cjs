/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node test harness. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadServer } = require("../scripts/server-loader.cjs");

const { AdminStore } = loadServer("lib/sqlite.ts");
const { SqliteKv } = loadServer("lib/kv.ts");

function fixture(t, keySource) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-admin-test-"));
  const filename = path.join(directory, "app.sqlite");
  const keyFile = `${filename}.key`;
  fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  const kv = new SqliteKv(filename);
  const store = new AdminStore(kv, keySource ?? { file: keyFile });
  t.after(() => {
    kv.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { filename, keyFile, kv, store };
}

test("admin password and session are hashed, and logout invalidates access", async (t) => {
  const { kv, store } = fixture(t);
  assert.equal(await store.isConfigured(), false);
  await assert.rejects(store.setup("short"), { status: 400 });
  const password = "test-only-password-123";
  await store.setup(password);
  assert.equal(await store.isConfigured(), true);
  await assert.rejects(store.setup(password), { status: 409 });
  await assert.rejects(store.login("wrong"), { status: 401 });
  const token = await store.login(password);
  assert.equal(await store.authenticated(token), true);
  assert.equal(await store.authenticated("invalid"), false);
  const account = await kv.get("admin:account");
  assert.notEqual(account.password_hash, password);
  const sessionKey = `admin:session:${crypto.createHash("sha256").update(token).digest("hex")}`;
  assert.ok(await kv.get(sessionKey));
  assert.equal(await kv.get(`admin:session:${token}`), null);
  await kv.set(sessionKey, { expires_at: 0 });
  assert.equal(await store.authenticated(token), false);
  const next = await store.login(password);
  await store.logout(next);
  assert.equal(await store.authenticated(next), false);
});

test("token is encrypted, omitted from public settings, preserved on edits, and persists", async (t) => {
  const { filename, keyFile, kv, store } = fixture(t);
  const token = "test.jwt.token";
  const saved = await store.saveSettings({ employeeId: "9007199254740993", token, metadata: { region: "north" }, notes: "Test" });
  assert.equal(saved.hasToken, true);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal((await store.getCredentials()).token, token);
  const encrypted = (await kv.get("settings:shared")).token_encrypted;
  assert.notEqual(encrypted, token);
  assert.equal(encrypted.includes(token), false);
  await store.saveSettings({ employeeId: "12345", token: "", metadata: { region: "south" } });
  assert.equal((await store.getCredentials()).token, token);
  assert.equal((await store.getCredentials()).employeeId, "12345");
  const reopenedKv = new SqliteKv(filename);
  const reopened = new AdminStore(reopenedKv, { file: keyFile });
  assert.equal((await reopened.getCredentials()).token, token);
  assert.equal((await reopened.readSettings()).metadata.region, "south");
  reopenedKv.close();
  await store.saveSettings({ employeeId: "12345", clearToken: true });
  assert.equal((await store.getCredentials()).token, null);
  assert.equal((await store.readSettings()).hasToken, false);
});

test("an environment key encrypts the token, and the wrong key cannot read it", async (t) => {
  const key = crypto.randomBytes(32).toString("base64");
  const { kv, store } = fixture(t, { base64: key });
  await store.saveSettings({ employeeId: "7", token: "env-token" });
  assert.equal((await store.getCredentials()).token, "env-token");
  await assert.rejects(new AdminStore(kv, { base64: crypto.randomBytes(32).toString("base64") }).getCredentials(), { status: 500 });
  await assert.rejects(new AdminStore(kv, { base64: "c2hvcnQ=" }).getCredentials(), { status: 500 });
});

test("invalid updates do not overwrite saved settings, and missing keys do not regenerate", async (t) => {
  const { keyFile, store } = fixture(t);
  await store.saveSettings({ employeeId: "123", token: "test-token" });
  for (const input of [
    { employeeId: "1);DROP TABLE shared_settings" },
    { employeeId: "123", metadata: [] },
    { employeeId: "123", token: "Bearer test" },
    { employeeId: "123", clearToken: true, token: "other" },
  ]) await assert.rejects(store.saveSettings(input), { status: 400 });
  assert.equal((await store.getCredentials()).token, "test-token");
  fs.unlinkSync(keyFile);
  await assert.rejects(store.getCredentials(), { status: 500 });
  assert.equal(fs.existsSync(keyFile), false);
});

test("context snapshots persist and the newest record can be retrieved by GLID", async (t) => {
  const { store } = fixture(t);
  const context = { glid: "441", mappingId: "map-1", fetchedAt: new Date().toISOString(), status: "success", requestedSegments: ["ActualData"], data: { ActualData: { count: 0 } }, response: {}, error: null };
  await store.saveGlobalContext(context);
  assert.equal((await store.getLatestGlobalContext("441")).mappingId, "map-1");
  await store.saveGlobalContext({ ...context, mappingId: "map-2" });
  assert.equal((await store.getLatestGlobalContext("441")).mappingId, "map-2");
  assert.equal(await store.getLatestGlobalContext("999"), null);
});

test("key-value store expires keys, counts with a fixed window, and trims lists", async (t) => {
  const { kv } = fixture(t);
  await kv.set("short", 1, 1);
  assert.equal(await kv.get("short"), 1);
  await kv.set("gone", 1, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await kv.get("gone"), null);
  assert.equal(await kv.incr("count", 60), 1);
  assert.equal(await kv.incr("count", 60), 2);
  for (let i = 0; i < 5; i++) await kv.lpush("list", i, 3);
  assert.deepEqual(await kv.lrange("list", 10), [4, 3, 2]);
  await kv.hset("h", "a", { x: 1 });
  await kv.hset("h", "b", 2);
  await kv.hset("hx", "c", 3);
  assert.deepEqual(await kv.hgetall("h"), { a: { x: 1 }, b: 2 });
});
