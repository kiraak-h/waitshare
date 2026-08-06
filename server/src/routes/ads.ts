import { Router, type Request } from "express"
import { z } from "zod"
import { db } from "../db.js"
import { pickNextAd } from "../services/auction.js"
import { verifyJsonSignature } from "../services/signing.js"
import { checkImpressionEligibility, checkFleetSignals, logFleetEventOnce, type FleetContext } from "../services/fraud.js"
import { deriveNetworkSignals } from "../services/network.js"
import { getServe, recordImpression, voidServe } from "../services/ledger.js"
import { getSplitContract } from "../services/split.js"
import { config } from "../config.js"

export const adsRouter = Router()

const SUPPORTED_SURFACES = ["opencode", "claude-code-cli", "vscode", "terminal"]

function getSessionDevId(req: Request): string | null {
  const token = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
  if (!token) return null
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as { dev_id: string } | undefined
  return session?.dev_id ?? null
}

adsRouter.get("/next", (req, res) => {
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
  const devId = getSessionDevId(req)
  const signals = deriveNetworkSignals(req)

  if (devId) {
    const fleet: FleetContext = {
      devId,
      deviceId,
      networkHash: signals.networkHash,
      windowMs: config.tier2.windowMs,
      farmThreshold: config.tier2.farmDevsPerNetwork,
      vpnThreshold: config.tier2.vpnNetworksPerDev,
    }
    const pre = checkFleetSignals(fleet)
    if (!pre.allowed) {
      logFleetEventOnce(fleet, pre.reason ?? "fleet signal")
      res.json({ ad: null, reason: pre.reason })
      return
    }
  }

  const ad = pickNextAd(surface, deviceId, devId, signals.networkHash)
  if (!ad) {
    res.json({ ad: null })
    return
  }

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

const impressionSchema = z.object({
  serveId: z.string().min(1),
  deviceId: z.string().min(1),
  durationMs: z.number().int().positive(),
  viewablePct: z.number().int().min(0).max(100),
  focusPct: z.number().int().min(0).max(100).default(100),
  nonce: z.string().min(1),
  ts: z.number().int(),
  signature: z.string().min(1),
})

adsRouter.post("/impressions", (req, res) => {
  const parsed = impressionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid impression payload" })
    return
  }
  const { serveId, deviceId, durationMs, viewablePct, focusPct, nonce, ts, signature } = parsed.data
  const now = Date.now()

  const serve = getServe(serveId)
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
    voidServe(serveId)
    res.status(403).json({ error: "serve challenge mismatch" })
    return
  }
  if (now > serve.expires_at) {
    voidServe(serveId)
    res.status(410).json({ error: "serve expired" })
    return
  }

  const signals = deriveNetworkSignals(req)
  if (serve.network_hash && signals.networkHash !== serve.network_hash) {
    voidServe(serveId)
    res.status(403).json({ error: "network changed since serve issued" })
    return
  }

  const device = db.prepare("SELECT * FROM device_keys WHERE device_id = ?").get(deviceId) as
    | { dev_id: string; pubkey: string }
    | undefined

  if (device) {
    const canonical = { serveId, deviceId, durationMs, viewablePct, focusPct, nonce, ts }
    if (!verifyJsonSignature(canonical, signature, device.pubkey)) {
      res.status(401).json({ error: "invalid signature" })
      return
    }
  } else {
    if (signature !== "demo") {
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
  const fraud = checkImpressionEligibility(deviceId, durationMs, viewablePct, focusPct, fleet)
  if (!fraud.allowed) {
    voidServe(serveId)
    res.status(422).json({ error: "impression rejected", reason: fraud.reason })
    return
  }

  const result = recordImpression({
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

  const split = getSplitContract()
  res.json({
    credited: true,
    impressionId: result.id,
    grossMills: result.grossMills,
    devShareMills: result.devShareMills,
    split: { devShare: split.devShare, platformShare: split.platformShare },
  })
})
