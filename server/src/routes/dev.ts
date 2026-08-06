import { Router, type Request } from "express"
import { db } from "../db.js"
import { payments } from "../services/payments.js"
import { config } from "../config.js"
import { randomUUID } from "node:crypto"
import type { DevDto } from "../types.js"

export const devRouter = Router()

function requireDev(req: Request) {
  const token = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
  if (!token) return null
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as { dev_id: string } | undefined
  if (!session) return null
  const dev = db.prepare("SELECT * FROM devs WHERE id = ?").get(session.dev_id) as
    | {
        id: string
        email: string
        country: string | null
        status: string
        balance_mills: number
        reserve_mills: number
        total_earned_mills: number
        paid_mills: number
        stripe_account_id: string | null
        stripe_onboarded: number
        created_at: number
      }
    | undefined
  return dev ?? null
}

function toDto(dev: NonNullable<ReturnType<typeof requireDev>>): DevDto {
  return {
    id: dev.id,
    email: dev.email,
    country: dev.country,
    status: dev.status,
    balanceCents: Math.floor(dev.balance_mills / 100),
    reserveCents: Math.floor(dev.reserve_mills / 100),
    totalEarnedCents: Math.floor(dev.total_earned_mills / 100),
    paidCents: Math.floor(dev.paid_mills / 100),
    stripeOnboarded: dev.stripe_onboarded === 1,
    createdAt: dev.created_at,
  }
}

devRouter.get("/me", (req, res) => {
  const dev = requireDev(req)
  if (!dev) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  res.json({ dev: toDto(dev), thresholdCents: config.paymentThresholdCents, paymentMode: payments.mode })
})

devRouter.get("/earnings", (req, res) => {
  const dev = requireDev(req)
  if (!dev) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  const rows = db
    .prepare(
      "SELECT i.id, i.serve_id, i.surface, i.duration_ms, i.viewable_pct, i.served_at, i.gross_mills, i.dev_share_mills, i.status, c.ad_line, c.url FROM impressions i LEFT JOIN campaigns c ON c.id = i.campaign_id WHERE i.dev_id = ? ORDER BY i.served_at DESC LIMIT 100"
    )
    .all(dev.id) as {
    id: string
    serve_id: string
    surface: string
    duration_ms: number
    viewable_pct: number
    served_at: number
    gross_mills: number
    dev_share_mills: number
    status: string
    ad_line: string
    url: string
  }[]

  res.json({
    earnings: rows.map((r) => ({
      id: r.id,
      surface: r.surface,
      durationMs: r.duration_ms,
      viewablePct: r.viewable_pct,
      servedAt: r.served_at,
      grossMills: r.gross_mills,
      devShareMills: r.dev_share_mills,
      status: r.status,
      adLine: r.ad_line,
      url: r.url,
    })),
  })
})

devRouter.post("/onboarding", async (req, res) => {
  const dev = requireDev(req)
  if (!dev) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  const link = await payments.createConnectAccountLink({
    devId: dev.id,
    email: dev.email,
    country: dev.country ?? "US",
    stripeAccountId: dev.stripe_account_id ?? undefined,
    refreshUrl: `${config.webBaseUrl}/dashboard`,
    returnUrl: `${config.webBaseUrl}/dashboard`,
  })
  if (!dev.stripe_account_id) {
    db.prepare("UPDATE devs SET stripe_account_id = ? WHERE id = ?").run(link.accountId, dev.id)
  }
  res.json({ url: link.url, accountId: link.accountId, mode: payments.mode })
})

devRouter.post("/payout", async (req, res) => {
  const dev = requireDev(req)
  if (!dev) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  if (dev.status !== "active") {
    res.status(403).json({ error: "account not eligible for payout" })
    return
  }
  if (dev.balance_mills < config.paymentThresholdCents * 100) {
    res.status(422).json({ error: "below payment threshold" })
    return
  }
  if (payments.mode !== "stub") {
    if (dev.stripe_onboarded !== 1 || !dev.stripe_account_id) {
      const link = await payments.createConnectAccountLink({
        devId: dev.id,
        email: dev.email,
        country: dev.country ?? "US",
        stripeAccountId: dev.stripe_account_id ?? undefined,
        refreshUrl: `${config.webBaseUrl}/dashboard`,
        returnUrl: `${config.webBaseUrl}/dashboard`,
      })
      if (!dev.stripe_account_id) {
        db.prepare("UPDATE devs SET stripe_account_id = ? WHERE id = ?").run(link.accountId, dev.id)
      }
      res.status(409).json({ error: "onboarding required", onboardingUrl: link.url })
      return
    }
  }

  const amountMills = dev.balance_mills
  const payoutId = randomUUID()
  const now = Date.now()
  const availableAt = now + config.payoutHoldMs
  db.prepare(
    "INSERT INTO payouts (id, dev_id, amount_mills, status, available_at, created_at) VALUES (?, ?, ?, 'held', ?, ?)"
  ).run(payoutId, dev.id, amountMills, availableAt, now)
  db.prepare("UPDATE devs SET balance_mills = 0 WHERE id = ?").run(dev.id)

  res.json({
    payoutId,
    amountMills,
    status: "held",
    availableAt,
    holdMs: config.payoutHoldMs,
    mode: payments.mode,
  })
})

devRouter.get("/payouts", (req, res) => {
  const dev = requireDev(req)
  if (!dev) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  const rows = db.prepare("SELECT * FROM payouts WHERE dev_id = ? ORDER BY created_at DESC LIMIT 50").all(dev.id) as {
    id: string
    amount_mills: number
    status: string
    available_at: number | null
    created_at: number
    cleared_at: number | null
  }[]
  res.json({
    payouts: rows.map((r) => ({
      id: r.id,
      amountMills: r.amount_mills,
      status: r.status,
      availableAt: r.available_at,
      createdAt: r.created_at,
      clearedAt: r.cleared_at,
    })),
  })
})
