#!/usr/bin/env node
// Restore a WaitShare backup produced by scripts/backup.mjs.
//
//   node scripts/restore.mjs <file>
//
//   <file>.db       SQLite snapshot -> copy into DATA_DIR/waitshare.db
//   <file>.sql.gz   Postgres dump   -> gunzip | psql DATABASE_URL
//   <file>.sql      Postgres dump   -> psql DATABASE_URL
//
// Stop the server before restoring to avoid clobbering a live datastore.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const file = process.argv[2]
if (!file) {
  console.error("usage: node scripts/restore.mjs <backup-file>")
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`backup not found: ${file}`)
  process.exit(1)
}

const ext = path.extname(file)
const dbUrl = process.env.DATABASE_URL ?? ""

if (ext === ".db") {
  const dataDir = process.env.DATA_DIR ?? path.resolve(import.meta.dirname, "../data")
  fs.mkdirSync(dataDir, { recursive: true })
  fs.copyFileSync(file, path.join(dataDir, "waitshare.db"))
  console.log(`restored sqlite -> ${path.join(dataDir, "waitshare.db")}`)
  process.exit(0)
}

if (!dbUrl) {
  console.error("DATABASE_URL is required to restore a Postgres dump")
  process.exit(1)
}

const cmd = ext === ".sql.gz" ? `gunzip -c "${file}" | psql "${dbUrl}"` : `psql "${dbUrl}" < "${file}"`
const res = spawnSync("sh", ["-c", cmd], { stdio: "inherit" })
if (res.status !== 0) {
  console.error(`restore failed: exited ${res.status}`)
  process.exit(res.status ?? 1)
}
console.log(`restored postgres from ${file}`)
