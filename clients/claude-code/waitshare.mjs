#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = process.env.WAITSHARE_HOME ?? path.join(os.homedir(), ".waitshare")
const CONFIG_PATH = path.join(HOME, "config.json")
const CURRENT_PATH = path.join(HOME, "current.json")
const SURFACE = "claude-code-cli"
const MIN_DURATION_MS = 10_000

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("WaitShare not configured. Run: node clients/shared/setup.mjs")
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
}

function signPayload(payload, privateKeyB64) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  })
  return crypto.sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64")
}

async function fetchAd(config) {
  const res = await fetch(
    `${config.api}/ads/next?surface=${SURFACE}&deviceId=${encodeURIComponent(config.deviceId)}`,
    { headers: { authorization: `Bearer ${config.token}` } }
  )
  if (!res.ok) return null
  const body = await res.json()
  if (!body?.ad) return null
  return { serveId: body.ad.serveId, adLine: body.ad.adLine, nonce: body.ad.nonce }
}

async function start() {
  const config = readConfig()
  try {
    const ad = await fetchAd(config)
    if (!ad) return
    fs.writeFileSync(CURRENT_PATH, JSON.stringify({ ...ad, startedAt: Date.now() }, null, 2))
  } catch (e) {
    console.error("[waitshare] start failed:", e.message)
  }
}

function status() {
  if (!fs.existsSync(CURRENT_PATH)) {
    process.stdout.write("")
    return
  }
  const current = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"))
  if (Date.now() - current.startedAt > 90_000) {
    process.stdout.write("")
    return
  }
  process.stdout.write(`Sponsored · ${current.adLine}`)
}

async function report() {
  const config = readConfig()
  if (!fs.existsSync(CURRENT_PATH)) return
  const current = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"))
  fs.rmSync(CURRENT_PATH, { force: true })

  const durationMs = Date.now() - current.startedAt
  if (durationMs < MIN_DURATION_MS) return

  try {
    const payload = {
      serveId: current.serveId,
      deviceId: config.deviceId,
      durationMs,
      viewablePct: 95,
      focusPct: 100,
      nonce: current.nonce,
      ts: Date.now(),
    }
    const signature = signPayload(payload, config.privateKeyB64)
    const res = await fetch(`${config.api}/ads/impressions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature }),
    })
    const body = await res.json()
    if (body?.credited) {
      console.error(`[waitshare] credited ${body.devShareMills} mills for ${Math.round(durationMs / 1000)}s`)
    } else {
      console.error(`[waitshare] rejected: ${body?.error ?? res.status} ${body?.reason ?? ""}`)
    }
  } catch (e) {
    console.error("[waitshare] report failed:", e.message)
  }
}

const cmd = process.argv[2]
if (cmd === "start") await start()
else if (cmd === "status") status()
else if (cmd === "report") await report()
else {
  console.error("usage: waitshare.mjs <start|status|report>")
  process.exit(1)
}
