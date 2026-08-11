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
  (`npm run test:unit -w server`) cover the SQL translation layer and the
  risk-scoring helpers. CI runs a dedicated Postgres job.

## 6. CI

`.github/workflows/ci.yml` runs on push to `main` and on PRs:

- `server` job: `npm ci`, typecheck, build, then `npm test -w server`
  (self-contained smoke test — spawns the server on a temp data dir and exercises
  auth → device key → campaign → serve → signed impression → payout → updates →
  tier-2/3 fraud signals → admin review).
- `server-postgres` job: same smoke test against a `postgres:15` service
  container via `DATABASE_URL`.
- `asn` job: regenerates the cloud-IP dataset with `npm run build:asn -w server`
  and fails if the committed `server/assets/asn.json` is stale (keeps the
  dataset tracking provider range changes; run locally where RIPE Stat is
  unreachable and commit the result).
- `web` job: `npm ci`, typecheck, build.

The smoke test also runs locally: `npm test -w server`, or against a running
instance with `SMOKE_BASE_URL=http://localhost:3001/api/v1`.

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
