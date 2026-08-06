import { db } from "../db.js"

export interface SplitContract {
  devShare: number
  platformShare: number
  version: number
  lockedAt: number
}

export function getSplitContract(): SplitContract {
  const row = db
    .prepare("SELECT dev_share, platform_share, version, locked_at FROM split_contract WHERE id = 1")
    .get() as { dev_share: number; platform_share: number; version: number; locked_at: number }
  return {
    devShare: row.dev_share,
    platformShare: row.platform_share,
    version: row.version,
    lockedAt: row.locked_at,
  }
}

export function devShareMills(grossMills: number): number {
  const { devShare } = getSplitContract()
  return Math.floor((grossMills * devShare) / 100)
}

export function platformShareMills(grossMills: number): number {
  const { platformShare } = getSplitContract()
  return Math.floor((grossMills * platformShare) / 100)
}

export function cpmToPerImpressionMills(cpmCents: number): number {
  return Math.floor((cpmCents * 1000) / 1000)
}
