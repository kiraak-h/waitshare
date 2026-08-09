-- WaitShare — Postgres bootstrap schema
-- Target for the production relational-database swap. The dev server currently
-- uses better-sqlite3 (synchronous, file-backed); this schema is the source of
-- truth for what the async Postgres provider must create and match.
--
-- Conventions mirror the SQLite schema exactly:
--   * all timestamps are epoch-millisecond BIGINT
--   * all ids are app-generated UUID/TEXT strings (no DB-generated ids except
--     fraud_events.id, which is a BIGSERIAL identity)
--   * money is integer mills (1/1000 of a cent), never floats

CREATE TABLE IF NOT EXISTS devs (
  id                TEXT PRIMARY KEY,
  email             TEXT UNIQUE,
  google_sub        TEXT UNIQUE,
  country           TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  balance_mills     BIGINT NOT NULL DEFAULT 0,
  reserve_mills     BIGINT NOT NULL DEFAULT 0,
  total_earned_mills BIGINT NOT NULL DEFAULT 0,
  paid_mills        BIGINT NOT NULL DEFAULT 0,
  stripe_account_id TEXT,
  stripe_onboarded  BOOLEAN NOT NULL DEFAULT FALSE,
  fraud_flags       INTEGER NOT NULL DEFAULT 0,
  trust_tier        INTEGER NOT NULL DEFAULT 0,
  created_at        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_keys (
  device_id TEXT PRIMARY KEY,
  dev_id    TEXT NOT NULL,
  pubkey    TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  dev_id     TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS advertisers (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  company    TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                 TEXT PRIMARY KEY,
  advertiser_id      TEXT NOT NULL,
  ad_line            TEXT NOT NULL,
  url                TEXT NOT NULL,
  brand_icon         TEXT,
  surface            TEXT NOT NULL,
  cpm_cents          INTEGER NOT NULL,
  blocks             INTEGER NOT NULL,
  impressions_bought INTEGER NOT NULL,
  impressions_served INTEGER NOT NULL DEFAULT 0,
  country_filter     TEXT,
  delivery_speed     TEXT NOT NULL DEFAULT 'fast',
  status             TEXT NOT NULL DEFAULT 'active',
  stripe_checkout_id TEXT,
  payment_intent_id  TEXT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS serves (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL,
  dev_id       TEXT,
  device_id    TEXT NOT NULL,
  surface      TEXT NOT NULL,
  ad_line      TEXT NOT NULL,
  url          TEXT NOT NULL,
  nonce        TEXT,
  network_hash TEXT,
  issued_at    BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS impressions (
  id                 TEXT PRIMARY KEY,
  serve_id           TEXT NOT NULL,
  campaign_id        TEXT NOT NULL,
  dev_id             TEXT,
  device_id          TEXT NOT NULL,
  surface            TEXT NOT NULL,
  duration_ms        INTEGER NOT NULL,
  viewable_pct       INTEGER NOT NULL,
  focus_pct          INTEGER NOT NULL DEFAULT 100,
  nonce              TEXT,
  network_hash       TEXT,
  ip_hash            TEXT,
  served_at          BIGINT NOT NULL,
  gross_mills        BIGINT NOT NULL,
  dev_share_mills    BIGINT NOT NULL,
  reserved_mills     BIGINT NOT NULL DEFAULT 0,
  reserve_released_at BIGINT,
  signature          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'credited'
);

CREATE TABLE IF NOT EXISTS fraud_events (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  dev_id       TEXT,
  device_id    TEXT,
  network_hash TEXT,
  reason       TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id                 TEXT PRIMARY KEY,
  dev_id             TEXT NOT NULL,
  amount_mills       BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'held',
  stripe_transfer_id TEXT,
  available_at       BIGINT,
  created_at         BIGINT NOT NULL,
  cleared_at         BIGINT
);

CREATE TABLE IF NOT EXISTS update_manifests (
  platform   TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  url        TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  signature  TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS split_contract (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  dev_share      INTEGER NOT NULL,
  platform_share INTEGER NOT NULL,
  version        INTEGER NOT NULL,
  locked_at      BIGINT NOT NULL
);

-- Seed the locked split contract (60/40). Matches the SQLite bootstrap.
INSERT INTO split_contract (id, dev_share, platform_share, version, locked_at)
VALUES (1, 60, 40, 1, (SELECT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT))
ON CONFLICT (id) DO NOTHING;

-- Idempotent column add for clusters created from an earlier revision of this schema.
ALTER TABLE devs ADD COLUMN IF NOT EXISTS trust_tier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS reserved_mills BIGINT NOT NULL DEFAULT 0;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS reserve_released_at BIGINT;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS nonce TEXT;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS focus_pct INTEGER NOT NULL DEFAULT 100;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS network_hash TEXT;
ALTER TABLE impressions ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE serves ADD COLUMN IF NOT EXISTS nonce TEXT;
ALTER TABLE serves ADD COLUMN IF NOT EXISTS network_hash TEXT;
ALTER TABLE devs ADD COLUMN IF NOT EXISTS reserve_mills BIGINT NOT NULL DEFAULT 0;
ALTER TABLE devs ADD COLUMN IF NOT EXISTS fraud_flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS available_at BIGINT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS stripe_checkout_id TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;

-- Indexes for the hot query paths (see server/src/services/*)
CREATE INDEX IF NOT EXISTS idx_serves_device_status   ON serves (device_id, status);
CREATE INDEX IF NOT EXISTS idx_serves_expires         ON serves (expires_at);
CREATE INDEX IF NOT EXISTS idx_impressions_device_at  ON impressions (device_id, served_at);
CREATE INDEX IF NOT EXISTS idx_impressions_dev_at     ON impressions (dev_id, served_at);
CREATE INDEX IF NOT EXISTS idx_impressions_campaign   ON impressions (campaign_id);
CREATE INDEX IF NOT EXISTS idx_impressions_network    ON impressions (network_hash, served_at);
CREATE INDEX IF NOT EXISTS idx_impressions_ip         ON impressions (ip_hash);
CREATE INDEX IF NOT EXISTS idx_fraud_dev              ON fraud_events (dev_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fraud_network          ON fraud_events (network_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_payouts_dev_status     ON payouts (dev_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_surface      ON campaigns (surface, status);
CREATE INDEX IF NOT EXISTS idx_sessions_dev           ON sessions (dev_id);
