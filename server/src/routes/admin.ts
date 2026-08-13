import { Router, type Request } from "express"
import { z } from "zod"
import { db } from "../db.js"
import { config } from "../config.js"
import { asyncHandler } from "../async-handler.js"

export const adminRouter = Router()

function requireAdmin(req: Request): boolean {
  const token = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
  return Boolean(config.adminToken && token === config.adminToken)
}

adminRouter.get(
  "/review",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req)) {
      res.status(401).json({ error: "admin token required" })
      return
    }
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000
    const [flagged, events] = await Promise.all([
      db.all<{
        id: string
        email: string
        status: string
        fraud_flags: number
        fraud_labels: string | null
        trust_tier: number
        created_at: number
        impressions: number
        earned_mills: number
      }>(
        "SELECT DISTINCT d.id, d.email, d.status, d.fraud_flags, d.fraud_labels, d.trust_tier, d.created_at, " +
          "(SELECT COUNT(*) FROM impressions i WHERE i.dev_id = d.id) AS impressions, " +
          "(SELECT COALESCE(SUM(dev_share_mills), 0) FROM impressions i WHERE i.dev_id = d.id) AS earned_mills " +
          "FROM devs d WHERE d.fraud_flags > 0 OR EXISTS " +
          "(SELECT 1 FROM fraud_events f WHERE f.dev_id = d.id AND f.created_at > ?) " +
          "ORDER BY d.fraud_flags DESC, d.created_at ASC LIMIT 100",
        [since]
      ),
      db.all<{ id: number; type: string; dev_id: string | null; device_id: string | null; reason: string; created_at: number }>(
        "SELECT id, type, dev_id, device_id, reason, created_at FROM fraud_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 200",
        [since]
      ),
    ])

    res.json({
      devs: flagged.map((d) => {
        let fraudLabels: Record<string, number> = {}
        try {
          fraudLabels = JSON.parse(d.fraud_labels ?? "{}")
        } catch {
          fraudLabels = {}
        }
        return {
          id: d.id,
          email: d.email,
          status: d.status,
          fraudFlags: d.fraud_flags,
          fraudLabels,
          trustTier: d.trust_tier,
          impressions: d.impressions,
          earnedCents: Math.floor(d.earned_mills / 100),
          createdAt: d.created_at,
        }
      }),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        devId: e.dev_id,
        reason: e.reason,
        createdAt: e.created_at,
      })),
    })
  })
)

const actionSchema = z.object({
  action: z.enum(["clear", "review", "suspend"]),
})

adminRouter.post(
  "/review/:devId",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req)) {
      res.status(401).json({ error: "admin token required" })
      return
    }
    const devId = String(req.params.devId)
    const parsed = actionSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid action" })
      return
    }
    const dev = await db.get<{ id: string; status: string }>("SELECT id, status FROM devs WHERE id = ?", [devId])
    if (!dev) {
      res.status(404).json({ error: "dev not found" })
      return
    }

    let status = "active"
    if (parsed.data.action === "review") status = "review"
    if (parsed.data.action === "suspend") status = "suspended"

    const resetLabels = parsed.data.action === "clear" ? ", fraud_labels = '{}'" : ""
    await db.run(`UPDATE devs SET status = ?, fraud_flags = 0${resetLabels} WHERE id = ?`, [status, devId])
    res.json({ ok: true, devId, status })
  })
)

adminRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req)) {
      res.status(401).json({ error: "admin token required" })
      return
    }
    const [totals, pending] = await Promise.all([
      db.get<{ n: number; gross: number; dev: number }>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(gross_mills),0) AS gross, COALESCE(SUM(dev_share_mills),0) AS dev FROM impressions"
      ),
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payouts WHERE status = 'held'"),
    ])
    res.json({
      impressions: (totals as { n: number; gross: number; dev: number }).n,
      grossMills: (totals as { n: number; gross: number; dev: number }).gross,
      devShareMills: (totals as { n: number; gross: number; dev: number }).dev,
      heldPayouts: (pending as { n: number }).n,
    })
  })
)
