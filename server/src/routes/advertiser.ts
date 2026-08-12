import { Router } from "express"
import { z } from "zod"
import { db } from "../db.js"
import { payments } from "../services/payments.js"
import { config } from "../config.js"
import { inc } from "../services/metrics.js"
import { asyncHandler } from "../async-handler.js"
import { randomUUID } from "node:crypto"

export const advertiserRouter = Router()

const campaignSchema = z.object({
  email: z.string().email(),
  company: z.string().max(120).optional(),
  adLine: z.string().min(3).max(60),
  url: z.string().url(),
  brandIcon: z.string().max(100).optional(),
  surface: z.enum(["opencode", "claude-code-cli", "vscode", "terminal"]),
  cpmCents: z.number().int().min(50).max(100000),
  blocks: z.number().int().min(1).max(10000),
  countryFilter: z.array(z.string().max(3)).max(50).optional(),
  deliverySpeed: z.enum(["slow", "medium", "fast"]).default("fast"),
  leaderboard: z.boolean().default(true),
})

advertiserRouter.post(
  "/campaigns",
  asyncHandler(async (req, res) => {
    const parsed = campaignSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid campaign", issues: parsed.error.issues })
      return
    }
    const c = parsed.data

    let advertiser = await db.get<{ id: string }>("SELECT id FROM advertisers WHERE email = ?", [c.email])
    if (!advertiser) {
      const id = randomUUID()
      await db.run("INSERT INTO advertisers (id, email, company, created_at) VALUES (?, ?, ?, ?)", [
        id,
        c.email,
        c.company ?? null,
        Date.now(),
      ])
      advertiser = { id }
    }

    const campaignId = randomUUID()
    const impressionsBought = c.blocks * 1000
    const now = Date.now()
    await db.run(
      "INSERT INTO campaigns (id, advertiser_id, ad_line, url, brand_icon, surface, cpm_cents, blocks, impressions_bought, country_filter, delivery_speed, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?)",
      [
        campaignId,
        advertiser.id,
        c.adLine,
        c.url,
        c.brandIcon ?? null,
        c.surface,
        c.cpmCents,
        c.blocks,
        impressionsBought,
        c.countryFilter ? JSON.stringify(c.countryFilter) : null,
        c.deliverySpeed,
        now,
        now,
      ]
    )

    const amountCents = c.cpmCents * c.blocks
    const checkout = await payments.createCheckoutSession({
      amountCents,
      description: `${c.blocks} block(s) of ${c.surface} impressions (${c.adLine})`,
      metadata: { campaignId, advertiserId: advertiser.id, surface: c.surface },
      successUrl: `${config.webBaseUrl}/advertise?paid=1&campaign=${campaignId}`,
      cancelUrl: `${config.webBaseUrl}/advertise?paid=0`,
    })
    inc("checkoutSessions")

    res.json({ campaignId, checkoutUrl: checkout.url, amountCents, mode: payments.mode })
  })
)

advertiserRouter.post(
  "/campaigns/:id/confirm",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id)
    const campaign = await db.get<{ status: string; advertiser_id: string }>("SELECT * FROM campaigns WHERE id = ?", [id])
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" })
      return
    }
    if (campaign.status === "pending_payment") {
      await db.run("UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?", [Date.now(), id])
    }
    res.json({ ok: true, status: "active" })
  })
)

advertiserRouter.get(
  "/campaigns",
  asyncHandler(async (req, res) => {
    const email = String(req.query.email ?? "")
    if (!email) {
      res.status(400).json({ error: "email required" })
      return
    }
    const advertiser = await db.get<{ id: string }>("SELECT id FROM advertisers WHERE email = ?", [email])
    if (!advertiser) {
      res.json({ campaigns: [] })
      return
    }
    const rows = await db.all("SELECT * FROM campaigns WHERE advertiser_id = ? ORDER BY created_at DESC", [advertiser.id])
    res.json({ campaigns: rows })
  })
)

// Stub-mode payment event simulation. Mirrors the live webhook handlers
// (charge.dispute.created / charge.refunded) so the chargeback lifecycle is
// testable offline. Never registered in live mode.
if (config.stripeMode === "stub") {
  advertiserRouter.post(
    "/campaigns/:id/payment-event",
    asyncHandler(async (req, res) => {
      const id = String(req.params.id)
      const event = String(req.body?.event ?? "")
      const campaign = await db.get<{ id: string }>("SELECT id FROM campaigns WHERE id = ?", [id])
      if (!campaign) {
        res.status(404).json({ error: "campaign not found" })
        return
      }
      if (event === "dispute") {
        await db.run("UPDATE campaigns SET status = 'disputed', updated_at = ? WHERE id = ?", [Date.now(), id])
        await db.run(
          "INSERT INTO fraud_events (type, dev_id, device_id, network_hash, reason, created_at) VALUES ('chargeback', NULL, NULL, NULL, ?, ?)",
          [`stub dispute simulation on campaign ${id}`, Date.now()]
        )
      } else if (event === "refund") {
        await db.run("UPDATE campaigns SET status = 'refunded', updated_at = ? WHERE id = ?", [Date.now(), id])
      } else {
        res.status(400).json({ error: "event must be 'dispute' or 'refund'" })
        return
      }
      res.json({ ok: true, status: event === "dispute" ? "disputed" : "refunded" })
    })
  )
}
