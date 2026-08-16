import { Router, type Request } from "express"
import { db } from "../db.js"
import { payments } from "../services/payments.js"
import { config } from "../config.js"
import { randomUUID } from "node:crypto"
import { computeTrustTier } from "../services/scoring.js"
import { asyncHandler } from "../async-handler.js"
import type { DevDto } from "../types.js"

export const devRouter = Router()

interface DevRow {
  id: string
  email: string
  country: string | null
  status: string
  trust_tier: number
  balance_mills: number
  reserve_mills: number
  total_earned_mills: number
  paid_mills: number
  stripe_account_id: string | null
  stripe_onboarded: number
  created_at: number
}

async function requireDev(req: Request): Promise<DevRow | null> {
  const token = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
  if (!token) return null
  const session = await db.get<{ dev_id: string }>("SELECT * FROM sessions WHERE token = ? AND expires_at > ?", [token, Date.now()])
  if (!session) return null
  const dev = await db.get<DevRow>("SELECT * FROM devs WHERE id = ?", [session.dev_id])
  return dev ?? null
}

function toDto(dev: DevRow): DevDto {
  return {
    id: dev.id,
    email: dev.email,
    country: dev.country,
    status: dev.status,
    trustTier: dev.trust_tier,
    balanceCents: Math.floor(dev.balance_mills / 1000),
    reserveCents: Math.floor(dev.reserve_mills / 1000),
    totalEarnedCents: Math.floor(dev.total_earned_mills / 1000),
    paidCents: Math.floor(dev.paid_mills / 1000),
    stripeOnboarded: dev.stripe_onboarded === 1,
    createdAt: dev.created_at,
  }
}

devRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const dev = await requireDev(req)
    if (!dev) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    res.json({ dev: toDto(dev), thresholdCents: config.paymentThresholdCents, paymentMode: payments.mode })
  })
)

devRouter.get(
  "/earnings",
  asyncHandler(async (req, res) => {
    const dev = await requireDev(req)
    if (!dev) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const rows = await db.all<{
      id: string
      surface: string
      duration_ms: number
      viewable_pct: number
      served_at: number
      gross_mills: number
      dev_share_mills: number
      status: string
      ad_line: string | null
      url: string | null
    }>(
      "SELECT i.id, i.surface, i.duration_ms, i.viewable_pct, i.served_at, i.gross_mills, i.dev_share_mills, i.status, c.ad_line, c.url FROM impressions i LEFT JOIN campaigns c ON c.id = i.campaign_id WHERE i.dev_id = ? ORDER BY i.served_at DESC LIMIT 100",
      [dev.id]
    )

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
)

devRouter.post(
  "/onboarding",
  asyncHandler(async (req, res) => {
    const dev = await requireDev(req)
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
      await db.run("UPDATE devs SET stripe_account_id = ? WHERE id = ?", [link.accountId, dev.id])
    }
    res.json({ url: link.url, accountId: link.accountId, mode: payments.mode })
  })
)

devRouter.post(
  "/payout",
  asyncHandler(async (req, res) => {
    const dev = await requireDev(req)
    if (!dev) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    if (dev.status !== "active") {
      res.status(403).json({ error: "account not eligible for payout" })
      return
    }
    if (dev.balance_mills < config.paymentThresholdCents * 1000) {
      res.status(422).json({ error: "below payment threshold" })
      return
    }
    if ((await computeTrustTier(dev.id)) === 0 && dev.balance_mills / 1000 > config.tier3.tier0PayoutCapCents) {
      res.status(422).json({ error: "new account payout cap reached", capCents: config.tier3.tier0PayoutCapCents })
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
          await db.run("UPDATE devs SET stripe_account_id = ? WHERE id = ?", [link.accountId, dev.id])
        }
        res.status(409).json({ error: "onboarding required", onboardingUrl: link.url })
        return
      }
    }

    const payoutId = randomUUID()
    const now = Date.now()
    const availableAt = now + config.payoutHoldMs
    const result = await db.withTransaction(async (tx) => {
      const current = await tx.get<{ balance_mills: number }>("SELECT balance_mills FROM devs WHERE id = ?", [dev.id])
      if (!current || current.balance_mills < config.paymentThresholdCents * 1000) return { code: "below" }
      // Re-check the tier0 cap on the fresh balance too: releaseReserves can
      // push the balance up between the outer check and this transaction.
      if ((await computeTrustTier(dev.id)) === 0 && current.balance_mills / 1000 > config.tier3.tier0PayoutCapCents) {
        return { code: "cap", capCents: config.tier3.tier0PayoutCapCents }
      }
      const claimed = await tx.run("UPDATE devs SET balance_mills = 0 WHERE id = ? AND balance_mills = ?", [
        dev.id,
        current.balance_mills,
      ])
      if (claimed.changes !== 1) return { code: "race" }
      await tx.run(
        "INSERT INTO payouts (id, dev_id, amount_mills, status, available_at, created_at) VALUES (?, ?, ?, 'held', ?, ?)",
        [payoutId, dev.id, current.balance_mills, availableAt, now]
      )
      return { code: "ok", amountMills: current.balance_mills }
    })
    if (result.code === "below") {
      res.status(422).json({ error: "below payment threshold" })
      return
    }
    if (result.code === "cap") {
      res.status(422).json({ error: "new account payout cap reached", capCents: result.capCents })
      return
    }
    if (result.code === "race") {
      res.status(409).json({ error: "balance changed; retry payout" })
      return
    }

    res.json({
      payoutId,
      amountMills: result.amountMills,
      status: "held",
      availableAt,
      holdMs: config.payoutHoldMs,
      mode: payments.mode,
    })
  })
)

devRouter.get(
  "/payouts",
  asyncHandler(async (req, res) => {
    const dev = await requireDev(req)
    if (!dev) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const rows = await db.all<{
      id: string
      amount_mills: number
      status: string
      available_at: number | null
      created_at: number
      cleared_at: number | null
    }>("SELECT * FROM payouts WHERE dev_id = ? ORDER BY created_at DESC LIMIT 50", [dev.id])
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
)
