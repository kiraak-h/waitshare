import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { api } from "../api"
import { centsToDollars, formatNumber, type AuctionStateDto, type SplitDto } from "../utils"

const SURFACES = [
  { id: "opencode", label: "Opencode", extension: true, cli: true, note: "First-class plugin surface" },
  { id: "claude-code-cli", label: "Claude Code CLI", extension: true, cli: true, note: "Status-line + spinner verb" },
  { id: "vscode", label: "VS Code", extension: true, cli: false, note: "Extension in development" },
  { id: "terminal", label: "Terminal", extension: true, cli: true, note: "Ambient status line" },
]

function useAuction() {
  const [state, setState] = useState<AuctionStateDto | null>(null)
  useEffect(() => {
    let alive = true
    const load = () =>
      api<AuctionStateDto>("/auction/state")
        .then((s) => alive && setState(s))
        .catch(() => undefined)
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  return state
}

function useSplit() {
  const [split, setSplit] = useState<SplitDto | null>(null)
  useEffect(() => {
    let alive = true
    api<{ split: SplitDto }>("/split")
      .then((r) => alive && setSplit(r.split))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return split
}

export default function Home() {
  const auction = useAuction()
  const split = useSplit()
  const devShare = split?.devShare ?? 60

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="hero-title">
            Get paid <span className="accent">for waiting.</span>
          </h1>
          <p className="hero-sub">
            Your AI assistant's thinking time is screen time. WaitShare turns the wait into a
            sponsored line — and pays you the majority of what it earns. No code, no prompts, ever.
          </p>
          <div className="hero-cta">
            <Link to="/install" className="btn btn-primary">
              Start earning
            </Link>
            <Link to="/advertise" className="btn btn-ghost">
              Advertise on the spinner
            </Link>
          </div>
        </div>
        <div className="spinner-card">
          <div className="spinner-head">
            <span className="dot" />
            <span className="spinner-title">Analyzing project structure…</span>
          </div>
          <div className="spinner-body">
            <span className="spinner-ad">Sponsored · Your campaign could appear here</span>
            <span className="spinner-ad" style={{ opacity: 0.55 }}>
              Sponsored · Reserved for the live auction winner
            </span>
          </div>
          <div className="spinner-foot">
            <span>you keep {devShare}% of every impression</span>
          </div>
        </div>
      </section>

      <section className="split-banner">
        <div className="split-stat">
          <span className="split-number">{devShare}%</span>
          <span className="split-label">developer share</span>
        </div>
        <div className="split-stat">
          <span className="split-number">{split ? 100 - devShare : 40}%</span>
          <span className="split-label">platform share</span>
        </div>
        <div className="split-text">
          <p>
            The split is locked at the contract level (v{split?.version ?? 1}) and enforced in the
            payment code. Every dollar an advertiser pays is split by a public formula:
          </p>
          <code className="formula">dev_share = floor(gross × {devShare} / 100)</code>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">How it works</h2>
        <div className="steps">
          <div className="step">
            <span className="step-num">01</span>
            <h3>Install & sign in</h3>
            <p>Add the plugin for your editor or CLI. No card, no setup, about 30 seconds.</p>
          </div>
          <div className="step">
            <span className="step-num">02</span>
            <h3>Code like normal</h3>
            <p>
              During a genuine wait-state, a short sponsored line (max 60 chars) replaces the
              spinner verb. Clearly marked, always reversible.
            </p>
          </div>
          <div className="step">
            <span className="step-num">03</span>
            <h3>Get paid</h3>
            <p>
              An impression must be on screen for at least 10 continuous seconds. Earnings accrue
              and cash out via Stripe Connect once you pass the threshold.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Live market</h2>
        <div className="market-grid">
          <div className="market-cell">
            <span className="market-value">
              {auction ? `$${centsToDollars(auction.market.cpmCents)}` : "—"}
            </span>
            <span className="market-label">Market CPM · per 1k impressions</span>
          </div>
          <div className="market-cell">
            <span className="market-value">{auction ? formatNumber(auction.market.impressionsPerHour) : "—"}</span>
            <span className="market-label">Billable impressions / hr</span>
          </div>
          <div className="market-cell">
            <span className="market-value">{auction ? formatNumber(auction.market.adSecondsPerHour) : "—"}</span>
            <span className="market-label">Ad seconds / hr</span>
          </div>
          <div className="market-cell">
            <span className="market-value">
              {auction ? `$${centsToDollars(auction.market.devEarnedPerHourCents)}` : "—"}
            </span>
            <span className="market-label">Dev earnings / hr</span>
          </div>
        </div>
        <div className="market-sub">
          <Link to="/leaderboard" className="link">
            View the public ledger →
          </Link>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Supported surfaces</h2>
        <div className="surface-table">
          <div className="surface-row surface-row-head">
            <span>Surface</span>
            <span>Plugin</span>
            <span>CLI</span>
            <span>Status</span>
          </div>
          {SURFACES.map((s) => (
            <div className="surface-row" key={s.id}>
              <span className="surface-name">{s.label}</span>
              <span>{s.extension ? "yes" : "—"}</span>
              <span>{s.cli ? "yes" : "—"}</span>
              <span className="surface-note">{s.note}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section privacy">
        <h2 className="section-title">Privacy by design</h2>
        <div className="privacy-grid">
          <div className="privacy-card ok">
            <h3>What we collect</h3>
            <p>Ad-event telemetry only: event ids, visibility metrics, per-install id, hashed IP.</p>
          </div>
          <div className="privacy-card no">
            <h3>What we never collect</h3>
            <p>
              Your code, prompts, and AI responses. The telemetry has no field that could carry
              them. There is no opt-in tier that changes this.
            </p>
          </div>
          <div className="privacy-card ok">
            <h3>Signed everything</h3>
            <p>Impression events and client updates are Ed25519-signed. No code-signing gaps.</p>
          </div>
        </div>
      </section>
    </div>
  )
}
