import { Router } from "express"
import { db } from "../db.js"
import { config } from "../config.js"
import { snapshot } from "../services/metrics.js"
import { asyncHandler } from "../async-handler.js"

export const metricsRouter = Router()

metricsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const token = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
    if (!config.adminToken || token !== config.adminToken) {
      res.status(401).json({ error: "admin token required" })
      return
    }
    const day = Date.now() - 24 * 60 * 60 * 1000
    const [activeCampaigns, pendingPayouts, impressionsToday, devsFlagged, split] = await Promise.all([
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'active'"),
      db.get<{ n: number }>("SELECT COALESCE(SUM(amount_mills), 0) AS n FROM payouts WHERE status IN ('held', 'pending')"),
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM impressions WHERE served_at > ?", [day]),
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devs WHERE fraud_flags > 0"),
      db.get<{ dev_share: number; platform_share: number; version: number; locked_at: number }>(
        "SELECT dev_share, platform_share, version, locked_at FROM split_contract WHERE id = 1"
      ),
    ])

    res.json({
      counters: snapshot(),
      db: {
        kind: db.kind,
        activeCampaigns: Number(activeCampaigns?.n ?? 0),
        pendingPayoutMills: Number(pendingPayouts?.n ?? 0),
        impressionsLast24h: Number(impressionsToday?.n ?? 0),
        devsFlagged: Number(devsFlagged?.n ?? 0),
      },
      split,
    })
  })
)
