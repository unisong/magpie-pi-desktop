#!/usr/bin/env node
// Snapshot and compare the Magpie+Codex state the Pi-Desktop plugin must leave alone.
// Prints hashes and non-secret fields only: never key values, tokens or stash contents.
//   node codex-invariants.mjs snapshot <out.json>
//   node codex-invariants.mjs compare <before.json> <after.json>
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const home = process.env.MAGPIE_INVARIANTS_HOME || homedir()
const magpieDir = join(home, ".config", "magpie")
const MAGPIE = process.env.MAGPIE || "magpie"
// The one plugins.json entry the install may add: this checkout's Magpie package folder.
const PACKAGE_DIR = resolve(fileURLToPath(new URL("../packages/pi-desktop", import.meta.url)))
const samePath = (a, b) => resolve(String(a)).replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase()

const sha = (data) => createHash("sha256").update(data).digest("hex").slice(0, 16)
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")) } catch { return undefined } }
const fileHash = (p) => (existsSync(p) ? sha(readFileSync(p)) : null)
const hashValues = (o) => o && typeof o === "object"
  ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sha(JSON.stringify(o[k]))])) : null

function magpie(args) {
  try {
    const out = execFileSync(MAGPIE, args, { encoding: "utf8", timeout: 30000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    return out.split(/\r?\n/).filter((l) => !l.includes("Codex Workbench console")).join("\n").trim()
  } catch (e) { return `ERROR ${e.status ?? ""} ${String(e.message).split("\n")[0]}` }
}

function codexConfig() {
  const p = join(home, ".codex", "config.toml")
  if (!existsSync(p)) return { file: null }
  const text = readFileSync(p, "utf8")
  const top = (k) => (text.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m")) || [])[1] ?? null
  const section = text.split(/^\[model_providers\.magpie\]\s*$/m)[1]?.split(/^\[/m)[0] ?? ""
  const field = (k) => (section.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m")) || [])[1] ?? null
  return {
    file: sha(text), model: top("model"), model_provider: top("model_provider"),
    magpie_base_url: field("base_url"), magpie_wire_api: field("wire_api"),
    token: field("experimental_bearer_token"), // used for the gateway probe, dropped before saving
    catalog: top("model_catalog_json"), // used to find the catalog, dropped before saving
  }
}

// The model catalog Codex reads (config.toml's model_catalog_json): a hash and the sorted slugs.
function codexCatalog(name) {
  const p = name ? (isAbsolute(name) ? name : join(home, ".codex", name)) : join(home, ".codex", "magpie-models.json")
  if (!existsSync(p)) return { file: null, slugs: null }
  const json = readJson(p)
  const list = Array.isArray(json) ? json : Array.isArray(json?.models) ? json.models : []
  return { file: fileHash(p), slugs: list.map((m) => m?.slug ?? m?.id).filter((s) => typeof s === "string").sort() }
}

// Magpie's per-model settings, which shape what Codex gets: hashes only.
function modelSettings() {
  const s = readJson(join(magpieDir, "settings.json"))
  if (!s || typeof s !== "object") return null
  return Object.fromEntries(["modelAPIs", "modelEfforts", "modelCompacts", "modelImages", "vision"].map((k) => [k, s[k] === undefined ? null : sha(JSON.stringify(s[k]))]))
}

async function probe(url, token) {
  try {
    const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000) })
    const body = await res.json().catch(() => null)
    const list = body?.data ?? body?.models
    return { status: res.status, models: Array.isArray(list) ? list.length : null }
  } catch (e) { return { status: null, error: e.name } }
}

async function snapshot(out) {
  const codex = codexConfig()
  const { token, catalog } = codex
  delete codex.token
  delete codex.catalog
  const base = codex.magpie_base_url
  const plugins = readJson(join(magpieDir, "plugins.json"))?.plugins
  const applied = readJson(join(magpieDir, "applied.json"))
  const stash = readJson(join(magpieDir, "stash.json"))
  const snap = {
    codexConfig: codex,
    codexCatalog: codexCatalog(catalog),
    modelSettings: modelSettings(),
    providersJson: fileHash(join(magpieDir, "providers.json")),
    pluginsJson: Array.isArray(plugins) ? plugins.map((e) => typeof e === "string" ? { spec: e }
      : { spec: e.spec, off: !!e.off, options: e.options === undefined ? null : sha(JSON.stringify(e.options)) }) : null,
    pluginsYml: fileHash(join(magpieDir, "plugins.yml")),
    applied: applied && Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, typeof v === "string" ? v : sha(JSON.stringify(v))])),
    stash: stash && typeof stash === "object" ? hashValues(stash) : null,
    piAgentSettings: fileHash(join(home, ".pi", "agent", "settings.json")),
    gateway: base ? { models: await probe(`${base.replace(/\/$/, "")}/models`, token),
      codexModels: await probe(`${new URL(base).origin}/v1/codex/models`, token) } : null,
    magpieLs: magpie(["ls"]),
    magpieCodex: magpie(["codex"]),
  }
  writeFileSync(out, JSON.stringify(snap, null, 2) + "\n")
  console.log(`snapshot written: ${out}`)
}

