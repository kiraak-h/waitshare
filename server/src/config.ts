import path from "node:path"
import fs from "node:fs"

export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: process.env.DATA_DIR ?? path.resolve(import.meta.dirname, "../data"),
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
