# WaitShare — Production Deployment Guide

This document covers turning the repo into a running production service. The dev
experience (SQLite + stub payments) is one flip of configuration away from a
credentialed deployment; this guide is the map for that flip.

## 1. Configuration

Copy `.env.example` to your environment (platform env vars or a managed `.env`)
and fill in real values. The server validates configuration at startup:

- hard **errors** (server refuses to start), e.g. `STRIPE_MODE=live` without
  `STRIPE_SECRET_KEY`;
- **warnings** for risky-but-runnable states, e.g. `NODE_ENV=production` with
  `SEED_DEMO` still enabled or localhost base URLs.

Run `npm run build -w server` and start with `NODE_ENV=production node server/dist/index.js`
behind your load balancer / reverse proxy. Health check: `GET /api/v1/health`.

The server also serves the built dashboard when `web/dist/index.html` exists
(`WEB_DIST_DIR` overrides the path): `npm run build -w web`, then static assets
are served at `/` with an SPA fallback for non-`/api` routes — one origin, no
CORS surface. Docker does this automatically (see §8).

## 2. Payments (Stripe)

Two flows use Stripe:

1. **Advertiser checkout** — `POST /api/v1/advertiser/campaigns` creates a Checkout
   Session (payment mode, USD). Campaigns start `pending_payment` and only activate
   after the `checkout.session.completed` webhook.
2. **Developer payouts** — `POST /api/v1/dev/onboarding` creates/refreshes a Connect
   Express account (`transfers` capability). Payouts (`POST /api/v1/dev/payout`)
   enter a 72h `held` window, then a sweeper creates a Connect transfer. Webhook
   `transfer.created` marks the payout `cleared`.

Setup:

- `STRIPE_MODE=live`, `STRIPE_SECRET_KEY` (secret key), `STRIPE_WEBHOOK_SECRET`.
- Create webhook endpoints in the Stripe dashboard for `checkout.session.completed`,
  `account.updated`, `transfer.created`, `charge.dispute.created`, `charge.dispute.closed`,
  and `charge.refunded`, all pointing at `https://<host>/api/v1/webhooks`.
- Stripe Radar runs on every advertiser charge by default. Dispute/refund webhooks
  transition the campaign to `disputed` / `refunded`, which stops delivery and records a
  `chargeback` row in `fraud_events` for operator review.
- Connect Express requires your platform account to be approved for payouts and
  (if operating in the EU) to be registered for OSS/VAT.

Until keys are present, `STRIPE_MODE=stub` exercises the entire marketplace with
deterministic simulated URLs — useful for staging and CI.

### Go-live checklist (test keys → live keys)

Order matters; do it in a maintenance window and keep the dashboard in stub mode
until the last step.

1. **Create the Stripe account.** Sign up for Stripe, complete your business
   profile, and enable *Checkout*, *Connect Express* (payouts), and *Radar*.
   Connect Express requires platform approval for payouts and — if operating in
   the EU — OSS/VAT registration.
2. **Collect test keys.** From the dashboard: *Developers → API keys* for
   `sk_test_*`, and *Developers → Webhooks* to create a webhook endpoint pointing
   at `https://<host>/api/v1/webhooks` with the events below; copy the
   `whsec_*` signing secret.
3. **Run against test keys.** Set `STRIPE_MODE=live`, `STRIPE_SECRET_KEY=sk_test_*`,
   `STRIPE_WEBHOOK_SECRET=whsec_*` on staging. Exercise the two flows end to end
   with Stripe test cards: advertiser checkout → campaign activates on
   `checkout.session.completed`; dev onboarding → Connect payout → `transfer.created`
   clears the held payout. Send a `charge.dispute.created` from the dashboard and
   confirm the campaign flips to `disputed` and a `chargeback` fraud event is
   recorded.
4. **Verify webhook delivery.** In the Stripe dashboard open *Webhooks →
   your endpoint → Recent deliveries* and confirm `200` status, plus that the
   signature timestamp tolerance (`parseStripeWebhook`) matches your clock.
5. **Switch to live keys.** In the same maintenance window replace the secret and
   webhook secret with `sk_live_*` / `whsec_*`, restart the server, and hit
   `GET /api/v1/health`. Keep `STRIPE_MODE=live` from here on — stub-mode payment
   simulation is no longer registered.
