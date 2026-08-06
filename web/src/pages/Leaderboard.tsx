import { useEffect, useState } from "react"
import { api } from "../api"
import {
  centsToDollars,
  formatNumber,
  millsToDollars,
  type AuctionStateDto,
  type LedgerDto,
} from "../utils"

export default function Leaderboard() {
  const [ledger, setLedger] = useState<LedgerDto | null>(null)
  const [auction, setAuction] = useState<AuctionStateDto | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [l, a] = await Promise.all([
          api<LedgerDto>("/ledger"),
          api<AuctionStateDto>("/auction/state"),
        ])
        if (!alive) return
        setLedger(l)
        setAuction(a)
      } catch {
        /* ignore */
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const surfaces = ["opencode", "claude-code-cli", "vscode", "terminal"]

  return (
    <div className="page">
      <section className="hero-mini">
        <h1>Transparency ledger</h1>
        <p>
          Every campaign, every CPM, every impression. The split is computed publicly from the
          locked contract — no "estimated" language, no hidden fees.
        </p>
      </section>

      <section className="section">
        <h2 className="section-title">Market price by surface</h2>
        <div className="market-grid">
          {surfaces.map((s) => (
            <div className="market-cell" key={s}>
              <span className="market-value">
                {auction?.surfaceCpm[s] ? `$${centsToDollars(auction.surfaceCpm[s])}` : "—"}
              </span>
              <span className="market-label">per 1k imps · {s}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Campaign ledger</h2>
        {!ledger ? (
          <p className="muted">Loading…</p>
        ) : ledger.entries.length === 0 ? (
          <p className="muted">No campaigns yet — be the first to claim the spinner.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Ad line</th>
                    <th>Surface</th>
                    <th className="num">CPM</th>
                    <th className="num">Served</th>
                    <th className="num">Dev share (recent)</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.entries.map((e) => (
                    <tr key={e.campaignId}>
                      <td>{e.brand}</td>
                      <td className="mono">{e.adLine}</td>
                      <td>{e.surface}</td>
                      <td className="num">${centsToDollars(e.cpmCents)}</td>
                      <td className="num">
                        {formatNumber(e.served)} / {formatNumber(e.bought)}
                      </td>
                      <td className="num">${millsToDollars(e.devShareMills)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>Totals (recent)</td>
                    <td className="num">{formatNumber(ledger.total.served)}</td>
                    <td className="num">${millsToDollars(ledger.total.devShareMills)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="muted">
              Dev share is computed as floor(gross × 60 / 100) per impression at credit time.
              Ledger covers recent activity.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
