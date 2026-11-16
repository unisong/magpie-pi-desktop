#!/usr/bin/env node
// Loads the plugin folder Magpie keeps into Pi-Desktop's own host-core, running in a
// throwaway data dir (PI_DESKTOP_DATA_DIR), as "Load local plugin" does, and checks that
// the provider rows follow the manifest when Magpie rewrites it: after a restart, and
// after turning the plugin off and on. Never touches the real data folder (~/.pi-desktop,
// or PI_DESKTOP_DATA_DIR): it snapshots its top level, plugins/ and secrets/ before and after.
//   PI_DESKTOP_HOST_BIN=<Pi-Desktop folder>/resources/bin/pi-desktop-host-core.exe node verify/pi-hostcore-sandbox.mjs [manifest.json]
// With a manifest (the one Magpie wrote, ~/.config/magpie-pi-desktop/plugin/manifest.json),
// a copy of it is what gets loaded first.
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { MAX_MODELS, agent, connect } from "../packages/pi-desktop/pi-desktop.agent.js"

const HOST = process.env.PI_DESKTOP_HOST_BIN || ""
const PROTOCOL_VERSION = 11 // Pi-Desktop 0.21.0 and 0.22.0
const PLUGIN_ID = "local.magpie-gateway"
const KEY = `magpie-${agent.id}` // the public key name, saved only in the sandbox
const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: KEY }
const catalog = (count, tag) => Array.from({ length: count }, (_, i) => ({ id: `${tag}${i % 40}/model-${i}`, name: `Model ${i} · ${tag}`, context: 200000, output: 32000, images: true, efforts: i % 9 ? ["low", "medium", "high", "xhigh"] : [] }))
const given = process.argv[2] ? resolve(process.argv[2]) : null
if (given && !existsSync(given)) { console.error(`no manifest at ${given}`); process.exit(2) }
if (!existsSync(HOST)) { console.error(`no host-core at ${HOST || "(not set)"}: set PI_DESKTOP_HOST_BIN to <Pi-Desktop folder>/resources/bin/pi-desktop-host-core.exe`); process.exit(2) }