6. **Smoke-test one real checkout.** Run a $1 campaign with the live secret and a
   real card, confirm the campaign activates, then refund it and confirm the
   `refunded` transition.
7. **Monitor.** Watch `/api/v1/metrics` (checkout sessions, webhook events,
   payouts cleared), the request log for webhook `4xx/5xx`, and the Stripe
   dashboard's webhook failure page for 24h after cutover.

Webhook events to register: `checkout.session.completed`, `account.updated`,
`transfer.created`, `charge.dispute.created`, `charge.dispute.closed`,
`charge.refunded`. If your reverse proxy terminates TLS, Stripe must reach the
server on the webhook path (no IP allow-listing required; signatures are the
authenticator).

## 3. Developer sign-in (Google OAuth)

- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- In Google Cloud Console, add an authorized redirect URI:
  `https://<host>/api/v1/auth/google/callback`.
- The dashboard "Continue with Google" button routes through
  `GET /api/v1/auth/google/login`; the callback upserts the dev by Google `sub` and
  returns the session token in the URL fragment.

If either client id or secret is missing, both are unset — OAuth is disabled and the
email sign-in demo fallback remains.

## 4. Signed update publishing

- Set `ADMIN_TOKEN`. `POST /api/v1/updates/` (manifest) and
  `PUT /api/v1/updates/artifacts/:name` (artifact upload) require it.
- Publish via `server/scripts/publish-update.mjs`; clients verify the Ed25519
  signature over exactly `{ platform, version, url, sha256 }` before applying.
- Empty `ADMIN_TOKEN` means publishing is disabled (safe default; clients still
  fetch manifests but nothing can be published).

## 5. Relational database (Postgres) — implemented

The server has two native storage drivers behind one async data-access layer
(`server/src/db.ts`):

- **SQLite** (default, dev): `better-sqlite3`, synchronous, file-backed, zero ops.
  Data lives under `DATA_DIR`.
- **Postgres** (production): `pg`, async. Activate by setting `DATABASE_URL` —
  e.g. `DATABASE_URL=postgres://user:pass@host:5432/waitshare`. The driver loads
  `server/migrations/001_init.sql` at startup (idempotent DDL + indexes + the
  seeded 60/40 split contract); `PG_SCHEMA_PATH` overrides the schema file.

The schema and the SQL the app runs are identical across both drivers; the
Postgres driver translates positional `?` placeholders to `$n`. Timestamps are
epoch-millisecond `BIGINT`, ids are app-generated UUID/TEXT, and money is integer
mills — never floats.

Supporting artifacts:

- `server/migrations/001_init.sql` — authoritative Postgres DDL.
- `server/scripts/export-postgres.mjs` — one-time migration of an existing SQLite
  DB to portable SQL: `node server/scripts/export-postgres.mjs dump.sql`, then
  `psql $DATABASE_URL -f dump.sql`.
- The smoke suite runs against both drivers. Locally: `npm test -w server`
  (SQLite) and `DATABASE_URL=... npm test -w server` (Postgres). Unit tests
  (`npm run test:unit -w server`) cover the SQL translation layer, the
  risk-scoring helpers, the ASN/IPv6 classifier, and — in `test/webhook.mts` —
  Stripe webhook signature verification plus every campaign/payout transition
  the live webhook handlers perform. CI runs a dedicated Postgres job.

## 6. CI

`.github/workflows/ci.yml` runs on push to `main` and on PRs:

- `server` job: `npm ci`, typecheck, build, then `npm test -w server`
  (self-contained smoke test — spawns the server on a temp data dir and exercises
  auth → device key → campaign → serve → signed impression → payout → updates →
  tier-2/3 fraud signals → admin review).
- `server-postgres` job: same smoke test against a `postgres:15` service
  container via `DATABASE_URL`.
- `asn` job (push to `main` only): regenerates the cloud-IP dataset with
  `npm run build:asn -w server` and fails if the committed `server/assets/asn.json`
  is stale — a gate that keeps the dataset tracking provider range changes. A
  separate scheduled workflow (`.github/workflows/asn-refresh.yml`) opens a PR
  with the regenerated dataset when RIPE announce drift occurs, so the refresh
  is automated instead of failing CI.
- `web` job: `npm ci`, typecheck, build.
- `docker` job: validates `docker compose config` and builds the image with
  `docker build` — exercises the multi-stage Dockerfile (alpine + native deps)
  and the compose wiring without needing a local Docker daemon.
