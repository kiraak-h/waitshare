import { signWithDeviceKey } from "../src/services/signing.js"

const BASE = "http://localhost:3001/api/v1"

async function main() {
  const email = `e2e-${Date.now()}@test.dev`
  const reg = await (await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, country: "US" }),
  })).json()
  const token = reg.token

  const device = await (await fetch(`${BASE}/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  })).json()
  const deviceId = device.deviceId
  const privKeyB64 = device.privateKey

  const next = await (await fetch(`${BASE}/ads/next?surface=opencode&deviceId=${deviceId}`, {
    headers: { authorization: `Bearer ${token}` },
  })).json()
  const serveId = next.ad.serveId
  const nonce = next.ad.nonce
  console.log("serveId:", serveId, "| adLine:", next.ad.adLine, "| nonce:", nonce.slice(0, 8))

  const payload = { serveId, deviceId, durationMs: 15000, viewablePct: 95, focusPct: 100, nonce, ts: Date.now() }
  const signature = signWithDeviceKey(payload, privKeyB64)

  const result = await (await fetch(`${BASE}/ads/impressions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, signature }),
  })).json()
  console.log("impression:", JSON.stringify(result))

  const me = await (await fetch(`${BASE}/dev/me`, { headers: { authorization: `Bearer ${token}` } })).json()
  console.log("dev balance cents:", me.dev.balanceCents, "| threshold:", me.thresholdCents)

  const ledger = await (await fetch(`${BASE}/ledger`)).json()
  console.log("ledger total devShareMills:", ledger.total.devShareMills)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
