import { Router, type Request } from "express"
import { z } from "zod"
import { db } from "../db.js"
import { pickNextAd } from "../services/auction.js"
import { verifyJsonSignature } from "../services/signing.js"
import { checkImpressionEligibility, checkFleetSignals, logFleetEventOnce, logFraudEvent, type FleetContext } from "../services/fraud.js"
import { scoreImpression, updateTrustTier } from "../services/scoring.js"
import { deriveNetworkSignals } from "../services/network.js"
import { getServe, recordImpression, voidServe } from "../services/ledger.js"
import { getSplitContract } from "../services/split.js"
import { config } from "../config.js"
import { inc } from "../services/metrics.js"
import { rateLimit } from "../services/rate-limit.js"
import { asyncHandler } from "../async-handler.js"

export const adsRouter = Router()

const SUPPORTED_SURFACES = ["opencode", "claude-code-cli", "vscode", "terminal"]

async function getSessionDevId(req: Request): Promise<string | null> {
  const token = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
  if (!token) return null
  const session = await db.get<{ dev_id: string }>("SELECT * FROM sessions WHERE token = ? AND expires_at > ?", [
    token,
    Date.now(),
  ])
  return session?.dev_id ?? null
}

adsRouter.get(
  "/next",
  rateLimit({ windowMs: 60_000, max: 120 }),
  asyncHandler(async (req, res) => {
    const surface = String(req.query.surface ?? "")
    const deviceId = String(req.query.deviceId ?? "")
    if (!SUPPORTED_SURFACES.includes(surface)) {
      res.status(400).json({ error: "unsupported surface" })
      return
    }
    if (!deviceId) {
      res.status(400).json({ error: "deviceId required" })
      return
    }
    const devId = await getSessionDevId(req)
    const signals = deriveNetworkSignals(req)

    if (config.tier2.dcEnforce && signals.kind === "datacenter") {
      await logFraudEvent("tier2-dc", {
        devId,
        deviceId,
        networkHash: signals.networkHash,
        reason: `datacenter network (${signals.asnName ?? "cloud"}) not eligible`,
      })
      res.json({ ad: null, reason: "datacenter network not eligible" })
      return
    }

    if (devId) {
      const dev = await db.get<{ status: string }>("SELECT status FROM devs WHERE id = ?", [devId])
      if (dev && dev.status !== "active") {
        res.json({ ad: null, reason: `account ${dev.status}` })
        return
      }
      const fleet: FleetContext = {
        devId,
        deviceId,
        networkHash: signals.networkHash,
        windowMs: config.tier2.windowMs,
        farmThreshold: config.tier2.farmDevsPerNetwork,
        vpnThreshold: config.tier2.vpnNetworksPerDev,
      }
      const pre = await checkFleetSignals(fleet)
      if (!pre.allowed) {
        await logFleetEventOnce(fleet, pre.reason ?? "fleet signal")
        res.json({ ad: null, reason: pre.reason })
        return
      }
    }

    const ad = await pickNextAd(surface, deviceId, devId, signals.networkHash)
    if (!ad) {
      res.json({ ad: null })
      return
    }
    inc("servesIssued")

    res.json({
      ad: {
        serveId: ad.serveId,
        adLine: ad.adLine,
        url: ad.url,
        nonce: ad.nonce,
        surface,
        expiresAt: ad.expiresAt,
        sponsored: true,
      },
    })
  })
)

const impressionSchema = z.object({
  serveId: z.string().min(1),
  deviceId: z.string().min(1),
  durationMs: z.number().int().positive().max(30 * 60 * 1000),
  viewablePct: z.number().int().min(0).max(100),
  focusPct: z.number().int().min(0).max(100).default(100),
  nonce: z.string().min(1),
  ts: z.number().int(),
  signature: z.string().min(1),
})

