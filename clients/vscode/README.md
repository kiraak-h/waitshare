# WaitShare for VS Code

Get paid for waiting. WaitShare inserts a short sponsored line into your status
bar while your editor is idle, and pays you 60% of the ad revenue for every
fully-viewed impression — locked into the split contract. Privacy-first: only
activity-shape statistics (durations, cadence, network class) are sent, never
prompt, code, or file contents. IPs are salted and hashed before storage.

## Commands

- `WaitShare: Show status` — current balance, trust tier, auto-earn state.
- `WaitShare: Start sponsored line` — manually start one sponsored line now.
- `WaitShare: Toggle auto-earn` — enable/disable the background earn loop.
- `WaitShare: Report impression` — report a completed sponsored line.
- `WaitShare: Verify update signature` — verify the Ed25519 signature on a
  downloaded update manifest.
- `WaitShare: Update extension (verified)` — apply a signature-verified update.

## Auto-earn

When enabled (the default), the extension reports impressions as they finish
during idle periods, at least every 10 seconds and capped at 2 minutes per
session, then immediately fetches the next sponsored line. Your state is
persisted in `~/.waitshare/auto.json`. You can disable it at any time with
`WaitShare: Toggle auto-earn`.

## Configuration

Extension state lives under `~/.waitshare/`:

- `config.json` — `{ api, token, deviceId, privateKeyB64 }`. `api` is the
  server base URL (default `http://localhost:3001/api/v1`, override with
  `WAITSHARE_API` at setup time), `token` the session token from sign-in, and
  `privateKeyB64` the device signing key used to prove impressions.
- `current.json` — the sponsored line currently being viewed.
- `auto.json` — `{ enabled }` auto-earn toggle (persisted by
  `WaitShare: Toggle auto-earn`).
- `downloads/` — signature-verified update packages.

## Development

```bash
npm ci
npm run build     # tsc -> dist/
npm run package   # build + vsce package -> .vsix
```

Publishing to [Open VSX](https://open-vsx.org) happens automatically on `v*`
tags via the `ovsx-publish` workflow (requires the `OVSX_PAT` repository
secret). Manual: `OVSX_PAT=<token> npm run publish:ovsx`.

### Setting up Open VSX publishing (one-time)

1. Sign in to [open-vsx.org](https://open-vsx.org) with a GitHub account and
   claim the namespace **`waitshare`** (must match the `publisher` field in
   `package.json`).
2. In *Profile → Access Tokens*, create a token scoped to that namespace.
3. Add it to the GitHub repo as a secret named `OVSX_PAT`
   (Settings → Secrets and variables → Actions).
4. Tag a release (`git tag vX.Y.Z && git push origin vX.Y.Z`). The
   `ovsx-publish` workflow builds the `.vsix` and publishes it; if the secret
   is missing the job is skipped.
