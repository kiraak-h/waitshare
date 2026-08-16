import { Router, type Request } from "express"
import { z } from "zod"
import { db } from "../db.js"
import { config } from "../config.js"
import { timingSafeEqualStr } from "../services/signing.js"
import { asyncHandler } from "../async-handler.js"

export const adminRouter = Router()

function requireAdmin(req: Request): boolean {
  const token = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
  return Boolean(config.adminToken && timingSafeEqualStr(token ?? "", config.adminToken))
}

interface DevRow {
  id: string
  email: string
  status: string
  fraud_flags: number
  fraud_labels: string | null
  trust_tier: number
  created_at: number
  impressions: number
  earned_mills: number
}

function parseLabels(raw: string | null): Record<string, number> {
  try {
    return JSON.parse(raw ?? "{}")
  } catch {
    return {}
  }
}

function mapDev(d: DevRow) {
  return {
    id: d.id,
    email: d.email,
    status: d.status,
    fraudFlags: d.fraud_flags,
    fraudLabels: parseLabels(d.fraud_labels),
    trustTier: d.trust_tier,
    impressions: d.impressions,
    earnedCents: Math.floor(d.earned_mills / 1000),
    createdAt: d.created_at,
  }
}

const DEV_SELECT =
  "SELECT d.id, d.email, d.status, d.fraud_flags, d.fraud_labels, d.trust_tier, d.created_at, " +
  "(SELECT COUNT(*) FROM impressions i WHERE i.dev_id = d.id) AS impressions, " +
  "(SELECT COALESCE(SUM(dev_share_mills), 0) FROM impressions i WHERE i.dev_id = d.id) AS earned_mills " +
  "FROM devs d "

adminRouter.get(
  "/review",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req)) {
      res.status(401).json({ error: "admin token required" })
      return
    }
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000
    const label = typeof req.query.label === "string" && req.query.label ? req.query.label : null
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200)
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0)

    const flaggedRaw = await db.all<DevRow>(
      DEV_SELECT +
        "WHERE d.fraud_flags > 0 OR EXISTS " +
        "(SELECT 1 FROM fraud_events f WHERE f.dev_id = d.id AND f.created_at > ?) " +
        "ORDER BY d.fraud_flags DESC, d.created_at ASC",
      [since]
    )
    const flagged = label ? flaggedRaw.filter((d) => (parseLabels(d.fraud_labels)[label] ?? 0) > 0) : flaggedRaw
    const total = flagged.length
    const page = flagged.slice(offset, offset + limit)

    const events = await db.all<{ id: number; type: string; dev_id: string | null; device_id: string | null; reason: string; created_at: number }>(
      "SELECT id, type, dev_id, device_id, reason, created_at FROM fraud_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 200",
      [since]
    )

    res.json({
      devs: page.map(mapDev),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        devId: e.dev_id,
        reason: e.reason,
        createdAt: e.created_at,
      })),
      total,
    })
  })
)

adminRouter.get(
  "/review/:devId",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req)) {
      res.status(401).json({ error: "admin token required" })
      return
    }
    const devId = String(req.params.devId)
    const dev = await db.get<DevRow>(DEV_SELECT + "WHERE d.id = ?", [devId])
    if (!dev) {
      res.status(404).json({ error: "dev not found" })
      return
    }
    const events = await db.all<{ id: number; type: string; dev_id: string | null; device_id: string | null; reason: string; created_at: number }>(
      "SELECT id, type, dev_id, device_id, reason, created_at FROM fraud_events WHERE dev_id = ? ORDER BY created_at DESC LIMIT 100",
      [devId]
    )
    res.json({
      dev: mapDev(dev),
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
    await db.run("INSERT INTO admin_actions (dev_id, action, created_at) VALUES (?, ?, ?)", [devId, parsed.data.action, Date.now()])
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
