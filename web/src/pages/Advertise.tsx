import { useState, type FormEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { api } from "../api"
import { centsToDollars, formatNumber } from "../utils"

interface CreateResult {
  campaignId: string
  checkoutUrl: string
  amountCents: number
  mode: string
}

export default function Advertise() {
  const [search] = useSearchParams()
  const [email, setEmail] = useState("")
  const [company, setCompany] = useState("")
  const [adLine, setAdLine] = useState("")
  const [url, setUrl] = useState("")
  const [surface, setSurface] = useState("opencode")
  const [cpm, setCpm] = useState(200)
  const [blocks, setBlocks] = useState(1)
  const [speed, setSpeed] = useState("fast")
  const [result, setResult] = useState<CreateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [myCampaigns, setMyCampaigns] = useState<unknown[]>([])

  const paidCampaign = search.get("campaign")
  const paid = search.get("paid")

  async function confirmPayment() {
    if (!paidCampaign) return
    try {
      await api(`/advertiser/campaigns/${paidCampaign}/confirm`, { method: "POST" })
      alert("Payment confirmed. Campaign is now live on the market.")
    } catch (e) {
      setError(String(e))
    }
  }

  async function loadCampaigns(email: string) {
    try {
      const r = await api<{ campaigns: unknown[] }>(`/advertiser/campaigns?email=${encodeURIComponent(email)}`)
      setMyCampaigns(r.campaigns)
    } catch {
      setMyCampaigns([])
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await api<CreateResult>("/advertiser/campaigns", {
        method: "POST",
        body: JSON.stringify({
          email,
          company,
          adLine,
          url,
          surface,
          cpmCents: cpm,
          blocks,
          deliverySpeed: speed,
        }),
      })
      setResult(res)
      await loadCampaigns(email)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const total = cpm * blocks

  return (
    <div className="page narrow">
      <section className="hero-mini">
        <h1>Advertise on the most-watched spinner</h1>
        <p>
          Each block buys 1,000 impressions. An impression requires at least 10 continuous seconds
          on screen. The highest bid serves first; you keep full control of the price.
        </p>
      </section>

      {paid === "1" && paidCampaign && !result && (
        <div className="notice">
          <p>Payment received for campaign {paidCampaign}.</p>
          <button className="btn btn-primary" onClick={confirmPayment}>
            Confirm & activate campaign
          </button>
        </div>
      )}

      <div className="advertise-grid">
        <form className="card form" onSubmit={onSubmit}>
          <label className="field">
            <span>Email (required)</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="you@company.com" />
          </label>
          <label className="field">
            <span>Company (optional)</span>
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="shown on leaderboard" />
          </label>
          <label className="field">
            <span>Ad line · 3–60 chars</span>
            <input value={adLine} onChange={(e) => setAdLine(e.target.value)} maxLength={60} required placeholder="ExampleCorp — deploy agents to the cloud" />
            <small>{adLine.length}/60</small>
          </label>
          <label className="field">
            <span>Destination URL (https://)</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" required placeholder="https://" />
          </label>
          <label className="field">
            <span>Surface</span>
            <select value={surface} onChange={(e) => setSurface(e.target.value)}>
              <option value="opencode">Opencode — in-session, higher CPM</option>
              <option value="claude-code-cli">Claude Code CLI — status line</option>
              <option value="vscode">VS Code — in-editor</option>
              <option value="terminal">Terminal — ambient, high volume</option>
            </select>
          </label>
          <div className="field-row">
            <label className="field">
              <span>Bid per block · min $0.50</span>
              <input value={cpm} onChange={(e) => setCpm(Number(e.target.value))} type="number" min={50} step={50} />
              <small>cents per 1,000 impressions</small>
            </label>
            <label className="field">
              <span>Blocks (1,000 impressions each)</span>
              <input value={blocks} onChange={(e) => setBlocks(Number(e.target.value))} type="number" min={1} max={10000} />
            </label>
          </div>
          <label className="field">
            <span>Delivery speed</span>
            <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
              <option value="slow">Slow · ~2 days</option>
              <option value="medium">Medium · ~6 hours</option>
              <option value="fast">Fast · ASAP</option>
            </select>
          </label>

          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Creating…" : `Checkout · $${centsToDollars(total)}`}
          </button>
          {error && <p className="error">{error}</p>}
        </form>

        <div className="side-col">
          <div className="card preview-card">
            <h3>Live preview</h3>
            <div className="spinner-card small">
              <div className="spinner-head">
                <span className="dot" />
                <span className="spinner-title">Thinking…</span>
              </div>
              <div className="spinner-body">
                <span className="spinner-ad">{adLine ? `Sponsored · ${adLine}` : "Sponsored · Your ad here"}</span>
              </div>
            </div>
            <p className="muted">
              Estimated total: {formatNumber(blocks)} block(s) at ${centsToDollars(cpm)} ={" "}
              {formatNumber(blocks * 1000)} impressions · ${centsToDollars(total)}
            </p>
            <p className="muted">
              {(cpm / 1000).toFixed(3)} cents per impression · dev keeps{" "}
              {((cpm / 1000) * 0.6).toFixed(4)} cents of it.
            </p>
          </div>

          {result && (
            <div className="card preview-card">
              <h3>Campaign created</h3>
              <p>Amount: ${centsToDollars(result.amountCents)} · Mode: {result.mode}</p>
              <a className="btn btn-primary btn-block" href={result.checkoutUrl} target="_blank" rel="noreferrer">
                Complete payment
              </a>
              <p className="muted">
                In stub mode the payment page is simulated. After checkout, this page confirms the
                campaign into the live auction automatically.
              </p>
            </div>
          )}

          {myCampaigns.length > 0 && (
            <div className="card preview-card">
              <h3>Your campaigns</h3>
              {myCampaigns.map((c: any) => (
                <div className="mini-campaign" key={c.id}>
                  <span>{c.ad_line}</span>
                  <span className={`badge badge-${c.status}`}>{c.status}</span>
                  <small>
                    {formatNumber(c.impressions_served)}/{formatNumber(c.impressions_bought)} served
                  </small>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
