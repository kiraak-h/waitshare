# Fraud & Abuse — Detection Strategy

Every fake impression is a double loss: it pays a fraudster (reducing the pool for honest
developers) and it forces advertiser credits/refunds (your cost line). This document is the
reference for how WaitShare detects, contains, and recovers from fraud at scale.

Status markers:
- `[IMPLEMENTED]` — present in this repo
- `[PLANNED]` — designed here, not yet in code
- `[TIER 2]` / `[TIER 3]` — deployment phases described below

## Threat model

| Attack | Description | Risk |
| --- | --- | --- |
| Impression botting | Scripts or loops issue prompts purely to rack up wait-state impressions | High |
| Device farms | Cheap VMs / emulators / headless environments serving ads 24/7 | High |
| Telemetry tampering | Spoofing duration, viewability, device IDs, or replaying serves | High |
| Multi-accounting | One person operating several earning accounts | Medium |
| Collusion networks | Many accounts/devices pooled to aggregate earnings | High |
| VPN / proxy rotation | Hiding device identity to evade per-device caps and IP checks | Medium |
| Click fraud | Automated clicking of advertiser links (once clicks are billed) | Medium |

Core principle: detection examines the **shape of activity**, never the content of work. The
telemetry schema has no field capable of carrying prompts or code, and it stays that way.

## Detection layers

### Layer 0 — Cryptographic integrity `[IMPLEMENTED]`

Stops drive-by abuse; does not stop organized abuse, but every higher layer depends on it.

- **Signed impressions.** Every event is Ed25519-signed with a device private key held by the
  client. The server stores only the public key and verifies the canonical payload
  `{ serveId, deviceId, durationMs, viewablePct, focusPct, nonce, ts }`.
- **Single-use, expiring serves.** A serve is issued for 90 seconds (env-tunable via
  `SERVE_TTL_MS`) and transitions pending → completed/void. Replays and reuse are rejected
  (`server/src/services/ledger.ts`).
- **Quality thresholds.** ≥10s continuous display, ≥50% viewability, and optional ≥`MIN_FOCUS_PCT`
  focus time (`server/src/services/fraud.ts`).
- **Caps.** Per-device hourly/daily caps (`CAP_HOURLY`, `CAP_DAILY`), a pending-serve cap
  (`MAX_PENDING_SERVES`) that stops serve hoarding, and optional inter-impression spacing
  (`MIN_GAP_MS`) — all env-tunable. The auction also avoids serving the same campaign twice in a row.

### Layer 1 — Behavioral heuristics `[IMPLEMENTED]`

Cheap and high-coverage. Core signal plumbing is shipped; tune thresholds from real abuse data.

- **Server-side challenge nonce `[IMPLEMENTED]`.** A per-serve nonce is embedded in the serve
  response and required (echoed + signed) in the impression payload, defeating blind replay of
  captured events (`server/src/routes/ads.ts`, `server/src/services/auction.ts`).
- **Focus/occlusion signals `[IMPLEMENTED]`.** Impressions carry a `focusPct` (share of duration
  the surface was focused/visible). The VSCode surface measures it via window-focus events; other
  surfaces report 100 until they can measure. Server stores it and can gate on `MIN_FOCUS_PCT`.
- **Inter-arrival distribution `[IMPLEMENTED]`.** Gap-coefficient-of-variation feeds the Tier 3
  risk model: real prompts are bursty and human-shaped, bots are suspiciously regular
  (`server/src/services/scoring.ts`).
- **Duration shape `[IMPLEMENTED]`.** Duration- and viewability-CV feed the Tier 3 risk model;
  synthetic traffic that is unnaturally uniform or parked exactly at the cap scores higher risk.

### Layer 2 — Graph & network intelligence `[PARTIALLY IMPLEMENTED]`

This is the layer that catches collusion. Per-device rules cannot see a farm; graphs can.

