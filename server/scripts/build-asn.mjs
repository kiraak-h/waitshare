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

function add(cidr, name) {
  if (typeof cidr !== "string" || !cidr.includes("/")) return
  if (!entries.has(cidr)) entries.set(cidr, { cidr, kind: "datacenter", name })
}

function log(label) {
  console.error(`${label}: ${entries.size} total entries`)
}

async function aws() {
  const data = await fetchJson("https://ip-ranges.amazonaws.com/ip-ranges.json")
  const wanted = new Set(["EC2", "S3", "CLOUDFRONT", "GLOBALACCELERATOR"])
  for (const p of data.prefixes ?? []) if (wanted.has(p.service)) add(p.ip_prefix, "amazon")
  for (const p of data.ipv6_prefixes ?? []) if (wanted.has(p.service)) add(p.ipv6_prefix, "amazon")
  log("aws")
}

async function gcp() {
  const data = await fetchJson("https://www.gstatic.com/ipranges/cloud.json")
  for (const p of data.prefixes ?? []) {
    if (p.ipv4Prefix) add(p.ipv4Prefix, "google")
    if (p.ipv6Prefix) add(p.ipv6Prefix, "google")
  }
  log("gcp")
}

async function azure() {
  const page = await fetchText("https://www.microsoft.com/en-us/download/confirmation.aspx?id=56519")
  const m = page.match(/https:\/\/download\.microsoft\.com\/download\/[^"']+ServiceTags_[^"']+\.json/)
  if (!m) throw new Error("azure: could not locate ServiceTags json url")
  const data = await fetchJson(m[0])
  for (const v of data.values ?? []) {
    for (const prefix of v.properties?.addressPrefixes ?? []) add(prefix, "microsoft")
  }
  log("azure")
}

async function oracle() {
  const data = await fetchJson("https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json")
  for (const region of data.regions ?? []) {
    for (const c of region.cidrs ?? []) add(c.cidr, "oracle")
  }
  log("oracle")
}

async function ripe(asn, name) {
  const data = await fetchJson(`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`)
  for (const p of data.data?.prefixes ?? []) add(p.prefix, name)
  log(`ripe-as${asn} (${name})`)
}

async function digitalocean() {
  const csv = await fetchText("https://www.digitalocean.com/geo/google.csv")
  for (const line of csv.split("\n").slice(1)) {
    const parts = line.split(",")
    if (parts.length >= 1 && /^[0-9a-fA-F:.]+(?:\/\d+)?$/.test(parts[0].trim())) add(parts[0].trim(), "digitalocean")
  }
  log("digitalocean")
}

const cloudAsns = [
  [14061, "digitalocean"],
  [24940, "hetzner"],
  [63949, "akamai-linode"],
  [20473, "vultr"],
  [16276, "ovh"],
  [12876, "scaleway"],
  [8560, "ionos"],
  [16265, "leaseweb"],
  [16509, "amazon"],
  [15169, "google"],
  [8075, "microsoft"],
  [31898, "oracle"],
  [13335, "cloudflare"],
  [54113, "fastly"],
  [60068, "datacamp"],
  [36352, "colocrossing"],
]

const sources = [
  ["aws", aws],
  ["gcp", gcp],
  ["azure", azure],
  ["oracle", oracle],
  ["digitalocean", digitalocean],
  ...cloudAsns.map(([asn, name]) => [`ripe-as${asn}`, () => ripe(asn, name)]),
]

for (const [label, fn] of sources) {
  try {
    await fn()
  } catch (e) {
    console.error(`WARN: ${label} failed, skipped: ${e?.message ?? e}`)
  }
}

const sorted = [...entries.values()].sort((a, b) => a.cidr.localeCompare(b.cidr, undefined, { numeric: true }))
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), entries: sorted }, null, 0) + "\n")
console.error(`wrote ${sorted.length} entries to ${outPath}`)
