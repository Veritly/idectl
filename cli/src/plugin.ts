import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { ides, launcher, object, stamp } from "./core"
import type { Ide } from "./core"
import debuggerFiles from "./debugger-plugin.json"

const plugin = path.resolve(import.meta.dir, "../../plugin")
const base = path.join(os.homedir(), ".cache/idectl/plugin")
const revision = sources(plugin)
const debuggerHash = "cd277059784084db72cbdc7f7072f182df11a37a89e54f29ae5e16f39c89ca84"
const debuggerUrl = "https://plugins.jetbrains.com/files/29233/1213010/jetbrains-debugger-mcp-plugin-5.4.0.zip"
const patched = "180da459be032072c0a57aa988a698efb66738c07b46675d05c1aeab0b61bdc6"
const debuggerJar = "lib/jetbrains-debugger-mcp-plugin-5.4.0.jar"

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "build" || entry.name === ".gradle" || entry.name === ".kotlin") return []
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? files(full) : [full]
  }).sort()
}

function sources(dir: string) {
  if (!fs.existsSync(path.join(dir, "settings.gradle.kts"))) throw new Error(`JetBrains plugin source is missing: ${dir}`)
  const hash = createHash("sha256")
  for (const file of files(dir)) hash.update(path.relative(dir, file)).update("\0").update(fs.readFileSync(file)).update("\0")
  return hash.digest("hex").slice(0, 24)
}

function digest(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function product(bin: string) {
  const dir = path.dirname(path.dirname(fs.realpathSync(bin)))
  const file = path.join(dir, "product-info.json")
  const info: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!object(info) || typeof info.buildNumber !== "string" || typeof info.dataDirectoryName !== "string")
    throw new Error(`Invalid JetBrains product metadata: ${file}`)
  if (!/^\d+(\.\d+)+$/.test(info.buildNumber) || !/^[A-Za-z0-9._-]+$/.test(info.dataDirectoryName))
    throw new Error(`Invalid JetBrains product identifier: ${file}`)
  // IDEs built on the platform by another vendor (Android Studio: Google) keep their data under that vendor's directory.
  const vendor = typeof info.productVendor === "string" && /^[A-Za-z0-9._-]+$/.test(info.productVendor) ? info.productVendor : "JetBrains"
  return { dir, build: info.buildNumber, name: info.dataDirectoryName, vendor }
}

type Product = ReturnType<typeof product>

/** Where the IDE keeps user-installed plugins. */
export function plugins(info: Product) {
  if (process.platform === "linux") return path.join(os.homedir(), ".local/share", info.vendor, info.name)
  throw new Error("Automatic JetBrains plugin installation currently supports Linux")
}

/**
 * The IDE the lifecycle plugin is compiled against. A 263-series IDE uses RustRover's SDK and the patched debugger, as
 * before. Any other IDE is its own SDK: the plugin is built against that IDE and the Marketplace debugger is used as is.
 */
function sdkFor(bin: string) {
  const info = product(bin)
  const rust = ides.find((item) => item.id === "rustrover")
  const rustbin = rust ? launcher(rust) : undefined
  if (info.build.startsWith("263.") && rustbin) {
    const sdk = product(rustbin)
    if (sdk.build.startsWith("263.")) return { ...sdk, self: false }
  }
  return { ...info, self: true }
}

const marketplace = { debugger: "com.github.hechtcarmel.jetbrainsdebuggermcpplugin", mcp: "com.intellij.mcpServer" }

function bundled(info: Product, name: string) {
  return fs.existsSync(path.join(info.dir, "plugins", name))
}

function mcpPath(info: Product) {
  return bundled(info, "mcpserver") ? undefined : path.join(plugins(info), "mcpserver")
}

function debuggerInstalled(info: Product) {
  const lib = path.join(plugins(info), "jetbrains-debugger-mcp-plugin/lib")
  return fs.existsSync(lib) && fs.readdirSync(lib).some((name) => /^jetbrains-debugger-mcp-plugin-[\d.]+\.jar$/.test(name))
}

