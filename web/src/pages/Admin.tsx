import { useEffect, useMemo, useState, type FormEvent } from "react"
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
  fraudLabels: Record<string, number>
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
  total: number
}

interface DevTimeline {
  dev: ReviewDev
  events: FraudEvent[]
}

const PAGE = 50

export default function Admin() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("ws_admin_token"))
  const [overview, setOverview] = useState<Overview | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [filter, setFilter] = useState<string>("")
  const [offset, setOffset] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<DevTimeline | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    if (!token) return
    setBusy(true)
    setErr(null)
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
      if (filter) params.set("label", filter)
      const [o, r] = await Promise.all([
        api<Overview>("/admin/overview", {}, token),
        api<Review>(`/admin/review?${params.toString()}`, {}, token),
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
  }, [token, filter, offset])

  async function loadTimeline(devId: string) {
    if (!token) return
    setErr(null)
    try {
      const t = await api<DevTimeline>(`/admin/review/${devId}`, {}, token)
      setTimeline(t)
      setExpandedId(devId)
    } catch (e) {
      setErr(String(e))
    }
  }

  function save(e: FormEvent) {
    e.preventDefault()
    localStorage.setItem("ws_admin_token", token ?? "")
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

  const labelOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of review?.devs ?? []) {
      for (const [label, n] of Object.entries(d.fraudLabels ?? {})) {
        counts.set(label, (counts.get(label) ?? 0) + n)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [review])

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
        <div className="row-split">
          <h2 className="section-title">Flagged developers</h2>
          <div className="action-row">
            <label className="field-inline">
              <span className="muted">Label</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">all</option>
                {labelOptions.map(([label]) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">
              {review?.total ?? 0} devs
            </span>
          </div>
        </div>
        {!review || review.devs.length === 0 ? (
          <p className="muted">No flagged developers right now. Fraud events from all tiers show here.</p>
        ) : (
          <>
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
                    <FragmentRow
                      key={d.id}
                      dev={d}
                      expanded={expandedId === d.id}
                      timeline={expandedId === d.id ? timeline : null}
                      onExpand={() => (expandedId === d.id ? setExpandedId(null) : void loadTimeline(d.id))}
                      onAct={(a) => act(d.id, a)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {(review.total > PAGE || offset > 0) && (
              <div className="pager">
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                >
                  Prev
                </button>
                <span className="muted">
                  {offset + 1}–{Math.min(offset + PAGE, review.total)} of {review.total}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={offset + PAGE >= review.total}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  Next
                </button>
              </div>
            )}
          </>
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

function FragmentRow({
  dev,
  expanded,
  timeline,
  onExpand,
  onAct,
}: {
  dev: ReviewDev
  expanded: boolean
  timeline: DevTimeline | null
  onExpand: () => void
  onAct: (action: string) => void
}) {
  return (
    <>
      <tr>
        <td>
          <button className="btn btn-ghost btn-sm expander" onClick={onExpand}>
            {expanded ? "▾" : "▸"}
          </button>
          <div className="cell-inline">
            <div>{dev.email}</div>
            <div className="muted mono" title={formatDate(dev.createdAt)}>
              {dev.id.slice(0, 8)}… · {timeAgo(dev.createdAt)}
            </div>
          </div>
          {Object.entries(dev.fraudLabels ?? {}).map(([label, n]) => (
            <span key={label} className="badge badge-fraud">
              {label} ×{n}
            </span>
          ))}
        </td>
        <td>
          <span className={`badge badge-${dev.status}`}>{dev.status}</span>
        </td>
        <td className="num">{dev.fraudFlags}</td>
        <td className="num">{dev.trustTier}</td>
        <td className="num">{dev.impressions}</td>
        <td>
          <div className="action-row">
            <button className="btn btn-ghost btn-sm" onClick={() => onAct("clear")}>
              Clear
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => onAct("review")}>
              Review
            </button>
            <button className="btn btn-danger btn-sm" onClick={() => onAct("suspend")}>
              Suspend
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="timeline-row">
          <td colSpan={6}>
            <div className="timeline">
              {timeline && timeline.events.length === 0 && <p className="muted">No fraud events for this dev.</p>}
              {timeline?.events.map((e) => (
                <div key={e.id} className="timeline-item">
                  <span className="mono">{e.type}</span>
                  <span className="muted" title={formatDate(e.createdAt)}>
                    {timeAgo(e.createdAt)}
                  </span>
                  <span className="muted">{e.reason}</span>
                </div>
              ))}
              {!timeline && <p className="muted">Loading…</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
