import { Router } from "express"
import { randomUUID } from "node:crypto"
import { db } from "../db.js"
import { config } from "../config.js"

export const oauthRouter = Router()

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

const pendingStates = new Map<string, { expires: number }>()

function pruneStates(): void {
  const now = Date.now()
  for (const [k, v] of pendingStates) {
    if (v.expires < now) pendingStates.delete(k)
  }
}

oauthRouter.get("/google/login", (req, res) => {
  if (!config.googleClientId || !config.googleClientSecret) {
    res.status(400).json({ error: "Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)" })
    return
  }
  pruneStates()
  const state = randomUUID()
  pendingStates.set(state, { expires: Date.now() + 10 * 60 * 1000 })
  const redirectUri = `${config.publicBaseUrl}/api/v1/auth/google/callback`
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  })
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`)
})

oauthRouter.get("/google/callback", async (req, res) => {
  const code = String(req.query.code ?? "")
  const state = String(req.query.state ?? "")
  if (!code || !state) {
    res.status(400).json({ error: "missing code or state" })
    return
  }
  const pending = pendingStates.get(state)
  pendingStates.delete(state)
  if (!pending || pending.expires < Date.now()) {
    res.status(401).json({ error: "invalid or expired state" })
    return
  }
  if (!config.googleClientId || !config.googleClientSecret) {
    res.status(400).json({ error: "Google OAuth is not configured" })
    return
  }
  const redirectUri = `${config.publicBaseUrl}/api/v1/auth/google/callback`

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    })
    if (!tokenRes.ok) {
      res.status(502).json({ error: "google token exchange failed" })
      return
    }
    const tokens = (await tokenRes.json()) as { access_token?: string }
    if (!tokens.access_token) {
      res.status(502).json({ error: "google returned no access token" })
      return
    }

    const infoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    if (!infoRes.ok) {
      res.status(502).json({ error: "google userinfo failed" })
      return
    }
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean }
    if (!info.sub || !info.email) {
      res.status(502).json({ error: "google userinfo incomplete" })
      return
    }

    const existing = db
      .prepare("SELECT id FROM devs WHERE google_sub = ? OR email = ?")
      .get(info.sub, info.email) as { id: string } | undefined

    const now = Date.now()
    let devId: string
    if (existing) {
      devId = existing.id
      db.prepare("UPDATE devs SET google_sub = ?, email = ? WHERE id = ?").run(info.sub, info.email, devId)
    } else {
      devId = randomUUID()
      db.prepare(
        "INSERT INTO devs (id, email, country, status, google_sub, created_at) VALUES (?, ?, NULL, 'active', ?, ?)"
      ).run(devId, info.email, info.sub, now)
    }

    const token = randomUUID().replace(/-/g, "")
    db.prepare("INSERT INTO sessions (token, dev_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      token,
      devId,
      now,
      now + 30 * 24 * 60 * 60 * 1000
    )

    res.redirect(`${config.webBaseUrl}/dashboard#ws_token=${token}`)
  } catch {
    res.status(502).json({ error: "google oauth failed" })
  }
})
