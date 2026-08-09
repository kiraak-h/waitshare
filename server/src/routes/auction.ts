import { Router } from "express"
import { listActiveCampaigns, type CampaignRow } from "../services/auction.js"
import { fleetStats } from "../services/ledger.js"
import { asyncHandler } from "../async-handler.js"
import type { AuctionStateDto, CampaignDto } from "../types.js"

export const auctionRouter = Router()

function toCampaignDto(row: CampaignRow): CampaignDto {
  return {
    id: row.id,
    advertiserId: row.advertiser_id,
    adLine: row.ad_line,
    url: row.url,
    brandIcon: row.brand_icon,
    surface: row.surface,
    cpmCents: row.cpm_cents,
    blocks: row.blocks,
    impressionsBought: row.impressions_bought,
    impressionsServed: row.impressions_served,
    countryFilter: row.country_filter ? JSON.parse(row.country_filter) : null,
    deliverySpeed: row.delivery_speed,
    status: row.status,
    createdAt: row.created_at,
  }
}

auctionRouter.get(
  "/state",
  asyncHandler(async (_req, res) => {
    const [campaigns, stats] = await Promise.all([listActiveCampaigns(), fleetStats(Date.now() - 60 * 60 * 1000)])
    const dto: CampaignDto[] = campaigns.map(toCampaignDto)

    const surfaces = ["opencode", "claude-code-cli", "vscode", "terminal"]
    const surfaceCpm: Record<string, number> = {}
    for (const s of surfaces) {
      const top = dto.filter((c) => c.surface === s).slice(0, 4)
      if (top.length > 0) {
        surfaceCpm[s] = Math.round(top.reduce((sum, c) => sum + c.cpmCents, 0) / top.length)
      }
    }

    const state: AuctionStateDto = {
      generatedAt: Date.now(),
      market: {
        cpmCents: dto.length ? Math.round(dto.slice(0, 4).reduce((s, c) => s + c.cpmCents, 0) / Math.min(4, dto.length)) : 0,
        impressionsPerHour: stats.impressions,
        adSecondsPerHour: Math.round(stats.adSeconds / 1000),
        devEarnedPerHourCents: Math.floor(stats.devEarnedMills / 1000),
      },
      surfaceCpm,
      campaigns: dto,
    }

    res.json(state)
  })
)
