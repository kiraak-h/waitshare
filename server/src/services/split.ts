import { db } from "../db.js"

export interface SplitContract {
  devShare: number
  platformShare: number
  version: number
  lockedAt: number
}

export async function getSplitContract(): Promise<SplitContract> {
  const row = (await db.get("SELECT dev_share, platform_share, version, locked_at FROM split_contract WHERE id = 1")) as {
    dev_share: number
    platform_share: number
    version: number
    locked_at: number
  }
  return {
    devShare: row.dev_share,
    platformShare: row.platform_share,
    version: row.version,
    lockedAt: row.locked_at,
  }
}

export async function devShareMills(grossMills: number): Promise<number> {
  const { devShare } = await getSplitContract()
  return Math.floor((grossMills * devShare) / 100)
}

export function cpmToPerImpressionMills(cpmCents: number): number {
  return Math.floor((cpmCents * 1000) / 1000)
}