- Build an account ↔ device ↔ campaign ↔ IP/ASN graph and run connected-component analysis.
- **Many accounts behind one network → farm signature `[IMPLEMENTED]`.** Serves are withheld when
  a masked network hash is shared by ≥ `TIER2_FARM_DEVS` (default 5) distinct developers within
  `TIER2_WINDOW_MS` (default 24h).
- **One account across many networks → VPN/proxy rotation signature `[IMPLEMENTED]`.** Serves are
  withheld when one developer appears on ≥ `TIER2_VPN_NETWORKS` (default 3) distinct networks
  within the window.
- **IP binding `[IMPLEMENTED]`.** A serve is bound to the network that issued it; an impression
  submitted from a different masked network is rejected (403) and the serve is voided.
- **IP/ASN reputation `[IMPLEMENTED]`.** `server/src/services/asn.ts` classifies IPs as
  `datacenter | residential | unknown` against a multi-provider range dataset
  (`server/assets/asn.json`, binary-search lookup, IPv4 + IPv6) built from AWS, Google Cloud,
  Microsoft Azure, Oracle, and DigitalOcean public ranges plus optional RIPE announced-prefix
  lookups for major cloud ASNs (`server/scripts/build-asn.mjs`, ~68.5k ranges). With
  `TIER2_DC_ENFORCE` on (default), serves are withheld from datacenter/cloud networks and a
  `tier2-dc` event is logged. `ASN_DB_PATH` overrides the dataset; unmatched IPs classify
  `residential` (conservative).
- **Audit trail `[IMPLEMENTED]`.** Farm/VPN rejections and impression-time fleet rejections are
  recorded to the `fraud_events` table (deduped per dev+network per window) and increment
  `devs.fraud_flags`.
- **Privacy-respecting implementation `[IMPLEMENTED]`.** IPs are masked to the /24 (or /48 for
  IPv6), then salted (persistent per-instance salt in `data/fraud-salt`, or `FRAUD_SALT`) and
  SHA-256 hashed. Only the hashes are persisted — matching the ToS: IPs are processed
  transiently, never stored raw.

### Layer 3 — Risk scoring + payout holds `[IMPLEMENTED]`

Where money is actually protected.

- **Pluggable risk model `[IMPLEMENTED]`.** Every impression is scored 0–100 through a
  `RiskModel` interface (`server/src/services/risk-model.ts`): a deterministic `HeuristicModel`
  (v0, threshold-matched to the original scoring) or a `LogisticModel` (sigmoid over the same
  normalized features). `getRiskModel()` lazy-loads `server/assets/risk-model.json`
  (`TIER3_MODEL_PATH` overrides) and falls back to the heuristic model if the file is missing or
  malformed. The shipped weights come from `server/scripts/train-risk-model.mjs`, a synthetic
  logistic-regression trainer (3k honest + 3k bot Gaussian samples, L2 regularization, 80/20
  split) that currently reaches 1.000 accuracy with zero false positives at the 75 threshold.
  Those weights are a placeholder pending real labeled data — swap new weights in behind the
  same interface without touching scoring call sites. Score ≥ `TIER3_HIGH_RISK` (75) rejects
  and increments `fraud_flags`; ≥ `TIER3_REVIEW` (55) logs a review event. No content factors,
  ever.
- **Graduated trust `[IMPLEMENTED]`.** `computeTrustTier()` derives `0 = new`, `1 = established`
  (≥ 50 impressions / 7 days), `2 = trusted` (≥ 2000 impressions / 30 days, zero flags). Trust
  tier 0 gets reduced hourly/daily caps (`TIER0_CAP_*`) and a single-payout cap
  (`TIER0_PAYOUT_CAP_CENTS`) enforced in `/dev/payout`; serve is gated on `status = active`.
  Admin review can clear/review/suspend via `/api/v1/admin/review`.
- **Payout clearing window `[IMPLEMENTED]`.** Payouts start `held` for `PAYOUT_HOLD_MS` (default
  72h) before the transfer is created; the dev's available balance is zeroed at request and the
  held amount lives in the `payouts` table. A sweeper (`server/src/services/payouts.ts`) advances
  held → pending (live) / cleared (stub) and reconciles paid totals.
