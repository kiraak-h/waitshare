import express from "express"
import cors from "cors"
import fs from "node:fs"
import path from "node:path"
import { config, validateConfig } from "./config.js"
import { db, initDb } from "./db.js"
import { authRouter } from "./routes/auth.js"
import { oauthRouter } from "./routes/oauth.js"
import { adsRouter } from "./routes/ads.js"
import { devRouter } from "./routes/dev.js"
import { advertiserRouter } from "./routes/advertiser.js"
import { auctionRouter } from "./routes/auction.js"
import { ledgerRouter } from "./routes/ledger.js"
import { updatesRouter } from "./routes/updates.js"
import { splitRouter } from "./routes/split.js"
import { adminRouter } from "./routes/admin.js"
import { metricsRouter } from "./routes/metrics.js"
import { webhookRouter } from "./routes/webhooks.js"
import { startSweeper } from "./services/payouts.js"
import { rateLimit } from "./services/rate-limit.js"
import { randomUUID } from "node:crypto"

const app = express()
app.set("trust proxy", config.trustProxy ? 1 : false)
app.use(cors())

app.use((req, res, next) => {
  const start = Date.now()
  res.on("finish", () => {
    if (req.path === "/api/v1/health") return
    console.log(`[waitshare] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`)
  })
  next()
})

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

app.use("/api/v1/auth", rateLimit({ windowMs: 60_000, max: 120 }), authRouter)
app.use("/api/v1/auth", oauthRouter)
app.use("/api/v1/ads", adsRouter)
app.use("/api/v1/dev", devRouter)
app.use("/api/v1/advertiser", advertiserRouter)
app.use("/api/v1/auction", auctionRouter)
app.use("/api/v1/ledger", ledgerRouter)
app.use("/api/v1/updates", updatesRouter)
app.use("/api/v1/split", splitRouter)
app.use("/api/v1/admin", adminRouter)
app.use("/api/v1/metrics", metricsRouter)

// JSON error handler — never leak HTML stack traces to API clients. Malformed
// JSON bodies (body-parser SyntaxError) are a client mistake, so 400, not 500.
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof SyntaxError && "body" in err && err.message.includes("JSON")) {
    res.status(400).json({ error: "invalid JSON body" })
    return
  }
  console.error(`[waitshare] error ${req.method} ${req.originalUrl}:`, err)
  res.status(500).json({ error: "internal error" })
})

const webDistIndex = path.join(config.webDistDir, "index.html")
if (fs.existsSync(webDistIndex)) {
  app.use(express.static(config.webDistDir))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(webDistIndex)
  })
}

async function seedDemo(): Promise<void> {
  if (process.env.SEED_DEMO === "0") return

  let advertiser = await db.get<{ id: string }>("SELECT id FROM advertisers WHERE email = 'demo@waitshare.dev'")
  if (!advertiser) {
    const id = randomUUID()
    await db.run("INSERT INTO advertisers (id, email, company, created_at) VALUES (?, ?, ?, ?)", [
      id,
      "demo@waitshare.dev",
      "ExampleCorp",
      Date.now(),
    ])
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
  for (const [surface, ads] of Object.entries(demoCampaigns)) {
    const existing = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM campaigns WHERE surface = ?", [surface])) as {
      n: number
    }
    if (existing.n > 0) continue
    for (const d of ads) {
      await db.run(
        "INSERT INTO campaigns (id, advertiser_id, ad_line, url, brand_icon, surface, cpm_cents, blocks, impressions_bought, country_filter, delivery_speed, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
        [randomUUID(), advertiser.id, d.adLine, "https://example.com", null, surface, d.cpm, 100, 100000, null, "fast", now, now]
      )
    }
  }

  const devEmail = process.env.DEMO_DEV_EMAIL ?? "demo@waitshare.dev"
  const existingDev = await db.get<{ id: string }>("SELECT id FROM devs WHERE email = ?", [devEmail])
  if (!existingDev) {
    await db.run("INSERT INTO devs (id, email, country, status, created_at) VALUES (?, ?, 'US', 'active', ?)", [
      randomUUID(),
      devEmail,
      now,
    ])
  }
}

async function main(): Promise<void> {
  await initDb()
  await seedDemo()
  startSweeper()

  app.listen(config.port, config.host, () => {
    console.log(`[waitshare] API listening on http://${config.host}:${config.port}`)
    console.log(`[waitshare] split contract: 60% developers / 40% platform (locked)`)
    console.log(
      `[waitshare] payouts: ${config.payoutHoldMs}ms hold, ${config.reservePct}% reserve released after ${config.reserveReleaseMs}ms`
    )
  })
}

void main()
