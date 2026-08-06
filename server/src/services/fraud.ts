import { db } from "../db.js"
import { config } from "../config.js"
import { pendingServeCount } from "./auction.js"

export interface FraudDecision {
  allowed: boolean
  reason?: string
}

export interface FleetContext {
  devId: string | null
  deviceId: string
  networkHash: string
  windowMs: number
  farmThreshold: number
  vpnThreshold: number
}

export function logFraudEvent(
  type: string,
  opts: { devId?: string | null; deviceId?: string | null; networkHash?: string | null; reason: string }
): void {
  db.prepare(
    "INSERT INTO fraud_events (type, dev_id, device_id, network_hash, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(type, opts.devId ?? null, opts.deviceId ?? null, opts.networkHash ?? null, opts.reason, Date.now())
}

export function logFleetEventOnce(ctx: FleetContext, reason: string): void {
  const recent = db
    .prepare(
      "SELECT id FROM fraud_events WHERE type = 'tier2' AND dev_id = ? AND network_hash = ? AND created_at > ? LIMIT 1"
    )
    .get(ctx.devId ?? null, ctx.networkHash, Date.now() - ctx.windowMs)
  if (!recent) {
    logFraudEvent("tier2", {
      devId: ctx.devId,
      deviceId: ctx.deviceId,
      networkHash: ctx.networkHash,
      reason,
    })
  }
}

function bumpFraudFlags(devId: string | null, by: number): void {
  if (devId) {
    db.prepare("UPDATE devs SET fraud_flags = fraud_flags + ? WHERE id = ?").run(by, devId)
  }
}

export function checkFleetSignals(ctx: FleetContext): FraudDecision {
  const now = Date.now()
  const since = now - ctx.windowMs

  const devsOnNetwork = db
    .prepare(
      "SELECT COUNT(DISTINCT dev_id) AS n FROM impressions WHERE network_hash = ? AND dev_id IS NOT NULL AND served_at > ?"
    )
    .get(ctx.networkHash, since) as { n: number }

  if (devsOnNetwork.n >= ctx.farmThreshold) {
    return { allowed: false, reason: "shared network flagged as farm" }
  }

  if (ctx.devId) {
    const networksForDev = db
      .prepare(
        "SELECT COUNT(DISTINCT network_hash) AS n FROM impressions WHERE dev_id = ? AND network_hash IS NOT NULL AND served_at > ?"
      )
      .get(ctx.devId, since) as { n: number }

    if (networksForDev.n >= ctx.vpnThreshold) {
      return { allowed: false, reason: "device rotated too many networks" }
    }
  }

  return { allowed: true }
}

export function checkImpressionEligibility(
  deviceId: string,
  durationMs: number,
  viewablePct: number,
  focusPct = 100,
  fleet?: FleetContext
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

  if (fleet) {
    const fleetDecision = checkFleetSignals(fleet)
    if (!fleetDecision.allowed) {
      logFraudEvent("tier2", {
        devId: fleet.devId,
        deviceId: fleet.deviceId,
        networkHash: fleet.networkHash,
        reason: fleetDecision.reason ?? "fleet signal",
      })
      bumpFraudFlags(fleet.devId, 1)
      return fleetDecision
    }
  }

  return { allowed: true }
}