adsRouter.post(
  "/impressions",
  asyncHandler(async (req, res) => {
    const parsed = impressionSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid impression payload" })
      return
    }
    const { serveId, deviceId, durationMs, viewablePct, focusPct, nonce, ts, signature } = parsed.data
    const now = Date.now()

    if (Math.abs(now - ts) > 10 * 60 * 1000) {
      res.status(400).json({ error: "impression timestamp out of range" })
      return
    }

    const serve = await getServe(serveId)
    if (!serve) {
      res.status(404).json({ error: "serve not found" })
      return
    }
    if (serve.status !== "pending") {
      res.status(409).json({ error: "serve already used", serveStatus: serve.status })
      return
    }
    if (serve.device_id !== deviceId) {
      res.status(403).json({ error: "serve not issued to this device" })
      return
    }
    if (serve.nonce && serve.nonce !== nonce) {
      await voidServe(serveId)
      res.status(403).json({ error: "serve challenge mismatch" })
      return
    }
    if (now > serve.expires_at) {
      await voidServe(serveId)
      res.status(410).json({ error: "serve expired" })
      return
    }

    const signals = deriveNetworkSignals(req)
    if (serve.network_hash && signals.networkHash !== serve.network_hash) {
      await voidServe(serveId)
      res.status(403).json({ error: "network changed since serve issued" })
      return
    }

    const device = await db.get<{ dev_id: string; pubkey: string }>("SELECT * FROM device_keys WHERE device_id = ?", [deviceId])

    if (device) {
      const canonical = { serveId, deviceId, durationMs, viewablePct, focusPct, nonce, ts }
      if (!verifyJsonSignature(canonical, signature, device.pubkey)) {
        res.status(401).json({ error: "invalid signature" })
        return
      }
    } else {
      // Unregistered devices may only submit the "demo" signature in stub mode.
      // In live mode every impression must be signed by a registered device key.
      if (config.stripeMode !== "stub" || signature !== "demo") {
        res.status(401).json({ error: "unregistered device or invalid signature" })
        return
      }
    }

    const devId = device?.dev_id ?? serve.dev_id
    const fleet: FleetContext = {
      devId,
      deviceId,
      networkHash: signals.networkHash,
      windowMs: config.tier2.windowMs,
      farmThreshold: config.tier2.farmDevsPerNetwork,
      vpnThreshold: config.tier2.vpnNetworksPerDev,
    }
    const fraud = await checkImpressionEligibility(deviceId, durationMs, viewablePct, focusPct, fleet)
    if (!fraud.allowed) {
      await voidServe(serveId)
      inc("impressionsRejected")
      res.status(422).json({ error: "impression rejected", reason: fraud.reason })
      return
    }

    const scored = await scoreImpression({ deviceId, devId, networkHash: signals.networkHash })
    if (scored.reject) {
      await voidServe(serveId)
      await logFraudEvent("tier3-reject", {
        devId,
        deviceId,
        networkHash: signals.networkHash,
        reason: `high risk score ${scored.score}`,
      })
      if (devId) await db.run("UPDATE devs SET fraud_flags = fraud_flags + 1 WHERE id = ?", [devId])
      inc("impressionsRejected")
      res.status(422).json({ error: "impression rejected", reason: `high risk score ${scored.score}` })
      return
    }
    if (scored.review) {
      await logFraudEvent("tier3-review", {
        devId,
        deviceId,
        networkHash: signals.networkHash,
        reason: `review score ${scored.score}`,
      })
    }

    const result = await recordImpression({
      serveId,
      campaignId: serve.campaign_id,
      devId,
      deviceId,
      surface: serve.surface,
      durationMs,
      viewablePct,
      focusPct,
      nonce,
      networkHash: signals.networkHash,
      ipHash: signals.ipHash,
      signature,
    })
    if (!result) {
      res.status(409).json({ error: "serve already used" })
      return
    }
    inc("impressionsCredited")

    const split = await getSplitContract()
    if (devId) await updateTrustTier(devId)
    res.json({
      credited: true,
      impressionId: result.id,
      grossMills: result.grossMills,
      devShareMills: result.devShareMills,
      split: { devShare: split.devShare, platformShare: split.platformShare },
    })
  })
)
