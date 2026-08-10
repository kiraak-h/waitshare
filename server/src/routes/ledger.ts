import { Router } from "express"
import { db } from "../db.js"
import { getSplitContract } from "../services/split.js"
import { asyncHandler } from "../async-handler.js"
import type { LedgerEntryDto } from "../types.js"

export const ledgerRouter = Router()

ledgerRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const since = Number(req.query.since ?? 0)
    const [{ rows, contract }] = await Promise.all([contractRows(since)])
    const shareOf = (mills: number): number => Math.floor((mills * contract.devShare) / 100)

    const entries: LedgerEntryDto[] = rows.map((r) => ({
      campaignId: r.id,
      brand: r.company || "Anonymous",
      adLine: r.ad_line,
      surface: r.surface,
      cpmCents: r.cpm_cents,
      served: r.impressions_served,
      bought: r.impressions_bought,
      grossMills: r.recent_gross,
      devShareMills: shareOf(r.recent_gross),
    }))

    const total = rows.reduce(
      (acc, r) => ({
        grossMills: acc.grossMills + r.recent_gross,
        devShareMills: acc.devShareMills + shareOf(r.recent_gross),
        served: acc.served + r.recent_served,
      }),
      { grossMills: 0, devShareMills: 0, served: 0 }
    )

    res.json({ entries, total })
  })
)

async function contractRows(since: number): Promise<{ rows: LedgerRow[]; contract: { devShare: number } }> {
  const [rows, contract] = await Promise.all([
    db.all<LedgerRow>(
      `SELECT c.id, c.ad_line, c.surface, c.cpm_cents, c.impressions_bought, c.impressions_served,
              COALESCE(a.company, '') AS company,
              (SELECT COUNT(*) FROM impressions i WHERE i.campaign_id = c.id AND i.served_at > ?) AS recent_served,
              (SELECT COALESCE(SUM(i.gross_mills), 0) FROM impressions i WHERE i.campaign_id = c.id AND i.served_at > ?) AS recent_gross
       FROM campaigns c
       LEFT JOIN advertisers a ON a.id = c.advertiser_id
       WHERE c.status IN ('active', 'completed')
       ORDER BY c.impressions_served DESC
       LIMIT 100`,
      [since, since]
    ),
    getSplitContract(),
  ])
  return { rows, contract }
}

interface LedgerRow {
  id: string
  ad_line: string
  surface: string
  cpm_cents: number
  impressions_bought: number
  impressions_served: number
  company: string
  recent_served: number
  recent_gross: number
}
