import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { SharedCredentials, SharedSettings } from "./admin-types";
import type { GlobalContextResult } from "./global-context-catalog";
import type { Prediction, SchedulingSettings } from "./best-time-types";
import { DEFAULT_SCHEDULING, validateSettings } from "./best-time-policy";
import { kv, type Kv } from "./kv";

// Admin account, sessions, shared Global Context credentials, calling settings and prediction
// history, on the app's key-value store (Upstash Redis on Vercel, SQLite locally).

export class AdminError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

type SharedRow = { employee_id: string; notes: string; metadata: Record<string, unknown>; token_encrypted: string | null; updated_at: string };
type Account = { password_salt: string; password_hash: string; created_at: string };
const SESSION_SECONDS = 8 * 60 * 60;
const K = { account: "admin:account", session: (h: string) => `admin:session:${h}`, shared: "settings:shared", prediction: "settings:prediction",
  predictions: (glid: string) => `predictions:${glid}`, models: "models", experiment: (id: string) => `experiment:${id}`, context: (glid: string) => `gctx:${glid}` };

/** The 32-byte key that encrypts the shared token: SETTINGS_ENCRYPTION_KEY (base64) or a local key file. */
export type KeySource = { base64?: string; file?: string };

export class AdminStore {
  constructor(private readonly store: Kv = kv(), private readonly keySource: KeySource = defaultKeySource()) {}

  async readPredictionSettings(): Promise<SchedulingSettings> {
    const saved = await this.store.get<SchedulingSettings>(K.prediction);
    return saved ? validateSettings(saved) : { ...DEFAULT_SCHEDULING, businessDays: [...DEFAULT_SCHEDULING.businessDays] };
  }

  async savePredictionSettings(value: unknown): Promise<SchedulingSettings> {
    let settings: SchedulingSettings;
    try { settings = validateSettings(value); } catch (error) { throw new AdminError(error instanceof Error ? error.message : "Invalid scheduling settings."); }
    await this.store.set(K.prediction, settings);
    return settings;
  }

  async savePrediction(prediction: Prediction) { await this.store.lpush(K.predictions(prediction.glid), prediction, 20); }
  async getLatestPrediction(glid: string): Promise<Prediction | null> { return (await this.store.lrange<Prediction>(K.predictions(glid), 1))[0] ?? null; }
  async registerModel(modelVersion: string, route: string, metadata: unknown) { await this.store.hset(K.models, modelVersion, { route, metadata, registered_at: new Date().toISOString() }); }
  async recordExperiment(id: string, summary: unknown) { await this.store.set(K.experiment(id), { summary, recorded_at: new Date().toISOString() }); }
  async saveGlobalContext(context: GlobalContextResult) { await this.store.set(K.context(context.glid), context, 30 * 86_400); }
  async getLatestGlobalContext(glid: string): Promise<GlobalContextResult | null> { return this.store.get<GlobalContextResult>(K.context(glid)); }

  async isConfigured(): Promise<boolean> { return !!(await this.store.get<Account>(K.account)); }

  async setup(password: unknown) {
    if (await this.isConfigured()) throw new AdminError("An admin password is already configured.", 409);
    if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new AdminError("Choose an admin password with at least 12 characters.");
    const salt = randomBytes(16).toString("hex");
    await this.store.set(K.account, { password_salt: salt, password_hash: scryptSync(password, salt, 64).toString("hex"), created_at: new Date().toISOString() } satisfies Account);
  }

  async login(password: unknown): Promise<string> {
    if (typeof password !== "string" || password.length > 1024) throw new AdminError("Invalid admin password.", 401);
    const account = await this.store.get<Account>(K.account);
    if (!account) throw new AdminError("Set up the admin password first.", 409);
    if (!timingSafeEqual(scryptSync(password, account.password_salt, 64), Buffer.from(account.password_hash, "hex"))) throw new AdminError("Invalid admin password.", 401);
    const token = randomBytes(32).toString("hex");
    await this.store.set(K.session(this.sessionHash(token)), { expires_at: Date.now() + SESSION_SECONDS * 1000 }, SESSION_SECONDS);
    return token;
  }

