import { Router } from "express"
import fs from "node:fs"
import path from "node:path"
import { db } from "../db.js"
import { signJson, getServerPublicKeyB64, timingSafeEqualStr } from "../services/signing.js"
import { config, ensureDataDir } from "../config.js"
import { asyncHandler } from "../async-handler.js"

export const updatesRouter = Router()

const artifactDir = path.join(ensureDataDir(), "updates")
fs.mkdirSync(artifactDir, { recursive: true })

const SIGNED_FIELDS = ["platform", "version", "url", "sha256"] as const

function signedPayload(m: { platform: string; version: string; url: string; sha256: string }) {
  return { platform: m.platform, version: m.version, url: m.url, sha256: m.sha256 }
}

/** Numeric semver comparison; "1.2.3-beta" is treated as 1.2.3. Returns -1/0/1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

updatesRouter.get("/key", (_req, res) => {
  res.json({ algorithm: "Ed25519", publicKey: getServerPublicKeyB64() })
})

updatesRouter.get(
  "/latest",
  asyncHandler(async (req, res) => {
    const platform = String(req.query.platform ?? "")
    const version = String(req.query.version ?? "0")
    if (!platform) {
      res.status(400).json({ error: "platform required" })
      return
    }
    const manifest = await db.get<{
      platform: string
      version: string
      url: string
      sha256: string
      signature: string
      created_at: number
    }>("SELECT * FROM update_manifests WHERE platform = ?", [platform])

    if (!manifest) {
      res.json({ latest: null })
      return
    }

    const body = { ...signedPayload(manifest), createdAt: manifest.created_at }
    if (compareVersions(version, manifest.version) >= 0) {
      res.json({ latest: body, upToDate: true })
      return
    }

    res.json({
      latest: { ...body, signature: manifest.signature },
      upToDate: false,
      verification: {
        algorithm: "Ed25519",
        signedFields: SIGNED_FIELDS,
        publicKey: getServerPublicKeyB64(),
        note: "Clients verify the manifest signature over exactly {platform, version, url, sha256} against the WaitShare public key.",
      },
    })
  })
)

function requireAdmin(req: { headers: { authorization?: string } }): boolean {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "")
  return Boolean(config.adminToken && timingSafeEqualStr(token ?? "", config.adminToken))
}

updatesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req)) {
      res.status(401).json({ error: "admin token required" })
      return
    }
    const body = req.body as { platform?: string; version?: string; url?: string; sha256?: string }
    if (!body.platform || !body.version || !body.url || !body.sha256) {
      res.status(400).json({ error: "platform, version, url, sha256 required" })
      return
    }
    const payload = signedPayload(body as { platform: string; version: string; url: string; sha256: string })
    const signature = signJson(payload)
    await db.run(
      "INSERT INTO update_manifests (platform, version, url, sha256, signature, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(platform) DO UPDATE SET version = excluded.version, url = excluded.url, sha256 = excluded.sha256, signature = excluded.signature, created_at = excluded.created_at",
      [body.platform, body.version, body.url, body.sha256, signature, Date.now()]
    )

    res.json({ ok: true, signature })
  })
)

updatesRouter.get("/artifacts/:name", (req, res) => {
  const name = path.basename(String(req.params.name ?? ""))
  if (!name || name.includes("..")) {
    res.status(400).json({ error: "invalid artifact name" })
    return
  }
  const filePath = path.join(artifactDir, name)
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "artifact not found" })
    return
  }
  res.setHeader("content-type", "application/octet-stream")
  res.setHeader("content-disposition", `attachment; filename="${name}"`)
  fs.createReadStream(filePath).pipe(res)
})

updatesRouter.put("/artifacts/:name", (req, res) => {
  if (!requireAdmin(req)) {
    res.status(401).json({ error: "admin token required" })
    return
  }
  const name = path.basename(String(req.params.name ?? ""))
  if (!name || name.includes("..")) {
    res.status(400).json({ error: "invalid artifact name" })
    return
  }
  const chunks: Buffer[] = []
  req.on("data", (c: Buffer) => chunks.push(c))
  req.on("end", () => {
    fs.writeFileSync(path.join(artifactDir, name), Buffer.concat(chunks))
    res.json({ ok: true, name })
  })
  req.on("error", () => {
    res.status(500).json({ error: "upload failed" })
  })
})
