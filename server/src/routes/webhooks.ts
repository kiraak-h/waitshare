import { Router } from "express"
import { config } from "../config.js"
import { parseStripeWebhook } from "../services/payments.js"
import { applyStripeEvent } from "../services/stripe-events.js"
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

    await applyStripeEvent(event)

    res.json({ received: true })
  })
)