  async authenticated(token: string | undefined): Promise<boolean> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const session = await this.store.get<{ expires_at: number }>(K.session(this.sessionHash(token)));
    return !!session && session.expires_at > Date.now();
  }

  async logout(token: string | undefined) { if (token) await this.store.del(K.session(this.sessionHash(token))); }

  private sessionHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

  private key(): Buffer {
    let key: Buffer;
    if (this.keySource.base64) key = Buffer.from(this.keySource.base64, "base64");
    else {
      try { key = readFileSync(this.keySource.file!); }
      catch { throw new AdminError("The token encryption key is missing. Set SETTINGS_ENCRYPTION_KEY.", 500); }
    }
    if (key.length !== 32) throw new AdminError("The token encryption key is invalid.", 500);
    return key;
  }

  private encrypt(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64")).join(".");
  }

  private row(): Promise<SharedRow | null> { return this.store.get<SharedRow>(K.shared); }

  async readSettings(): Promise<SharedSettings> {
    const row = await this.row();
    return { employeeId: row?.employee_id ?? "", notes: row?.notes ?? "", metadata: row?.metadata ?? {}, hasToken: !!row?.token_encrypted, updatedAt: row?.updated_at ?? null };
  }

  async saveSettings(input: unknown): Promise<SharedSettings> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("Settings must be a JSON object.");
    const { employeeId, token = "", notes = "", metadata = {}, clearToken = false } = input as Record<string, unknown>;
    if (typeof employeeId !== "string" || !/^[1-9][0-9]{0,18}$/.test(employeeId)) throw new AdminError("Employee ID must be a positive whole number.");
    if (typeof token !== "string" || token.length > 16384 || (token.trim() && /\s/.test(token.trim()))) throw new AdminError("Paste a token without spaces or a Bearer prefix (maximum 16384 characters).");
    if (typeof notes !== "string" || notes.length > 4000) throw new AdminError("Notes must be at most 4000 characters.");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new AdminError("Extra data must be a JSON object.");
    if (typeof clearToken !== "boolean") throw new AdminError("clearToken must be a boolean.");
    if (JSON.stringify(metadata).length > 32000) throw new AdminError("Extra data is too large (maximum 32000 characters).");
    if (clearToken && token.trim()) throw new AdminError("Choose either a replacement token or removal.");
    const encrypted = clearToken ? null : token.trim() ? this.encrypt(token.trim()) : (await this.row())?.token_encrypted ?? null;
    await this.store.set(K.shared, { employee_id: employeeId, token_encrypted: encrypted, notes, metadata: metadata as Record<string, unknown>, updated_at: new Date().toISOString() } satisfies SharedRow);
    return this.readSettings();
  }

  /** Server-side integrations use this helper; HTTP responses never include the token. */
  async getCredentials(): Promise<SharedCredentials> {
    const row = await this.row();
    let token: string | null = null;
    if (row?.token_encrypted) {
      try {
        const [iv, tag, encrypted] = row.token_encrypted.split(".").map((value) => Buffer.from(value, "base64"));
        const decipher = createDecipheriv("aes-256-gcm", this.key(), iv);
        decipher.setAuthTag(tag);
        token = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      } catch { throw new AdminError("Cannot decrypt the shared token. Restore the encryption key.", 500); }
    }
    return { token, employeeId: row?.employee_id ?? "", notes: row?.notes ?? "", metadata: row?.metadata ?? {} };
  }
}

function defaultKeySource(): KeySource {
  return process.env.SETTINGS_ENCRYPTION_KEY ? { base64: process.env.SETTINGS_ENCRYPTION_KEY }
    : { file: `${path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.SQLITE_DATABASE_PATH || ".data/app.sqlite")}.key` };
}

const globalStore = globalThis as typeof globalThis & { hackathonAdminStore?: AdminStore };
export function getAdminStore(): AdminStore {
  globalStore.hackathonAdminStore ??= new AdminStore();
  return globalStore.hackathonAdminStore;
}

export function getSharedCredentials(): Promise<SharedCredentials> { return getAdminStore().getCredentials(); }
