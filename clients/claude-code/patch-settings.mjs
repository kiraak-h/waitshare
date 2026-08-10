#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const argCli = process.argv[2]
const argSettings = process.argv[3]

const restore = argCli === "--restore"
const cliPath = restore ? null : path.resolve(argCli)
const settingsPath = restore ? path.resolve(argSettings) : path.resolve(argSettings ?? path.join(os.homedir(), ".claude", "settings.json"))
const backupPath = `${settingsPath}.waitshare.bak`

if (restore) {
  if (!fs.existsSync(backupPath)) {
    console.error("No backup found at", backupPath)
    process.exit(1)
  }
  fs.copyFileSync(backupPath, settingsPath)
  console.log("Restored settings from backup:", backupPath)
  process.exit(0)
}

if (!cliPath) {
  console.error("usage: patch-settings.mjs <path-to-waitshare.mjs> [settings.json] | patch-settings.mjs --restore [settings.json]")
  process.exit(1)
}

const statusLine = {
  type: "command",
  command: `node ${cliPath} status`,
}

const hooks = {
  SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `node ${cliPath} start` }] }],
  Stop: [{ matcher: "", hooks: [{ type: "command", command: `node ${cliPath} report` }] }],
}

let settings = {}
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
}

settings.statusLine = statusLine
settings.hooks = settings.hooks ?? {}
settings.hooks.SessionStart = hooks.SessionStart
settings.hooks.Stop = hooks.Stop

fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
console.log("Patched", settingsPath)
