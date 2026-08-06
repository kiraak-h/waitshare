import { Router } from "express"
import { z } from "zod"
import { db } from "../db.js"
import { generateDeviceKeypair } from "../services/signing.js"
import { randomUUID } from "node:crypto"

export const authRouter = Router()

const registerSchema = z.object({
  email: z.string().email(),
  country: z.string().max(3).optional(),
})

authRouter.post("/register", (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid email" })
    return
  }
  const { email, country } = parsed.data
  const existing = db.prepare("SELECT * FROM devs WHERE email = ?").get(email) as
    | { id: string; status: string }
    | undefined

  let devId: string
  if (existing) {
    devId = existing.id
  } else {
    devId = randomUUID()
    db.prepare("INSERT INTO devs (id, email, country, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(
      devId,
      email,
      country ?? null,
      Date.now()
    )
  }

  const token = randomUUID().replace(/-/g, "")
  const now = Date.now()
  db.prepare("INSERT INTO sessions (token, dev_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    devId,
    now,
    now + 30 * 24 * 60 * 60 * 1000
  )

  res.json({ token, devId, status: existing?.status ?? "active" })
})

const deviceSchema = z.object({
  token: z.string().min(8),
  publicKey: z.string().min(20).optional(),
})

authRouter.post("/device", (req, res) => {
  const parsed = deviceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "missing token" })
    return
  }
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(parsed.data.token) as
    | { dev_id: string }
    | undefined
  if (!session) {
    res.status(401).json({ error: "invalid session" })
    return
  }

  const { publicKeyB64, privateKeyB64 } = parsed.data.publicKey
    ? { publicKeyB64: parsed.data.publicKey, privateKeyB64: undefined }
    : generateDeviceKeypair()
  const deviceId = randomUUID()
  db.prepare("INSERT INTO device_keys (device_id, dev_id, pubkey, created_at) VALUES (?, ?, ?, ?)").run(
    deviceId,
    session.dev_id,
    publicKeyB64,
    Date.now()
  )

  if (privateKeyB64) {
    res.json({ deviceId, publicKey: publicKeyB64, privateKey: privateKeyB64 })
    return
  }

  const registration = { deviceId, publicKey: publicKeyB64 }
  res.json({ deviceId, publicKey: publicKeyB64, proof: "registered" })
})