// The real data folder, read before the sandbox sets PI_DESKTOP_DATA_DIR for the child.
const realDir = process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop")
// Top-level entries, plus every file under plugins/ and secrets/, where a stray install or key
// would land. Records names, sizes and times; never reads a secret.
function snapshot() {
  const out = {}
  for (const name of existsSync(realDir) ? readdirSync(realDir) : []) {
    const s = statSync(join(realDir, name))
    out[name] = s.isFile() ? `${s.size}:${s.mtimeMs}` : "dir"
  }
  const walk = (rel) => {
    let entries = []
    try { entries = readdirSync(join(realDir, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const sub = `${rel}/${e.name}`
      if (e.isDirectory()) { out[sub] = "dir"; walk(sub) }
      else { try { const s = statSync(join(realDir, sub)); out[sub] = `${s.size}:${s.mtimeMs}` } catch { out[sub] = "?" } }
    }
  }
  walk("plugins")
  walk("secrets")
  const reg = join(realDir, "plugins", "registry.json")
  out["plugins/registry.json#sha256"] = existsSync(reg) ? createHash("sha256").update(readFileSync(reg)).digest("hex") : null
  return out
}

function startHost(dataDir) {
  const child = spawn(HOST, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_ELECTRON_PID: String(process.pid) } })
  const pending = new Map()
  let buffer = "", stderr = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (text) => {
    buffer += text
    let nl
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const p = msg.id != null && pending.get(String(msg.id))
      if (p) { pending.delete(String(msg.id)); msg.error ? p.reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? "")}`)) : p.resolve(msg.result) }
    }
  })
  child.stderr.on("data", (t) => { stderr = (stderr + t).slice(-3000) })
  const call = (method, params) => new Promise((res, rej) => {
    const id = randomUUID()
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`timeout: ${method}`)) }, 30000)
    pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v) }, reject: (e) => { clearTimeout(timer); rej(e) } })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  const close = () => new Promise((r) => {
    const t = setTimeout(() => { child.kill(); r() }, 5000)
    child.on("exit", () => { clearTimeout(t); r() })
    child.stdin.end()
  })
  return { call, close, stderr: () => stderr }
}

let failed = 0
const check = (cond, msg) => { if (!cond) failed++; console.log(`${cond ? "ok  " : "FAIL"}  ${msg}`) }
const before = snapshot()
const dataDir = mkdtempSync(join(tmpdir(), "pi-hostcore-sandbox-"))
const pluginDir = mkdtempSync(join(tmpdir(), "pi-hostcore-plugin-"))
const manifestPath = join(pluginDir, "manifest.json")
// As Magpie writes the file: every key connect() returns, as JSON.
const write = (manifest) => { writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n"); return manifest }
let host = startHost(dataDir)
const restart = async () => { await host.close(); host = startHost(dataDir); await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION }) }

async function rows() {
  const list = await host.call("providers.list", { includeDisabled: true })
  return (Array.isArray(list) ? list : list?.providers ?? []).filter((p) => p.id.startsWith(`plugin:${PLUGIN_ID}:`))
}
// Do the rows Pi-Desktop holds match exactly what the manifest declares?
async function follows(manifest, label) {
  const have = await rows(), want = manifest.contributes.providers
  const same = have.length === want.length && want.every((p, i) => {
    const row = have[i]
    return row.id === `plugin:${PLUGIN_ID}:${p.id}` && row.name === p.name && row.baseUrl === p.baseUrl && row.apiStyle === "chat_completions" && row.authKind === "api_key" &&
      row.ownerPluginId === PLUGIN_ID && row.enabled && row.models.length === p.models.length && p.models.every((m, k) => {
        const got = row.models[k]
        return got.id === m.id && got.alias === m.name && (got.defaultThinkingLevel ?? undefined) === m.defaultThinkingLevel &&
          JSON.stringify(got.thinkingLevels ?? []) === JSON.stringify(m.thinkingLevels || []) && (m.contextWindow === undefined || got.contextWindow === m.contextWindow)
      })
  })
  const withLevel = have.reduce((n, row) => n + row.models.filter((m) => m.defaultThinkingLevel).length, 0)
  check(same, `${label}: ${have.map((row) => `${row.name} (${row.models.length})`).join(", ") || "no rows"}, ${withLevel} models with a default thinking level${same ? "" : `; the manifest declares ${want.map((p) => `${p.name} (${p.models.length})`).join(", ")}`}`)
  return have
}
const hasKey = async (id) => (await host.call("providers.getSecret", { id }))?.value === KEY

try {
  await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION })
  check(true, `handshake with host-core in ${dataDir}`)

  let manifest = write(given ? JSON.parse(readFileSync(given, "utf8")) : connect({ gateway, models: catalog(50, "a") }))
  if (given) check(manifest.id === PLUGIN_ID && manifest.contributes?.providers?.length > 0, `${given} is a Magpie Gateway manifest`)
  const loaded = await host.call("plugins.loadDev", { path: pluginDir })
  check(loaded?.plugin?.id === PLUGIN_ID && loaded.plugin.source === "dev" && loaded.plugin.enabled, `loaded as a local plugin: ${loaded?.plugin?.id} ${loaded?.plugin?.version}, permissions ${JSON.stringify(loaded?.plugin?.permissions)}`)
  await restart()
  let have = await follows(manifest, "after Pi-Desktop starts")
  await host.call("providers.setSecret", { id: have[0].id, secretValue: KEY })

  // The models change in Magpie: more than one card can hold.
  manifest = write(connect({ gateway, models: catalog(MAX_MODELS + 40, "b") }))
  await restart()
  have = await follows(manifest, "Magpie rewrote the manifest, Pi-Desktop started again")
  check(have.length > 1, `more than ${MAX_MODELS} models make a second card`)
  check(await hasKey(have[0].id), "the key saved for Magpie is still there")
  check(!have[1].hasSecret, "the new card has no key yet")

  // The gateway moves to another port.
  const moved = { url: "http://127.0.0.1:4525", v1: "http://127.0.0.1:4525/v1", key: KEY }
  manifest = write(connect({ gateway: moved, models: catalog(MAX_MODELS + 40, "b") }))
  await restart()
  have = await follows(manifest, "Magpie moved to another port, Pi-Desktop started again")
  check(have[0]?.baseUrl === moved.v1 && await hasKey(have[0].id), `the card points at ${moved.v1} and keeps its key`)

  // Without a restart: the plugin turned off and on in Extensions.
  manifest = write(connect({ gateway, models: catalog(20, "c") }))
  await host.call("plugins.disable", { id: PLUGIN_ID })
  check((await rows()).every((row) => row.enabled === false), "turning the plugin off disables its providers")
  await host.call("plugins.enable", { id: PLUGIN_ID })
  have = await follows(manifest, "Magpie rewrote the manifest, plugin turned off and on")
  check(have.length === 1 && await hasKey(have[0].id), "the card that is no longer needed is gone, the key stays")

  // The row switched off in Magpie: its keys are taken out of the file.
  writeFileSync(manifestPath, "{}\n")
  await restart()
  have = await rows()
  check(have.length === 1 && have[0].models.length === 20, "with the row off in Magpie, Pi-Desktop keeps the last model list")
  write(manifest)

  await host.call("plugins.uninstall", { id: PLUGIN_ID })
  check((await rows()).length === 0, "uninstalling the plugin removes its provider rows")
  check(existsSync(manifestPath), "uninstalling leaves the folder Magpie keeps alone")
} catch (e) {
  check(false, `${e.message}\n  host-core stderr tail: ${host.stderr().trim().split("\n").slice(-5).join("\n  ")}`)
}
await host.close()
check(JSON.stringify(snapshot()) === JSON.stringify(before), `real ${realDir} unchanged`)
console.log(`\n${failed ? `${failed} failed` : "all passed"} (sandbox left at ${dataDir} and ${pluginDir})`)
process.exitCode = failed ? 1 : 0
