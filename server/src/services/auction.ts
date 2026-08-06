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

export function listActiveCampaigns(surface?: string): CampaignRow[] {
  if (surface) {
    return db
      .prepare("SELECT * FROM campaigns WHERE status = 'active' AND surface = ? ORDER BY cpm_cents DESC, created_at ASC")
      .all(surface) as CampaignRow[]
  }
  return db.prepare("SELECT * FROM campaigns WHERE status = 'active' ORDER BY cpm_cents DESC, created_at ASC").all() as CampaignRow[]
}

export function getCampaign(id: string): CampaignRow | undefined {
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined
}

export function lastServeForDevice(deviceId: string, surface: string): { campaign_id: string } | undefined {
  return db
    .prepare("SELECT campaign_id FROM serves WHERE device_id = ? AND surface = ? ORDER BY issued_at DESC LIMIT 1")
    .get(deviceId, surface) as { campaign_id: string } | undefined
}

export interface NextAd {
  campaign: CampaignRow
  serveId: string
  adLine: string
  url: string
  nonce: string
  expiresAt: number
}

export function pendingServeCount(deviceId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM serves WHERE device_id = ? AND status = 'pending'")
    .get(deviceId) as { n: number }
  return row.n
}

export function pickNextAd(surface: string, deviceId: string, devId: string | null): NextAd | null {
  const candidates = listActiveCampaigns(surface).filter((c) => c.impressions_served < c.impressions_bought)
  if (candidates.length === 0) return null
  if (pendingServeCount(deviceId) >= config.maxPendingServes) return null

  const last = lastServeForDevice(deviceId, surface)
  const lastId = last?.campaign_id

  let pick = candidates[0]
  if (lastId && candidates.length > 1 && candidates[0].id === lastId) {
    pick = candidates[1]
  }

  const serveId = randomUUID()
  const nonce = randomUUID().replace(/-/g, "")
  const now = Date.now()
  const ttl = config.serveTtlMs

  db.prepare(
    "INSERT INTO serves (id, campaign_id, dev_id, device_id, surface, ad_line, url, nonce, issued_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')"
  ).run(serveId, pick.id, devId, deviceId, surface, pick.ad_line, pick.url, nonce, now, now + ttl)

  return {
    campaign: pick,
    serveId,
    adLine: pick.ad_line,
    url: pick.url,
    nonce,
    expiresAt: now + ttl,
  }
}
