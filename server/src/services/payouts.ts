import { db } from "../db.js"
import { config } from "../config.js"
import { payments } from "./payments.js"

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
  const due = db
    .prepare("SELECT * FROM payouts WHERE status = 'held' AND available_at IS NOT NULL AND available_at <= ?")
    .all(now) as PayoutRow[]

  let processed = 0
  let failed = 0

  for (const p of due) {
    if (payments.mode === "live") {
      const dev = db.prepare("SELECT stripe_account_id FROM devs WHERE id = ?").get(p.dev_id) as
        | { stripe_account_id: string | null }
        | undefined
      if (!dev?.stripe_account_id) {
        db.prepare("UPDATE payouts SET status = 'failed', cleared_at = ? WHERE id = ?").run(now, p.id)
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
        db.prepare("UPDATE payouts SET status = 'pending', stripe_transfer_id = ? WHERE id = ?").run(
          transfer.transferId,
          p.id
        )
        processed++
      } catch {
        failed++
      }
    } else {
      db.prepare("UPDATE payouts SET status = 'cleared', cleared_at = ? WHERE id = ?").run(now, p.id)
      db.prepare("UPDATE devs SET paid_mills = paid_mills + ? WHERE id = ?").run(p.amount_mills, p.dev_id)
      processed++
    }
  }

  return { processed, failed }
}

export function releaseReserves(): { releasedMills: number; devs: number } {
  const cutoff = Date.now() - config.reserveReleaseMs
  const rows = db
    .prepare(
      "SELECT id, dev_id, reserved_mills FROM impressions WHERE reserved_mills > 0 AND reserve_released_at IS NULL AND served_at <= ?"
    )
    .all(cutoff) as { id: string; dev_id: string; reserved_mills: number }[]

  if (rows.length === 0) return { releasedMills: 0, devs: 0 }

  const byDev = new Map<string, number>()
  for (const r of rows) {
    byDev.set(r.dev_id, (byDev.get(r.dev_id) ?? 0) + r.reserved_mills)
  }

  const now = Date.now()
  const markReleased = db.prepare("UPDATE impressions SET reserve_released_at = ? WHERE id = ?")
  const addBack = db.prepare(
    "UPDATE devs SET reserve_mills = reserve_mills - ?, balance_mills = balance_mills + ? WHERE id = ?"
  )

  let releasedMills = 0
  for (const r of rows) markReleased.run(now, r.id)
  for (const [devId, mills] of byDev) {
    addBack.run(mills, mills, devId)
    releasedMills += mills
  }

  return { releasedMills, devs: byDev.size }
}

export function startSweeper(): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const held = await processHeldPayouts()
      const reserve = releaseReserves()
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
