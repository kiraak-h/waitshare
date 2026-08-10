import fs from "node:fs"
import { config } from "../config.js"

/**
 * Pluggable Tier-3 risk models. All models consume the same normalized 0-1
 * feature vector and return a 0-100 risk score (higher = riskier). The default
 * is the deterministic heuristic; a trained model can be supplied as JSON via
 * TIER3_MODEL_PATH and is loaded lazily on first use.
 */

export interface RiskFeatures {
  regularity: number
  durationUniformity: number
  viewabilityUniformity: number
  rate: number
  networkScore: number
  flagScore: number
  youth: number
}

export interface RiskModel {
  readonly name: string
  score(f: RiskFeatures): number
}

/** Deterministic weighted baseline (v0). Scores match scoreImpression() before the refactor. */
export class HeuristicModel implements RiskModel {
  readonly name = "heuristic-v0"
  score(f: RiskFeatures): number {
    return Math.round(
      100 *
        (0.2 * f.regularity +
          0.15 * f.durationUniformity +
          0.1 * f.viewabilityUniformity +
          0.2 * f.rate +
          0.1 * f.networkScore +
          0.15 * f.flagScore +
          0.1 * f.youth)
    )
  }
}

export interface TrainedModelJson {
  name: string
  features: (keyof RiskFeatures)[]
  weights: number[]
  intercept: number
}

export class LogisticModel implements RiskModel {
  readonly name: string
  private weights: number[]
  private intercept: number
  private features: (keyof RiskFeatures)[]

  constructor(data: TrainedModelJson) {
    this.name = data.name
    this.weights = data.weights
    this.intercept = data.intercept
    this.features = data.features
  }

  score(f: RiskFeatures): number {
    let z = this.intercept
    for (let i = 0; i < this.weights.length; i++) {
      z += this.weights[i] * f[this.features[i]]
    }
    const p = 1 / (1 + Math.exp(-z))
    return Math.round(p * 100)
  }
}

let cache: RiskModel | null = null

/** Load the configured model. Falls back to the deterministic heuristic. */
export function getRiskModel(): RiskModel {
  if (cache) return cache
  const modelPath = config.tier3.modelPath
  if (modelPath && fs.existsSync(modelPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(modelPath, "utf8")) as TrainedModelJson
      if (
        Array.isArray(parsed.features) &&
        Array.isArray(parsed.weights) &&
        parsed.features.length === parsed.weights.length &&
        typeof parsed.intercept === "number"
      ) {
        cache = new LogisticModel(parsed)
        return cache
      }
      console.warn(`[waitshare] TIER3_MODEL_PATH=${modelPath} is malformed; using heuristic model`)
    } catch (e) {
      console.warn(`[waitshare] failed to load TIER3_MODEL_PATH=${modelPath}: ${(e as Error).message}; using heuristic model`)
    }
  }
  cache = new HeuristicModel()
  return cache
}
