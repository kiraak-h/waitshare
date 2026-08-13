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
