import { useEffect, useState, type FormEvent } from "react"
import { api } from "../api"
import { formatDate, millsToDollars, timeAgo } from "../utils"

interface DevMe {
  dev: {
    id: string
    email: string
    country: string | null
    status: string
    balanceCents: number
    reserveCents: number
    totalEarnedCents: number
    paidCents: number
    stripeOnboarded: boolean
    createdAt: number
  }
  thresholdCents: number
  paymentMode: string
}

interface Payout {
  id: string
  amountMills: number
  status: string
  availableAt: number | null
  createdAt: number
  clearedAt: number | null
}

interface Earnings {
  earnings: {
    id: string
    surface: string
    durationMs: number
    viewablePct: number
    servedAt: number
    grossMills: number
    devShareMills: number
    status: string
    adLine: string
    url: string
  }[]
}

export default function Dashboard() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("ws_token"))
  const [email, setEmail] = useState("")
  const [me, setMe] = useState<DevMe | null>(null)
  const [earnings, setEarnings] = useState<Earnings | null>(null)
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [deviceProof, setDeviceProof] = useState<string | null>(null)

  useEffect(() => {
    const m = window.location.hash.match(/^#ws_token=([^&]+)/)
    if (m) {
      const t = decodeURIComponent(m[1])
      localStorage.setItem("ws_token", t)
      window.location.hash = ""
      setToken(t)
    }
  }, [])

  useEffect(() => {
    if (!token) return
    setBusy(true)
    Promise.all([
      api<DevMe>("/dev/me", {}, token),
      api<Earnings>("/dev/earnings", {}, token),
      api<{ payouts: Payout[] }>("/dev/payouts", {}, token),
    ])
      .then(([m, e, p]) => {
        setMe(m)
        setEarnings(e)
        setPayouts(p.payouts)
      })
      .catch(() => {
        localStorage.removeItem("ws_token")
        setToken(null)
      })
      .finally(() => setBusy(false))
  }, [token])

  async function signIn(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const r = await api<{ token: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email }),
      })
      localStorage.setItem("ws_token", r.token)
      setToken(r.token)
    } catch (err) {
      setErr(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function registerDevice() {
    if (!token) return
    try {
      const r = await api<{ deviceId: string; publicKey: string; proof: string }>("/auth/device", {
        method: "POST",
        body: JSON.stringify({ token }),
      })
      localStorage.setItem("ws_device", JSON.stringify(r))
      setDeviceProof(`device ${r.deviceId.slice(0, 8)}… registered — signed proof verified by server`)
    } catch (err) {
      setErr(String(err))
    }
  }

  async function onboarding() {
    if (!token) return
    try {
      const r = await api<{ url: string; mode: string }>("/dev/onboarding", { method: "POST" }, token)
      window.open(r.url, "_blank")
      setMsg(`Onboarding link opened (${r.mode} mode).`)
    } catch (err) {
      setErr(String(err))
    }
  }

  async function payout() {
    if (!token) return
    setErr(null)
    setMsg(null)
    try {
      const r = await api<{
        payoutId: string
        amountMills: number
        status: string
        availableAt: number
        holdMs: number
        onboardingUrl?: string
      }>("/dev/payout", { method: "POST" }, token)
      if (r.onboardingUrl) {
        window.open(r.onboardingUrl, "_blank")
        setMsg("Complete Stripe onboarding first — a link was opened.")
      } else {
        setMsg(
          `Payout ${r.payoutId.slice(0, 8)}… ${r.status} — $${(r.amountMills / 100000).toFixed(2)} clears after ${(r.holdMs / 3600000).toFixed(1)}h.`
        )
        const p = await api<{ payouts: Payout[] }>("/dev/payouts", {}, token)
        setPayouts(p.payouts)
      }
    } catch (err) {
      setErr(String(err))
    }
  }

  function signOut() {
    localStorage.removeItem("ws_token")
    setToken(null)
    setMe(null)
    setEarnings(null)
  }

  if (!token) {
    return (
      <div className="page narrow">
        <section className="hero-mini">
          <h1>Start earning</h1>
          <p>Sign in with your email. Install a client surface, and earnings accrue as you code.</p>
        </section>
        <form className="card form" onSubmit={signIn}>
          <button
            type="button"
            className="btn btn-google btn-block"
            onClick={() => (window.location.href = "/api/v1/auth/google/login")}
          >
            Continue with Google
          </button>
          <div className="form-divider">
            <span>or use an email</span>
          </div>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Signing in…" : "Sign in / create account"}
          </button>
          {err && <p className="error">{err}</p>}
          <p className="muted">
            Google OAuth verifies your identity; email sign-in is a demo fallback. No card, no cost.
          </p>
        </form>
      </div>
    )
  }

  const dev = me?.dev

  return (
    <div className="page narrow">
      <section className="hero-mini row-split">
        <div>
          <h1>Dashboard</h1>
          <p>{dev?.email}</p>
        </div>
        <button className="btn btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </section>

      {busy ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="market-grid">
            <div className="market-cell">
              <span className="market-value">${((dev?.balanceCents ?? 0) / 100).toFixed(2)}</span>
              <span className="market-label">Available balance</span>
            </div>
            <div className="market-cell">
              <span className="market-value">${((dev?.reserveCents ?? 0) / 100).toFixed(2)}</span>
              <span className="market-label">Held in reserve</span>
            </div>
            <div className="market-cell">
              <span className="market-value">${((dev?.totalEarnedCents ?? 0) / 100).toFixed(2)}</span>
              <span className="market-label">Lifetime earned</span>
            </div>
            <div className="market-cell">
              <span className="market-value">${((dev?.paidCents ?? 0) / 100).toFixed(2)}</span>
              <span className="market-label">Paid out</span>
            </div>
            <div className="market-cell">
              <span className="market-value">
                {dev ? `${Math.max(0, (me?.thresholdCents ?? 1000) - dev.balanceCents)}c` : "—"}
              </span>
              <span className="market-label">Left to threshold ($10)</span>
            </div>
          </div>

          <div className="card action-row">
            <button className="btn btn-primary" onClick={registerDevice}>
              Register device key (demo)
            </button>
            <button className="btn btn-ghost" onClick={onboarding}>
              {dev?.stripeOnboarded ? "Stripe connected" : "Start Stripe onboarding"}
            </button>
            <button
              className="btn btn-primary"
              onClick={payout}
              disabled={me?.paymentMode === "live" && !dev?.stripeOnboarded}
            >
              Request payout
            </button>
          </div>
          {deviceProof && <p className="ok">Device registered: {deviceProof}</p>}
          {msg && <p className="ok">{msg}</p>}
          {err && <p className="error">{err}</p>}

          <section className="section">
            <h2 className="section-title">Recent impressions</h2>
            {!earnings || earnings.earnings.length === 0 ? (
              <p className="muted">
                No impressions yet. Install a client surface and start coding — an impression needs
                10+ continuous seconds of ad on screen during a real wait.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Surface</th>
                      <th>Ad</th>
                      <th className="num">Dur</th>
                      <th className="num">Share</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {earnings.earnings.map((r) => (
                      <tr key={r.id}>
                        <td title={formatDate(r.servedAt)}>{timeAgo(r.servedAt)}</td>
                        <td>{r.surface}</td>
                        <td className="mono">{r.adLine}</td>
                        <td className="num">{(r.durationMs / 1000).toFixed(1)}s</td>
                        <td className="num">${millsToDollars(r.devShareMills)}</td>
                        <td>
                          <span className={`badge badge-${r.status}`}>{r.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="section">
            <h2 className="section-title">Payouts</h2>
            {payouts.length === 0 ? (
              <p className="muted">
                No payout requests yet. Balances clear a 72h fraud window before being paid out.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Requested</th>
                      <th className="num">Amount</th>
                      <th>Status</th>
                      <th>Clears</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr key={p.id}>
                        <td title={formatDate(p.createdAt)}>{timeAgo(p.createdAt)}</td>
                        <td className="num">${millsToDollars(p.amountMills)}</td>
                        <td>
                          <span className={`badge badge-${p.status}`}>{p.status}</span>
                        </td>
                        <td title={p.clearedAt ? formatDate(p.clearedAt) : ""}>
                          {p.status === "held" && p.availableAt
                            ? timeAgo(p.availableAt)
                            : p.clearedAt
                              ? "paid"
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
