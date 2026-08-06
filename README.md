# WaitShare

Get paid for waiting. A privacy-first, transparent ad marketplace for AI coding tools — built as a
"better Kickbacks.ai" reference product.

- **60/40 split, locked.** 60% of net ad revenue goes to the developer, enforced by a public
  formula in payment code (`dev_share = floor(gross × 60 / 100)`). Not "estimated", not "up to".
- **Privacy by design.** Telemetry carries ad-event metrics only — no code, no prompts, no AI
  responses, ever. There is no opt-in tier that changes this.
- **Signed everything.** Impression events are Ed25519-signed per device; client update manifests
  are Ed25519-signed by the server. No unsigned event is credited, no unsigned update is applied.
- **Transparent.** Every campaign, CPM, impression count, and dev payout is on a public ledger.

See `docs/ARCHITECTURE.md` for design decisions, `docs/FRAUD.md` for the fraud-detection
strategy, and `docs/COMPLIANCE.md` for money rails and tax/compliance.

## Layout

```
server/    Express + better-sqlite3 API (auction, ledger, payments, signed updates)
web/       Vite + React dashboard (home, advertise, transparency, earnings, install)
clients/
  opencode/        opencode plugin (ad fetching + signed impressions)
  claude-code/     Claude Code CLI status-line + hooks integration
  vscode/          VS Code extension (status-bar surface + update verification)
  shared/          account setup script (registers email + device Ed25519 key)
start.sh   Runs API (:3001) and web (:5173) together
```

## Quick start

```bash
npm install
./start.sh
```

Then open the web dashboard at `http://localhost:5173` (API at `http://localhost:3001`).

Demo data is seeded on first boot: campaigns across all four surfaces plus a demo account.

## Using a client surface

First configure an account (shared by all surfaces):

```bash
node clients/shared/setup.mjs
```

- **Opencode:** copy `clients/opencode/plugin.ts` to `~/.config/opencode/plugins/`, reload opencode.
- **Claude Code CLI:** `bash clients/claude-code/install.sh` — patches `statusLine` + `SessionStart`/`Stop`
  hooks in `~/.claude/settings.json` (backup written first, restore command printed). Self-update:
  `node clients/claude-code/waitshare.mjs update`.
- **VS Code:** build with `npm run build` in `clients/vscode`, package with `vsce`, install. The
  status bar renders the shared sponsored line and the `WaitShare: Verify update signature` command
  demonstrates signed-update verification.

## API

All routes are under `/api/v1`.

| Route | Purpose |
| --- | --- |
| `GET /ads/next?surface=&deviceId=` | Issue an ad serve (90s TTL) |
| `POST /ads/impressions` | Report a signed impression; credit dev at locked split |
| `POST /auth/register` | Create/sign-in a developer account |
| `POST /auth/device` | Register a device Ed25519 public key |
| `GET /auth/google/login` · `GET /auth/google/callback` | Google OAuth sign-in (redirects to dashboard) |
| `POST /webhooks/stripe` | Stripe webhooks (campaign activation, onboarding, payout clearing) |
| `GET /dev/me` · `GET /dev/earnings` · `GET /dev/payouts` | Developer dashboard data + payout history |
| `POST /dev/onboarding` · `POST /dev/payout` | Stripe Connect onboarding and payout request |
| `POST /advertiser/campaigns` | Create campaign + Stripe Checkout session |
| `GET /auction/state` | Live market: surface CPMs, impressions/hr |
| `GET /ledger` | Public transparency ledger |
| `GET /updates/latest` · `GET /updates/key` | Signed update manifest + server public key |
| `GET`/`PUT /updates/artifacts/:name` | Download / upload update artifacts (PUT is admin-only) |
| `POST /updates/` | Publish a signed manifest (admin token required) |
| `GET /split` | The locked revenue split contract |

## Payments

`services/payments.ts` defines a `PaymentProvider` interface. A working stub is active by default
(`STRIPE_MODE=stub`), so checkout, onboarding, and transfers simulate cleanly. To go live:

1. Set `STRIPE_SECRET_KEY` (secret key) and `STRIPE_MODE=live`.
2. Set `STRIPE_WEBHOOK_SECRET` (webhook signing secret) and add `POST /api/v1/webhooks/stripe` to your
   Stripe account's webhook endpoints.
3. Webhooks handled: `checkout.session.completed` activates a paid campaign, `account.updated` flips
   dev onboarding status, `transfer.created` marks a payout cleared. The route is mounted before
   `express.json()` so the raw body is available for signature verification.

