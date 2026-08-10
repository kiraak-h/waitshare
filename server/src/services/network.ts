import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { config, ensureDataDir } from "../config.js"
import { classifyIp } from "./asn.js"
import type { Request } from "express"

const saltPath = path.join(ensureDataDir(), "fraud-salt")

function getSalt(): string {
  if (config.fraudSalt) return config.fraudSalt
  if (fs.existsSync(saltPath)) {
    return fs.readFileSync(saltPath, "utf8").trim()
  }
  const generated = crypto.randomBytes(32).toString("hex")
  fs.writeFileSync(saltPath, generated, { mode: 0o600 })
  return generated
}

export interface NetworkSignals {
  networkHash: string
  ipHash: string
  kind: string
  asnName?: string
}

export function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"]
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim()
  }
  return req.socket.remoteAddress ?? "unknown"
}

export function maskIp(ip: string): string {
  if (ip.includes(":")) {
    const parts = ip.split(":")
    const v6 = parts[parts.length - 1]
    if (v6.includes(".")) {
      const v4 = v6.split(".")
      return `${v4[0]}.${v4[1]}.${v4[2]}.0`
    }
    const chunks = ip.split("::")[0].split(":")
    return chunks.slice(0, 3).join(":") + "::/48"
  }
  const v4 = ip.split(".")
  return v4.length === 4 ? `${v4[0]}.${v4[1]}.${v4[2]}.0` : ip
}

function hashWithSalt(input: string): string {
  return crypto.createHash("sha256").update(getSalt()).update(":").update(input).digest("hex")
}

/**
 * Pluggable network classification. Returns "datacenter" | "residential" | "unknown".
 * Backed by a bundled ASN/cloud-range dataset (server/assets/asn.json, AWS + DigitalOcean);
 * supply your own dataset via ASN_DB_PATH (e.g. a GeoLite2-derived list) to extend coverage.
 */
export function classifyNetwork(ip: string): { kind: string; name?: string } {
  return classifyIp(ip)
}

export function deriveNetworkSignals(req: Request): NetworkSignals {
  const ip = getClientIp(req)
  const cls = classifyIp(ip)
  return {
    networkHash: hashWithSalt(maskIp(ip)),
    ipHash: hashWithSalt(ip),
    kind: cls.kind,
    asnName: cls.name,
  }
}

export function hashIpDirect(ip: string): string {
  return hashWithSalt(ip)
}
