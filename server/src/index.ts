import express from "express"
import cors from "cors"
import { config, validateConfig } from "./config.js"
import { db } from "./db.js"
import { authRouter } from "./routes/auth.js"
import { oauthRouter } from "./routes/oauth.js"
import { adsRouter } from "./routes/ads.js"
import { devRouter } from "./routes/dev.js"
import { advertiserRouter } from "./routes/advertiser.js"
import { auctionRouter } from "./routes/auction.js"
import { ledgerRouter } from "./routes/ledger.js"
import { updatesRouter } from "./routes/updates.js"
import { splitRouter } from "./routes/split.js"
import { webhookRouter } from "./routes/webhooks.js"
import { startSweeper } from "./services/payouts.js"
import { randomUUID } from "node:crypto"

const app = express()
app.use(cors())

const report = validateConfig()
for (const w of report.warnings) {
  console.warn(`[waitshare] config warning: ${w}`)
}
if (report.errors.length > 0) {
  for (const e of report.errors) {
    console.error(`[waitshare] config error: ${e}`)
  }
  throw new Error(`invalid configuration: ${report.errors.join("; ")}`)
}
app.use("/api/v1/webhooks", express.raw({ type: "application/json" }), webhookRouter)
app.use(express.json())

app.get("/api/v1/health", (_req, res) => {
  res.json({ ok: true, service: "waitshare", time: Date.now() })
})

app.use("/api/v1/auth", authRouter)
app.use("/api/v1/auth", oauthRouter)
app.use("/api/v1/ads", adsRouter)
app.use("/api/v1/dev", devRouter)
app.use("/api/v1/advertiser", advertiserRouter)
app.use("/api/v1/auction", auctionRouter)
app.use("/api/v1/ledger", ledgerRouter)
app.use("/api/v1/updates", updatesRouter)
app.use("/api/v1/split", splitRouter)

function seedDemo() {
  if (process.env.SEED_DEMO === "0") return

  let advertiser = db.prepare("SELECT id FROM advertisers WHERE email = 'demo@waitshare.dev'").get() as
    | { id: string }
    | undefined
  if (!advertiser) {
    const id = randomUUID()
    db.prepare("INSERT INTO advertisers (id, email, company, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      "demo@waitshare.dev",
      "ExampleCorp",
      Date.now()
    )
    advertiser = { id }
  }

  const demoCampaigns: Record<string, { adLine: string; cpm: number }[]> = {
    opencode: [
      { adLine: "ExampleCorp — deploy agents to the cloud", cpm: 300 },
      { adLine: "DevToolX — observability for AI agents", cpm: 250 },
    ],
    "claude-code-cli": [{ adLine: "ShipFast — code review that ships", cpm: 200 }],
    vscode: [{ adLine: "BetterStack — logs for every deploy", cpm: 220 }],
    terminal: [{ adLine: "PingBot — uptime for your APIs", cpm: 150 }],
  }

  const now = Date.now()
  const insert = db.prepare(
    "INSERT INTO campaigns (id, advertiser_id, ad_line, url, brand_icon, surface, cpm_cents, blocks, impressions_bought, country_filter, delivery_speed, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)"
  )
  for (const [surface, ads] of Object.entries(demoCampaigns)) {
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE surface = ?")
      .get(surface) as { n: number }
    if (existing.n > 0) continue
    for (const d of ads) {
      insert.run(randomUUID(), advertiser.id, d.adLine, "https://example.com", null, surface, d.cpm, 100, 100000, null, "fast", now, now)
    }
  }

  const devEmail = process.env.DEMO_DEV_EMAIL ?? "demo@waitshare.dev"
  const existingDev = db.prepare("SELECT id FROM devs WHERE email = ?").get(devEmail) as { id: string } | undefined
  if (!existingDev) {
    db.prepare("INSERT INTO devs (id, email, country, status, created_at) VALUES (?, ?, 'US', 'active', ?)").run(
      randomUUID(),
      devEmail,
      now
    )
  }
}

seedDemo()
startSweeper()

app.listen(config.port, config.host, () => {
  console.log(`[waitshare] API listening on http://${config.host}:${config.port}`)
  console.log(`[waitshare] split contract: 60% developers / 40% platform (locked)`)
  console.log(
    `[waitshare] payouts: ${config.payoutHoldMs}ms hold, ${config.reservePct}% reserve released after ${config.reserveReleaseMs}ms`
  )
})
