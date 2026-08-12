import { useEffect, useState, type FormEvent } from "react"
import { api } from "../api"
import { formatDate, millsToDollars, timeAgo } from "../utils"

interface Overview {
  impressions: number
  grossMills: number
  devShareMills: number
  heldPayouts: number
}

interface ReviewDev {
  id: string
  email: string
  status: string
  fraudFlags: number
  trustTier: number
  impressions: number
  earnedCents: number
  createdAt: number
}

interface FraudEvent {
  id: number
  type: string
  devId: string | null
  reason: string
  createdAt: number
}

interface Review {
  devs: ReviewDev[]
  events: FraudEvent[]
}

export default function Admin() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("ws_admin_token"))
  const [overview, setOverview] = useState<Overview | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    if (!token) return
    setBusy(true)
    setErr(null)
    try {
      const [o, r] = await Promise.all([
        api<Overview>("/admin/overview", {}, token),
        api<Review>("/admin/review", {}, token),
      ])
      setOverview(o)
      setReview(r)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [token])

  function save(e: FormEvent) {
    e.preventDefault()
    localStorage.setItem("ws_admin_token", token ?? "")
    setMsg("Admin token saved. Reloading…")
    setToken(token)
    setMsg(null)
    void load()
  }

  async function act(devId: string, action: string) {
    if (!token) return
    setErr(null)
    try {
      await api(`/admin/review/${devId}`, { method: "POST", body: JSON.stringify({ action }) }, token)
      setMsg(`${action} applied to ${devId.slice(0, 8)}…`)
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  if (!token) {
    return (
      <div className="page narrow">
        <section className="hero-mini">
          <h1>Admin</h1>
          <p>Fraud review queue. Requires the server ADMIN_TOKEN.</p>
        </section>
        <form className="card form" onSubmit={save}>
          <label className="field">
            <span>Admin token</span>
            <input
              type="password"
              value={token ?? ""}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste ADMIN_TOKEN"
            />
          </label>
          <button className="btn btn-primary btn-block">Unlock</button>
          {err && <p className="error">{err}</p>}
        </form>
      </div>
    )
  }

  return (
    <div className="page narrow">
      <section className="hero-mini row-split">
        <div>
          <h1>Admin</h1>
          <p>Fraud review queue — {busy ? "loading…" : "live"}</p>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            localStorage.removeItem("ws_admin_token")
            setToken(null)
          }}
        >
          Lock
        </button>
      </section>

      {overview && (
        <div className="market-grid">
          <div className="market-cell">
            <span className="market-value">{overview.impressions.toLocaleString()}</span>
            <span className="market-label">Impressions</span>
          </div>
          <div className="market-cell">
            <span className="market-value">${millsToDollars(overview.grossMills)}</span>
            <span className="market-label">Gross (mills→$)</span>
          </div>
          <div className="market-cell">
            <span className="market-value">${millsToDollars(overview.devShareMills)}</span>
            <span className="market-label">Dev share (60%)</span>
          </div>
          <div className="market-cell">
            <span className="market-value">{overview.heldPayouts}</span>
            <span className="market-label">Held payouts</span>
          </div>
        </div>
      )}
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="error">{err}</p>}

      <section className="section">
        <h2 className="section-title">Flagged developers</h2>
        {!review || review.devs.length === 0 ? (
          <p className="muted">No flagged developers right now. Fraud events from all tiers show here.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Dev</th>
                  <th>Status</th>
                  <th className="num">Flags</th>
                  <th className="num">Tier</th>
                  <th className="num">Impr</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {review.devs.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div>{d.email}</div>
                      <div className="muted mono" title={formatDate(d.createdAt)}>
                        {d.id.slice(0, 8)}… · {timeAgo(d.createdAt)}
                      </div>
                    </td>
                    <td>
                      <span className={`badge badge-${d.status}`}>{d.status}</span>
                    </td>
                    <td className="num">{d.fraudFlags}</td>
                    <td className="num">{d.trustTier}</td>
                    <td className="num">{d.impressions}</td>
                    <td>
                      <div className="action-row">
                        <button className="btn btn-ghost btn-sm" onClick={() => act(d.id, "clear")}>
                          Clear
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => act(d.id, "review")}>
                          Review
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => act(d.id, "suspend")}>
                          Suspend
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <h2 className="section-title">Fraud events (last 7 days)</h2>
        {!review || review.events.length === 0 ? (
          <p className="muted">No fraud events recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {review.events.map((e) => (
                  <tr key={e.id}>
                    <td title={formatDate(e.createdAt)}>{timeAgo(e.createdAt)}</td>
                    <td>
                      <span className="mono">{e.type}</span>
                    </td>
                    <td className="muted">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
