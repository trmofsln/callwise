import path from "node:path";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

// One small key-value store for everything the app persists (admin account, settings, caches,
// saved lookups). On Vercel the disk is not persistent, so it uses Upstash Redis over its REST
// API; locally it falls back to a table in .data/app.sqlite so development needs no service.

type Json = unknown;
export interface Kv {
  get<T = Json>(key: string): Promise<T | null>;
  set(key: string, value: Json, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Set only if the key is absent (or expired); true when this call set it. */
  setnx(key: string, value: Json, ttlSeconds: number): Promise<boolean>;
  /** Increment a counter, setting its expiry on first use. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  hset(key: string, field: string, value: Json): Promise<void>;
  hgetall<T = Json>(key: string): Promise<Record<string, T>>;
  /** Prepend to a list and keep only the newest `max` items. */
  lpush(key: string, value: Json, max: number): Promise<void>;
  lrange<T = Json>(key: string, count: number): Promise<T[]>;
}

const url = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const kvBackend = () => url() && token() ? "upstash" : "sqlite";

class UpstashKv implements Kv {
  private async call(commands: (string | number)[][]): Promise<unknown[]> {
    const response = await fetch(`${url()}/pipeline`, {
      method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands), cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Storage request failed (HTTP ${response.status}).`);
    const body = await response.json() as { result?: unknown; error?: string }[];
    const failed = body.find(r => r.error);
    if (failed) throw new Error(`Storage error: ${failed.error}`);
    return body.map(r => r.result);
  }
  private parse<T>(raw: unknown): T | null { return typeof raw === "string" ? JSON.parse(raw) as T : null; }
  async get<T>(key: string) { return this.parse<T>((await this.call([["GET", key]]))[0]); }
  async set(key: string, value: Json, ttl?: number) { await this.call([ttl ? ["SET", key, JSON.stringify(value), "EX", ttl] : ["SET", key, JSON.stringify(value)]]); }
  async del(key: string) { await this.call([["DEL", key]]); }
  async setnx(key: string, value: Json, ttl: number) { return (await this.call([["SET", key, JSON.stringify(value), "NX", "EX", ttl]]))[0] === "OK"; }
  async incr(key: string, ttl: number) {
    const [count] = await this.call([["INCR", key], ["EXPIRE", key, ttl, "NX"]]);
    return Number(count);
  }
  async hset(key: string, field: string, value: Json) { await this.call([["HSET", key, field, JSON.stringify(value)]]); }
  async hgetall<T>(key: string) {
    const flat = (await this.call([["HGETALL", key]]))[0] as string[] | null;
    const out: Record<string, T> = {};
    for (let i = 0; flat && i < flat.length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]) as T;
    return out;
  }
  async lpush(key: string, value: Json, max: number) { await this.call([["LPUSH", key, JSON.stringify(value)], ["LTRIM", key, 0, max - 1]]); }
  async lrange<T>(key: string, count: number) { return ((await this.call([["LRANGE", key, 0, count - 1]]))[0] as string[] ?? []).map(v => JSON.parse(v) as T); }
}

export class SqliteKv implements Kv {
  private db: DatabaseSync | null = null;
  constructor(private readonly file = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.SQLITE_DATABASE_PATH || ".data/app.sqlite")) {}
  close() { this.db?.close(); this.db = null; }
  private async store(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    const { DatabaseSync } = await import("node:sqlite");
    const file = this.file;
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file, { timeout: 5000 });
    db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS kv_list (key TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kv_list_key ON kv_list(key, seq);`);
    this.db = db;
    return db;
  }
  private live = (row: { value: string; expires_at: number | null } | undefined) => row && (row.expires_at === null || row.expires_at > Date.now()) ? row.value : null;
  async get<T>(key: string) {
    const raw = this.live((await this.store()).prepare("SELECT value, expires_at FROM kv WHERE key = ?").get(key) as { value: string; expires_at: number | null } | undefined);
    return raw === null ? null : JSON.parse(raw) as T;
  }
  async set(key: string, value: Json, ttl?: number) {
    (await this.store()).prepare("INSERT INTO kv(key, value, expires_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
      .run(key, JSON.stringify(value), ttl ? Date.now() + ttl * 1000 : null);
  }
  async del(key: string) { (await this.store()).prepare("DELETE FROM kv WHERE key = ?").run(key); }
  async setnx(key: string, value: Json, ttl: number) {
    const result = (await this.store()).prepare("INSERT INTO kv(key, value, expires_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at WHERE kv.expires_at IS NOT NULL AND kv.expires_at <= ?")
      .run(key, JSON.stringify(value), Date.now() + ttl * 1000, Date.now());
    return Number(result.changes) > 0;
  }
  async incr(key: string, ttl: number) {
    const current = (await this.get<number>(key)) ?? 0;
    const row = (await this.store()).prepare("SELECT expires_at FROM kv WHERE key = ?").get(key) as { expires_at: number | null } | undefined;
    const keep = current > 0 && row?.expires_at ? Math.max(1, Math.round((row.expires_at - Date.now()) / 1000)) : ttl;
    await this.set(key, current + 1, keep);
    return current + 1;
  }
  async hset(key: string, field: string, value: Json) { await this.set(`${key}\u001f${field}`, value); }
  async hgetall<T>(key: string) {
    const rows = (await this.store()).prepare("SELECT key, value, expires_at FROM kv WHERE key >= ? AND key < ?").all(`${key}\u001f`, `${key}\u0020`) as { key: string; value: string; expires_at: number | null }[];
    const out: Record<string, T> = {};
    for (const r of rows) { const v = this.live(r); if (v !== null) out[r.key.slice(key.length + 1)] = JSON.parse(v) as T; }
    return out;
  }
  async lpush(key: string, value: Json, max: number) {
    const db = await this.store();
    db.prepare("INSERT INTO kv_list(key, value) VALUES(?, ?)").run(key, JSON.stringify(value));
    db.prepare("DELETE FROM kv_list WHERE key = ? AND seq NOT IN (SELECT seq FROM kv_list WHERE key = ? ORDER BY seq DESC LIMIT ?)").run(key, key, max);
  }
  async lrange<T>(key: string, count: number) {
    return ((await this.store()).prepare("SELECT value FROM kv_list WHERE key = ? ORDER BY seq DESC LIMIT ?").all(key, count) as { value: string }[]).map(r => JSON.parse(r.value) as T);
  }
}

const holder = globalThis as typeof globalThis & { callwiseKv?: Kv };
export function kv(): Kv {
  holder.callwiseKv ??= kvBackend() === "upstash" ? new UpstashKv() : new SqliteKv();
  return holder.callwiseKv;
}
