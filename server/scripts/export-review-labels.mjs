#!/usr/bin/env node
// Export labeled rows from the review queue for the risk-model trainer.
//
//   Postgres: DATABASE_URL=... node scripts/export-review-labels.mjs
//   SQLite:   DATA_DIR=... node scripts/export-review-labels.mjs
//
// Admin decisions become labels per dev (the latest action wins):
//   suspend -> 1 (bot), clear -> 0 (honest), review -> skipped.
// For each labeled dev, up to --per-dev impressions are re-scored with the
// same features the live risk model sees (mirrors server/src/services/scoring.ts
// extractFeatures) and written as CSV rows (7 features + label) to stdout, or
// to --out.
//
// Options:
//   --out <csv>    write to a file instead of stdout
//   --per-dev <n>  max impressions per dev (default 300)
//   --max-rows <n> overall row cap (default 20000)
import fs from "node:fs"
import path from "node:path"

const dataDir = process.env.DATA_DIR ?? path.resolve(import.meta.dirname, "../data")
const dbUrl = process.env.DATABASE_URL ?? ""

const args = process.argv.slice(2)
const outIdx = args.indexOf("--out")
const perDevIdx = args.indexOf("--per-dev")
const maxRowsIdx = args.indexOf("--max-rows")
const outPath = outIdx >= 0 ? args[outIdx + 1] : null
const perDev = perDevIdx >= 0 ? Number(args[perDevIdx + 1]) : 300
const maxRows = maxRowsIdx >= 0 ? Number(args[maxRowsIdx + 1]) : 20000

const FEATURES = ["regularity", "durationUniformity", "viewabilityUniformity", "rate", "networkScore", "flagScore", "youth"]
const WINDOW_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function clamp01(x) {
  return Math.max(0, Math.min(1, x))
}
function meanStd(values) {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}
function cv(values) {
  if (values.length < 3) return null
  const { mean, std } = meanStd(values)
  if (mean === 0) return null
  return std / mean
}

// Same normalization as server/src/services/scoring.ts extractFeatures.
function featuresFor(history, hourly, networks, fraudFlags, ageHours) {
  const durations = history.map((r) => r.duration_ms)
  const viewables = history.map((r) => r.viewable_pct)
  const durationCv = cv(durations)
  const viewabilityCv = cv(viewables)
  const sorted = [...history].sort((a, b) => a.served_at - b.served_at)
  const gaps = []
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].served_at - sorted[i - 1].served_at
    if (g > 0) gaps.push(g)
  }
  const gapCv = cv(gaps)
  return [
    gapCv === null ? 0.5 : clamp01(1 - gapCv / 0.5),
    durationCv === null ? 0.5 : clamp01(1 - durationCv / 0.4),
    viewabilityCv === null ? 0.5 : clamp01(1 - viewabilityCv / 0.3),
    clamp01(hourly / 60),
    clamp01(networks / 3),
    clamp01(fraudFlags / 5),
    clamp01(1 - ageHours / 24),
  ]
}

let rows = []
let q = null
let run = null

if (dbUrl) {
  const { default: pg } = await import("pg")
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  q = async (sql, params = []) => {
    let i = 0
    const res = await client.query(sql.replace(/\?/g, () => `$${++i}`), params)
    return res.rows
  }
  run = async () => client.end()
} else {
  const { default: Database } = await import("better-sqlite3")
  const raw = new Database(path.join(dataDir, "waitshare.db"), { readonly: true })
  q = async (sql, params = []) => raw.prepare(sql).all(...params)
  run = async () => raw.close()
}

try {
  const decisions = await q(
    "SELECT a.dev_id, a.action FROM admin_actions a " +
      "JOIN (SELECT dev_id, MAX(created_at) AS mx FROM admin_actions GROUP BY dev_id) m " +
      "ON a.dev_id = m.dev_id AND a.created_at = m.mx"
  )
  const labelOf = new Map()
  for (const d of decisions) {
    if (d.action === "suspend") labelOf.set(d.dev_id, 1)
    else if (d.action === "clear") labelOf.set(d.dev_id, 0)
  }
  console.error(`admin decisions: ${decisions.length} (labeled devs: ${labelOf.size})`)

  for (const devId of labelOf.keys()) {
    if (rows.length >= maxRows) break
    const label = labelOf.get(devId)
    const dev = await q("SELECT created_at, fraud_flags FROM devs WHERE id = ?", [devId])
    if (!dev.length) continue
    const devCreated = Number(dev[0].created_at)
    const fraudFlags = Number(dev[0].fraud_flags)

    const imps = await q(
      "SELECT device_id, duration_ms, viewable_pct, served_at, network_hash FROM impressions " +
        "WHERE dev_id = ? ORDER BY served_at ASC LIMIT ?",
      [devId, perDev * 4]
    )
    const byDevice = new Map()
    for (const imp of imps) {
      const arr = byDevice.get(imp.device_id) ?? []
      arr.push(imp)
      byDevice.set(imp.device_id, arr)
    }

    let written = 0
    for (const imp of imps) {
      if (written >= perDev || rows.length >= maxRows) break
      const device = byDevice.get(imp.device_id)
      const idx = device.indexOf(imp)
      const history = device.slice(0, idx).filter((r) => r.served_at < Number(imp.served_at)).slice(-50)
      if (history.length < 3) continue
      const hourly = device.filter((r) => Number(imp.served_at) - Number(r.served_at) <= HOUR_MS && Number(r.served_at) < Number(imp.served_at)).length
      const networks = new Set(
        device
          .filter((r) => r.network_hash && Number(imp.served_at) - Number(r.served_at) <= WINDOW_MS && Number(r.served_at) < Number(imp.served_at))
          .map((r) => r.network_hash)
      ).size
      const ageHours = (Number(imp.served_at) - devCreated) / HOUR_MS
      const features = featuresFor(history, hourly, networks, fraudFlags, ageHours)
      rows.push(features.map((v) => v.toFixed(4)).join(",") + `,${label}`)
      written++
    }
    console.error(`  dev ${devId.slice(0, 8)} label=${label} rows=${written}`)
  }
} finally {
  await run()
}

if (rows.length < 20) {
  console.error(`only ${rows.length} labeled rows exported; the trainer needs >= 20`)
}
const csv = FEATURES.join(",") + ",label\n" + rows.join("\n") + "\n"
if (outPath) {
  fs.writeFileSync(outPath, csv)
  console.error(`wrote ${rows.length} rows to ${outPath}`)
} else {
  process.stdout.write(csv)
  console.error(`exported ${rows.length} rows`)
}
