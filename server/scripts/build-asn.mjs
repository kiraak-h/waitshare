import fs from "node:fs"
import path from "node:path"

const outPath = process.argv[2] ?? path.resolve(import.meta.dirname, "../assets/asn.json")

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "waitshare-asn-builder/0.1" } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "waitshare-asn-builder/0.1" } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.text()
}

const entries = new Map()

async function aws() {
  const data = await fetchJson("https://ip-ranges.amazonaws.com/ip-ranges.json")
  const wanted = new Set(["EC2", "S3", "CLOUDFRONT", "GLOBALACCELERATOR"])
  for (const p of data.prefixes ?? []) {
    if (wanted.has(p.service)) {
      entries.set(p.ip_prefix, { cidr: p.ip_prefix, kind: "datacenter", name: "amazon" })
    }
  }
  for (const p of data.ipv6_prefixes ?? []) {
    if (wanted.has(p.service)) {
      entries.set(p.ipv6_prefix, { cidr: p.ipv6_prefix, kind: "datacenter", name: "amazon" })
    }
  }
  console.error(`aws: ${entries.size} total entries so far`)
}

async function digitalocean() {
  const csv = await fetchText("https://www.digitalocean.com/geo/google.csv")
  for (const line of csv.split("\n").slice(1)) {
    const parts = line.split(",")
    if (parts.length >= 1 && /^[0-9a-fA-F:.]+(?:\/\d+)?$/.test(parts[0].trim())) {
      const cidr = parts[0].trim()
      entries.set(cidr, { cidr, kind: "datacenter", name: "digitalocean" })
    }
  }
  console.error(`digitalocean: ${entries.size} total entries`)
}

await aws()
await digitalocean()

const sorted = [...entries.values()].sort((a, b) => a.cidr.localeCompare(b.cidr, undefined, { numeric: true }))
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), entries: sorted }, null, 0) + "\n")
console.error(`wrote ${sorted.length} entries to ${outPath}`)
