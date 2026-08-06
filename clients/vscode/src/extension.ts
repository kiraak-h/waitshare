import * as vscode from "vscode"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SURFACE = "vscode"
const MIN_DURATION_MS = 10_000

const home = () => path.join(os.homedir(), ".waitshare")
const configPath = () => path.join(home(), "config.json")
const currentPath = () => path.join(home(), "current.json")

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
    vscode.window.showInformationMessage(`WaitShare: ${state} · device ${config.deviceId.slice(0, 8)}…`)
  })

  const startCmd = vscode.commands.registerCommand("waitshare.start", async () => {
    const config = loadConfig()
    if (!config) return
    const ad = await fetchAd(config)
    if (!ad) {
      vscode.window.showInformationMessage("WaitShare: no ads available on this surface right now")
      return
    }
    fs.mkdirSync(home(), { recursive: true })
    focusMs = 0
    lastFocusChange = Date.now()
    windowFocused = vscode.window.state.focused
    fs.writeFileSync(currentPath(), JSON.stringify({ ...ad, startedAt: Date.now() }))
    render()
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
      const manifestRes = await fetch(`${config.api}/updates/latest?platform=${SURFACE}&version=0`)
      const manifest = (await manifestRes.json()) as {
        latest?: { platform: string; version: string; url: string; sha256: string; signature: string }
      }
      if (!manifest.latest) {
        vscode.window.showInformationMessage("WaitShare: no update manifest published yet")
        return
      }
      const { signature, ...rest } = manifest.latest
      const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
      const valid = crypto.verify(
        null,
        Buffer.from(JSON.stringify(rest)),
        key,
        Buffer.from(signature, "base64")
      )
      vscode.window.showInformationMessage(
        `WaitShare: manifest ${manifest.latest.version} signature ${valid ? "VERIFIED (Ed25519)" : "INVALID"}`
      )
    } catch (e) {
      vscode.window.showErrorMessage(`WaitShare: verification failed — ${String(e)}`)
    }
  })

  context.subscriptions.push(bar, statusCmd, startCmd, reportCmd, verifyCmd, focusListener, {
    dispose: () => {
      if (watcher) watcher.close()
      if (debounce) clearTimeout(debounce)
    },
  })
}

export function deactivate() {}
