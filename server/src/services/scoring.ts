import { db } from "../db.js"
import { config } from "../config.js"
import { getRiskModel, type RiskFeatures } from "./risk-model.js"

export interface ScoreResult {
  score: number
  model: string
  reject: boolean
  review: boolean
  factors: Record<string, number | null>
}

interface RecentRow {
  duration_ms: number
  viewable_pct: number
  served_at: number
}

export function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}

export function cv(values: number[]): number | null {
  if (values.length < 3) return null
  const { mean, std } = meanStd(values)
  if (mean === 0) return null
  return std / mean
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export interface FeatureContext {
  recent: RecentRow[]
  hourly: number
  networks: number
  fraudFlags: number
  accountAgeHours: number
}

export interface FeatureBundle {
  features: RiskFeatures
  raw: Record<string, number | null>
}

/** Normalized 0-1 feature vector shared by every risk model, plus raw stats for auditing. */
export function extractFeatures(ctx: FeatureContext): FeatureBundle {
  const durations = ctx.recent.map((r) => r.duration_ms)
  const viewables = ctx.recent.map((r) => r.viewable_pct)
  const durationCv = cv(durations)
  const viewabilityCv = cv(viewables)

  const sorted = [...ctx.recent].sort((a, b) => a.served_at - b.served_at)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].served_at - sorted[i - 1].served_at
    if (g > 0) gaps.push(g)
  }
  const gapCv = cv(gaps)

  const features: RiskFeatures = {
    regularity: gapCv === null ? 0.5 : clamp01(1 - gapCv / 0.5),
    durationUniformity: durationCv === null ? 0.5 : clamp01(1 - durationCv / 0.4),
    viewabilityUniformity: viewabilityCv === null ? 0.5 : clamp01(1 - viewabilityCv / 0.3),
    rate: clamp01(ctx.hourly / config.caps.hourlyImpressions),
    networkScore: clamp01(ctx.networks / config.tier2.vpnNetworksPerDev),
    flagScore: clamp01(ctx.fraudFlags / 5),
    youth: clamp01(1 - ctx.accountAgeHours / 24),
  }

  const raw: Record<string, number | null> = {
    gapCv,
    durationCv,
    viewabilityCv,
    hourlyRate: ctx.hourly,
    networks: ctx.networks,
  }

  return { features, raw }
}

export interface ScoreContext {
  deviceId: string
  devId?: string | null
  networkHash?: string | null
}

/**
 * Tier 3 risk scoring. Features are activity-shape statistics — never content.
 * Returns a 0-100 score plus the rejection/review flags.
 */
export async function scoreImpression(ctx: ScoreContext): Promise<ScoreResult> {
  const now = Date.now()
  const recent = await db.all<RecentRow>(
    "SELECT duration_ms, viewable_pct, served_at FROM impressions WHERE device_id = ? ORDER BY served_at DESC LIMIT 50",
    [ctx.deviceId]
  )

  const hourly = (await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM impressions WHERE device_id = ? AND served_at > ?",
    [ctx.deviceId, now - 60 * 60 * 1000]
  )) as { n: number }

  let networks = 0
  if (ctx.networkHash) {
    const n = (await db.get<{ n: number }>(
      "SELECT COUNT(DISTINCT network_hash) AS n FROM impressions WHERE device_id = ? AND network_hash IS NOT NULL AND served_at > ?",
      [ctx.deviceId, now - config.tier2.windowMs]
    )) as { n: number }
    networks = n.n
  }

  let fraudFlags = 0
  let accountAgeHours = 24
  if (ctx.devId) {
    const dev = await db.get<{ fraud_flags: number; created_at: number }>("SELECT fraud_flags, created_at FROM devs WHERE id = ?", [
      ctx.devId,
    ])
    if (dev) {
      fraudFlags = dev.fraud_flags
      accountAgeHours = Math.max((now - dev.created_at) / (60 * 60 * 1000), 0.01)
    }
  }

  const { features, raw } = extractFeatures({ recent, hourly: hourly.n, networks, fraudFlags, accountAgeHours })
  const model = getRiskModel()
  const score = model.score(features)

  return {
    score,
    model: model.name,
    reject: score >= config.tier3.highRisk,
    review: score >= config.tier3.review && score < config.tier3.highRisk,
    factors: { ...features, ...raw },
  }
}

export type TrustTier = 0 | 1 | 2

export async function computeTrustTier(devId: string): Promise<TrustTier> {
  const row = await db.get<{ n: number; created_at: number; fraud_flags: number }>(
    "SELECT (SELECT COUNT(*) FROM impressions WHERE dev_id = ?) AS n, created_at, fraud_flags FROM devs WHERE id = ?",
    [devId, devId]
  )
  if (!row) return 0
  const ageDays = (Date.now() - row.created_at) / (24 * 60 * 60 * 1000)
  if (row.n < config.tier3.establishedImpressions || ageDays < config.tier3.establishedDays) return 0
  if (row.n >= config.tier3.trustedImpressions && ageDays >= config.tier3.trustedDays && row.fraud_flags === 0) return 2
  return 1
}

export async function updateTrustTier(devId: string): Promise<TrustTier> {
  const tier = await computeTrustTier(devId)
  await db.run("UPDATE devs SET trust_tier = ? WHERE id = ?", [tier, devId])
  return tier
}

export function trustCaps(tier: TrustTier): { hourly: number; daily: number } {
  if (tier === 0) {
    return { hourly: config.tier3.tier0HourlyCap, daily: config.tier3.tier0DailyCap }
  }
  return { hourly: config.caps.hourlyImpressions, daily: config.caps.dailyImpressions }
}
