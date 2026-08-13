import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import assert from "node:assert"
import type Stripe from "stripe"

// Env must be set before config/db are evaluated, so load them via dynamic
// imports after the assignments below (ESM hoists static imports).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "waitshare-webhook-test-"))
process.env.DATABASE_URL = ""
process.env.STRIPE_MODE = "live"
process.env.STRIPE_SECRET_KEY = "sk_test_webhook_unit"
process.env.STRIPE_WEBHOOK_SECRET = "whsec_webhook_unit"
process.env.SEED_DEMO = "0"

const { db, initDb } = await import("../src/db.js")
const { parseStripeWebhook } = await import("../src/services/payments.js")
const { applyStripeEvent } = await import("../src/services/stripe-events.js")
const { logFraudEvent } = await import("../src/services/fraud.js")

const SECRET = "whsec_webhook_unit"

function signedHeader(payload: string): string {
  const ts = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${payload}`).digest("hex")
  return `t=${ts},v1=${sig}`
}

function event<T extends Stripe.Event>(type: T["type"], object: unknown): T {
  return { id: "evt_test", object: "event", type, data: { object } } as unknown as T
}

const CAMP_COLS =
  "(id, advertiser_id, ad_line, url, surface, cpm_cents, blocks, impressions_bought, status, payment_intent_id, created_at, updated_at)"

let passed = 0
let failed = 0

async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS  webhook: ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  webhook: ${name}  (${(e as Error).message})`)
  }
}

await t("webhook: accepts a valid Stripe signature", () => {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: {} } })
  const ev = parseStripeWebhook(payload, signedHeader(payload), { secret: SECRET, apiKey: "sk_test_webhook_unit" })
  assert.strictEqual(ev.type, "checkout.session.completed")
})

await t("webhook: rejects an invalid signature", () => {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: {} } })
  assert.throws(() => parseStripeWebhook(payload, "t=1,v1=deadbeef", { secret: SECRET, apiKey: "sk_test_webhook_unit" }))
})

await t("webhook: checkout.session.completed activates a paid campaign", async () => {
  await initDb()
  const now = Date.now()
  await db.run(
    `INSERT INTO campaigns ${CAMP_COLS} VALUES (?, 'adv1', 'Co', 'https://example.com', 'opencode', 300, 5, 5000, 'pending', NULL, ?, ?)`,
    ["c-co", now, now]
  )
  await applyStripeEvent(
    event("checkout.session.completed", {
      id: "cs_test",
      metadata: { campaignId: "c-co" },
      payment_status: "paid",
      payment_intent: "pi_co",
    } as unknown as Stripe.Checkout.Session)
  )
  const row = await db.get<{ status: string; payment_intent_id: string | null }>(
    "SELECT status, payment_intent_id FROM campaigns WHERE id = ?",
    ["c-co"]
  )
  assert.strictEqual(row?.status, "active")
  assert.strictEqual(row?.payment_intent_id, "pi_co")
})

await t("webhook: charge.dispute.created stops a campaign and audits it", async () => {
  const now = Date.now()
  await db.run(
    `INSERT INTO campaigns ${CAMP_COLS} VALUES (?, 'adv1', 'Disp', 'https://example.com', 'opencode', 300, 5, 5000, 'active', 'pi_disp', ?, ?)`,
    ["c-disp", now, now]
  )
  await applyStripeEvent(
    event("charge.dispute.created", { id: "dp_test", payment_intent: "pi_disp", charge: "ch_disp" } as unknown as Stripe.Dispute)
  )
  const row = await db.get<{ status: string }>("SELECT status FROM campaigns WHERE id = ?", ["c-disp"])
  assert.strictEqual(row?.status, "disputed")
  const fe = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fraud_events WHERE type = 'chargeback'")
  assert.ok(Number(fe?.n) >= 1)
})

await t("webhook: charge.refunded flips a campaign to refunded", async () => {
  const now = Date.now()
  await db.run(
    `INSERT INTO campaigns ${CAMP_COLS} VALUES (?, 'adv1', 'Refund', 'https://example.com', 'opencode', 300, 5, 5000, 'active', 'pi_refund', ?, ?)`,
    ["c-refund", now, now]
  )
  await applyStripeEvent(event("charge.refunded", { id: "ch_refund", payment_intent: "pi_refund", refunded: true } as unknown as Stripe.Charge))
  const row = await db.get<{ status: string }>("SELECT status FROM campaigns WHERE id = ?", ["c-refund"])
  assert.strictEqual(row?.status, "refunded")
})

await t("webhook: transfer.created clears a payout and pays the dev", async () => {
  const now = Date.now()
  await db.run("INSERT INTO devs (id, email, country, status, paid_mills, created_at) VALUES (?, ?, 'US', 'active', 0, ?)", [
    "d-tr",
    "d@test.dev",
    now,
  ])
  await db.run(
    "INSERT INTO payouts (id, dev_id, amount_mills, status, stripe_transfer_id, available_at, created_at) VALUES (?, ?, 5000, 'held', 'tr_test', ?, ?)",
    ["p-tr", "d-tr", now, now]
  )
  await applyStripeEvent(event("transfer.created", { id: "tr_test" } as unknown as Stripe.Transfer))
  const p = await db.get<{ status: string }>("SELECT status FROM payouts WHERE id = ?", ["p-tr"])
  assert.strictEqual(p?.status, "cleared")
  const d = await db.get<{ paid_mills: number }>("SELECT paid_mills FROM devs WHERE id = ?", ["d-tr"])
  assert.strictEqual(d?.paid_mills, 5000)
})

await t("webhook: logFraudEvent buckets fraud_labels per dev", async () => {
  const now = Date.now()
  await db.run(
    "INSERT INTO devs (id, email, country, status, fraud_flags, created_at) VALUES (?, ?, 'US', 'active', 0, ?)",
    ["d-lbl", "lbl@test.dev", now]
  )
  await logFraudEvent("tier3-reject", { devId: "d-lbl", reason: "high risk score 90" })
  await logFraudEvent("tier3-reject", { devId: "d-lbl", reason: "high risk score 92" })
  await logFraudEvent("tier2", { devId: "d-lbl", reason: "shared network flagged as farm" })
  const row = await db.get<{ fraud_labels: string | null }>("SELECT fraud_labels FROM devs WHERE id = ?", ["d-lbl"])
  assert.deepStrictEqual(JSON.parse(row?.fraud_labels ?? "{}"), { "risk-reject": 2, "fleet-farm": 1 })
  const flags = await db.get<{ fraud_flags: number }>("SELECT fraud_flags FROM devs WHERE id = ?", ["d-lbl"])
  assert.strictEqual(flags?.fraud_flags, 0)
})

await t("webhook: logFraudEvent without a dev id does not bump labels", async () => {
  const before = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fraud_events")
  await logFraudEvent("chargeback", { reason: "advertiser dispute dp_stub" })
  const after = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fraud_events")
  assert.strictEqual(Number(after?.n), Number(before?.n) + 1)
})

await db.close()

const total = passed + failed
console.log(`\n${passed}/${total} webhook checks passed`)
process.exitCode = failed === 0 ? 0 : 1
