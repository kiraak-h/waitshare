import fs from "node:fs"
import path from "node:path"
import { config } from "../config.js"

interface AsnEntry {
  cidr: string
  kind: string
  name: string
}

interface V4Range {
  start: number
  end: number
  name: string
}

interface V6Range {
  start: bigint
  end: bigint
  name: string
}

interface LoadedDb {
  v4: V4Range[]
  v6: V6Range[]
  count: number
}

let cache: LoadedDb | null = null

function defaultDbPath(): string {
  return path.resolve(import.meta.dirname, "../../assets/asn.json")
}

function parseV4(cidr: string): { start: number; end: number } | null {
  const [ip, bitsRaw] = cidr.split("/")
  const octets = ip.split(".").map(Number)
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null
  const bits = bitsRaw ? Number(bitsRaw) : 32
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return null
  const raw = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  const start = raw & mask
  const end = bits === 0 ? 0xffffffff : start + ((1 << (32 - bits)) - 1)
  return { start, end }
}

function parseV6(cidr: string): { start: bigint; end: bigint } | null {
  const [ipPart, bitsRaw] = cidr.split("/")
  const bits = bitsRaw ? Number(bitsRaw) : 128
  const halves = ipPart.split("::")
  let hextets: number[] = []
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : []
    const right = halves[1] ? halves[1].split(":") : []
    const fill = 8 - left.length - right.length
    hextets = [...left.map((h) => parseInt(h || "0", 16)), ...Array(fill).fill(0), ...right.map((h) => parseInt(h || "0", 16))]
  } else {
    hextets = ipPart.split(":").map((h) => parseInt(h || "0", 16))
  }
  if (hextets.length !== 8 || hextets.some((h) => Number.isNaN(h))) return null
  let raw = 0n
  for (const h of hextets) raw = (raw << 16n) | BigInt(h)
  const mask = bits >= 128 ? 0n : bits <= 0 ? 0n : ~((1n << BigInt(128 - bits)) - 1n)
  const start = bits <= 0 ? 0n : raw & mask
  const end = bits >= 128 ? (1n << 128n) - 1n : start + ((1n << BigInt(128 - bits)) - 1n)
  return { start, end }
}

export function loadAsnDb(): LoadedDb {
  if (cache) return cache
  const dbPath = config.asnDbPath || defaultDbPath()
  if (!fs.existsSync(dbPath)) {
    cache = { v4: [], v6: [], count: 0 }
    return cache
  }
  let parsed: { entries?: AsnEntry[] }
  try {
    parsed = JSON.parse(fs.readFileSync(dbPath, "utf8"))
  } catch {
    cache = { v4: [], v6: [], count: 0 }
    return cache
  }
  const v4: V4Range[] = []
  const v6: V6Range[] = []
  for (const e of parsed.entries ?? []) {
    if (e.cidr.includes(":")) {
      const r = parseV6(e.cidr)
      if (r) v6.push({ ...r, name: e.name })
    } else {
      const r = parseV4(e.cidr)
      if (r) v4.push({ ...r, name: e.name })
    }
  }
  v4.sort((a, b) => a.start - b.start)
  v6.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  cache = { v4, v6, count: v4.length + v6.length }
  return cache
}

function ipv4ToInt(ip: string): number | null {
  const octets = ip.split(".").map(Number)
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function findV4(ranges: V4Range[], ip: number): string | null {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (ip < r.start) hi = mid - 1
    else if (ip > r.end) lo = mid + 1
    else return r.name
  }
  return null
}

function ipv6ToBigInt(ip: string): bigint | null {
  const parts = ip.split(":")
  if (parts.length !== 8) return null
  let v = 0n
  for (const p of parts) {
    const h = parseInt(p || "0", 16)
    if (Number.isNaN(h)) return null
    v = (v << 16n) | BigInt(h)
  }
  return v
}

function findV6(ranges: V6Range[], ip: bigint): string | null {
  for (const r of ranges) {
    if (ip < r.start) return null
    if (ip <= r.end) return r.name
  }
  return null
}

export interface IpClass {
  kind: "datacenter" | "residential" | "unknown"
  name?: string
}

export function classifyIp(ip: string): IpClass {
  if (!ip || ip === "unknown") return { kind: "unknown" }
  const db = loadAsnDb()
  const clean = ip.replace(/^::ffff:/, "")
  if (!clean.includes(":")) {
    const n = ipv4ToInt(clean)
    if (n === null) return { kind: "unknown" }
    const name = findV4(db.v4, n)
    return name ? { kind: "datacenter", name } : { kind: "residential" }
  }
  const n6 = ipv6ToBigInt(clean)
  if (n6 === null) return { kind: "unknown" }
  const name = findV6(db.v6, n6)
  return name ? { kind: "datacenter", name } : { kind: "residential" }
}
