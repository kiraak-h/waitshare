import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import nodeCrypto from "node:crypto"

const CONFIG_PATH = path.join(os.homedir(), ".waitshare", "config.json")
const SURFACE = "opencode"
const MIN_DURATION_MS = 10_000
const AUTO_TICK_MS = 5_000
const MAX_AUTO_MS = 120_000
const VERSION = "0.1.0"

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function b64encode(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

async function signPayload(payload: Record<string, unknown>, privateKeyB64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    b64decode(privateKeyB64),
    { name: "Ed25519" },
    false,
    ["sign"]
  )
  const encoded = new TextEncoder().encode(JSON.stringify(payload))
  const data = new Uint8Array(new ArrayBuffer(encoded.byteLength))
  data.set(encoded)
  const sig = await crypto.subtle.sign(null, key, data)
  return b64encode(new Uint8Array(sig))
}

export const WaitSharePlugin = async ({ client }: { client: any }) => {
  let config: { api: string; token: string; deviceId: string; privateKeyB64: string } | null = null
  let active = false
  let serve: { serveId: string; adLine: string; nonce: string; startedAt: number } | null = null
  let sessionStartedAt: number | null = null
  let tickHandle: ReturnType<typeof setInterval> | null = null
  let ticking = false

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    }
  } catch (e) {
    console.error("[waitshare] could not load config:", e)
  }

  if (!config) {
    console.error(
      `[waitshare] not configured. Run: node clients/opencode/setup.mjs then reload opencode.`
    )
  }

  function stopTicker() {
    if (tickHandle) {
      clearInterval(tickHandle)
      tickHandle = null
    }
  }

  async function reportServe() {
    if (!config || !serve) return
    const { serveId, startedAt, nonce } = serve
    serve = null
    const durationMs = Date.now() - startedAt
    if (durationMs < MIN_DURATION_MS) return
    try {
      const payload = {
        serveId,
        deviceId: config.deviceId,
        durationMs,
        viewablePct: 95,
        focusPct: 100,
        nonce,
        ts: Date.now(),
      }
      const signature = await signPayload(payload, config.privateKeyB64)
      const res = await fetch(`${config.api}/ads/impressions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, signature }),
      })
      const body = await res.json()
      if (body?.credited) {
        await client?.app?.log?.({
          body: {
            service: "waitshare",
            level: "info",
            message: `credited ${body.devShareMills} mills for ${(durationMs / 1000).toFixed(0)}s of spinner`,
            extra: { impressionId: body.impressionId },
          },
        })
      } else {
        console.error("[waitshare] impression rejected:", body?.error, body?.reason ?? "")
      }
    } catch (e) {
      console.error("[waitshare] impression report failed:", e)
    }
  }

  async function fetchNext() {
    if (!config) return
    try {
      const res = await fetch(
        `${config.api}/ads/next?surface=${SURFACE}&deviceId=${encodeURIComponent(config.deviceId)}`,
        { headers: { authorization: `Bearer ${config.token}` } }
      )
      const body = await res.json()
      if (body?.ad) {
        serve = { serveId: body.ad.serveId, adLine: body.ad.adLine, nonce: body.ad.nonce, startedAt: Date.now() }
        await client?.app?.log?.({
          body: {
            service: "waitshare",
            level: "info",
            message: `Sponsored · ${body.ad.adLine}`,
            extra: { serveId: body.ad.serveId, surface: SURFACE },
          },
        })
      }
    } catch (e) {
      console.error("[waitshare] ad fetch failed:", e)
    }
  }

  async function startRun() {
    if (!config || active) return
    active = true
    await fetchNext()
    sessionStartedAt = Date.now()
    if (!tickHandle) {
      tickHandle = setInterval(async () => {
        if (!active || ticking) return
        ticking = true
        try {
          if (serve && Date.now() - serve.startedAt >= MIN_DURATION_MS && Date.now() - (sessionStartedAt ?? Date.now()) <= MAX_AUTO_MS) {
            await reportServe()
            if (active) await fetchNext()
          }
        } finally {
          ticking = false
        }
      }, AUTO_TICK_MS)
    }
  }

  async function endRun() {
    if (!config || !active) return
    active = false
    stopTicker()
    await reportServe()
  }

  function isRunning(event: any): boolean {
    const p = event?.properties ?? {}
    const status = String(p.status ?? "").toLowerCase()
    return (
      event?.type === "session.status" &&
      (status === "running" || status === "working" || status === "queued")
    )
  }

  function isIdle(event: any): boolean {
    const p = event?.properties ?? {}
    const status = String(p.status ?? "").toLowerCase()
    if (event?.type === "session.idle") return true
    return (
      event?.type === "session.status" &&
      (status === "idle" || status === "error" || status === "completed" || status === "paused")
    )
  }

  return {
    event: async ({ event }: { event: any }) => {
      try {
        if (isRunning(event)) await startRun()
        else if (isIdle(event)) await endRun()
      } catch (e) {
        console.error("[waitshare] event handling failed:", e)
      }
    },
  }
}

void checkForUpdateOnce()

async function checkForUpdateOnce() {
  try {
    let config: { api: string } | null = null
    if (fs.existsSync(CONFIG_PATH)) config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    if (!config) return
    const keyRes = await fetch(`${config.api}/updates/key`)
    const { publicKey } = await keyRes.json()
    const res = await fetch(`${config.api}/updates/latest?platform=${SURFACE}&version=${VERSION}`)
    const body = await res.json()
    if (!body?.latest || body?.upToDate) return
    const { platform, version, url, sha256, signature } = body.latest
    const payload = { platform, version, url, sha256 }
    const key = nodeCrypto.createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    })
    const valid = nodeCrypto.verify(
      null,
      Buffer.from(JSON.stringify(payload)),
      key,
      Buffer.from(signature, "base64")
    )
    if (valid) {
      console.log(`[waitshare] update available: ${version} (Ed25519 verified)`)
    } else {
      console.error(`[waitshare] update manifest signature INVALID for ${version}`)
    }
  } catch (e) {
    console.error("[waitshare] update check failed:", e)
  }
}
