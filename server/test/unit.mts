import assert from "node:assert"
import { toPgSql } from "../src/db.js"
import { meanStd, cv, clamp01, extractFeatures } from "../src/services/scoring.js"
import { HeuristicModel, LogisticModel, getRiskModel } from "../src/services/risk-model.js"
import { parseV4, parseV6, ipv6ToBigInt, findV6 } from "../src/services/asn.js"

let passed = 0
let failed = 0

function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`PASS  unit: ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  unit: ${name}  (${(e as Error).message})`)
  }
}

// --- toPgSql ---------------------------------------------------------------
t("toPgSql: converts positional ? to $n in order", () => {
  assert.strictEqual(toPgSql("SELECT * FROM t WHERE a = ? AND b = ?"), "SELECT * FROM t WHERE a = $1 AND b = $2")
})
t("toPgSql: repeated ? renumber correctly", () => {
  assert.strictEqual(toPgSql("INSERT INTO t (a,b,c) VALUES (?,?,?) ON CONFLICT(a) DO UPDATE SET b = ?, c = ?"), "INSERT INTO t (a,b,c) VALUES ($1,$2,$3) ON CONFLICT(a) DO UPDATE SET b = $4, c = $5")
})
t("toPgSql: no placeholders is a no-op", () => {
  assert.strictEqual(toPgSql("SELECT 1"), "SELECT 1")
})
t("toPgSql: empty params still converts", () => {
  assert.strictEqual(toPgSql("SELECT * FROM t WHERE a = ?"), "SELECT * FROM t WHERE a = $1")
})

// --- meanStd / cv / clamp01 ------------------------------------------------
t("meanStd: empty returns zeros", () => {
  assert.deepStrictEqual(meanStd([]), { mean: 0, std: 0 })
})
t("meanStd: constant series has zero std", () => {
  assert.deepStrictEqual(meanStd([5, 5, 5]), { mean: 5, std: 0 })
})
t("cv: fewer than 3 samples is null", () => {
  assert.strictEqual(cv([]), null)
  assert.strictEqual(cv([1, 2]), null)
})
t("cv: constant series cv = 0", () => {
  assert.strictEqual(cv([10, 10, 10]), 0)
})
t("cv: varied series has positive cv", () => {
  assert.ok(cv([1, 2, 3])! > 0)
})
t("clamp01: clamps below and above", () => {
  assert.strictEqual(clamp01(-1), 0)
  assert.strictEqual(clamp01(2), 1)
  assert.strictEqual(clamp01(0.5), 0.5)
})

// --- extractFeatures --------------------------------------------------------
t("extractFeatures: empty history defaults to neutral 0.5", () => {
  const { features } = extractFeatures({ recent: [], hourly: 0, networks: 0, fraudFlags: 0, accountAgeHours: 72 })
  assert.strictEqual(features.regularity, 0.5)
  assert.strictEqual(features.durationUniformity, 0.5)
  assert.strictEqual(features.viewabilityUniformity, 0.5)
  assert.strictEqual(features.rate, 0)
})
t("extractFeatures: perfectly regular bot-ish series -> high regularity", () => {
  const recent = []
  const now = 1_000_000
  for (let i = 0; i < 10; i++) recent.push({ duration_ms: 11000, viewable_pct: 100, served_at: now - (10 - i) * 60_000 })
  const { features } = extractFeatures({ recent, hourly: 10, networks: 2, fraudFlags: 5, accountAgeHours: 0.5 })
  assert.ok(features.regularity > 0.95)
  assert.ok(features.durationUniformity > 0.95)
  assert.ok(features.flagScore >= 1)
})
t("extractFeatures: rate and network score clamp at 1", () => {
  const { features } = extractFeatures({ recent: [], hourly: 999, networks: 99, fraudFlags: 0, accountAgeHours: 24 })
  assert.strictEqual(features.rate, 1)
  assert.strictEqual(features.networkScore, 1)
})

