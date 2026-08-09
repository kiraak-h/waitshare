import { db } from "../db.js"
import { config } from "../config.js"

export interface ScoreResult {
  score: number
  reject: boolean
  review: boolean
  factors: Record<string, number | null>
}

interface RecentRow {
  duration_ms: number
  viewable_pct: number
  served_at: number
}

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}

function cv(values: number[]): number | null {
  if (values.length < 3) return null
  const { mean, std } = meanStd(values)
  if (mean === 0) return null
  return std / mean
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export interface ScoreContext {
  deviceId: string
  devId?: string | null
  networkHash?: string | null
}

/**
 * Tier 3 risk model. Features are activity-shape statistics — never content.
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

  const durations = recent.map((r) => r.duration_ms)
  const viewables = recent.map((r) => r.viewable_pct)
  const durationCv = cv(durations)
  const viewabilityCv = cv(viewables)

  const sorted = [...recent].sort((a, b) => a.served_at - b.served_at)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].served_at - sorted[i - 1].served_at
    if (g > 0) gaps.push(g)
  }
  const gapCv = cv(gaps)

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

  const regularity = gapCv === null ? 0.5 : clamp01(1 - gapCv / 0.5)
  const durationUniformity = durationCv === null ? 0.5 : clamp01(1 - durationCv / 0.4)
  const viewabilityUniformity = viewabilityCv === null ? 0.5 : clamp01(1 - viewabilityCv / 0.3)
  const rate = clamp01(hourly.n / config.caps.hourlyImpressions)
  const networkScore = clamp01(networks / config.tier2.vpnNetworksPerDev)
  const flagScore = clamp01(fraudFlags / 5)
  const youth = clamp01(1 - accountAgeHours / 24)

  const factors = {
    regularity,
    durationUniformity,
    viewabilityUniformity,
    rate,
    networkScore,
    flagScore,
    youth,
    gapCv,
    durationCv,
    hourlyRate: hourly.n,
  }

  const score = Math.round(
    100 *
      (0.2 * regularity +
        0.15 * durationUniformity +
        0.1 * viewabilityUniformity +
        0.2 * rate +
        0.1 * networkScore +
        0.15 * flagScore +
        0.1 * youth)
  )

  return {
    score,
    reject: score >= config.tier3.highRisk,
    review: score >= config.tier3.review && score < config.tier3.highRisk,
    factors,
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
