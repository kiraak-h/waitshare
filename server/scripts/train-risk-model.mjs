import fs from "node:fs"
import path from "node:path"

/**
 * Trains a logistic-regression risk model and writes the weights to
 * server/assets/risk-model.json.
 *
 * Data source:
 * - `--data <csv>` — real labeled rows exported from the review queue. CSV must
 *   have a header row containing the 7 feature columns (regularity,
 *   durationUniformity, viewabilityUniformity, rate, networkScore, flagScore,
 *   youth) plus a `label` column (0 = honest, 1 = bot).
 * - otherwise — synthetic samples drawn from the honest and bot distributions
 *   described in docs/FRAUD.md (placeholder until real labels exist).
 *
 * Output JSON shape: { name, features, weights, intercept }
 */

const FEATURES = ["regularity", "durationUniformity", "viewabilityUniformity", "rate", "networkScore", "flagScore", "youth"]

const args = process.argv.slice(2)
const dataIdx = args.indexOf("--data")
const dataPath = dataIdx >= 0 ? args[dataIdx + 1] : null
const outIdx = args.indexOf("--out")
const outPath = outIdx >= 0 ? args[outIdx + 1] : path.resolve(import.meta.dirname, "../assets/risk-model.json")

function gaussian(mean, std) {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x))
}

function loadCsv(file) {
  const text = fs.readFileSync(file, "utf8")
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const header = lines[0].split(",").map((s) => s.trim())
  const featIdx = FEATURES.map((f) => header.indexOf(f))
  if (featIdx.some((i) => i < 0)) throw new Error(`CSV must contain columns: ${FEATURES.join(", ")}`)
  const labelIdx = header.indexOf("label")
  if (labelIdx < 0) throw new Error('CSV must contain a "label" column (0 = honest, 1 = bot)')
  const rows = lines.slice(1)
  if (rows.length < 20) throw new Error(`need at least 20 labeled rows, got ${rows.length}`)
  return rows.map((line) => {
    const parts = line.split(",").map((s) => s.trim())
    return {
      x: featIdx.map((i) => clamp01(Number(parts[i]))),
      y: Number(parts[labelIdx]) === 1 ? 1 : 0,
    }
  })
}

function honestSample() {
  const gapCv = gaussian(0.7, 0.2)
  const durCv = gaussian(0.3, 0.1)
  const viewCv = gaussian(0.25, 0.08)
  const hourly = 60 * Math.random() * 0.4
  const networks = 1 + Math.floor(Math.random() * 2)
  const fraudFlags = Math.random() < 0.95 ? 0 : 1
  const ageHours = 72 + Math.random() * 2000
  return [
    clamp01(1 - gapCv / 0.5),
    clamp01(1 - durCv / 0.4),
    clamp01(1 - viewCv / 0.3),
    clamp01(hourly / 60),
    clamp01(networks / 3),
    clamp01(fraudFlags / 5),
    clamp01(1 - ageHours / 24),
  ]
}

function botSample() {
  const gapCv = gaussian(0.1, 0.05)
  const durCv = gaussian(0.05, 0.03)
  const viewCv = gaussian(0.05, 0.03)
  const hourly = 60 * (0.6 + Math.random() * 0.4)
  const networks = 3 + Math.floor(Math.random() * 6)
  const fraudFlags = 2 + Math.floor(Math.random() * 9)
  const ageHours = Math.random() * 12
  return [
    clamp01(1 - gapCv / 0.5),
    clamp01(1 - durCv / 0.4),
    clamp01(1 - viewCv / 0.3),
    clamp01(hourly / 60),
    clamp01(networks / 3),
    clamp01(fraudFlags / 5),
    clamp01(1 - ageHours / 24),
  ]
}

let samples
if (dataPath) {
  samples = loadCsv(dataPath)
  console.error(`loaded ${samples.length} labeled rows from ${dataPath}`)
} else {
  const N = 3000
  samples = []
  for (let i = 0; i < N; i++) {
    samples.push({ x: honestSample(), y: 0 })
    samples.push({ x: botSample(), y: 1 })
  }
  console.error(`no --data given; training on ${samples.length} synthetic samples`)
}

for (let i = samples.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1))
  ;[samples[i], samples[j]] = [samples[j], samples[i]]
}

const split = Math.floor(samples.length * 0.8)
const train = samples.slice(0, split)
const test = samples.slice(split)

const D = FEATURES.length
let w = new Array(D).fill(0)
let b = 0
const lr = 0.5
const lambda = 0.01
const epochs = 3000

function predict(x) {
  let z = b
  for (let i = 0; i < D; i++) z += w[i] * x[i]
  return 1 / (1 + Math.exp(-z))
}

for (let e = 0; e < epochs; e++) {
  const gw = new Array(D).fill(0)
  let gb = 0
  for (const { x, y } of train) {
    const p = predict(x)
    const err = p - y
    for (let i = 0; i < D; i++) gw[i] += err * x[i]
    gb += err
  }
  for (let i = 0; i < D; i++) {
    w[i] -= lr * ((gw[i] / train.length) + lambda * w[i])
  }
  b -= lr * (gb / train.length)
}

let tp = 0
let tn = 0
let fp = 0
let fn = 0
let honestScores = 0
let botScores = 0
for (const { x, y } of test) {
  const s = predict(x) * 100
  if (y === 1) botScores += s
  else honestScores += s
  if (s >= 75) {
    if (y === 1) tp++
    else fp++
  } else {
    if (y === 1) fn++
    else tn++
  }
}
const nTest = test.length
const nHonest = test.filter((t) => t.y === 0).length || 1
const nBot = test.filter((t) => t.y === 1).length || 1
console.log(`accuracy: ${((tp + tn) / nTest).toFixed(3)}`)
console.log(`confusion @75: tp=${tp} fp=${fp} tn=${tn} fn=${fn}`)
console.log(`mean risk score honest=${(honestScores / nHonest).toFixed(1)} bot=${(botScores / nBot).toFixed(1)}`)
console.log("weights:", w.map((v) => v.toFixed(3)).join(" "))
console.log("intercept:", b.toFixed(3))

const model = { name: `logistic-${new Date().toISOString().slice(0, 10)}`, features: FEATURES, weights: w, intercept: b }
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(model, null, 2) + "\n")
console.error(`wrote ${outPath}`)
