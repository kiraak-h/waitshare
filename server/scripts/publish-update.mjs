#!/usr/bin/env node
import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"

const API = process.env.WAITSHARE_API ?? "http://localhost:3001/api/v1"
const ADMIN_TOKEN = process.env.WAITSHARE_ADMIN_TOKEN

function usage() {
  console.error(
    "usage: publish-update.mjs <platform> <version> <artifact-file>\n" +
      "env: WAITSHARE_API (default http://localhost:3001/api/v1), WAITSHARE_ADMIN_TOKEN (required)"
  )
  process.exit(1)
}

async function main() {
  const [platform, version, artifactFile] = process.argv.slice(2)
  if (!platform || !version || !artifactFile) usage()
  if (!ADMIN_TOKEN) {
    console.error("WAITSHARE_ADMIN_TOKEN is required to publish")
    process.exit(1)
  }

  const artifactPath = path.resolve(artifactFile)
  if (!fs.existsSync(artifactPath)) {
    console.error(`artifact not found: ${artifactPath}`)
    process.exit(1)
  }

  const artifact = fs.readFileSync(artifactPath)
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex")
  const name = `${platform}-${version}`
  const url = `${API}/updates/artifacts/${name}`

  const upload = await fetch(`${API}/updates/artifacts/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    body: artifact,
  })
  if (!upload.ok) {
    console.error(`artifact upload failed: ${upload.status}`)
    process.exit(1)
  }

  const res = await fetch(`${API}/updates/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ platform, version, url, sha256 }),
  })
  const body = await res.json()
  if (!res.ok) {
    console.error(`publish failed: ${res.status} ${JSON.stringify(body)}`)
    process.exit(1)
  }

  console.log(`published ${platform}@${version}`)
  console.log(`url: ${url}`)
  console.log(`sha256: ${sha256}`)
  console.log(`signature: ${body.signature.slice(0, 24)}…`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
