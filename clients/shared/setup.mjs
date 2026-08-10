import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((resolve) => rl.question(q, resolve))

const API = process.env.WAITSHARE_API ?? "http://localhost:3001/api/v1"
const CONFIG_DIR = process.env.WAITSHARE_HOME ?? path.join(os.homedir(), ".waitshare")
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json")

async function main() {
  let email = process.env.WAITSHARE_EMAIL
  if (!email) email = await ask("Email: ")

  const reg = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, country: (process.env.WAITSHARE_COUNTRY ?? "US") }),
  })
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`)
  const { token } = await reg.json()

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64")
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")

  const dev = await fetch(`${API}/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, publicKey: publicKeyB64 }),
  })
  if (!dev.ok) throw new Error(`device registration failed: ${dev.status}`)
  const { deviceId, publicKey: registeredPublicKey } = await dev.json()

  if (registeredPublicKey !== publicKeyB64) {
    throw new Error("server registered a different public key than the one this device generated")
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const cfg = { api: API, token, deviceId, privateKeyB64, publicKeyB64, createdAt: Date.now() }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  fs.chmodSync(CONFIG_PATH, 0o600)

  console.log(`WaitShare configured for ${email}`)
  console.log(`Device: ${deviceId}`)
  console.log(`Config: ${CONFIG_PATH}`)
  rl.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
