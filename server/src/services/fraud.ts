import { db } from "../db.js"
import { config } from "../config.js"
import { pendingServeCount } from "./auction.js"

export interface FraudDecision {
  allowed: boolean
  reason?: string
}

export function checkImpressionEligibility(
  deviceId: string,
  durationMs: number,
  viewablePct: number,
  focusPct = 100
): FraudDecision {
  const minMs = config.minImpressionSeconds * 1000
  if (durationMs < minMs) {
    return { allowed: false, reason: "duration below minimum" }
  }
  if (viewablePct < config.minViewablePct) {
    return { allowed: false, reason: "not sufficiently viewable" }
  }
  if (focusPct < config.minFocusPct) {
    return { allowed: false, reason: "surface not focused enough" }
  }

  const hourAgo = Date.now() - 60 * 60 * 1000
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000

  const hourly = db
    .prepare("SELECT COUNT(*) AS n FROM impressions WHERE device_id = ? AND served_at > ?")
    .get(deviceId, hourAgo) as { n: number }
  const daily = db
    .prepare("SELECT COUNT(*) AS n FROM impressions WHERE device_id = ? AND served_at > ?")
    .get(deviceId, dayAgo) as { n: number }

  if (hourly.n >= config.caps.hourlyImpressions) {
    return { allowed: false, reason: "hourly cap reached" }
  }
  if (daily.n >= config.caps.dailyImpressions) {
    return { allowed: false, reason: "daily cap reached" }
  }

  if (pendingServeCount(deviceId) > config.maxPendingServes) {
    return { allowed: false, reason: "too many pending serves" }
  }

  const last = db
    .prepare("SELECT MAX(served_at) AS last FROM impressions WHERE device_id = ?")
    .get(deviceId) as { last: number | null }
  if (last.last && config.minGapMs > 0 && Date.now() - last.last < config.minGapMs) {
    return { allowed: false, reason: "impressions too close together" }
  }

  return { allowed: true }
}

export function checkDeviceSignatureValid(pubkeyB64: string | undefined): boolean {
  return Boolean(pubkeyB64 && pubkeyB64.length > 32)
}