The live provider uses Stripe Checkout for advertiser payments and Stripe Connect Express for dev
payouts (payouts are transfers to the dev's connected account; WaitShare never holds funds).

### Payout lifecycle

1. `POST /dev/payout` moves the available balance into a `held` payout (available balance zeroed).
2. After the clearing window (`PAYOUT_HOLD_MS`, default 72h) a sweeper creates the transfer
   (`pending` in live mode, `cleared` in stub mode) and the `transfer.created` webhook marks it
   `cleared`.
3. `RESERVE_PCT` (default 10%) of each dev share is withheld in `reserve_mills` at credit time and
   released back to the available balance after `RESERVE_RELEASE_MS` (default 30 days).

## Auth

Google OAuth is available for developers: the dashboard's "Continue with Google" button redirects to
`/api/v1/auth/google/login`, and the callback exchanges the code, upserts the dev by Google `sub`/email,
and redirects back to the dashboard with a session token in the URL fragment. Set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` to enable; email sign-in remains as a demo fallback.

## Fraud controls

Impression integrity beyond signatures:

- **Challenge nonce.** Every serve carries a random nonce; the impression must echo it (signed) or the
  serve is voided — defeats blind replay of captured events.
- **Focus/occlusion.** Impressions report `focusPct` (share of time the surface was focused/visible);
  the VSCode surface measures it from window-focus events. Gate with `MIN_FOCUS_PCT` when ready.
- **Env-tunable caps.** `CAP_HOURLY`, `CAP_DAILY`, `MAX_PENDING_SERVES` (serve hoarding), `MIN_GAP_MS`
  (inter-impression spacing), `SERVE_TTL_MS`, `MIN_IMPRESSION_SECONDS`, `MIN_VIEWABLE_PCT`. Payout
  safety: `PAYOUT_HOLD_MS` (clearing window), `RESERVE_PCT` + `RESERVE_RELEASE_MS` (clawback reserve).
- **Fleet-wide (Tier 2).** IPs are masked to the /24 (IPv6 /48), salted (`FRAUD_SALT` or a
  persistent per-instance salt), and SHA-256 hashed; only the hashes are stored. Detection:
  - **Farm** — a masked network shared by ≥ `TIER2_FARM_DEVS` (5) distinct developers within
    `TIER2_WINDOW_MS` (24h) is withheld from serving.
  - **VPN rotation** — a developer appearing on ≥ `TIER2_VPN_NETWORKS` (3) distinct networks within
    the window is withheld.
  - **IP binding** — each serve is bound to the network that issued it; an impression from a
    different masked network is rejected (403) and the serve voided.
  - Rejections land in the `fraud_events` audit table and increment `devs.fraud_flags`.
  - `server/src/services/network.ts` exposes a `classifyNetwork()` hook for ASN/DC reputation; it
    stays unenforced until a GeoLite2 dataset is supplied.

## Signed updates

Client updates are integrity-protected end-to-end:

1. Publish an artifact and manifest (admin only — `ADMIN_TOKEN` required):

   ```bash
   WAITSHARE_ADMIN_TOKEN=<token> node server/scripts/publish-update.mjs claude-code-cli 0.2.0 ./artifact.mjs
   ```

   The script uploads the artifact, computes its sha256, and stores an Ed25519-signed manifest.
   The signature covers exactly `{ platform, version, url, sha256 }` (stable key order) and can be
   verified against the public key at `GET /updates/key`.
2. Clients check `GET /updates/latest?platform=&version=`; the shared updater
   (`clients/shared/updater.mjs`) verifies the manifest signature, downloads the artifact, and
   verifies its sha256 before applying atomically (write-temp + rename).
3. Wired surfaces: `waitshare.mjs update` (Claude Code CLI, self-replaces), the VS Code
   `WaitShare: Update extension (verified)` command (downloads + installs the `.vsix`), and the
   opencode plugin logs a verified-update notice on load. Any manifest or artifact that fails
   verification is refused.

## Security notes

- Device keys are generated client-side; the server stores only the public key.
- Impression payloads must be signed with the registered device key and echo the serve's challenge
  nonce; the server rejects unsigned, wrongly-signed, or nonce-mismatched events.
- IP addresses are masked to the /24 (IPv6 /48), salted, and SHA-256 hashed; only the hashes are
  persisted and used transiently for fleet detection — raw IPs are never stored.
- Serve records expire after 90 seconds, can be used once, and cap at `MAX_PENDING_SERVES` per device.

## Production roadmap

- ASN/DC reputation: supply a GeoLite2 dataset behind the `classifyNetwork()` hook and enforce it.
- ML scoring ensemble (Tier 3) + graduated trust with a human review queue.
- Relational database for production scale; real Stripe/Google credentials; CI pipeline.
