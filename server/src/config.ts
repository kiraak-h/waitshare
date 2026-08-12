import path from "node:path"
import fs from "node:fs"

export const nodeEnv = process.env.NODE_ENV ?? "development"
export const isProduction = nodeEnv === "production"

export interface ConfigReport {
  errors: string[]
  warnings: string[]
}

export function validateConfig(): ConfigReport {
  const errors: string[] = []
  const warnings: string[] = []

  if (config.stripeMode === "live" && !config.stripeSecretKey) {
    errors.push("STRIPE_MODE=live requires STRIPE_SECRET_KEY")
  }
  if (config.stripeMode === "live" && !config.stripeWebhookSecret) {
    warnings.push("STRIPE_MODE=live: set STRIPE_WEBHOOK_SECRET to verify webhook signatures")
  }
  if (Boolean(config.googleClientId) !== Boolean(config.googleClientSecret)) {
    warnings.push("Google OAuth is misconfigured: set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")
  }
  if (isProduction && process.env.SEED_DEMO !== "0") {
    warnings.push("NODE_ENV=production: set SEED_DEMO=0 to disable demo data seeding")
  }
  if (isProduction && config.publicBaseUrl.startsWith("http://localhost")) {
    warnings.push(`NODE_ENV=production: PUBLIC_BASE_URL is still the default (${config.publicBaseUrl})`)
  }
  if (isProduction && config.webBaseUrl.startsWith("http://localhost")) {
    warnings.push(`NODE_ENV=production: WEB_BASE_URL is still the default (${config.webBaseUrl})`)
  }
  if (isProduction && config.dataDir.includes("/workspace")) {
    warnings.push("NODE_ENV=production: DATA_DIR points into the workspace checkout")
  }

  return { errors, warnings }
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: process.env.DATA_DIR ?? path.resolve(import.meta.dirname, "../data"),
  webDistDir: process.env.WEB_DIST_DIR ?? path.resolve(import.meta.dirname, "../../web/dist"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3001",
  webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:5173",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeMode: process.env.STRIPE_MODE ?? "stub",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  adminToken: process.env.ADMIN_TOKEN ?? "",
  paymentThresholdCents: Number(process.env.PAYMENT_THRESHOLD_CENTS ?? 1000),
  payoutHoldMs: Number(process.env.PAYOUT_HOLD_MS ?? 72 * 60 * 60 * 1000),
  reservePct: Number(process.env.RESERVE_PCT ?? 10),
  reserveReleaseMs: Number(process.env.RESERVE_RELEASE_MS ?? 30 * 24 * 60 * 60 * 1000),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 60_000),
  minImpressionSeconds: Number(process.env.MIN_IMPRESSION_SECONDS ?? 10),
  minViewablePct: Number(process.env.MIN_VIEWABLE_PCT ?? 50),
  minFocusPct: Number(process.env.MIN_FOCUS_PCT ?? 0),
  minGapMs: Number(process.env.MIN_GAP_MS ?? 0),
  maxPendingServes: Number(process.env.MAX_PENDING_SERVES ?? 2),
  fraudSalt: process.env.FRAUD_SALT ?? "",
  asnDbPath: process.env.ASN_DB_PATH ?? "",
  tier2: {
    farmDevsPerNetwork: Number(process.env.TIER2_FARM_DEVS ?? 5),
    vpnNetworksPerDev: Number(process.env.TIER2_VPN_NETWORKS ?? 3),
    windowMs: Number(process.env.TIER2_WINDOW_MS ?? 24 * 60 * 60 * 1000),
    dcEnforce: process.env.TIER2_DC_ENFORCE !== "0",
  },
  tier3: {
    highRisk: Number(process.env.TIER3_HIGH_RISK ?? 75),
    review: Number(process.env.TIER3_REVIEW ?? 55),
    modelPath: process.env.TIER3_MODEL_PATH ?? path.resolve(import.meta.dirname, "../assets/risk-model.json"),
    establishedImpressions: Number(process.env.TRUST_ESTABLISHED_IMPRESSIONS ?? 50),
    establishedDays: Number(process.env.TRUST_ESTABLISHED_DAYS ?? 7),
    trustedImpressions: Number(process.env.TRUST_TRUSTED_IMPRESSIONS ?? 2000),
    trustedDays: Number(process.env.TRUST_TRUSTED_DAYS ?? 30),
    tier0HourlyCap: Number(process.env.TIER0_CAP_HOURLY ?? 20),
    tier0DailyCap: Number(process.env.TIER0_CAP_DAILY ?? 100),
    tier0PayoutCapCents: Number(process.env.TIER0_PAYOUT_CAP_CENTS ?? 10000),
  },
  serveTtlMs: Number(process.env.SERVE_TTL_MS ?? 90_000),
  caps: {
    hourlyImpressions: Number(process.env.CAP_HOURLY ?? 60),
    dailyImpressions: Number(process.env.CAP_DAILY ?? 600),
  },
  split: {
    devShare: 60,
    platformShare: 40,
    version: 1,
  },
}

export function ensureDataDir(): string {
  fs.mkdirSync(config.dataDir, { recursive: true })
  return config.dataDir
}