const CRITICAL = ["codexConfig", "codexCatalog", "modelSettings", "providersJson", "stash.codex", "applied.codex", "gateway", "magpieCodex"]

// A Codex check that failed while snapshotting proves nothing, even if it failed the same way twice.
function brokenChecks(snap) {
  const out = []
  if (typeof snap.magpieCodex === "string" && snap.magpieCodex.startsWith("ERROR")) out.push("magpieCodex")
  for (const [name, p] of Object.entries(snap.gateway ?? {})) if (!p || p.status !== 200) out.push(`gateway.${name}`)
  if (!snap.gateway) out.push("gateway")
  if (!snap.codexConfig?.file) out.push("codexConfig")
  return out
}

function slugDiff(before, after) {
  const b = new Set(JSON.parse(before ?? "null") ?? []), a = new Set(JSON.parse(after ?? "null") ?? [])
  const added = [...a].filter((s) => !b.has(s)), removed = [...b].filter((s) => !a.has(s))
  return `${added.length} added${added.length ? ` (${added.slice(0, 8).join(", ")})` : ""}, ${removed.length} removed${removed.length ? ` (${removed.slice(0, 8).join(", ")})` : ""}`
}
function flatten(o, prefix = "", out = {}) {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const k of Object.keys(o)) flatten(o[k], prefix ? `${prefix}.${k}` : k, out)
  else out[prefix] = JSON.stringify(o)
  return out
}

function compare(beforePath, afterPath) {
  const before = readJson(beforePath), after = readJson(afterPath)
  let failed = 0
  const report = (critical, msg) => { if (critical) failed++; console.log(`${critical ? "FAIL" : "info"}  ${msg}`) }
  for (const [label, snap] of [["before", before], ["after", after]]) {
    for (const check of brokenChecks(snap)) report(true, `${check}: not checked, it failed in the ${label} snapshot`)
  }
  const { pluginsJson: pb = [], ...restB } = before, { pluginsJson: pa = [], ...restA } = after
  for (const entry of pb ?? []) {
    if (!(pa ?? []).some((x) => JSON.stringify(x) === JSON.stringify(entry))) report(true, `plugins.json entry changed or removed: ${entry.spec}`)
  }
  let ours = 0
  for (const entry of pa ?? []) {
    if ((pb ?? []).some((x) => x.spec === entry.spec)) continue
    const expected = (samePath(entry.spec, PACKAGE_DIR) || /^@magpie-community\/agent-pi-desktop(@[^/]+)?$/.test(entry.spec)) && ours++ === 0
    report(!expected, `plugins.json entry added: ${entry.spec}${expected ? " (this plugin)" : ""}`)
  }
  const fb = flatten(restB), fa = flatten(restA)
  for (const key of new Set([...Object.keys(fb), ...Object.keys(fa)])) {
    if (fb[key] === fa[key]) continue
    const critical = CRITICAL.some((c) => key === c || key.startsWith(`${c}.`))
    if (critical && !(key in fb) && ["codexCatalog", "modelSettings"].some((c) => key.startsWith(c))) {
      report(false, `${key}: not in the before snapshot (taken by an older version of this script)`)
      continue
    }
    const detail = key === "codexCatalog.slugs" ? slugDiff(fb[key], fa[key])
      : key.startsWith("magpie") ? "(text changed)" : `${fb[key]} -> ${fa[key]}`
    report(critical, `${key}: ${detail}`)
  }
  console.log(failed ? `\n${failed} Codex-critical difference(s)` : "\nOK: no Codex-critical differences")
  process.exitCode = failed ? 1 : 0
}

const [cmd, a, b] = process.argv.slice(2)
if (cmd === "snapshot" && a) await snapshot(a)
else if (cmd === "compare" && a && b) compare(a, b)
else { console.error("usage: codex-invariants.mjs snapshot <out.json> | compare <before.json> <after.json>"); process.exitCode = 2 }
