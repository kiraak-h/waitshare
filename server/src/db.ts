import fs from "node:fs"
import path from "node:path"
import pg from "pg"
import Database from "better-sqlite3"
import { config, ensureDataDir } from "./config.js"

export interface RunResult {
  changes: number
}

export interface DbDriver {
  readonly kind: "sqlite" | "postgres"
  init(): Promise<void>
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<RunResult>
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS devs (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  google_sub TEXT UNIQUE,
  country TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  balance_mills INTEGER NOT NULL DEFAULT 0,
  reserve_mills INTEGER NOT NULL DEFAULT 0,
  total_earned_mills INTEGER NOT NULL DEFAULT 0,
  paid_mills INTEGER NOT NULL DEFAULT 0,
  stripe_account_id TEXT,
  stripe_onboarded INTEGER NOT NULL DEFAULT 0,
  fraud_flags INTEGER NOT NULL DEFAULT 0,
  fraud_labels TEXT NOT NULL DEFAULT '{}',
  trust_tier INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_keys (
  device_id TEXT PRIMARY KEY,
  dev_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  dev_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS advertisers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  company TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  advertiser_id TEXT NOT NULL,
  ad_line TEXT NOT NULL,
  url TEXT NOT NULL,
  brand_icon TEXT,
  surface TEXT NOT NULL,
  cpm_cents INTEGER NOT NULL,
  blocks INTEGER NOT NULL,
  impressions_bought INTEGER NOT NULL,
  impressions_served INTEGER NOT NULL DEFAULT 0,
  country_filter TEXT,
  delivery_speed TEXT NOT NULL DEFAULT 'fast',
  status TEXT NOT NULL DEFAULT 'active',
  stripe_checkout_id TEXT,
  payment_intent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS serves (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  dev_id TEXT,
  device_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  ad_line TEXT NOT NULL,
  url TEXT NOT NULL,
  nonce TEXT,
  network_hash TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS impressions (
  id TEXT PRIMARY KEY,
  serve_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  dev_id TEXT,
  device_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  viewable_pct INTEGER NOT NULL,
  focus_pct INTEGER NOT NULL DEFAULT 100,
  nonce TEXT,
  network_hash TEXT,
  ip_hash TEXT,
  served_at INTEGER NOT NULL,
  gross_mills INTEGER NOT NULL,
  dev_share_mills INTEGER NOT NULL,
  reserved_mills INTEGER NOT NULL DEFAULT 0,
  reserve_released_at INTEGER,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'credited'
);

CREATE TABLE IF NOT EXISTS fraud_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  dev_id TEXT,
  device_id TEXT,
  network_hash TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dev_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  dev_id TEXT NOT NULL,
  amount_mills INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  stripe_transfer_id TEXT,
  available_at INTEGER,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);

CREATE TABLE IF NOT EXISTS update_manifests (
  platform TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS split_contract (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dev_share INTEGER NOT NULL,
  platform_share INTEGER NOT NULL,
  version INTEGER NOT NULL,
  locked_at INTEGER NOT NULL
);
`

function ensureColumnSq(raw: Database.Database, table: string, column: string, ddl: string): void {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

class SqliteDriver implements DbDriver {
  readonly kind = "sqlite" as const
  private raw: Database.Database | null = null

  async init(): Promise<void> {
    const dataDir = ensureDataDir()
    const raw = new Database(`${dataDir}/waitshare.db`)
    raw.pragma("journal_mode = WAL")
    raw.pragma("foreign_keys = ON")
    raw.exec(SQLITE_DDL)
    this.raw = raw

    const contractExists = raw.prepare("SELECT id FROM split_contract WHERE id = 1").get()
    if (!contractExists) {
      raw.prepare("INSERT INTO split_contract (id, dev_share, platform_share, version, locked_at) VALUES (1, 60, 40, 1, ?)").run(Date.now())
    }

    ensureColumnSq(raw, "serves", "nonce", "nonce TEXT")
    ensureColumnSq(raw, "impressions", "nonce", "nonce TEXT")
    ensureColumnSq(raw, "impressions", "focus_pct", "focus_pct INTEGER NOT NULL DEFAULT 100")
    ensureColumnSq(raw, "devs", "reserve_mills", "reserve_mills INTEGER NOT NULL DEFAULT 0")
    ensureColumnSq(raw, "devs", "fraud_flags", "fraud_flags INTEGER NOT NULL DEFAULT 0")
    ensureColumnSq(raw, "devs", "fraud_labels", "fraud_labels TEXT NOT NULL DEFAULT '{}'")
    ensureColumnSq(raw, "devs", "trust_tier", "trust_tier INTEGER NOT NULL DEFAULT 0")
    ensureColumnSq(raw, "impressions", "reserved_mills", "reserved_mills INTEGER NOT NULL DEFAULT 0")
    ensureColumnSq(raw, "impressions", "reserve_released_at", "reserve_released_at INTEGER")
    ensureColumnSq(raw, "impressions", "network_hash", "network_hash TEXT")
    ensureColumnSq(raw, "impressions", "ip_hash", "ip_hash TEXT")
    ensureColumnSq(raw, "serves", "network_hash", "network_hash TEXT")
    ensureColumnSq(raw, "payouts", "available_at", "available_at INTEGER")
    ensureColumnSq(raw, "campaigns", "stripe_checkout_id", "stripe_checkout_id TEXT")
    ensureColumnSq(raw, "campaigns", "payment_intent_id", "payment_intent_id TEXT")
  }

  private require(): Database.Database {
    if (!this.raw) throw new Error("database not initialized")
    return this.raw
  }

  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return this.require().prepare(sql).get(...(params ?? [])) as T | undefined
  }

  async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.require().prepare(sql).all(...(params ?? [])) as T[]
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    const info = this.require().prepare(sql).run(...(params ?? []))
    return { changes: info.changes }
  }

  async exec(sql: string): Promise<void> {
    this.require().exec(sql)
  }

  async close(): Promise<void> {
    this.raw?.close()
    this.raw = null
  }
}

pg.types.setTypeParser(20, (v) => Number(v))
pg.types.setTypeParser(16, (v) => (v === "true" ? 1 : 0))

export function toPgSql(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

function postgresSchemaPath(): string {
  return path.resolve(import.meta.dirname, "../migrations/001_init.sql")
}

class PostgresDriver implements DbDriver {
  readonly kind = "postgres" as const
  private pool: pg.Pool | null = null
  private url: string

  constructor(url: string) {
    this.url = url
  }

  async init(): Promise<void> {
    const pool = new pg.Pool({ connectionString: this.url, max: 10 })
    this.pool = pool
    const schemaPath = process.env.PG_SCHEMA_PATH || postgresSchemaPath()
    if (fs.existsSync(schemaPath)) {
      const ddl = fs.readFileSync(schemaPath, "utf8")
      await pool.query(ddl)
    }
  }

  private require(): pg.Pool {
    if (!this.pool) throw new Error("database not initialized")
    return this.pool
  }

  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const res = await this.require().query(toPgSql(sql), params ?? [])
    return res.rows[0] as T | undefined
  }

  async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const res = await this.require().query(toPgSql(sql), params ?? [])
    return res.rows as T[]
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    const res = await this.require().query(toPgSql(sql), params ?? [])
    return { changes: res.rowCount ?? 0 }
  }

  async exec(sql: string): Promise<void> {
    await this.require().query(sql)
  }

  async close(): Promise<void> {
    await this.pool?.end()
    this.pool = null
  }
}

const databaseUrl = process.env.DATABASE_URL
export const dbKind: "sqlite" | "postgres" = databaseUrl ? "postgres" : "sqlite"
export const driver: DbDriver = databaseUrl ? new PostgresDriver(databaseUrl) : new SqliteDriver()

let ready: Promise<void> | null = null

export function initDb(): Promise<void> {
  if (!ready) {
    ready = driver.init()
  }
  return ready
}

async function withReady<T>(fn: () => Promise<T>): Promise<T> {
  await initDb()
  return fn()
}

export const db = {
  kind: dbKind,
  get: <T>(sql: string, params?: unknown[]) => withReady(() => driver.get<T>(sql, params)),
  all: <T>(sql: string, params?: unknown[]) => withReady(() => driver.all<T>(sql, params)),
  run: (sql: string, params?: unknown[]) => withReady(() => driver.run(sql, params)),
  exec: (sql: string) => withReady(() => driver.exec(sql)),
  close: () => driver.close(),
}
