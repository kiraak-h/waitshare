import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(serverDir, "package.json"))

async function api(base, p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    signal: opts.signal ?? AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  })
  let body = null
  try {
    body = await res.json()
  } catch {}
  return { status: res.status, body }
}

function sign(payload, privateKeyB64) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" })
  return crypto.sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64")
}

function sha256hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex")
}

const results = []
function record(name, pass, detail = "") {
  results.push({ name, pass })
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}

let child = null
let pgClient = null
let tdb = null
let base = process.env.SMOKE_BASE_URL
let dataDir = null
const local = !base

if (!base) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "waitshare-smoke-"))
  const port = Number(process.env.SMOKE_PORT ?? 3999)
  base = `http://localhost:${port}/api/v1`
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SEED_DEMO: "0",
      STRIPE_MODE: "stub",
      PAYMENT_THRESHOLD_CENTS: "1",
      ADMIN_TOKEN: "smoke-admin-token",
    },
    stdio: "ignore",
  })

  let healthy = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const r = await fetch(base + "/health")
      if (r.ok) {
        healthy = true
        break
      }
    } catch {}
  }
  if (!healthy) {
    console.error("FAIL  smoke: server did not become healthy")
    child.kill()
    process.exit(1)
  }
}

try {
  const health = await api(base, "/health")
  record("smoke: health endpoint", health.status === 200 && health.body.ok === true)

  const reg = await api(base, "/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: `smoke-${Date.now()}@test.dev`, country: "US" }),
  })
  record("smoke: register dev", reg.status === 200 && Boolean(reg.body.token), reg.status)
  const token = reg.body.token
  const devId = reg.body.devId

  const device = await api(base, "/auth/device", {
    method: "POST",
    body: JSON.stringify({ token }),
  })
  record("smoke: register device + keypair", device.status === 200 && Boolean(device.body.deviceId && device.body.privateKey), device.status)
  const deviceId = device.body.deviceId
  const privKey = device.body.privateKey

  const campaign = await api(base, "/advertiser/campaigns", {
    method: "POST",
    body: JSON.stringify({
      email: `smoke-adv-${Date.now()}@test.dev`,
      adLine: "Smoke test campaign",
      url: "https://example.com",
      surface: "opencode",
      cpmCents: 300,
      blocks: 10,
      deliverySpeed: "fast",
    }),
  })
  record("smoke: create campaign", campaign.status === 200 && Boolean(campaign.body.campaignId) && campaign.body.mode === "stub", campaign.status)
  const campaignId = campaign.body.campaignId

  const confirmed = await api(base, `/advertiser/campaigns/${campaignId}/confirm`, { method: "POST" })
  record("smoke: confirm campaign", confirmed.status === 200 && confirmed.body.status === "active", confirmed.status)

  const next = await api(base, `/ads/next?surface=opencode&deviceId=${deviceId}`)
  record("smoke: serve issued", next.status === 200 && Boolean(next.body.ad?.serveId && next.body.ad?.nonce), next.status)

  const canonical = { serveId: next.body.ad.serveId, deviceId, durationMs: 11000, viewablePct: 100, focusPct: 100, nonce: next.body.ad.nonce, ts: Date.now() }

  const tampered = await api(base, "/ads/impressions", {
    method: "POST",
    body: JSON.stringify({ ...canonical, durationMs: 9999, signature: sign(canonical, privKey) }),
  })
  record("smoke: tampered impression rejected (401)", tampered.status === 401, `${tampered.status} ${tampered.body?.error ?? ""}`)

  const shortSigned = { ...canonical, durationMs: 5000, signature: sign({ ...canonical, durationMs: 5000 }, privKey) }
  const shortRes = await api(base, "/ads/impressions", { method: "POST", body: JSON.stringify(shortSigned) })
  record("smoke: sub-min duration rejected (422)", shortRes.status === 422 && shortRes.body.reason === "duration below minimum", `${shortRes.status} ${shortRes.body?.reason ?? ""}`)

  const next2 = await api(base, `/ads/next?surface=opencode&deviceId=${deviceId}`)
  const canonical2 = { serveId: next2.body.ad.serveId, deviceId, durationMs: 11000, viewablePct: 100, focusPct: 100, nonce: next2.body.ad.nonce, ts: Date.now() }
  const honest = await api(base, "/ads/impressions", {
    method: "POST",
    body: JSON.stringify({ ...canonical2, signature: sign(canonical2, privKey) }),
  })
  record("smoke: honest impression credited", honest.status === 200 && honest.body.credited === true && honest.body.devShareMills === 180, `${honest.status} ${JSON.stringify(honest.body)}`)

  const me = await api(base, "/dev/me", { headers: { authorization: `Bearer ${token}` } })
  record("smoke: dev balance reflects credit", me.status === 200 && me.body.dev.balanceCents >= 1, `${me.status} balanceCents=${me.body.dev?.balanceCents}`)

  const payout = await api(base, "/dev/payout", { method: "POST", headers: { authorization: `Bearer ${token}` } })
  record("smoke: payout enters held", payout.status === 200 && payout.body.status === "held" && payout.body.amountMills > 0, `${payout.status} ${JSON.stringify(payout.body)}`)

  const updKey = await api(base, "/updates/key")
  record("smoke: update public key exposed", updKey.status === 200 && Boolean(updKey.body.publicKey), updKey.status)

  const updLatest = await api(base, "/updates/latest?platform=opencode&version=0.1.0")
  record("smoke: update latest responds (no manifest yet)", updLatest.status === 200 && updLatest.body.latest === null, `${updLatest.status} ${JSON.stringify(updLatest.body)}`)

  const split = await api(base, "/split/")
  record("smoke: split contract locked 60/40", split.status === 200 && split.body.split.devShare === 60 && split.body.split.platformShare === 40, `${split.status} ${JSON.stringify(split.body)}`)

  // tier4: advertiser chargeback lifecycle (stub payment-event simulation)
  const adv2Email = `smoke-adv2-${Date.now()}@test.dev`
  const dc = await api(base, "/advertiser/campaigns", {
    method: "POST",
    body: JSON.stringify({
      email: adv2Email,
      adLine: "Dispute sim campaign",
      url: "https://example.com",
      surface: "opencode",
      cpmCents: 99999,
      blocks: 5,
      deliverySpeed: "fast",
    }),
  })
  const disputeCampaignId = dc.body.campaignId
  await api(base, `/advertiser/campaigns/${disputeCampaignId}/confirm`, { method: "POST" })
  const beforeDispute = await api(base, "/ads/next?surface=opencode&deviceId=dispute-device-a")
  record(
    "tier4: highest-CPM active campaign serves before dispute",
    beforeDispute.status === 200 && beforeDispute.body.ad?.adLine === "Dispute sim campaign",
    `${beforeDispute.status} ${beforeDispute.body.ad?.adLine}`
  )
  const disputeEv = await api(base, `/advertiser/campaigns/${disputeCampaignId}/payment-event`, {
    method: "POST",
    body: JSON.stringify({ event: "dispute" }),
  })
  record("tier4: dispute flips campaign to disputed", disputeEv.status === 200 && disputeEv.body.status === "disputed", `${disputeEv.status} ${JSON.stringify(disputeEv.body)}`)
  const afterDispute = await api(base, "/ads/next?surface=opencode&deviceId=dispute-device-b")
  record(
    "tier4: disputed campaign stops serving (auction skips it)",
    afterDispute.status === 200 && Boolean(afterDispute.body.ad?.serveId) && afterDispute.body.ad?.adLine !== "Dispute sim campaign",
    `${afterDispute.status} ${afterDispute.body.ad?.adLine}`
  )
  const listD = await api(base, `/advertiser/campaigns?email=${encodeURIComponent(adv2Email)}`)
  record("tier4: advertiser list reflects disputed status", listD.body.campaigns?.[0]?.status === "disputed", `${listD.body.campaigns?.[0]?.status}`)
  const refundEv = await api(base, `/advertiser/campaigns/${disputeCampaignId}/payment-event`, {
    method: "POST",
    body: JSON.stringify({ event: "refund" }),
  })
  record("tier4: refund flips campaign to refunded", refundEv.status === 200 && refundEv.body.status === "refunded", `${refundEv.status} ${JSON.stringify(refundEv.body)}`)

  if (local) {
    const pgUrl = process.env.DATABASE_URL
    const seedImp = async (row) => {
      const sql = `INSERT INTO impressions (id, serve_id, campaign_id, dev_id, device_id, surface, duration_ms, viewable_pct, focus_pct, nonce, network_hash, ip_hash, served_at, gross_mills, dev_share_mills, reserved_mills, signature, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'credited')`
      const vals = [row.id, row.serveId, row.campaignId, row.devId, row.deviceId, "opencode", 11000, 100, 100, "seed", row.networkHash, row.networkHash, row.servedAt, 500, 300, 50, "seed"]
      if (pgUrl) {
        let i = 0
        await pgClient.query(sql.replace(/\?/g, () => `$${++i}`), vals)
      } else {
        tdb.prepare(sql).run(...vals)
      }
    }
    const seedDevUpdate = async (devId, fraudFlags, createdAt) => {
      if (pgUrl) {
        await pgClient.query("UPDATE devs SET fraud_flags = $1, created_at = $2 WHERE id = $3", [fraudFlags, createdAt, devId])
      } else {
        tdb.prepare("UPDATE devs SET fraud_flags = ?, created_at = ? WHERE id = ?").run(fraudFlags, createdAt, devId)
      }
    }
    const seedRow = (devId, deviceId, networkHash, servedAt) =>
      seedImp({ id: crypto.randomUUID(), serveId: crypto.randomUUID(), campaignId: crypto.randomUUID(), devId, deviceId, networkHash, servedAt })

    if (pgUrl) {
      const { default: pg } = await import("pg")
      pgClient = new pg.Client({ connectionString: pgUrl })
      await pgClient.connect()
    } else {
      const Database = require("better-sqlite3")
      tdb = new Database(path.join(dataDir, "waitshare.db"))
      tdb.pragma("journal_mode = WAL")
      tdb.pragma("busy_timeout = 5000")
    }

    // tier3: bot-shaped history → high risk score rejects the impression
    const botReg = await api(base, "/auth/register", { method: "POST", body: JSON.stringify({ email: `smoke-bot-${Date.now()}@test.dev` }) })
    const botDev = botReg.body.devId
    const botDevice = `bot-device-${Date.now()}`
    const now = Date.now()
    for (let i = 0; i < 50; i++) {
      await seedRow(botDev, botDevice, i % 2 === 0 ? "seed-network-a" : "seed-network-b", now - (50 - i) * 60_000)
    }
    await seedDevUpdate(botDev, 5, now - 8 * 24 * 60 * 60 * 1000)
    const botNext = await api(base, `/ads/next?surface=opencode&deviceId=${botDevice}`, { headers: { authorization: `Bearer ${botReg.body.token}` } })
    if (botNext.body.ad?.serveId) {
      const bc = { serveId: botNext.body.ad.serveId, deviceId: botDevice, durationMs: 11000, viewablePct: 100, focusPct: 100, nonce: botNext.body.ad.nonce, ts: Date.now() }
      const botImp = await api(base, "/ads/impressions", { method: "POST", body: JSON.stringify({ ...bc, signature: "demo" }) })
      record("tier3: high-risk impression rejected", botImp.status === 422 && String(botImp.body?.reason ?? "").includes("high risk score"), `${botImp.status} ${JSON.stringify(botImp.body)}`)
    } else {
      record("tier3: high-risk impression rejected", false, "no serve issued")
    }

    // tier3: new-account (trust tier 0) has reduced caps
    const freshReg = await api(base, "/auth/register", { method: "POST", body: JSON.stringify({ email: `smoke-fresh-${Date.now()}@test.dev` }) })
    const freshDev = freshReg.body.devId
    const freshDevice = `fresh-device-${Date.now()}`
    for (let i = 0; i < 21; i++) {
      await seedRow(freshDev, freshDevice, "fresh-network-hash", now - (21 - i) * 60_000)
    }
    const freshNext = await api(base, `/ads/next?surface=opencode&deviceId=${freshDevice}`, { headers: { authorization: `Bearer ${freshReg.body.token}` } })
    if (freshNext.body.ad?.serveId) {
      const fc = { serveId: freshNext.body.ad.serveId, deviceId: freshDevice, durationMs: 11000, viewablePct: 100, focusPct: 100, nonce: freshNext.body.ad.nonce, ts: Date.now() }
      const freshImp = await api(base, "/ads/impressions", { method: "POST", body: JSON.stringify({ ...fc, signature: "demo" }) })
      record("tier3: trust-tier-0 cap enforced", freshImp.status === 422 && freshImp.body.reason === "hourly cap reached", `${freshImp.status} ${JSON.stringify(freshImp.body)}`)
    } else {
      record("tier3: trust-tier-0 cap enforced", false, "no serve issued")
    }

    // admin review queue
    const noAuth = await api(base, "/admin/review")
    record("tier3: admin review requires token", noAuth.status === 401, `${noAuth.status}`)
    const review = await api(base, "/admin/review", { headers: { authorization: "Bearer smoke-admin-token" } })
    record("tier3: admin review lists flagged devs", review.status === 200 && review.body.devs.length > 0, `${review.status} devs=${review.body.devs?.length}`)
    const suspend = await api(base, `/admin/review/${botDev}`, { method: "POST", body: JSON.stringify({ action: "suspend" }), headers: { authorization: "Bearer smoke-admin-token" } })
    record("tier3: admin suspend", suspend.status === 200 && suspend.body.status === "suspended", `${suspend.status} ${JSON.stringify(suspend.body)}`)
    const suspendedNext = await api(base, "/ads/next?surface=opencode&deviceId=bot-device-2", { headers: { authorization: `Bearer ${botReg.body.token}` } })
    record("tier3: suspended dev cannot serve", suspendedNext.body.ad === null && String(suspendedNext.body.reason ?? "").includes("account"), `${JSON.stringify(suspendedNext.body)}`)
    const overview = await api(base, "/admin/overview", { headers: { authorization: "Bearer smoke-admin-token" } })
    record("tier3: admin overview", overview.status === 200 && overview.body.impressions > 0, `${overview.status} impressions=${overview.body.impressions}`)
  }

  const total = results.length
  const passed = results.filter((r) => r.pass).length
  console.log(`\n${passed}/${total} passed`)
  process.exitCode = passed === total ? 0 : 1
} catch (err) {
  console.error("smoke error:", err)
  process.exitCode = 1
} finally {
  if (pgClient) {
    try {
      await pgClient.end()
    } catch {}
  }
  if (tdb) {
    try {
      tdb.close()
    } catch {}
  }
  if (child) {
    child.kill()
  }
}
