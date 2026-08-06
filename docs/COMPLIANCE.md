# WaitShare — Compliance & Money Rails

How WaitShare moves money and stays compliant. Two rails: **fiat (Stripe)** today, **stablecoin (USDC)**
as a payout escape hatch for markets Stripe can't reach. The two rails share the same entity, ledger,
and tax-reporting backbone.

## 1. Operating model

| Concern | Decision | Why |
|---|---|---|
| Legal entity | Single Delaware C-Corp (WaitShare, Inc.) | One entity keeps tax/KYC/holds simple at launch |
| Payment processor | Stripe (Checkout + Connect Express) | Cards, chargebacks, onboarding, 40+ country payouts out of the box |
| Payout rail | Stripe transfers to dev's Connect account | WaitShare **never custody funds** — keeps us out of money-transmitter territory |
| Crypto rail | USDC payouts via licensed partner (Stripe crypto payouts / Coinbase Commerce) | Reaches countries Stripe can't; still no self-custody |
| Payer of record | Stripe Connect Express (or Tipalti as fallback) | They own the tax form issuance burden, not us |
| Money movement | `services/payments.ts` `PaymentProvider` | Swap `StubPaymentProvider` ↔ `LiveStripeProvider` without touching routes |

Key invariant: **WaitShare is a marketplace, not a bank.** All balances are records in our ledger; the
actual money lives with the processor/payer-of-record until disbursed.

## 2. Fiat rail (Stripe)

### Advertiser side — Checkout
- Advertiser pays in USD by card via Stripe Checkout; `checkout.session.completed` activates the campaign.
- Full refunds are honored for unused impressions (see `docs/FRAUD.md` L4 advertiser credits).
- Chargeback risk is our cost surface: only activate campaigns on `payment_status === "paid"`.

### Dev side — Connect Express
- Each dev gets a Stripe Connect Express account; onboarding via Account Link, verified by
  `account.updated` → `details_submitted`.
- Payouts are `transfers` to that account. **We never see or hold the dev's bank/card details.**
- Balance clears only after a 72h hold + `transfer.created` webhook (fraud window, see FRAUD.md L3).

### Cross-border obligations (fiat)
- **VAT/GST on the ad platform fee**: our 40% platform cut is a taxable service. Register for EU **OSS**
  to remit VAT for all EU advertisers in one return; handle UK VAT and US nexus (likely WA/CA) separately.
- **Income tax on the 60% dev share**: belongs to the dev, not us — but if Stripe/Tipalti is payer of
  record they issue the W-9/W-8BEN; if not, we must. Plan: use Connect so they issue.
- **Withholding**: if we ever pay devs directly from our account, WHT applies in some countries
  (e.g., India). Prefer payer-of-record processors to push this onto them, or withhold + file.
- **Unclaimed property (escheat)**: payouts below threshold that sit unpaid must eventually be remitted
  to the state. Set `PAYMENT_THRESHOLD_CENTS` but enforce an annual sweep to Connect balances.

## 3. Crypto rail (stablecoin, Phase 2)

Use case: **the long tail.** ~30% of countries (mostly LatAm, Africa, parts of Asia) can't receive
Stripe payouts. USDC (Solana/Polygon/Stellar low-fee chains) pays them with minimal friction.

### What we deliberately do NOT do
- **No self-custody.** We never hold devs' USDC; a licensed partner (Stripe crypto payout / Coinbase
  Commerce) disburses from their rails. This is the difference between a *payment method* and a
  *money transmitter / VASP*.
- **No on-chain ad payments.** Advertisers keep paying in fiat/cards. Onboarding advertisers via
  crypto would drag the whole fiat compliance burden into wallet-KYC land for zero benefit.
- **No anonymous payouts.** Every payout (fiat or crypto) requires completed KYC via the processor.
  "Pay me in crypto to an address" is a money-laundering red flag, not a feature.

### What crypto does NOT fix
- **Taxes don't disappear.** A dev paid in USDC owes income tax on the dollar value at receipt. USDC
  (a stablecoin pegged to USD) keeps that valuation trivial vs BTC/ETH — that's why we chose it.
- **AML/KYC don't disappear.** If we ever self-custody USDC, we'd inherit VASP obligations: AML
  programs, OFAC sanctions screening (Travel Rule for transfers ≥ $3k), FinCEN/SEC/CFTC registration
  questions, plus each country's virtual-asset licensing. All avoided by routing through licensed
  partners.

### Crypto-specific ops
- Record receipt value in USD at payout time (stablecoin = simple).
- Keep OFAC country-blocklist consistent between fiat and crypto payouts (same `country_filter` gating).
- If devs self-report crypto addresses, they're just payout destinations — same KYC as bank payouts.

## 4. Tax reporting backbone (shared)

| Who | What we must report |
|---|---|
| Advertisers | Invoices/receipts; VAT/GST remitted via OSS where applicable |
| Devs (US) | 1099-K/1099-MISC issued by payer of record (Connect/Tipalti) |
| Devs (non-US) | W-8BEN via payer of record; no US 1099 needed |
| Our entity | Corporate income tax on the 40% platform fee, minus costs |

Rule: **the platform fee is our revenue; the dev share is their revenue.** Keep the 60/40 split visible
in the ledger (`/split` contract + per-impression `dev_share_mills`) so every amount traces to its owner.

## 5. Legal hardening checklist

- [ ] Hire one international tax advisor (not 27). Scope: EU OSS, US nexus, payer-of-record setup.
- [ ] Delaware C-Corp formation + operating agreement; review with counsel before Stripe Connect KYB.
- [ ] ToS + Ads policy: prohibited categories (crypto bros, gambling, weapons, political), brand standards.
- [ ] Country gating for devs and advertisers via `country_filter` + processor restrictions.
- [ ] Data processing agreement / privacy policy: no prompts or code ever collected (see ARCHITECTURE).
- [ ] Worker classification: devs are independent users, not employees — no control over their work.

## 6. Decision record

- 2026-08-04: Stripe live provider implemented in `server/src/services/payments.ts`
  (`LiveStripeProvider`, Checkout + Connect Express + webhooks). Stub remains the default until
  `STRIPE_SECRET_KEY`/`STRIPE_MODE=live` are set.
- 2026-08-04: Staged plan approved — launch fiat first, add USDC payouts as Phase 2 escape hatch,
  never custody funds, never treat crypto as a tax substitute.
