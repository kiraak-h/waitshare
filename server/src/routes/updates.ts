import { Router } from "express"
import { db } from "../db.js"
import { signJson, getServerPublicKeyB64 } from "../services/signing.js"

export const updatesRouter = Router()

updatesRouter.get("/key", (_req, res) => {
  res.json({ algorithm: "Ed25519", publicKey: getServerPublicKeyB64() })
})

updatesRouter.get("/latest", (req, res) => {
  const platform = String(req.query.platform ?? "")
  const version = String(req.query.version ?? "0")
  if (!platform) {
    res.status(400).json({ error: "platform required" })
    return
  }
  const manifest = db.prepare("SELECT * FROM update_manifests WHERE platform = ?").get(platform) as
    | { platform: string; version: string; url: string; sha256: string; signature: string; created_at: number }
    | undefined

  if (!manifest) {
    res.json({ latest: null })
    return
  }

  const body = { platform, version: manifest.version, url: manifest.url, sha256: manifest.sha256, createdAt: manifest.created_at }
  if (version === manifest.version) {
    res.json({ latest: body, upToDate: true })
    return
  }

  res.json({
    latest: { ...body, signature: manifest.signature },
    upToDate: false,
    verification: {
      algorithm: "Ed25519",
      publicKey: null,
      note: "Clients verify the manifest signature against the WaitShare public key bundled in each client.",
    },
  })
})

updatesRouter.post("/", (req, res) => {
  const body = req.body as { platform?: string; version?: string; url?: string; sha256?: string }
  if (!body.platform || !body.version || !body.url || !body.sha256) {
    res.status(400).json({ error: "platform, version, url, sha256 required" })
    return
  }
  const payload = { platform: body.platform, version: body.version, url: body.url, sha256: body.sha256 }
  const signature = signJson(payload)
  db.prepare(
    "INSERT INTO update_manifests (platform, version, url, sha256, signature, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(platform) DO UPDATE SET version = excluded.version, url = excluded.url, sha256 = excluded.sha256, signature = excluded.signature, created_at = excluded.created_at"
  ).run(body.platform, body.version, body.url, body.sha256, signature, Date.now())

  res.json({ ok: true, signature })
})
