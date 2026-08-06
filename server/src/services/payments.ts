import Stripe from "stripe"
import { config } from "../config.js"

export interface CheckoutResult {
  url: string
  reference: string
}

export interface ConnectLinkResult {
  url: string
  accountId: string
}

export interface TransferResult {
  transferId: string
}

export interface CheckoutOpts {
  amountCents: number
  description: string
  metadata: Record<string, string>
  successUrl: string
  cancelUrl: string
}

export interface ConnectLinkOpts {
  devId: string
  email: string
  country?: string
  stripeAccountId?: string
  refreshUrl: string
  returnUrl: string
}

export interface TransferOpts {
  devId: string
  accountId: string
  amountCents: number
  metadata: Record<string, string>
}

export interface PaymentProvider {
  readonly mode: string
  createCheckoutSession(opts: CheckoutOpts): Promise<CheckoutResult>
  createConnectAccountLink(opts: ConnectLinkOpts): Promise<ConnectLinkResult>
  createTransfer(opts: TransferOpts): Promise<TransferResult>
}

class StubPaymentProvider implements PaymentProvider {
  readonly mode = "stub"

  async createCheckoutSession(opts: CheckoutOpts): Promise<CheckoutResult> {
    return {
      url: `${config.webBaseUrl}/checkout/simulated?amount=${opts.amountCents}&reference=${opts.metadata.campaignId ?? ""}`,
      reference: `stub_checkout_${Date.now()}`,
    }
  }

  async createConnectAccountLink(opts: ConnectLinkOpts): Promise<ConnectLinkResult> {
    return {
      url: `${config.webBaseUrl}/onboarding/simulated?dev=${opts.devId}`,
      accountId: `stub_acct_${opts.devId}`,
    }
  }

  async createTransfer(opts: TransferOpts): Promise<TransferResult> {
    return { transferId: `stub_tr_${opts.devId}_${Date.now()}` }
  }
}

let stripeClient: Stripe | null = null

function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(config.stripeSecretKey)
  }
  return stripeClient
}

class LiveStripeProvider implements PaymentProvider {
  readonly mode = "live"
  private stripe: Stripe

  constructor() {
    this.stripe = getStripeClient()
  }

  async createCheckoutSession(opts: CheckoutOpts): Promise<CheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: opts.description },
            unit_amount: opts.amountCents,
          },
          quantity: 1,
        },
      ],
      metadata: opts.metadata,
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
    })
    if (!session.url) throw new Error("stripe checkout returned no url")
    return { url: session.url, reference: session.id }
  }

  async createConnectAccountLink(opts: ConnectLinkOpts): Promise<ConnectLinkResult> {
    let accountId = opts.stripeAccountId
    if (!accountId) {
      const account = await this.stripe.accounts.create({
        type: "express",
        country: opts.country ?? "US",
        email: opts.email,
        capabilities: { transfers: { requested: true } },
      })
      accountId = account.id
    }
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: opts.refreshUrl,
      return_url: opts.returnUrl,
    })
    return { url: link.url, accountId }
  }

  async createTransfer(opts: TransferOpts): Promise<TransferResult> {
    const transfer = await this.stripe.transfers.create({
      amount: opts.amountCents,
      currency: "usd",
      destination: opts.accountId,
      metadata: opts.metadata,
    })
    return { transferId: transfer.id }
  }
}

export function parseStripeWebhook(payload: string | Buffer, signature: string): Stripe.Event {
  return getStripeClient().webhooks.constructEvent(payload, signature, config.stripeWebhookSecret)
}

function getProvider(): PaymentProvider {
  if (config.stripeSecretKey && config.stripeMode === "live") {
    return new LiveStripeProvider()
  }
  return new StubPaymentProvider()
}

export const payments = getProvider()
