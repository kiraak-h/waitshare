# Architecture

WaitShare is a two-sided marketplace: developers rent their AI wait-states (supply) and
advertisers buy impression blocks (demand). This document covers the design decisions and how the
product is deliberately "better" than the reference (Kickbacks.ai).

## Design goals

1. **Fair economics.** The developer share is a floor, locked in code and public.
2. **Privacy by design.** The data model physically cannot carry prompts or code.
3. **Trust through cryptography.** Impressions and updates are Ed25519-signed.
4. **Transparency.** Everything the platform claims is verifiable on a public ledger.

## The revenue split contract

Unlike Kickbacks' ToS, which describes the 50/50 split as "estimated" and "may be flexibly and
dynamically modified", WaitShare persists the split as a database contract row and computes every
credit from one function:

```
dev_share = floor(gross × dev_share_pct / 100)
```

- Money is tracked in integer **mills** (1 mill = 0.001 cent = $0.00001) to avoid float drift.
- Per-impression gross = `floor(cpm_cents × 1000 / 1000)` mills (i.e. cpm cents per 1,000
  impressions).
- The `GET /api/v1/split` endpoint exposes the contract; the ledger re-derives shares from it.

## Ad serving flow

```
client                          server
  |  GET /ads/next?surface=&deviceId=   |
  |------------------------------------>|  pickNextAd() -> create serve (90s TTL, status=pending)
  |  { serveId, adLine, url, expiresAt }|
  |<------------------------------------|
  |  [sponsored line on screen]         |
  |  POST /ads/impressions              |
  |  { serveId, deviceId, durationMs,   |
  |    viewablePct, ts, signature }     |
  |------------------------------------>|  verify Ed25519 signature vs registered device key
  |                                     |  validate serve: pending, unexpired, right device
  |                                     |  fraud check: duration>=10s, viewable>=50%, caps
  |                                     |  recordImpression(): credit dev at locked split
  |  { credited, devShareMills }        |
  |<------------------------------------|
```

Auction: active campaigns per surface, ordered by `cpm_cents DESC`. The same campaign is not
served to a device twice in a row. Blocks are 1,000 impressions each.

## What Kickbacks got wrong and how this fixes it

| Issue | Kickbacks.ai | WaitShare |
| --- | --- | --- |
| Split certainty | ToS says 50% split is "estimated", changeable at will | Split is a locked contract enforced by `dev_share_mills()` |
| Auditability | Claims open source; the linked repo 404s | Everything is in this repo; ledger + split contract public |
| Signed updates | HN-reported self-update every 90s with no signature check | Manifests signed with Ed25519; server public key published at `/updates/key` |
| Device authentication | Auth token only, in keychain | Device keypair held by the client; server stores only the public key; every event signed |
| Prompt data | Optional "Boosted Mode" sends cleaned conversations | No such mode exists; the telemetry schema has no content fields |
| No hidden capture | Patching third-party extensions | Surface integrations are explicit, reversible, documented |

## Security model

- **Device key registration** (`POST /auth/device`): the client generates an Ed25519 keypair and
  sends only the public key. The server never holds device private keys.
- **Impression integrity**: the canonical signed payload is
  `{ serveId, deviceId, durationMs, viewablePct, focusPct, nonce, ts }`. The server re-serializes and
  verifies with the registered public key. Replay is blocked by the single-use serve status.
- **Update integrity**: the server signs `{ platform, version, url, sha256 }`. Clients verify
  against the published public key before applying anything.
- **Fraud controls**: minimum 10s display, minimum 50% viewability, hourly/daily per-device caps,
  single-use 90s serves. Fleet-wide Tier 2 signals (farm: ≥`TIER2_FARM_DEVS` accounts per masked
  network; VPN rotation: ≥`TIER2_VPN_NETWORKS` networks per account; IP binding on each serve) are
  implemented in `services/fraud.ts` + `services/network.ts` and audited to `fraud_events`.

## Privacy guarantees

- The `impressions` table stores event metrics only: serve, campaign, device, duration, viewable
  %, timestamps, gross/share, signature. No field can carry prompt or code content.
- IP addresses are masked to the /24 (IPv6 /48), salted, and SHA-256 hashed; only the hashes are
  persisted for fleet detection — nothing raw is stored.
- There is no telemetry mode that reads prompts. Removing that option entirely is the strongest
  way to guarantee it.

## Payment provider interface

`services/payments.ts` exposes `PaymentProvider` with three operations:
`createCheckoutSession`, `createConnectAccountLink`, `createTransfer`. The default `stub` provider
returns deterministic simulated URLs so the whole marketplace can be exercised without keys. In
production, swap in a `LiveStripeProvider` backed by the Stripe SDK (same signatures).

## Surfaces

- **opencode plugin** — subscribes to session events; starts an ad when a session runs, reports a
  signed impression when it idles. Config shared at `~/.waitshare/config.json`.
- **Claude Code CLI** — `SessionStart`/`Stop` hooks plus a `statusLine` command render the
  sponsored line and report impressions; `~/.claude/settings.json` is backed up before patching.
- **VS Code** — status-bar renderer watching the shared `current.json`, native start/report
  commands, and a demo of signed-update verification.

All surfaces share one account config and the same signed-impression protocol.

## Running

- `start.sh` boots the API (`:3001`) and the Vite dashboard (`:5173`, proxying `/api` to the API).
- `SEED_DEMO=0` disables demo campaigns. `STRIPE_MODE=live` + `STRIPE_SECRET_KEY` enable the real
  payment path once the SDK is wired in.
