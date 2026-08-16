#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as updater from "../shared/updater.mjs"

const HOME = process.env.WAITSHARE_HOME ?? path.join(os.homedir(), ".waitshare")
const CONFIG_PATH = path.join(HOME, "config.json")
const CURRENT_PATH = path.join(HOME, "current.json")
const SURFACE = "claude-code-cli"
const MIN_DURATION_MS = 10_000
const AUTO_TICK_MS = 5_000
const MAX_AUTO_MS = 120_000
const VERSION = "0.1.0"

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

  const durationMs = Date.now() - current.startedAt
  if (durationMs < MIN_DURATION_MS) {
    fs.rmSync(CURRENT_PATH, { force: true })
    return
  }

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
    // Keep current.json so a later report can retry; the server dedupes by serveId.
    console.error("[waitshare] report failed:", e.message)
    return
  }

  // Only clear the file if it still describes the serve we just reported.
  try {
    const live = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"))
    if (live.serveId === current.serveId) fs.rmSync(CURRENT_PATH, { force: true })
  } catch {
    /* already gone */
  }
}

async function autoEarn() {
  const startedAt = Date.now()
  console.error(`[waitshare] auto-earn running for up to ${MAX_AUTO_MS / 1000}s (Ctrl-C to stop)`)
  while (Date.now() - startedAt <= MAX_AUTO_MS) {
    if (fs.existsSync(CURRENT_PATH)) {
      const current = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"))
      if (Date.now() - current.startedAt >= MIN_DURATION_MS) {
        await report()
        await start()
      }
    } else {
      await start()
    }
    await new Promise((r) => setTimeout(r, AUTO_TICK_MS))
  }
  console.error("[waitshare] auto-earn session cap reached")
}

async function update() {
  const config = readConfig()
  try {
    const result = await updater.checkForUpdate({
      api: config.api,
      platform: SURFACE,
      currentVersion: VERSION,
    })
    if (!result.available) {
      console.error("[waitshare] already up to date")
      return
    }
    updater.applyArtifact(new URL(import.meta.url).pathname, result.artifact)
    console.error(
      `[waitshare] updated ${SURFACE} to ${result.latest.version} (Ed25519 + sha256 verified)`
    )
  } catch (e) {
    console.error(`[waitshare] update failed: ${e.message}`)
  }
}

const cmd = process.argv[2]
if (cmd === "start") await start()
else if (cmd === "status") status()
else if (cmd === "report") await report()
else if (cmd === "auto") await autoEarn()
else if (cmd === "update") await update()
else {
  console.error("usage: waitshare.mjs <start|status|report|auto|update>")
  process.exit(1)
}
