import { randomUUID } from "node:crypto"
import { db } from "../db.js"
import { config } from "../config.js"

export interface CampaignRow {
  id: string
  advertiser_id: string
  ad_line: string
  url: string
  brand_icon: string | null
  surface: string
  cpm_cents: number
  blocks: number
  impressions_bought: number
  impressions_served: number
  country_filter: string | null
  delivery_speed: string
  status: string
  created_at: number
}

export async function listActiveCampaigns(surface?: string): Promise<CampaignRow[]> {
  if (surface) {
    return db.all<CampaignRow>("SELECT * FROM campaigns WHERE status = 'active' AND surface = ? ORDER BY cpm_cents DESC, created_at ASC", [surface])
  }
  return db.all<CampaignRow>("SELECT * FROM campaigns WHERE status = 'active' ORDER BY cpm_cents DESC, created_at ASC")
}

export async function getCampaign(id: string): Promise<CampaignRow | undefined> {
  return db.get<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", [id])
}

export async function lastServeForDevice(deviceId: string, surface: string): Promise<{ campaign_id: string } | undefined> {
  return db.get<{ campaign_id: string }>(
    "SELECT campaign_id FROM serves WHERE device_id = ? AND surface = ? ORDER BY issued_at DESC LIMIT 1",
    [deviceId, surface]
  )
}

export interface NextAd {
  campaign: CampaignRow
  serveId: string
  adLine: string
  url: string
  nonce: string
  expiresAt: number
}

export async function pendingServeCount(deviceId: string): Promise<number> {
  const row = (await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM serves WHERE device_id = ? AND status = 'pending' AND expires_at > ?",
    [deviceId, Date.now()]
  )) as { n: number }
  return row.n
}

export async function pickNextAd(
  surface: string,
  deviceId: string,
  devId: string | null,
  networkHash?: string
): Promise<NextAd | null> {
  let candidates = (await listActiveCampaigns(surface)).filter((c) => c.impressions_served < c.impressions_bought)
  if (candidates.length === 0) return null
  if ((await pendingServeCount(deviceId)) >= config.maxPendingServes) return null

  const devCountry = devId
    ? ((await db.get<{ country: string | null }>("SELECT country FROM devs WHERE id = ?", [devId]))?.country ?? null)
    : null
  if (devCountry) {
    candidates = candidates.filter((c) => {
      if (!c.country_filter) return true
      try {
        const allowed = JSON.parse(c.country_filter)
        return Array.isArray(allowed) && allowed.includes(devCountry)
      } catch {
        return true
      }
    })
  }
  if (candidates.length === 0) return null

  const deliveryPriority: Record<string, number> = { fast: 0, medium: 1, slow: 2 }
  candidates.sort((a, b) => {
    const pa = deliveryPriority[a.delivery_speed] ?? 0
    const pb = deliveryPriority[b.delivery_speed] ?? 0
    if (pa !== pb) return pa - pb
    if (a.cpm_cents !== b.cpm_cents) return b.cpm_cents - a.cpm_cents
    return a.created_at - b.created_at
  })

  const last = await lastServeForDevice(deviceId, surface)
  const lastId = last?.campaign_id

  let pick = candidates[0]
  if (lastId && candidates.length > 1 && candidates[0].id === lastId) {
    pick = candidates[1]
  }

  const serveId = randomUUID()
  const nonce = randomUUID().replace(/-/g, "")
  const now = Date.now()
  const ttl = config.serveTtlMs

  await db.run(
    "INSERT INTO serves (id, campaign_id, dev_id, device_id, surface, ad_line, url, nonce, network_hash, issued_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
    [serveId, pick.id, devId, deviceId, surface, pick.ad_line, pick.url, nonce, networkHash ?? null, now, now + ttl]
  )

  return {
    campaign: pick,
    serveId,
    adLine: pick.ad_line,
    url: pick.url,
    nonce,
    expiresAt: now + ttl,
  }
}
