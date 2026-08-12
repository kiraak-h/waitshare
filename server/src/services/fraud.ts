import { db } from "../db.js"
import { config } from "../config.js"
import { pendingServeCount } from "./auction.js"
import { computeTrustTier, trustCaps } from "./scoring.js"
import { inc } from "./metrics.js"

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

export async function logFraudEvent(
  type: string,
  opts: { devId?: string | null; deviceId?: string | null; networkHash?: string | null; reason: string }
): Promise<void> {
  await db.run(
    "INSERT INTO fraud_events (type, dev_id, device_id, network_hash, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [type, opts.devId ?? null, opts.deviceId ?? null, opts.networkHash ?? null, opts.reason, Date.now()]
  )
  inc("fraudEvents")
}

export async function logFleetEventOnce(ctx: FleetContext, reason: string): Promise<void> {
  const recent = await db.get<{ id: number }>(
    "SELECT id FROM fraud_events WHERE type = 'tier2' AND dev_id = ? AND network_hash = ? AND created_at > ? LIMIT 1",
    [ctx.devId ?? null, ctx.networkHash, Date.now() - ctx.windowMs]
  )
  if (!recent) {
    await logFraudEvent("tier2", {
      devId: ctx.devId,
      deviceId: ctx.deviceId,
      networkHash: ctx.networkHash,
      reason,
    })
  }
}

async function bumpFraudFlags(devId: string | null, by: number): Promise<void> {
  if (devId) {
    await db.run("UPDATE devs SET fraud_flags = fraud_flags + ? WHERE id = ?", [by, devId])
  }
}

export async function checkFleetSignals(ctx: FleetContext): Promise<FraudDecision> {
  const since = Date.now() - ctx.windowMs

  const devsOnNetwork = (await db.get<{ n: number }>(
    "SELECT COUNT(DISTINCT dev_id) AS n FROM impressions WHERE network_hash = ? AND dev_id IS NOT NULL AND served_at > ?",
    [ctx.networkHash, since]
  )) as { n: number }

  if (devsOnNetwork.n >= ctx.farmThreshold) {
    return { allowed: false, reason: "shared network flagged as farm" }
  }

  if (ctx.devId) {
    const networksForDev = (await db.get<{ n: number }>(
      "SELECT COUNT(DISTINCT network_hash) AS n FROM impressions WHERE dev_id = ? AND network_hash IS NOT NULL AND served_at > ?",
      [ctx.devId, since]
    )) as { n: number }

    if (networksForDev.n >= ctx.vpnThreshold) {
      return { allowed: false, reason: "device rotated too many networks" }
    }
  }

  return { allowed: true }
}

export async function checkImpressionEligibility(
  deviceId: string,
  durationMs: number,
  viewablePct: number,
  focusPct = 100,
  fleet?: FleetContext
): Promise<FraudDecision> {
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

  const caps = fleet?.devId ? trustCaps(await computeTrustTier(fleet.devId)) : trustCaps(1)
  const hourlyCap = caps.hourly
  const dailyCap = caps.daily

  const hourly = (await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM impressions WHERE device_id = ? AND served_at > ?",
    [deviceId, hourAgo]
  )) as { n: number }
  const daily = (await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM impressions WHERE device_id = ? AND served_at > ?",
    [deviceId, dayAgo]
  )) as { n: number }

  if (hourly.n >= hourlyCap) {
    return { allowed: false, reason: "hourly cap reached" }
  }
  if (daily.n >= dailyCap) {
    return { allowed: false, reason: "daily cap reached" }
  }

  if ((await pendingServeCount(deviceId)) > config.maxPendingServes) {
    return { allowed: false, reason: "too many pending serves" }
  }

  const last = (await db.get<{ last: number | null }>("SELECT MAX(served_at) AS last FROM impressions WHERE device_id = ?", [
    deviceId,
  ])) as { last: number | null }
  if (last.last && config.minGapMs > 0 && Date.now() - last.last < config.minGapMs) {
    return { allowed: false, reason: "impressions too close together" }
  }

  if (fleet) {
    const fleetDecision = await checkFleetSignals(fleet)
    if (!fleetDecision.allowed) {
      await logFraudEvent("tier2", {
        devId: fleet.devId,
        deviceId: fleet.deviceId,
        networkHash: fleet.networkHash,
        reason: fleetDecision.reason ?? "fleet signal",
      })
      await bumpFraudFlags(fleet.devId, 1)
      return fleetDecision
    }
  }

  return { allowed: true }
}
