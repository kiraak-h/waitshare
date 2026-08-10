import { db } from "../db.js"
import { devShareMills, cpmToPerImpressionMills } from "./split.js"
import { config } from "../config.js"
import { randomUUID } from "node:crypto"

export interface RecordImpressionInput {
  serveId: string
  campaignId: string
  devId: string | null
  deviceId: string
  surface: string
  durationMs: number
  viewablePct: number
  focusPct: number
  nonce: string
  networkHash: string | null
  ipHash: string | null
  signature: string
}

export async function recordImpression(
  input: RecordImpressionInput
): Promise<{ id: string; devShareMills: number; grossMills: number }> {
  const campaign = await db.get<{ cpm_cents: number }>("SELECT * FROM campaigns WHERE id = ?", [input.campaignId])

  const grossMills = campaign ? cpmToPerImpressionMills(campaign.cpm_cents) : 0
  const share = campaign ? await devShareMills(grossMills) : 0
  const reserved = Math.floor((share * config.reservePct) / 100)
  const released = share - reserved

  const id = randomUUID()
  const now = Date.now()

  await db.run(
    "INSERT INTO impressions (id, serve_id, campaign_id, dev_id, device_id, surface, duration_ms, viewable_pct, focus_pct, nonce, network_hash, ip_hash, served_at, gross_mills, dev_share_mills, reserved_mills, signature, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'credited')",
    [
      id,
      input.serveId,
      input.campaignId,
      input.devId,
      input.deviceId,
      input.surface,
      input.durationMs,
      input.viewablePct,
      input.focusPct,
      input.nonce,
      input.networkHash,
      input.ipHash,
      now,
      grossMills,
      share,
      reserved,
      input.signature,
    ]
  )

  await db.run("UPDATE campaigns SET impressions_served = impressions_served + 1, updated_at = ? WHERE id = ?", [
    now,
    input.campaignId,
  ])

  await db.run("UPDATE serves SET status = 'completed', completed_at = ? WHERE id = ?", [now, input.serveId])

  if (input.devId) {
    await db.run(
      "UPDATE devs SET balance_mills = balance_mills + ?, reserve_mills = reserve_mills + ?, total_earned_mills = total_earned_mills + ? WHERE id = ?",
      [released, reserved, share, input.devId]
    )
  }

  return { id, devShareMills: share, grossMills }
}

export async function voidServe(serveId: string): Promise<void> {
  await db.run("UPDATE serves SET status = 'void', completed_at = ? WHERE id = ?", [Date.now(), serveId])
}

export async function getServe(serveId: string) {
  return db.get(
    "SELECT * FROM serves WHERE id = ?",
    [serveId]
  ) as Promise<
    | {
        id: string
        campaign_id: string
        dev_id: string | null
        device_id: string
        surface: string
        ad_line: string
        url: string
        nonce: string | null
        network_hash: string | null
        issued_at: number
        expires_at: number
        status: string
        completed_at: number | null
      }
    | undefined
  >
}

export async function fleetStats(sinceMs: number): Promise<{ impressions: number; devEarnedMills: number; adSeconds: number }> {
  const row = (await db.get<{ impressions: number; devEarned: number; adSeconds: number }>(
    "SELECT COUNT(*) AS impressions, COALESCE(SUM(dev_share_mills), 0) AS devEarned, COALESCE(SUM(duration_ms), 0) AS adSeconds FROM impressions WHERE served_at > ?",
    [sinceMs]
  )) as { impressions: number; devEarned: number; adSeconds: number }
  return { impressions: row.impressions, devEarnedMills: row.devEarned, adSeconds: row.adSeconds }
}