/** Installs Marketplace plugins with the IDE's own installer; only possible while the IDE is not running. */
function marketplaceInstall(bin: string, ids: string[]) {
  const out = Bun.spawnSync([bin, "installPlugins", ...ids], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 180_000 })
  if (out.exitCode !== 0) throw new Error(`${path.basename(bin)} installPlugins ${ids.join(" ")} failed: ${out.stderr.toString().trim().slice(-400)}`)
  // The platform lists plugins from other vendors here and blocks startup on a consent dialog until it is gone.
  const info = product(bin)
  for (const dir of [plugins(info), path.join(os.homedir(), ".config", info.vendor, info.name)]) fs.rmSync(path.join(dir, "alien_plugins.txt"), { force: true })
}

function folder(info: Product) {
  return path.join(plugins(info), "idectl-lifecycle")
}

function validDebugger(target: string, patch = true) {
  return Object.entries(debuggerFiles).every(([file, hash]) => {
    const full = path.join(target, file)
    return fs.existsSync(full) && fs.statSync(full).isFile() && digest(full) === (patch && file === debuggerJar ? patched : hash)
  })
}

function running(info: Product) {
  const file = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), info.vendor, info.name, ".pid")
  if (!fs.existsSync(file)) return false
  const pid = Number(fs.readFileSync(file, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid JetBrains process record: ${file}`)
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (object(err) && err.code === "ESRCH") return false
    if (object(err) && err.code === "EPERM") return true
    throw err
  }
}

function read(file: string) {
  if (!fs.existsSync(file)) return
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!object(value)) throw new Error(`Invalid plugin installation state: ${file}`)
  return value
}

function save(file: string, value: object) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function state(dir: string) {
  const value = read(path.join(dir, "state.json"))
  if (!value) {
    if (Date.now() - fs.statSync(dir).mtimeMs < 5000) return { phase: "queued" }
    return { phase: "failed", error: "Plugin preparation did not initialize" }
  }
  if (value.phase === "queued" && Date.now() - fs.statSync(path.join(dir, "state.json")).mtimeMs > 10000)
    return { ...value, phase: "failed", error: "Plugin preparation did not start" }
  if (typeof value.pid === "number" && typeof value.token === "string" && value.phase !== "ready" && value.phase !== "failed" && stamp(value.pid) !== value.token)
    return { ...value, phase: "failed", error: "Plugin preparation process exited unexpectedly" }
  return value
}

async function run(args: string[], cwd: string, log: number, env = globalThis.process.env, timeout = 0) {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: log, stderr: log })
  const timed = { value: false }
  const timer = timeout ? setTimeout(() => { timed.value = true; child.kill() }, timeout) : undefined
  const code = await child.exited
  if (timer) clearTimeout(timer)
  if (timed.value) throw new Error(`${args[0]} timed out; inspect the plugin build log`)
  if (code !== 0) throw new Error(`${args[0]} exited with code ${code}; inspect the plugin build log`)
}

export function retry() {
  const builds = ides.map((item) => launcher(item)).filter((bin): bin is string => Boolean(bin)).map((bin) => sdkFor(bin).build)
  if (!builds.length) throw new Error("No JetBrains IDE is installed")
  const dirs = [...new Set(builds)].map((build) => path.join(base, `${revision}-${build}`)).concat(path.join(base, "debugger-5.4.0"))
  const failed = dirs.filter((dir) => fs.existsSync(dir) && state(dir).phase === "failed")
  if (!failed.length) throw new Error("No plugin installation has failed")
  const previous = failed.map((dir) => {
    const archive = `${dir}.failed-${Date.now()}`
    fs.renameSync(dir, archive)
    return archive
  })
  return { ok: true, phase: "retry_ready", previous }
}

function enqueue(dir: string, args: string[]) {
  if (fs.existsSync(dir)) return
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
    save(path.join(dir, "state.json"), { phase: "queued" })
    const log = fs.openSync(path.join(dir, "worker.log"), "a", 0o600)
    const child = Bun.spawn(["setsid", globalThis.process.execPath, import.meta.path, ...args], { stdin: "ignore", stdout: log, stderr: log })
    fs.closeSync(log)
    child.unref()
  } catch (err) {
    if (!object(err) || err.code !== "EEXIST") throw err
  }
}

async function download(dir: string) {
  const file = path.join(dir, "state.json")
  const token = stamp(globalThis.process.pid)
  if (!token) throw new Error("Cannot identify plugin download process")
  const update = (phase: string, extra: Record<string, unknown> = {}) => save(file, { phase, pid: globalThis.process.pid, token, ...extra })
  try {
    update("downloading debugger")
    const res = await fetch(debuggerUrl, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`JetBrains Marketplace returned HTTP ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > 16000000 || createHash("sha256").update(bytes).digest("hex") !== debuggerHash)
      throw new Error("Debugger plugin archive checksum is invalid")
    fs.writeFileSync(path.join(dir, "debugger.zip"), bytes, { mode: 0o600 })
    update("ready")
  } catch (err) {
    update("failed", { error: err instanceof Error ? err.message : String(err) })
  }
}

