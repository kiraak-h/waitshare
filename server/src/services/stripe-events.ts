import type Stripe from "stripe"
import { db } from "../db.js"
import { inc } from "./metrics.js"
import { logFraudEvent } from "./fraud.js"
export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  inc("webhookEvents")
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
        await logFraudEvent("chargeback", {
          reason: `advertiser dispute ${dispute.id} on campaign ${campaign.id}`,
        })
      }
      break
    }
    case "charge.dispute.closed": {
      // The advertiser's dispute resolved. Won: delivery resumes (campaign
      // back to active) and the resolution is audited. Lost: the chargeback
      // stands — the campaign stays 'disputed' until Stripe refunds via
      // charge.refunded.
      const closedDispute = event.data.object as Stripe.Dispute
      const paymentIntentId =
        typeof closedDispute.payment_intent === "string"
          ? closedDispute.payment_intent
          : (closedDispute.charge as string) ?? null
      const campaign = await db.get<{ id: string }>(
        "SELECT id FROM campaigns WHERE payment_intent_id = ? OR stripe_checkout_id = ? LIMIT 1",
        [paymentIntentId, paymentIntentId]
      )
      if (campaign && closedDispute.status === "won") {
        await db.run("UPDATE campaigns SET status = 'active', updated_at = ? WHERE id = ?", [Date.now(), campaign.id])
        await logFraudEvent("dispute-won", {
          reason: `dispute ${closedDispute.id} won, campaign ${campaign.id} reactivated`,
        })
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
      await db.run("UPDATE devs SET stripe_onboarded = ? WHERE stripe_account_id = ?", [submitted ? 1 : 0, account.id])
      break
    }
    case "transfer.created": {
      const transfer = event.data.object as Stripe.Transfer
      const now = Date.now()
      const payoutId = transfer.metadata?.payoutId
      // Prefer matching on the payout id we stamp on the transfer at creation
      // time: it lets this handler reconcile a payout even when the payout
      // sweep crashed between createTransfer and recording stripe_transfer_id.
      // The fallback (transfer id) covers transfers created before that change.
      const result = payoutId
        ? await db.run(
            "UPDATE payouts SET status = 'cleared', cleared_at = ?, stripe_transfer_id = ? WHERE id = ? AND status <> 'cleared'",
            [now, transfer.id, payoutId]
          )
        : await db.run(
            "UPDATE payouts SET status = 'cleared', cleared_at = ? WHERE stripe_transfer_id = ? AND status <> 'cleared'",
            [now, transfer.id]
          )
      // Only credit paid_mills once per payout. Stripe redelivers webhooks,
      // and the conditional status update above makes this idempotent
      // regardless of whether the payout is still 'held' or already 'pending'.
      if (result.changes === 1) {
        const payout = await db.get<{ dev_id: string; amount_mills: number }>(
          "SELECT dev_id, amount_mills FROM payouts WHERE id = ? OR stripe_transfer_id = ? LIMIT 1",
          [payoutId ?? "", transfer.id]
        )
        if (payout) {
          await db.run("UPDATE devs SET paid_mills = paid_mills + ? WHERE id = ?", [payout.amount_mills, payout.dev_id])
          inc("payoutsCleared")
        }
      }
      break
    }
  }
}
