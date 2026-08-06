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

### Layer 1 — Behavioral heuristics `[PARTIAL, TUNE]`

Cheap and high-coverage. Core signal plumbing is shipped; tune thresholds from real abuse data.

- **Server-side challenge nonce `[IMPLEMENTED]`.** A per-serve nonce is embedded in the serve
  response and required (echoed + signed) in the impression payload, defeating blind replay of
  captured events (`server/src/routes/ads.ts`, `server/src/services/auction.ts`).
- **Focus/occlusion signals `[IMPLEMENTED]`.** Impressions carry a `focusPct` (share of duration
  the surface was focused/visible). The VSCode surface measures it via window-focus events; other
  surfaces report 100 until they can measure. Server stores it and can gate on `MIN_FOCUS_PCT`.
- **Inter-arrival distribution `[PLANNED]`.** Real prompts are bursty and human-shaped; bots are
  suspiciously regular. Track request cadence per device/account; flag machines.
- **Duration shape `[PLANNED]`.** Real thinking times cluster realistically. Synthetic traffic is
  unnaturally uniform or parked exactly at the cap (e.g., always 10.0–11.0s).

### Layer 2 — Graph & network intelligence `[TIER 2]`

This is the layer that catches collusion. Per-device rules cannot see a farm; graphs can.

- Build an account ↔ device ↔ campaign ↔ IP/ASN graph and run connected-component analysis.
- **Many accounts behind one network** → farm signature. **One account across many networks** →
  VPN/proxy rotation signature. Both are named in the reference market's own FAQ as the
  canonical signals; implement both directions.
- **IP/ASN reputation.** Flag datacenter / VPS / emulator / known-proxy ranges as high risk.
- **Privacy-respecting implementation.** Derive signals and persist only salted hashes and
  aggregate patterns (matching the ToS: IPs are processed transiently, never stored raw).

### Layer 3 — ML scoring + payout holds `[PARTIAL]`

Where money is actually protected.

- Score every impression with an ensemble:
  - unsupervised anomaly detection on features (impressions/hr, session length, viewability
    rate, CPM-weighted earnings, inter-arrival stats);
  - supervised model trained on manually-labeled fraud from the review queue.
- **Payout clearing window `[IMPLEMENTED]`.** Payouts start `held` for `PAYOUT_HOLD_MS` (default
  72h) before the transfer is created; the dev's available balance is zeroed at request and the
  held amount lives in the `payouts` table. A sweeper (`server/src/services/payouts.ts`) advances
  held → pending (live) / cleared (stub) and reconciles paid totals.
- **Reserve buffer `[IMPLEMENTED]`.** `RESERVE_PCT` (default 10%) of each dev share is held in
  `devs.reserve_mills` at credit time and released back to the available balance after
  `RESERVE_RELEASE_MS` (default 30 days) via the same sweeper.
- **Graduated trust.** New accounts get low caps and human review before large payouts;
  established honest accounts get the benefit of the doubt.

### Layer 4 — Human review & advertiser protection `[IMPLEMENTED BASELINE, EXPAND]`

- Review queue for flagged accounts; preserve the automated-decision appeal path (GDPR Art. 22
  right to human review, ToS §9.7).
- Settle advertiser billing only against post-vetting impressions; issue credits for voided
  delivery (ToS advertiser section already permits this).
- Chargeback defense on the advertiser checkout side (Stripe Radar / chargeback protection).

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
3. **Tier 2** — graph + IP/ASN reputation (payout clearing window and reserve buffer are already
   implemented).
4. **Tier 3** — ML scoring ensemble; graduated trust; automated blocking with human review queue.

Every tier is additive and doesn't change the impression contract, so honest clients keep
working unchanged.