- `vscode` job: `npm ci` in `clients/vscode`, then typechecks and packages the
  extension (`vsce`). A separate tag-triggered `ovsx-publish` workflow publishes
  the extension to Open VSX when `OVSX_PAT` is configured.

The smoke test also runs locally: `npm test -w server`, or against a running
instance with `SMOKE_BASE_URL=http://localhost:3001/api/v1`.

Releases are fully automated by `.github/workflows/release.yml`. Pushing a
`v*` tag triggers it to: build the frontend, assemble `waitshare.zip` from the
tracked files (excluding `server/data/`), publish a GitHub Release with the zip
and auto-generated notes, then push a `release/<tag>` branch carrying the
force-added artifact, open a PR to `main`, and merge it. The PR step surfaces
failures via `::error::` instead of swallowing them, so a broken tag push is
visible in the Actions log.

## 7. Operational notes

- **One exposed port.** The web dev server proxies `/api` to the backend
  (`vite.config.ts`); in production, terminate TLS on a single host and route
  `/api/*` to the API and everything else to the dashboard, or serve the built
  dashboard statically behind the same origin. There is no cross-origin CORS
  surface in production if you do this.
- **Data directory.** `DATA_DIR` holds SQLite, the server Ed25519 key, and the
  fraud-hashing salt. Back it up; losing it invalidates update signatures and
  fleet-detection history.
- **Scaling.** Stateless API + stateful DB: put the SQLite file on persistent
  storage (single replica), or run with `DATABASE_URL` on managed Postgres for
  horizontal scale.
- **Cloud-IP data licensing.** `server/assets/asn.json` is assembled from the
  public cloud range files of AWS, Google, Microsoft, Oracle, and DigitalOcean
  (plus optional RIPE announced prefixes). Each source's ToS governs use; the
  dataset is for internal fraud/abuse classification only and is not redistributed
  as a product. Regenerate with `npm run build:asn -w server`; CI can do so where
  those providers are reachable.

## 8. Docker deployment

A multi-stage `Dockerfile` (Node 22) builds server + web and serves both from one
container; `docker-compose.yml` adds a managed Postgres 16 with health-gated
startup:

```bash
cp .env.example .env   # set POSTGRES_PASSWORD, ADMIN_TOKEN, STRIPE_* as needed
docker compose up -d --build
```

- The API listens on `:3001`; the built dashboard is served at `/` with an SPA
  fallback, so a single origin (plus TLS at your reverse proxy) serves the whole
  product.
- `DATA_DIR` and the Postgres volume are persisted; `SEED_DEMO=0` is forced in
  production and `STRIPE_MODE` defaults to `stub` so the container boots without
  keys.
- Health check: `GET /api/v1/health` (or `docker compose ps`).

## 9. Operations

- **Metrics.** `GET /api/v1/metrics` (requires `ADMIN_TOKEN` bearer) returns
  process counters (serves issued, impressions credited/rejected, fraud events,
  checkout sessions, webhook events, payouts cleared, uptime) plus DB-derived
  figures (active campaigns, pending payout mills, 24h impressions, flagged devs)
  and the locked split contract. Poll it into your monitoring system.
- **Request logging.** Every request (except `/health`) logs
  `METHOD path status duration-ms` to stdout — sufficient for access forensics;
  combine with structured platform logging if you need log shipping.
- **Rate limiting.** In-process fixed-window limiter per client IP. `POST /auth/*`
  is limited to 120 req/min and `GET /ads/next` to 120 req/min; over-limit returns
  `429` with `retryAfterMs`. `trust proxy` is set to one hop, so set it correctly
  behind your reverse proxy to get real client IPs.
- **Backups.** `npm run backup -w server` snapshots the datastore:
  `pg_dump | gzip` when `DATABASE_URL` is set, otherwise a `better-sqlite3` online
  backup of the SQLite file — both into `BACKUP_DIR` (default `<DATA_DIR>/backups`)
  with timestamped names. Restore with `npm run restore -w server -- <file>`:
  `.db` copies into `DATA_DIR`, `.sql`/`.sql.gz` pipes into `psql`. Stop the server
  before restoring. Schedule backups with your platform cron; the script never
  deletes old snapshots.
