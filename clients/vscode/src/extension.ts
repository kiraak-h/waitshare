import * as vscode from "vscode"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { exec } from "node:child_process"

const SURFACE = "vscode"
const MIN_DURATION_MS = 10_000
const MAX_AUTO_MS = 120_000
const AUTO_TICK_MS = 5_000
const VERSION = "0.1.0"

const home = () => path.join(os.homedir(), ".waitshare")
const configPath = () => path.join(home(), "config.json")
const currentPath = () => path.join(home(), "current.json")
const autoPath = () => path.join(home(), "auto.json")
const downloadsDir = () => path.join(home(), "downloads")

interface Config {
  api: string
  token: string
  deviceId: string
  privateKeyB64: string
}

function loadConfig(): Config | null {
  try {
    if (!fs.existsSync(configPath())) return null
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Config
  } catch {
    return null
  }
}

function signPayload(payload: Record<string, unknown>, privateKeyB64: string): string {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  })
  return crypto.sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64")
}

function loadAuto(): boolean {
  try {
    return JSON.parse(fs.readFileSync(autoPath(), "utf8")).enabled !== false
  } catch {
    return true
  }
}

function saveAuto(enabled: boolean): void {
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(autoPath(), JSON.stringify({ enabled }))
}

async function fetchAd(config: Config): Promise<{ serveId: string; adLine: string; nonce: string } | null> {
  const res = await fetch(`${config.api}/ads/next?surface=${SURFACE}&deviceId=${encodeURIComponent(config.deviceId)}`, {
    headers: { authorization: `Bearer ${config.token}` },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { ad?: { serveId: string; adLine: string; nonce: string } }
  return body.ad ?? null
}

async function reportImpression(config: Config, focusMs: number, windowFocusedNow: boolean, lastFocusChange: number): Promise<string | null> {
  if (!fs.existsSync(currentPath())) return null
  const current = JSON.parse(fs.readFileSync(currentPath(), "utf8")) as {
    serveId: string
    startedAt: number
    nonce: string
  }
  fs.rmSync(currentPath(), { force: true })

  const durationMs = Date.now() - current.startedAt
  if (durationMs < MIN_DURATION_MS) return "too short"

  let accumulated = focusMs
  if (windowFocusedNow) accumulated += Date.now() - lastFocusChange
  const focusPct = Math.max(0, Math.min(100, Math.round((accumulated / durationMs) * 100)))

  const payload = {
    serveId: current.serveId,
    deviceId: config.deviceId,
    durationMs,
    viewablePct: 95,
    focusPct,
    nonce: current.nonce,
    ts: Date.now(),
  }
  const signature = signPayload(payload, config.privateKeyB64)
  const res = await fetch(`${config.api}/ads/impressions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, signature }),
  })
  const body = (await res.json()) as { credited?: boolean; devShareMills?: number; error?: string; reason?: string }
  return body.credited ? `credited ${body.devShareMills} mills` : body.error ?? String(res.status)
}

export function activate(context: vscode.ExtensionContext) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  bar.command = "waitshare.status"

  let watcher: fs.FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null

  let windowFocused = true
  let focusMs = 0
  let lastFocusChange = Date.now()

  const focusListener = vscode.window.onDidChangeWindowState((e) => {
    const now = Date.now()
    if (windowFocused && !e.focused) focusMs += now - lastFocusChange
    windowFocused = e.focused
    lastFocusChange = now
  })

  function render() {
    if (!fs.existsSync(currentPath())) {
      bar.hide()
      return
    }
    try {
      const current = JSON.parse(fs.readFileSync(currentPath(), "utf8")) as { adLine: string }
      bar.text = `$(megaphone) Sponsored · ${current.adLine}`
      bar.tooltip = "WaitShare — you keep 60% of this impression"
      bar.show()
    } catch {
      bar.hide()
    }
  }

  function watchCurrent() {
    try {
      watcher = fs.watch(home(), (event, filename) => {
        if (filename === "current.json") {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(render, 250)
        }
      })
    } catch {
      /* watcher unavailable */
    }
  }

  render()
  watchCurrent()

  let autoEnabled = loadAuto()
  let autoTimer: ReturnType<typeof setInterval> | null = null
  let reporting = false
  let lastAdAttempt = 0

  async function beginAd() {
    const cfg = loadConfig()
    if (!cfg) return
    const ad = await fetchAd(cfg)
    if (!ad) return
    fs.mkdirSync(home(), { recursive: true })
    focusMs = 0
    lastFocusChange = Date.now()
    windowFocused = vscode.window.state.focused
    fs.writeFileSync(currentPath(), JSON.stringify({ ...ad, startedAt: Date.now() }))
    render()
  }

  async function tick() {
    if (!autoEnabled || reporting) return
    const cfg = loadConfig()
    if (!cfg) return
    if (fs.existsSync(currentPath())) {
      try {
        const cur = JSON.parse(fs.readFileSync(currentPath(), "utf8")) as { startedAt: number }
        const elapsed = Date.now() - cur.startedAt
        if (elapsed >= MIN_DURATION_MS && (!vscode.window.state.focused || elapsed >= MAX_AUTO_MS)) {
          reporting = true
          try {
            await reportImpression(cfg, focusMs, vscode.window.state.focused, lastFocusChange)
            await beginAd()
          } finally {
            reporting = false
          }
        }
      } catch {
        /* transient errors are fine — next tick retries */
      }
    } else if (vscode.window.state.focused && Date.now() - lastAdAttempt >= 60_000) {
      lastAdAttempt = Date.now()
      await beginAd()
    }
  }

  autoTimer = setInterval(() => void tick(), AUTO_TICK_MS)

  const statusCmd = vscode.commands.registerCommand("waitshare.status", async () => {
    const config = loadConfig()
    if (!config) {
      vscode.window.showInformationMessage(
        "WaitShare is not configured. Run: node clients/shared/setup.mjs"
      )
      return
    }
    const state = fs.existsSync(currentPath())
      ? `showing sponsored line`
      : `idle (no active ad)`
    vscode.window.showInformationMessage(
      `WaitShare: ${state} · device ${config.deviceId.slice(0, 8)}… · auto-earn ${autoEnabled ? "on" : "off"}`
    )
  })

  const toggleAutoCmd = vscode.commands.registerCommand("waitshare.toggleAuto", () => {
    autoEnabled = !autoEnabled
    saveAuto(autoEnabled)
    vscode.window.showInformationMessage(`WaitShare: auto-earn ${autoEnabled ? "ON" : "OFF"}`)
  })

  const startCmd = vscode.commands.registerCommand("waitshare.start", async () => {
    if (!loadConfig()) return
    const hadAd = fs.existsSync(currentPath())
    await beginAd()
    if (!hadAd && !fs.existsSync(currentPath())) {
      vscode.window.showInformationMessage("WaitShare: no ads available on this surface right now")
    }
  })

  const reportCmd = vscode.commands.registerCommand("waitshare.report", async () => {
    const config = loadConfig()
    if (!config) return
    const result = await reportImpression(config, focusMs, windowFocused, lastFocusChange)
    render()
    vscode.window.showInformationMessage(`WaitShare: ${result ?? "no active impression"}`)
  })

  const verifyCmd = vscode.commands.registerCommand("waitshare.verifyUpdate", async () => {
    const config = loadConfig()
    if (!config) return
    try {
      const keyRes = await fetch(`${config.api}/updates/key`)
      const { publicKey } = (await keyRes.json()) as { publicKey: string }
      const manifestRes = await fetch(`${config.api}/updates/latest?platform=${SURFACE}&version=${VERSION}`)
      const manifest = (await manifestRes.json()) as {
        latest?: { platform: string; version: string; url: string; sha256: string; signature: string }
      }
      if (!manifest.latest) {
        vscode.window.showInformationMessage("WaitShare: no update manifest published yet")
        return
      }
      const { platform, version, url, sha256, signature } = manifest.latest
      const payload = { platform, version, url, sha256 }
      const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
      const valid = crypto.verify(
        null,
        Buffer.from(JSON.stringify(payload)),
        key,
        Buffer.from(signature, "base64")
      )
      vscode.window.showInformationMessage(
        `WaitShare: manifest ${version} signature ${valid ? "VERIFIED (Ed25519)" : "INVALID"}`
      )
    } catch (e) {
      vscode.window.showErrorMessage(`WaitShare: verification failed — ${String(e)}`)
    }
  })

  const updateCmd = vscode.commands.registerCommand("waitshare.update", async () => {
    const config = loadConfig()
    if (!config) return
    try {
      const keyRes = await fetch(`${config.api}/updates/key`)
      const { publicKey } = (await keyRes.json()) as { publicKey: string }
      const manifestRes = await fetch(`${config.api}/updates/latest?platform=${SURFACE}&version=${VERSION}`)
      const manifest = (await manifestRes.json()) as {
        upToDate?: boolean
        latest?: { platform: string; version: string; url: string; sha256: string; signature: string }
      }
      if (!manifest.latest) {
        vscode.window.showInformationMessage("WaitShare: no update manifest published yet")
        return
      }
      if (manifest.upToDate) {
        vscode.window.showInformationMessage("WaitShare: already up to date")
        return
      }
      const { platform, version, url, sha256, signature } = manifest.latest
      const payload = { platform, version, url, sha256 }
      const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
      if (!crypto.verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, "base64"))) {
        vscode.window.showErrorMessage("WaitShare: update manifest signature INVALID — refusing update")
        return
      }

      const artRes = await fetch(url)
      if (!artRes.ok) throw new Error(`download failed: ${artRes.status}`)
      const artifact = Buffer.from(await artRes.arrayBuffer())
      const hash = crypto.createHash("sha256").update(artifact).digest("hex")
      if (hash !== sha256) {
        vscode.window.showErrorMessage("WaitShare: artifact sha256 MISMATCH — refusing update")
        return
      }

      fs.mkdirSync(downloadsDir(), { recursive: true })
      const vsixPath = path.join(downloadsDir(), `waitshare-${version}.vsix`)
      fs.writeFileSync(vsixPath, artifact)
      vscode.window.showInformationMessage(
        `WaitShare: verified ${version} (Ed25519 + sha256). Installing…`
      )
      exec(`code --install-extension "${vsixPath}"`, (err) => {
        if (err) {
          vscode.window.showInformationMessage(
            `WaitShare: install manually with: code --install-extension "${vsixPath}"`
          )
          return
        }
        vscode.window.showInformationMessage("WaitShare: installed — reload VS Code to finish.")
      })
    } catch (e) {
      vscode.window.showErrorMessage(`WaitShare: update failed — ${String(e)}`)
    }
  })

  context.subscriptions.push(bar, statusCmd, toggleAutoCmd, startCmd, reportCmd, verifyCmd, updateCmd, focusListener, {
    dispose: () => {
      if (autoTimer) clearInterval(autoTimer)
      if (watcher) watcher.close()
      if (debounce) clearTimeout(debounce)
    },
  })
}

export function deactivate() {}
