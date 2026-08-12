#!/usr/bin/env node
// One-shot backup of the WaitShare datastore.
//
//   Postgres: pg_dump | gzip -> BACKUP_DIR/waitshare-<ts>.sql.gz
//   SQLite:   better-sqlite3 online backup -> BACKUP_DIR/waitshare-<ts>.db
//
// Env:
//   DATABASE_URL   set to back up Postgres (otherwise SQLite under DATA_DIR)
//   DATA_DIR       SQLite data directory (default server/data)
//   BACKUP_DIR     destination (default <DATA_DIR>/backups)
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const dataDir = process.env.DATA_DIR ?? path.resolve(import.meta.dirname, "../data")
const backupDir = process.env.BACKUP_DIR ?? path.join(dataDir, "backups")
const dbUrl = process.env.DATABASE_URL ?? ""

fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")

if (dbUrl) {
  const dest = path.join(backupDir, `waitshare-${stamp}.sql.gz`)
  const res = spawnSync("sh", ["-c", `pg_dump "${dbUrl}" | gzip > "${dest}"`], { stdio: "inherit" })
  if (res.status !== 0) {
    console.error(`backup failed: pg_dump exited ${res.status}`)
    process.exit(res.status ?? 1)
  }
  console.log(`backed up postgres -> ${dest}`)
  process.exit(0)
}

const src = path.join(dataDir, "waitshare.db")
if (!fs.existsSync(src)) {
  console.error(`no sqlite database at ${src}`)
  process.exit(1)
}

const dest = path.join(backupDir, `waitshare-${stamp}.db`)
const { default: Database } = await import("better-sqlite3")
const raw = new Database(src, { readonly: true })
try {
  await raw.backup(dest)
} finally {
  raw.close()
}
console.log(`backed up sqlite -> ${dest}`)
