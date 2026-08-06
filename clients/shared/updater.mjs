import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function canonicalPayload(m) {
  return { platform: m.platform, version: m.version, url: m.url, sha256: m.sha256 }
}

function verifySignature(publicKeyB64, payload, signatureB64) {
  const key = crypto.createPublicKey({
    key: Buffer.from(publicKeyB64, "base64"),
    format: "der",
    type: "spki",
  })
  return crypto.verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signatureB64, "base64"))
}

function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

export async function checkForUpdate({ api, platform, currentVersion }) {
  const keyRes = await fetch(`${api}/updates/key`)
  if (!keyRes.ok) throw new Error(`failed to fetch update key: ${keyRes.status}`)
  const { publicKey } = await keyRes.json()

  const res = await fetch(`${api}/updates/latest?platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(currentVersion)}`)
  if (!res.ok) throw new Error(`failed to check for updates: ${res.status}`)
  const body = await res.json()
  if (!body.latest) return { available: false }
  if (body.upToDate) return { available: false, upToDate: true }

  const latest = body.latest
  const payload = canonicalPayload(latest)
  if (!verifySignature(publicKey, payload, latest.signature)) {
    throw new Error("update manifest signature INVALID — refusing update")
  }

  const artRes = await fetch(latest.url)
  if (!artRes.ok) throw new Error(`failed to download artifact: ${artRes.status}`)
  const artifact = Buffer.from(await artRes.arrayBuffer())
  if (sha256hex(artifact) !== latest.sha256) {
    throw new Error("artifact sha256 MISMATCH — refusing update")
  }

  return { available: true, latest, artifact }
}

export function applyArtifact(targetPath, artifact) {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, artifact)
  fs.renameSync(tmp, targetPath)
  try {
    fs.chmodSync(targetPath, 0o755)
  } catch {
    /* permissions not critical */
  }
  return targetPath
}

export { sha256hex }
