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
          const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null
          await db.run(
            "UPDATE campaigns SET status = 'active', stripe_checkout_id = ?, payment_intent_id = ?, updated_at = ? WHERE id = ?",
            [session.id, paymentIntentId, Date.now(), campaignId]
          )
        }
        break
      }
      case "charge.dispute.created": {
        // A chargeback on an advertiser payment: stop the campaign immediately
        // and record it in the fraud audit trail. The advertiser can dispute
        // via the review queue before we ever bill impressions again.
        const dispute = event.data.object as Stripe.Dispute
        const paymentIntentId =
          typeof dispute.payment_intent === "string" ? dispute.payment_intent : (dispute.charge as string) ?? null
        const campaign = await db.get<{ id: string }>(
          "SELECT id FROM campaigns WHERE payment_intent_id = ? OR stripe_checkout_id = ? LIMIT 1",
          [paymentIntentId, paymentIntentId]
        )
        if (campaign) {
          await db.run("UPDATE campaigns SET status = 'disputed', updated_at = ? WHERE id = ?", [Date.now(), campaign.id])
          await db.run(
            "INSERT INTO fraud_events (type, dev_id, device_id, network_hash, reason, created_at) VALUES ('chargeback', NULL, NULL, NULL, ?, ?)",
            [`advertiser dispute ${dispute.id} on campaign ${campaign.id}`, Date.now()]
          )
        }
        break
      }
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge
        const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null
        const fullyRefunded = charge.refunded === true
        if (fullyRefunded && paymentIntentId) {
          await db.run("UPDATE campaigns SET status = 'refunded', updated_at = ? WHERE payment_intent_id = ?", [
            Date.now(),
            paymentIntentId,
          ])
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
