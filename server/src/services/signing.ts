import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ensureDataDir } from "../config.js"

const keyPath = path.join(ensureDataDir(), "server-key.pem")

export function getServerKeyPair(): crypto.KeyObject {
  if (fs.existsSync(keyPath)) {
    const pem = fs.readFileSync(keyPath, "utf8")
    return crypto.createPrivateKey(pem)
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
  return privateKey
}

export function getServerPublicKeyB64(): string {
  const key = getServerKeyPair()
  const pub = crypto.createPublicKey(key)
  return pub.export({ type: "spki", format: "der" }).toString("base64")
}

export function signJson(payload: Record<string, unknown>): string {
  const key = getServerKeyPair()
  return crypto.sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64")
}

export function verifyJsonSignature(payload: Record<string, unknown>, signatureB64: string, pubkeyB64: string): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(pubkeyB64, "base64"),
      format: "der",
      type: "spki",
    })
    return crypto.verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signatureB64, "base64"))
  } catch {
    return false
  }
}

export function generateDeviceKeypair(): { publicKeyB64: string; privateKeyB64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyB64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  }
}

export function signWithDeviceKey(payload: Record<string, unknown>, privateKeyB64: string): string {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  })
  return crypto.sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64")
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest()
  const hb = crypto.createHash("sha256").update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}
