import { Router } from "express"
import { db } from "../db.js"
import { config } from "../config.js"
import { parseStripeWebhook } from "../services/payments.js"
import { asyncHandler } from "../async-handler.js"
import type Stripe from "stripe"

export const webhookRouter = Router()

webhookRouter.post(
  "/stripe",
  asyncHandler(async (req, res) => {
    if (config.stripeMode !== "live") {
      res.status(501).json({ error: "webhooks disabled in stub mode" })
      return
    }
    const signature = req.headers["stripe-signature"]
    if (typeof signature !== "string") {
      res.status(400).json({ error: "missing stripe-signature header" })
      return
    }
    let event: Stripe.Event
    try {
      event = parseStripeWebhook(req.body, signature)
    } catch {
      res.status(400).json({ error: "invalid signature" })
      return
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const campaignId = session.metadata?.campaignId
        if (campaignId && session.payment_status === "paid") {
          await db.run("UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?", [Date.now(), campaignId])
        }
        break
      }
      case "account.updated": {
        const account = event.data.object as Stripe.Account
        const submitted = account.details_submitted === true
        await db.run("UPDATE devs SET stripe_onboarded = ? WHERE stripe_account_id = ?", [
          submitted ? 1 : 0,
          account.id,
        ])
        break
      }
      case "transfer.created": {
        const transfer = event.data.object as Stripe.Transfer
        const payout = await db.get<{ dev_id: string; amount_mills: number }>(
          "SELECT dev_id, amount_mills FROM payouts WHERE stripe_transfer_id = ?",
          [transfer.id]
        )
        await db.run("UPDATE payouts SET status = 'cleared', cleared_at = ? WHERE stripe_transfer_id = ?", [
          Date.now(),
          transfer.id,
        ])
        if (payout) {
          await db.run("UPDATE devs SET paid_mills = paid_mills + ? WHERE id = ?", [payout.amount_mills, payout.dev_id])
        }
        break
      }
    }

    res.json({ received: true })
  })
)
