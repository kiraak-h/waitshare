import Database from "better-sqlite3"
import { ensureDataDir } from "./config.js"

const dataDir = ensureDataDir()
const db = new Database(`${dataDir}/waitshare.db`)
db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")

db.exec(`
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
  served_at INTEGER NOT NULL,
  gross_mills INTEGER NOT NULL,
  dev_share_mills INTEGER NOT NULL,
  reserved_mills INTEGER NOT NULL DEFAULT 0,
  reserve_released_at INTEGER,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'credited'
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
`)

const contractExists = db.prepare("SELECT id FROM split_contract WHERE id = 1").get()
if (!contractExists) {
  db.prepare(
    "INSERT INTO split_contract (id, dev_share, platform_share, version, locked_at) VALUES (1, 60, 40, 1, ?)"
  ).run(Date.now())
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

ensureColumn("serves", "nonce", "nonce TEXT")
ensureColumn("impressions", "nonce", "nonce TEXT")
ensureColumn("impressions", "focus_pct", "focus_pct INTEGER NOT NULL DEFAULT 100")
ensureColumn("devs", "reserve_mills", "reserve_mills INTEGER NOT NULL DEFAULT 0")
ensureColumn("impressions", "reserved_mills", "reserved_mills INTEGER NOT NULL DEFAULT 0")
ensureColumn("impressions", "reserve_released_at", "reserve_released_at INTEGER")
ensureColumn("payouts", "available_at", "available_at INTEGER")

export { db }