- **Reserve buffer `[IMPLEMENTED]`.** `RESERVE_PCT` (default 10%) of each dev share is held in
  `devs.reserve_mills` at credit time and released back to the available balance after
  `RESERVE_RELEASE_MS` (default 30 days) via the same sweeper.

### Layer 4 — Human review & advertiser protection `[IMPLEMENTED]`

- Review queue for flagged accounts; preserve the automated-decision appeal path (GDPR Art. 22
  right to human review, ToS §9.7).
- Settle advertiser billing only against post-vetting impressions; issue credits for voided
  delivery (ToS advertiser section already permits this).
- **Chargeback / refund defense `[IMPLEMENTED]`.** Live checkout (`server/src/services/payments.ts`)
  runs Stripe Radar on every advertiser charge. Webhook handling
  (`server/src/routes/webhooks.ts`) persists the `stripe_checkout_id` / `payment_intent_id` on
  the campaign at `checkout.session.completed`, then reacts to `charge.dispute.created`
  (campaign → `status = 'disputed'` and a `chargeback` row in `fraud_events`), `charge.refunded`
  (fully refunded → `status = 'refunded'`), and `charge.dispute.closed`. Disputed/refunded
  campaigns stop serving immediately and can be re-reviewed by an operator before any further
  delivery. Stub mode mirrors these statuses so the payment-risk lifecycle is testable offline.

## Known hard problem: human vs. agent-initiated waits

CI jobs and sub-agents legitimately use these tools, but agent-initiated impressions are not
"your attention" and should not earn. Client-side flags are spoofable; the server cannot always
distinguish. Conservative default: exclude agent/background sessions from earning and accept
occasional under-crediting of honest automation. Under-crediting costs goodwill; fraud payouts
cost the whole marketplace.

## Privacy vs. anti-fraud tension

Fraud detection wants fingerprints; the product promise is minimal data. The resolution:
**derive signals, store hashes.** Process IPs, timing, and graph features transiently; persist
only salted hashes and aggregates. GDPR legitimate-interest basis for anti-fraud is defensible
(ToS §10.3 already states it); the data flows must match the ToS and Privacy Policy exactly.

## KPIs to track

| Metric | Why |
| --- | --- |
| Fraud rate (voided / served) | Core health; target < 1% long-term |
| Advertiser credit rate | Money flowing back; cost line |
| Chargeback rate | Demand-side risk; Stripe Radar target < 0.5% |
| False-positive rate on blocks | Honest devs harmed; measure via appeals upheld |
| Median time-to-block | Speed of containment |
| Payout recovery rate | % of fraud detected after payout (should be ~0) |

## Deployment roadmap

1. **Now (`[IMPLEMENTED]`)** — signatures, single-use serves, challenge nonce, focus/occlusion
   plumbing, quality thresholds, env-tunable caps. Ship and collect baseline distributions.
2. **Tier 1 (`[DONE]`)** — challenge nonce, focus flag, pending-serve cap, inter-impression spacing.
   Remaining: tune the inter-arrival and duration-shape detectors from real data.
3. **Tier 2 (`[IMPLEMENTED]`)** — graph + IP/ASN reputation: farm, VPN-rotation, IP-binding, and
   datacenter-network detection are live behind env-tunable thresholds, with the bundled ASN
   dataset. Payout clearing window and reserve buffer are also implemented.
4. **Tier 3 (`[IMPLEMENTED]`)** — pluggable risk scoring (heuristic v0 + trained logistic model
   behind one interface), graduated trust tiers with per-tier caps and payout gates, and an admin
   review queue (clear/review/suspend).
5. **Tier 4 (`[IMPLEMENTED BASELINE]`)** — advertiser chargeback/refund defense via Stripe Radar
   and dispute webhooks that suspend delivery; remaining work is real-data tuning of the risk
   weights and operational runbooks for dispute handling.

Every tier is additive and doesn't change the impression contract, so honest clients keep
working unchanged.