// --- models -----------------------------------------------------------------
t("heuristic: all-clean features score lower than all-risky", () => {
  const h = new HeuristicModel()
  const clean = { regularity: 0, durationUniformity: 0, viewabilityUniformity: 0, rate: 0, networkScore: 0, flagScore: 0, youth: 0 }
  const risky = { regularity: 1, durationUniformity: 1, viewabilityUniformity: 1, rate: 1, networkScore: 1, flagScore: 1, youth: 1 }
  assert.ok(h.score(clean) < h.score(risky))
})
t("logistic: sigmoid math matches hand calculation", () => {
  const m = new LogisticModel({ name: "t", features: ["regularity", "durationUniformity", "viewabilityUniformity", "rate", "networkScore", "flagScore", "youth"], weights: [1, 0, 0, 0, 0, 0, 0], intercept: -2 })
  const f = { regularity: 0, durationUniformity: 0, viewabilityUniformity: 0, rate: 0, networkScore: 0, flagScore: 0, youth: 0 }
  assert.strictEqual(m.score(f), Math.round((1 / (1 + Math.exp(2))) * 100))
  assert.ok(m.score({ ...f, regularity: 1 }) > m.score(f))
})
t("logistic: monotone increasing in a positively-weighted feature", () => {
  const m = new LogisticModel({ name: "t", features: ["youth"], weights: [5], intercept: 0 })
  const base = { regularity: 0, durationUniformity: 0, viewabilityUniformity: 0, rate: 0, networkScore: 0, flagScore: 0, youth: 0 }
  const older = { ...base, youth: 0.2 }
  const younger = { ...base, youth: 0.9 }
  assert.ok(m.score(younger) > m.score(older))
})
t("getRiskModel: returns a cached singleton", () => {
  assert.strictEqual(getRiskModel(), getRiskModel())
})

// --- ASN parsing ------------------------------------------------------------
t("asn: parseV4 boundaries", () => {
  const r = parseV4("1.2.3.0/24")!
  assert.strictEqual(r.start, ((1 << 24) | (2 << 16) | (3 << 8) | 0) >>> 0)
  assert.strictEqual(r.end, r.start + 255)
})
t("asn: parseV4 /32 and full range", () => {
  assert.strictEqual(parseV4("10.0.0.1/32")!.start, parseV4("10.0.0.1/32")!.end)
  assert.strictEqual(parseV4("0.0.0.0/0")!.start, 0)
  assert.strictEqual(parseV4("0.0.0.0/0")!.end, 0xffffffff)
})
t("asn: parseV4 rejects malformed", () => {
  assert.strictEqual(parseV4("999.1.1.1/8"), null)
  assert.strictEqual(parseV4("1.2.3/8"), null)
  assert.strictEqual(parseV4("1.2.3.4/33"), null)
})
t("asn: parseV6 with :: compression", () => {
  const r = parseV6("2a00:1c68::/29")!
  assert.ok(r.start < r.end)
  assert.strictEqual(parseV6("::1/128")!.start, 1n)
  assert.strictEqual(parseV6("2001:db8::/32")!.start, 0x20010db8000000000000000000000000n)
})
t("asn: ipv6ToBigInt handles compressed addresses", () => {
  assert.strictEqual(ipv6ToBigInt("::1"), 1n)
  assert.strictEqual(ipv6ToBigInt("2a00:1c68::"), parseV6("2a00:1c68::/29")!.start)
  assert.strictEqual(ipv6ToBigInt("::ffff:7f00:1"), 0xffff7f000001n)
  assert.strictEqual(ipv6ToBigInt("2a00:1c68:0:0:0:0:0:1"), 0x2a001c68000000000000000000000001n)
})
t("asn: findV6 binary search matches range", () => {
  const ranges = [
    { start: 10n, end: 20n, name: "a" },
    { start: 50n, end: 60n, name: "b" },
    { start: 100n, end: 200n, name: "c" },
  ]
  assert.strictEqual(findV6(ranges, 15n), "a")
  assert.strictEqual(findV6(ranges, 55n), "b")
  assert.strictEqual(findV6(ranges, 150n), "c")
  assert.strictEqual(findV6(ranges, 1n), null)
  assert.strictEqual(findV6(ranges, 21n), null)
  assert.strictEqual(findV6(ranges, 500n), null)
})

console.log(`\n${passed}/${passed + failed} unit checks passed`)
process.exitCode = failed === 0 ? 0 : 1
