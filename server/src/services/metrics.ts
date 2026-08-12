export type MetricKey =
  | "servesIssued"
  | "impressionsCredited"
  | "impressionsRejected"
  | "fraudEvents"
  | "checkoutSessions"
  | "webhookEvents"
  | "payoutsCleared"

const counters: Record<MetricKey, number> = {
  servesIssued: 0,
  impressionsCredited: 0,
  impressionsRejected: 0,
  fraudEvents: 0,
  checkoutSessions: 0,
  webhookEvents: 0,
  payoutsCleared: 0,
}

export const startedAt = Date.now()

export function inc(key: MetricKey, n = 1): void {
  counters[key] += n
}

export function snapshot(): Record<MetricKey, number> & { startedAt: number; uptimeSec: number } {
  return { ...counters, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }
}