export function installDebugger(target: string, dir: string, active: boolean, name: string, patch?: string) {
  const current = state(dir)
  if (current.phase === "failed") return { ok: false, phase: "plugin_failed", error: current.error }
  if (current.phase !== "ready") return { ok: false, phase: "plugin_installing", stage: current.phase }
  const archive = path.join(dir, "debugger.zip")
  if (!fs.existsSync(archive) || digest(archive) !== debuggerHash) throw new Error("Debugger plugin archive is missing or invalid")
  if (active) return { ok: false, phase: "plugin_restart_required", message: `Close ${name} after finishing active work, then open the project again` }
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const stage = fs.mkdtempSync(path.join(parent, ".idectl-debugger-"))
  const out = Bun.spawnSync(["unzip", "-q", archive, "-d", stage], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (out.exitCode !== 0) throw new Error("Could not extract the verified debugger plugin")
  const plugin = path.join(stage, "jetbrains-debugger-mcp-plugin")
  if (!validDebugger(plugin, false)) throw new Error("Extracted debugger plugin files do not match the verified release")
  if (!patch || !fs.existsSync(patch) || digest(patch) !== patched) throw new Error("Debugger patch is missing or invalid")
  fs.copyFileSync(patch, path.join(plugin, debuggerJar))
  if (!validDebugger(plugin)) throw new Error("Patched debugger plugin files do not match the verified build")
  const backup = path.join(base, `debugger-backup-${Date.now()}-${process.pid}`)
  const previous = fs.existsSync(target)
  if (previous) fs.renameSync(target, backup)
  try {
    fs.renameSync(plugin, target)
  } catch (err) {
    if (fs.existsSync(backup)) fs.renameSync(backup, target)
    throw err
  }
  fs.rmdirSync(stage)
  return { ok: true, phase: "installed", previous: previous ? backup : undefined }
}

export function install(target: string, dir: string, active: boolean, name: string, build: string) {
  const current = state(dir)
  if (current.phase === "failed") return { ok: false, phase: "plugin_failed", error: current.error, log: path.join(dir, "build.log") }
  if (current.phase !== "ready") return { ok: false, phase: "plugin_installing", stage: current.phase, log: path.join(dir, "build.log") }
  if (typeof current.sha256 !== "string" || !fs.existsSync(path.join(dir, "plugin.jar")) || digest(path.join(dir, "plugin.jar")) !== current.sha256)
    throw new Error("Built plugin artifact is missing or invalid")
  if (active) return { ok: false, phase: "plugin_restart_required", message: `Close ${name} after finishing active work, then open the project again` }
  fs.mkdirSync(path.join(target, "lib"), { recursive: true, mode: 0o700 })
  const jar = path.join(target, "lib/idectl-lifecycle.jar")
  const temp = path.join(target, `lib/.plugin-${globalThis.process.pid}.jar`)
  fs.copyFileSync(path.join(dir, "plugin.jar"), temp)
  fs.renameSync(temp, jar)
  save(path.join(target, ".idectl.json"), { revision, sha256: current.sha256, sdk: current.build, ide: build })
  return { ok: true, phase: "installed" }
}

async function worker(dir: string, sdk: string, build: string, self = false, mcp = "", flutter = "") {
  const file = path.join(dir, "state.json")
  const token = stamp(globalThis.process.pid)
  if (!token) throw new Error("Cannot identify plugin build process")
  const log = fs.openSync(path.join(dir, "build.log"), "a", 0o600)
  const update = (phase: string, extra: Record<string, unknown> = {}) => save(file, { phase, pid: globalThis.process.pid, token, revision, build, ...extra })
  try {
    update("copying")
    const source = path.join(dir, "source")
    fs.cpSync(plugin, source, { recursive: true, filter: (file) => ![".gradle", "build", ".kotlin"].includes(path.basename(file)) })
    if (sources(source) !== revision) throw new Error("Plugin source changed while it was copied; retry the plugin build")
    update("building")
    const java = path.join(sdk, "jbr")
    if (!fs.existsSync(path.join(java, "bin/java"))) throw new Error(`The IDE runtime is missing: ${java}`)
    if (self) {
      // Built against the target IDE itself: no Rust toolset unless that IDE has the Rust plugin, and no debugger patch.
      const rust = fs.existsSync(path.join(sdk, "plugins/intellij-rust")) || fs.existsSync(path.join(sdk, "plugins/rust"))
      await run(["./gradlew", "buildPlugin", `-PidePath=${sdk}`, `-PsinceBuild=${build.split(".")[0]}`, `-Prust=${rust}`, ...(mcp ? [`-PmcpServerPath=${mcp}`] : []), ...(flutter ? [`-PflutterPath=${flutter}`] : []), "--no-daemon", "--console=plain"], source, log, { ...globalThis.process.env, JAVA_HOME: java })
      const archive = path.join(source, "build/distributions/idectl-lifecycle.zip")
      const jar = path.join(dir, "plugin.jar")
      const out = Bun.spawn(["unzip", "-p", archive, "idectl-lifecycle/lib/idectl-lifecycle.jar"], { stdout: "pipe", stderr: log, stdin: "ignore" })
      const bytes = await new Response(out.stdout).arrayBuffer()
      if (await out.exited !== 0 || bytes.byteLength === 0) throw new Error("Plugin archive does not contain the expected JAR")
      fs.writeFileSync(jar, Buffer.from(bytes), { mode: 0o600 })
      update("ready", { sha256: digest(jar) })
      return
    }
    const downloaded = path.join(base, "debugger-5.4.0")
    fs.mkdirSync(downloaded, { recursive: true, mode: 0o700 })
    const zip = path.join(downloaded, "debugger.zip")
    if (!fs.existsSync(zip) || digest(zip) !== debuggerHash) await download(downloaded)
    if (!fs.existsSync(zip) || digest(zip) !== debuggerHash) throw new Error("Verified debugger plugin download is unavailable")
    const original = path.join(dir, "debugger-original.jar")
    const extracted = Bun.spawn(["unzip", "-p", zip, `jetbrains-debugger-mcp-plugin/${debuggerJar}`], { stdout: "pipe", stderr: log, stdin: "ignore" })
    const dependency = await new Response(extracted.stdout).arrayBuffer()
    if (await extracted.exited !== 0) throw new Error("Could not extract the debugger build dependency")
    fs.writeFileSync(original, Buffer.from(dependency), { mode: 0o600 })
    if (digest(original) !== debuggerFiles[debuggerJar]) throw new Error("Debugger build dependency checksum is invalid")
    await run(["./gradlew", "buildPlugin", "debuggerPatch", `-PidePath=${sdk}`, `-PdebuggerPath=${original}`, "--no-daemon", "--console=plain"], source, log, { ...globalThis.process.env, JAVA_HOME: java })
    const patch = path.join(source, "build/distributions/debugger-patched.jar")
    if (!fs.existsSync(patch) || digest(patch) !== patched) throw new Error("Debugger patch checksum is invalid")
    fs.copyFileSync(patch, path.join(dir, "debugger-patched.jar"))
    const archive = path.join(source, "build/distributions/idectl-lifecycle.zip")
    const jar = path.join(dir, "plugin.jar")
    const out = Bun.spawn(["unzip", "-p", archive, "idectl-lifecycle/lib/idectl-lifecycle.jar"], { stdout: "pipe", stderr: log, stdin: "ignore" })
    const bytes = await new Response(out.stdout).arrayBuffer()
    if (await out.exited !== 0 || bytes.byteLength === 0) throw new Error("Plugin archive does not contain the expected JAR")
    fs.writeFileSync(jar, Buffer.from(bytes), { mode: 0o600 })
    update("ready", { sha256: digest(jar) })
  } catch (err) {
    update("failed", { error: err instanceof Error ? err.message : String(err) })
  } finally {
    fs.closeSync(log)
  }
}

export function inspect(ide: Ide, bin: string) {
  const info = product(bin)
  const sdk = sdkFor(bin)
  const target = folder(info)
  const debuggerReady = sdk.self ? debuggerInstalled(info) : validDebugger(path.join(path.dirname(target), "jetbrains-debugger-mcp-plugin"))
  const jar = path.join(target, "lib/idectl-lifecycle.jar")
  const marker = read(path.join(target, ".idectl.json"))
  if (fs.existsSync(jar)) {
    const hash = digest(jar)
    if (marker?.revision === revision && marker.sha256 === hash && marker.ide === info.build && marker.sdk === sdk.build)
      return { ok: debuggerReady, phase: debuggerReady ? "ready" : "missing_debugger" }
  }
  return { ok: false, phase: "missing" }
}

export function ensure(ide: Ide, bin: string, active: boolean) {
  const info = product(bin)
  const live = active || running(info)
  const status = inspect(ide, bin)
  if (status.ok) return { ...status, running: live }
  const target = folder(info)
  const sdk = sdkFor(bin)
  if (sdk.self) {
    // The IDE's own MCP server and the debugger come from the Marketplace when the IDE does not bundle them.
    const missing = [...(mcpPath(info) && !fs.existsSync(mcpPath(info)!) ? [marketplace.mcp] : []), ...(debuggerInstalled(info) ? [] : [marketplace.debugger])]
    if (missing.length) {
      if (live) return { ok: false, phase: "plugin_restart_required", message: `Close ${ide.name} after finishing active work, then open the project again`, running: live }
      marketplaceInstall(bin, missing)
    }
  }
  const dir = path.join(base, `${revision}-${sdk.build}`)
  const flutter = path.join(plugins(info), "flutter-intellij")
  enqueue(dir, ["worker", dir, sdk.dir, sdk.build, String(sdk.self), sdk.self ? mcpPath(info) || "" : "", sdk.self && fs.existsSync(flutter) ? flutter : ""])
  const current = state(dir)
  if (current.phase === "failed") return { ok: false, phase: "plugin_failed", error: current.error, running: live }
  if (current.phase !== "ready") return { ok: false, phase: "plugin_installing", stage: current.phase, running: live }
  if (!sdk.self) {
    const debuggerTarget = path.join(path.dirname(target), "jetbrains-debugger-mcp-plugin")
    if (!validDebugger(debuggerTarget)) {
      const result = installDebugger(debuggerTarget, path.join(base, "debugger-5.4.0"), live, ide.name, path.join(dir, "debugger-patched.jar"))
      if (!result.ok) return { ...result, running: live }
    }
  }
  return { ...install(target, dir, live, ide.name, info.build), running: live }
}

export async function wait(ide: Ide, bin: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("--timeout must be between 0 and 60 seconds")
  const until = Date.now() + seconds * 1000
  while (true) {
    const result = ensure(ide, bin, false)
    if (result.phase !== "plugin_installing" || Date.now() >= until) return result
    await Bun.sleep(Math.min(250, until - Date.now()))
  }
}

if (import.meta.main) {
  if (globalThis.process.argv[2] === "worker" && [6, 9].includes(globalThis.process.argv.length))
    await worker(globalThis.process.argv[3], globalThis.process.argv[4], globalThis.process.argv[5], globalThis.process.argv[6] === "true", globalThis.process.argv[7] || "", globalThis.process.argv[8] || "")
  else if (globalThis.process.argv[2] === "download" && globalThis.process.argv.length === 4)
    await download(globalThis.process.argv[3])
  else throw new Error("Invalid plugin worker invocation")
}
