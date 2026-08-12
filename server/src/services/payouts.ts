import { db } from "../db.js"
import { config } from "../config.js"
import { payments } from "./payments.js"
import { inc } from "./metrics.js"

export interface PayoutRow {
  id: string
  dev_id: string
  amount_mills: number
  status: string
  stripe_transfer_id: string | null
  available_at: number | null
  created_at: number
  cleared_at: number | null
}

export async function processHeldPayouts(): Promise<{ processed: number; failed: number }> {
  const now = Date.now()
  const due = await db.all<PayoutRow>(
    "SELECT * FROM payouts WHERE status = 'held' AND available_at IS NOT NULL AND available_at <= ?",
    [now]
  )

  let processed = 0
  let failed = 0

  for (const p of due) {
    if (payments.mode === "live") {
      const dev = await db.get<{ stripe_account_id: string | null }>("SELECT stripe_account_id FROM devs WHERE id = ?", [
        p.dev_id,
      ])
      if (!dev?.stripe_account_id) {
        await db.run("UPDATE payouts SET status = 'failed', cleared_at = ? WHERE id = ?", [now, p.id])
        failed++
        continue
      }
      try {
        const transfer = await payments.createTransfer({
          devId: p.dev_id,
          accountId: dev.stripe_account_id,
          amountCents: Math.floor(p.amount_mills / 100),
          metadata: { payoutId: p.id },
        })
        await db.run("UPDATE payouts SET status = 'pending', stripe_transfer_id = ? WHERE id = ?", [
          transfer.transferId,
          p.id,
        ])
        processed++
      } catch {
        failed++
      }
    } else {
      await db.run("UPDATE payouts SET status = 'cleared', cleared_at = ? WHERE id = ?", [now, p.id])
      await db.run("UPDATE devs SET paid_mills = paid_mills + ? WHERE id = ?", [p.amount_mills, p.dev_id])
      inc("payoutsCleared")
      processed++
    }
  }

  return { processed, failed }
}

export async function releaseReserves(): Promise<{ releasedMills: number; devs: number }> {
  const cutoff = Date.now() - config.reserveReleaseMs
  const rows = await db.all<{ id: string; dev_id: string; reserved_mills: number }>(
    "SELECT id, dev_id, reserved_mills FROM impressions WHERE reserved_mills > 0 AND reserve_released_at IS NULL AND served_at <= ?",
    [cutoff]
  )

  if (rows.length === 0) return { releasedMills: 0, devs: 0 }

  const byDev = new Map<string, number>()
  for (const r of rows) {
    byDev.set(r.dev_id, (byDev.get(r.dev_id) ?? 0) + r.reserved_mills)
  }

  const now = Date.now()
  for (const r of rows) {
    await db.run("UPDATE impressions SET reserve_released_at = ? WHERE id = ?", [now, r.id])
  }

  let releasedMills = 0
  for (const [devId, mills] of byDev) {
    await db.run("UPDATE devs SET reserve_mills = reserve_mills - ?, balance_mills = balance_mills + ? WHERE id = ?", [
      mills,
      mills,
      devId,
    ])
    releasedMills += mills
  }

  return { releasedMills, devs: byDev.size }
}

export function startSweeper(): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const held = await processHeldPayouts()
      const reserve = await releaseReserves()
      if (held.processed > 0 || held.failed > 0 || reserve.devs > 0) {
        console.log(
          `[waitshare] payout sweep: held→ ${held.processed} (${held.failed} failed), reserves released: ${reserve.releasedMills} mills across ${reserve.devs} dev(s)`
        )
      }
    } catch (e) {
      console.error("[waitshare] payout sweep failed:", e)
    }
  }
  tick()
  return setInterval(tick, config.sweepIntervalMs)
}
