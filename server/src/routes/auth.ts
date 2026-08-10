import { Router } from "express"
import { z } from "zod"
import { db } from "../db.js"
import { generateDeviceKeypair } from "../services/signing.js"
import { asyncHandler } from "../async-handler.js"
import { randomUUID } from "node:crypto"

export const authRouter = Router()

const registerSchema = z.object({
  email: z.string().email(),
  country: z.string().max(3).optional(),
})

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid email" })
      return
    }
    const { email, country } = parsed.data
    const existing = await db.get<{ id: string; status: string }>("SELECT * FROM devs WHERE email = ?", [email])

    let devId: string
    if (existing) {
      devId = existing.id
    } else {
      devId = randomUUID()
      await db.run("INSERT INTO devs (id, email, country, status, created_at) VALUES (?, ?, ?, 'active', ?)", [
        devId,
        email,
        country ?? null,
        Date.now(),
      ])
    }

    const token = randomUUID().replace(/-/g, "")
    const now = Date.now()
    await db.run("INSERT INTO sessions (token, dev_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
      token,
      devId,
      now,
      now + 30 * 24 * 60 * 60 * 1000,
    ])

    res.json({ token, devId, status: existing?.status ?? "active" })
  })
)

const deviceSchema = z.object({
  token: z.string().min(8),
  publicKey: z.string().min(20).optional(),
})

authRouter.post(
  "/device",
  asyncHandler(async (req, res) => {
    const parsed = deviceSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "missing token" })
      return
    }
    const session = await db.get<{ dev_id: string }>("SELECT * FROM sessions WHERE token = ?", [parsed.data.token])
    if (!session) {
      res.status(401).json({ error: "invalid session" })
      return
    }

    const { publicKeyB64, privateKeyB64 } = parsed.data.publicKey
      ? { publicKeyB64: parsed.data.publicKey, privateKeyB64: undefined }
      : generateDeviceKeypair()
    const deviceId = randomUUID()
    await db.run("INSERT INTO device_keys (device_id, dev_id, pubkey, created_at) VALUES (?, ?, ?, ?)", [
      deviceId,
      session.dev_id,
      publicKeyB64,
      Date.now(),
    ])

    if (privateKeyB64) {
      res.json({ deviceId, publicKey: publicKeyB64, privateKey: privateKeyB64 })
      return
    }

    res.json({ deviceId, publicKey: publicKeyB64, proof: "registered" })
  })
)
