#!/usr/bin/env bun
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { browser, prepare, scope } from "./project"

type Json = Record<string, unknown>
type Ide = {
  id: string
  name: string
  port: number
  bins: string[]
  apps: string[]
}
type Endpoint = {
  id: string
  name: string
  port: number
  url: string
  pid?: number
  process?: string
  tools: Json[]
}
type Spec = {
  id: string
  workload: string
  key: string
  remote: string
  program: string
  health: string
}

const root = path.resolve(import.meta.dir, "../../..")
const file = path.join(root, ".env.local-cluster")
const namespace = "veritly"
const ides: Ide[] = [
  { id: "intellij", name: "IntelliJ IDEA", port: 29190, bins: ["idea"], apps: ["intellij-idea"] },
  { id: "android-studio", name: "Android Studio", port: 29191, bins: ["studio"], apps: ["android-studio"] },
  { id: "pycharm", name: "PyCharm", port: 29192, bins: ["pycharm"], apps: ["pycharm"] },
  { id: "webstorm", name: "WebStorm", port: 29193, bins: ["webstorm"], apps: ["webstorm"] },
  { id: "goland", name: "GoLand", port: 29194, bins: ["goland"], apps: ["goland"] },
  { id: "phpstorm", name: "PhpStorm", port: 29195, bins: ["phpstorm"], apps: ["phpstorm"] },
  { id: "rubymine", name: "RubyMine", port: 29196, bins: ["rubymine"], apps: ["rubymine"] },
  { id: "clion", name: "CLion", port: 29197, bins: ["clion"], apps: ["clion"] },
  { id: "rustrover", name: "RustRover", port: 29198, bins: ["rustrover"], apps: ["rustrover"] },
  { id: "datagrip", name: "DataGrip", port: 29199, bins: ["datagrip"], apps: ["datagrip"] },
  { id: "aqua", name: "Aqua", port: 29200, bins: ["aqua"], apps: ["aqua"] },
  { id: "dataspell", name: "DataSpell", port: 29201, bins: ["dataspell"], apps: ["dataspell"] },
  { id: "rider", name: "Rider", port: 29202, bins: ["rider"], apps: ["rider"] },
]
const specs: Spec[] = [
  {
    id: "frontend",
    workload: "veritly-frontend-dev",
    key: "DEV_FRONTEND_PORT",
    remote: "http",
    program: "packages/app/node_modules/vite/bin/vite.js",
    health: "/",
  },
]

const args = process.argv.slice(2)

function option(name: string) {
  const inline = args.findIndex((arg) => arg.startsWith(`${name}=`))
  if (inline !== -1) return args.splice(inline, 1)[0].slice(name.length + 1)
  const pos = args.indexOf(name)
  if (pos === -1) return
  const value = args[pos + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  args.splice(pos, 2)
  return value
}

function flag(name: string) {
  const pos = args.indexOf(name)
  if (pos === -1) return false
  args.splice(pos, 1)
  return true
}

const chosen = option("--ide")
const override = option("--port")
const session = option("--session")
const project = option("--project")
const frame = option("--frame")
const details = flag("--inspect")
const url = option("--url")

function object(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function message(value: unknown) {
  if (value instanceof Error) return value.message
  return String(value)
}

function index() {
  if (!frame) return 0
  const value = Number(frame)
  if (!Number.isInteger(value) || value < 0) throw new Error("--frame must be a non-negative integer")
  return value
}

function parse(value: string) {
  if (!value.trim()) throw new Error("command returned empty output")
  const data: unknown = JSON.parse(value)
  return data
}

async function command(argv: string[], cwd = root, timeout?: number, env = process.env) {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const state = { timed: false }
  const timer = timeout
    ? setTimeout(() => {
        state.timed = true
        proc.kill()
      }, timeout)
    : undefined
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (timer) clearTimeout(timer)
  if (state.timed) throw new Error(`${argv.join(" ")} timed out after ${timeout}ms`)
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `${argv.join(" ")} failed with ${code}`)
  return stdout.trim()
}

async function attempt<T>(run: () => Promise<T>) {
  try {
    return { ok: true as const, value: await run() }
  } catch (err) {
    return { ok: false as const, error: message(err) }
  }
}

function launcher(ide: Ide) {
  for (const bin of ide.bins) {
    const found = Bun.which(bin)
    if (found) return found
  }
  const base = path.join(os.homedir(), ".local/share/JetBrains/Toolbox")
  for (const bin of ide.bins) {
    const script = path.join(base, "scripts", bin)
    if (fs.existsSync(script)) return script
  }
  for (const app of ide.apps) {
    for (const bin of ide.bins) {
      for (const name of [bin, `${bin}.sh`]) {
        const target = path.join(base, "apps", app, "bin", name)
        if (fs.existsSync(target)) return target
      }
    }
  }
  const opt = path.join(os.homedir(), ".local/opt")
  if (!fs.existsSync(opt)) return
  for (const dir of fs
    .readdirSync(opt)
    .filter((dir) => dir.toLowerCase().startsWith(ide.id))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const file = path.join(opt, dir, "product-info.json")
    if (!fs.existsSync(file)) continue
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!object(data) || !Array.isArray(data.launch)) continue
    const launch = data.launch
      .filter(object)
      .find((item) => item.os === (process.platform === "linux" ? "Linux" : "macOS"))
    if (!launch || typeof launch.launcherPath !== "string") continue
    const bin = path.join(opt, dir, launch.launcherPath)
    return fs.existsSync(`${bin}.sh`) ? `${bin}.sh` : bin
  }
  return
}

async function sockets() {
  if (process.platform === "darwin") {
    const text = await command(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], root, 1000)
    const owner: { pid?: number; process?: string } = {}
    return text.split("\n").flatMap((line) => {
      if (line.startsWith("p")) owner.pid = Number(line.slice(1))
      if (line.startsWith("c")) owner.process = line.slice(1)
      const port = line.startsWith("n") ? line.match(/:(\d+)$/) : undefined
      return port ? [{ ...owner, port: Number(port[1]) }] : []
    })
  }
  const data = await attempt(() => command(["ss", "-H", "-ltnp"]))
  if (!data.ok) return []
  return data.value
    .split("\n")
    .map((line) => {
      const port = line.match(/\s(?:\[[^\]]+\]|\S+):(\d+)\s/)
      if (!port) return
      const proc = line.match(/users:\(\(\"([^\"]+)\",pid=(\d+)/)
      return {
        port: Number(port[1]),
        ...(proc ? { process: proc[1], pid: Number(proc[2]) } : {}),
      }
    })
    .filter((row): row is { port: number; process?: string; pid?: number } => Boolean(row))
}

async function owner(row: { port: number; pid?: number; process?: string }) {
  if (!row.pid) return { verified: false, reason: "listener ownership is unavailable" }
  const result = await attempt(() =>
    process.platform === "linux"
      ? Bun.file(`/proc/${row.pid}/cmdline`).text()
      : command(["ps", "-p", String(row.pid), "-o", "command="], root, 1000),
  )
  if (!result.ok) return { verified: false, reason: `cannot inspect listener PID ${row.pid}` }
  const verified =
    /com\.intellij\.idea\.Main|com\.intellij\.platform\.ide\.bootstrap|\/Contents\/MacOS\/(webstorm|rustrover|idea|clion)\b/.test(
      result.value,
    )
  return {
    verified,
    reason: verified
      ? "JetBrains process verified"
      : `port belongs to ${row.process || "another process"} (PID ${row.pid}), expected a JetBrains IDE`,
  }
}

async function rpc(port: number, method: string, params: Json, timeout = 5_000) {
  const res = await fetch(`http://127.0.0.1:${port}/debugger-mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Debugger MCP on ${port} returned HTTP ${res.status}: ${text}`)
  const data = parse(text)
  if (!object(data)) throw new Error(`Debugger MCP on ${port} returned invalid JSON-RPC`)
  if (object(data.error)) {
    const reason = typeof data.error.message === "string" ? data.error.message : JSON.stringify(data.error)
    throw new Error(reason)
  }
  return data.result
}

function identity(port: number, proc?: string) {
  const name = proc?.toLowerCase()
  if (name) {
    const found = ides.find((ide) => ide.bins.some((bin) => name.includes(bin)))
    if (found) return found
    if (name.includes("idea")) return ides[0]
  }
  return ides.find((ide) => ide.port === port)
}

async function probe(port: number, proc?: string, pid?: number) {
  const result = await rpc(port, "tools/list", {}, 500)
  if (!object(result) || !Array.isArray(result.tools)) return
  const tools = result.tools.filter(object)
  if (!tools.some((tool) => tool.name === "set_breakpoint")) return
  const ide = identity(port, proc)
  return {
    id: ide ? ide.id : proc || `port-${port}`,
    name: ide ? ide.name : proc || `JetBrains IDE on ${port}`,
    port,
    url: `http://127.0.0.1:${port}/debugger-mcp/streamable-http`,
    ...(pid ? { pid } : {}),
    ...(proc ? { process: proc } : {}),
    tools,
  } satisfies Endpoint
}

async function endpoints() {
  const live = await sockets()
  const map = new Map(live.filter((row) => identity(row.port, row.process)).map((row) => [row.port, row]))
  ides.forEach((ide) => {
    if (!map.has(ide.port)) map.set(ide.port, { port: ide.port })
  })
  if (override) {
    const port = Number(override)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be 1..65535")
    if (!map.has(port)) map.set(port, { port })
  }
  const rows = await Promise.all(
    [...map.values()].map(async (row) => {
      if (!live.some((item) => item.port === row.port)) {
        if (override && row.port === Number(override))
          throw new Error(`Debugger port ${row.port} is not listening; start the IDE and enable Debugger MCP`)
        return
      }
      const status = await owner(row)
      if (!status.verified) {
        if ((override && row.port === Number(override)) || (chosen && identity(row.port, row.process)?.id === chosen))
          throw new Error(`Debugger port ${row.port}: ${status.reason}; no probe sent`)
        return
      }
      const result = await attempt(() => probe(row.port, row.process, row.pid))
      if (!result.ok) {
        if (override || (chosen && identity(row.port, row.process)?.id === chosen))
          throw new Error(`JetBrains owns port ${row.port}, but Debugger MCP is unavailable: ${result.error}`)
        return
      }
      return result.value
    }),
  )
  return rows.filter((row): row is Endpoint => Boolean(row)).sort((a, b) => a.port - b.port)
}

async function endpoint() {
  const rows = await endpoints()
  if (override) {
    const found = rows.find((row) => row.port === Number(override))
    if (found) return found
    throw new Error(`no Debugger MCP server found on port ${override}`)
  }
  if (chosen) {
    const found = rows.find((row) => row.id === chosen || row.name.toLowerCase() === chosen.toLowerCase())
    if (found) return found
    throw new Error(`no active Debugger MCP server found for ${chosen}`)
  }
  const webstorm = rows.find((row) => row.id === "webstorm")
  if (webstorm) return webstorm
  if (rows[0]) return rows[0]
  throw new Error("no JetBrains Debugger MCP server found; launch an IDE and enable the Debugger MCP Server plugin")
}

function content(result: unknown) {
  if (!object(result)) return result
  if (result.isError === true) {
    const rows = Array.isArray(result.content) ? result.content.filter(object) : []
    const text = rows
      .map((row) => row.text)
      .filter((value): value is string => typeof value === "string")
      .join("\n")
    throw new Error(text || "Debugger MCP tool failed")
  }
  if (result.structuredContent !== undefined) return result.structuredContent
  const rows = Array.isArray(result.content) ? result.content.filter(object) : []
  const text = rows.find((row) => typeof row.text === "string")?.text
  if (typeof text !== "string") return result
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function tool(ide: Endpoint, name: string, input: Json = {}, timeout = 5_000) {
  const schema = ide.tools.find((item) => item.name === name)
  if (!schema) throw new Error(`${ide.name} does not expose ${name}`)
  const args = { ...input }
  const props = object(schema.inputSchema) && object(schema.inputSchema.properties) ? schema.inputSchema.properties : {}
  if (session && props.session_id && !args.session_id) args.session_id = session
  if (props.project_path) {
    if (!args.project_path) args.project_path = project ? path.resolve(project) : root
  }
  if (props.session_id && !args.session_id && !(name === "get_source_context" && args.file_path)) {
    const result = content(
      await rpc(ide.port, "tools/call", {
        name: "list_debug_sessions",
        arguments: { project_path: args.project_path },
      }),
    )
    const live = rows(result, "sessions")
    if (live.length > 1)
      throw new Error(
        `Select --session ID: ${JSON.stringify(live.map((row) => ({ id: row.id, name: row.name, state: row.state })))}`,
      )
    if (live.length === 1) args.session_id = field(live[0], ["id", "sessionId"])
  }
  return content(await rpc(ide.port, "tools/call", { name, arguments: args }, timeout))
}

async function input(values: string[]) {
  const inline = values.join(" ").trim()
  const raw =
    inline === "-"
      ? (await Bun.stdin.text()).trim()
      : inline || (process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim())
  if (!raw) return {}
  const data: unknown = JSON.parse(raw)
  if (!object(data)) throw new Error("arguments must be a JSON object")
  return data
}

function vars(target = file) {
  if (!fs.existsSync(target)) throw new Error(`${target} is required`)
  return fs
    .readFileSync(target, "utf8")
    .split("\n")
    .reduce<Record<string, string>>((all, line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
      if (!match) return all
      const raw = match[2].trim()
      const value =
        raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
          ? raw.slice(1, -1)
          : raw
      all[match[1]] = value
      return all
    }, {})
}

function spec(name?: string) {
  const found = specs.find((item) => item.id === name || item.workload === name)
  if (!found) throw new Error(`unknown service ${name || ""}; expected ${specs.map((item) => item.id).join("|")}`)
  return found
}

function port(item: Spec) {
  const value = Number(vars()[item.key])
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${item.key} in ${file} must be 1..65535`)
  return value
}

async function tunnel() {
  const context = await cluster()
  const status = await attempt(async () =>
    parse(await command(["telepresence", "status", "--format", "json"], root, 5_000)),
  )
  if (status.ok && object(status.value) && object(status.value.user_daemon)) {
    const daemon = status.value.user_daemon
    const mapped = Array.isArray(daemon.mapped_namespaces) ? daemon.mapped_namespaces : []
    if (daemon.status === "Connected" && daemon.kubernetes_context === context && mapped.includes(namespace))
      return status.value
    if (daemon.status === "Connected")
      throw new Error(`Telepresence is connected to ${String(daemon.kubernetes_context)} without ${namespace} mapped`)
  }
  await command(
    [
      "telepresence",
      "connect",
      "--context",
      context,
      "--namespace",
      namespace,
      "--mapped-namespaces",
      namespace,
      "--format",
      "json",
      "--progress",
      "quiet",
    ],
    root,
    10_000,
  )
  const current = parse(await command(["telepresence", "status", "--format", "json"], root, 5000))
  if (!object(current) || !object(current.user_daemon) || current.user_daemon.status !== "Connected")
    throw new Error("Telepresence connect returned without a connected daemon; run telepresence status")
  return current
}

async function cluster() {
  const value = (await command(["kubectl", "config", "current-context"], root, 1000)).trim()
  if (!value) throw new Error("select this VM's Kubernetes context before connecting")
  return value
}

async function workloads() {
  const data = parse(
    await command(
      ["telepresence", "list", "--namespace", namespace, "--format", "json", "--progress", "quiet"],
      root,
      5_000,
    ),
  )
  if (!Array.isArray(data)) throw new Error("telepresence list returned invalid JSON")
  return data.filter(object)
}

function intercepted(row: Json) {
  if (Array.isArray(row.intercept_info) && row.intercept_info.length) return true
  if (typeof row.state === "string" && row.state.toLowerCase().includes("intercept")) return true
  return false
}

function route(row: Json) {
  const info = Array.isArray(row.intercept_info) ? row.intercept_info.filter(object) : []
  return {
    name: row.name,
    namespace: row.namespace,
    intercepts: info.map((item) => {
      const spec = object(item.spec) ? item.spec : {}
      return {
        id: item.id,
        pod: item.pod_name,
        mechanism: spec.mechanism,
        target_host: spec.target_host,
        target_port: spec.target_port,
        service_port: spec.service_port,
        node_agent: spec.node_agent,
      }
    }),
  }
}

async function intercept(item: Spec) {
  const rows = await workloads()
  const active = rows.find((row) => row.name === item.workload && intercepted(row))
  if (active) {
    const value = route(active)
    if (!value.intercepts.every((row) => row.target_host === "127.0.0.1" && row.target_port === port(item)))
      throw new Error(`${item.workload} already forwards to a different target; existing intercept preserved`)
    return { created: false, value }
  }
  await command(
    [
      "telepresence",
      "intercept",
      item.workload,
      "--namespace",
      namespace,
      "--port",
      `${port(item)}:${item.remote}`,
      "--mount",
      "false",
      "--format",
      "json",
      "--progress",
      "quiet",
    ],
    root,
    20_000,
  )
  const found = (await workloads()).find((row) => row.name === item.workload && intercepted(row))
  if (!found) throw new Error(`Telepresence did not create an intercept for ${item.workload}`)
  return { created: true, value: route(found) }
}

async function detach(item: Spec) {
  const rows = await workloads()
  if (!rows.some((row) => row.name === item.workload && intercepted(row))) return { detached: false }
  await command(
    ["telepresence", "detach", item.workload, "--namespace", namespace, "--format", "json", "--progress", "quiet"],
    root,
    5_000,
  )
  return { detached: true }
}

async function configs(ide: Endpoint) {
  const data = await tool(ide, "list_run_configurations")
  if (!object(data) || !Array.isArray(data.configurations)) return []
  return data.configurations.filter(object)
}

async function config(ide: Endpoint, name: string) {
  for (const delay of [0, 200, 400, 800, 1_600]) {
    if (delay) await Bun.sleep(delay)
    const rows = await configs(ide)
    const found = rows.find((row) => row.name === name)
    if (found) return found
  }
  throw new Error(`${name} is not loaded in ${ide.name}; open ${root} and let project run configurations refresh`)
}

async function health(item: Spec) {
  const url = `http://127.0.0.1:${port(item)}${item.health}`
  const hit = await fetch(url, { signal: AbortSignal.timeout(500) }).then(
    (res) => ({ ok: res.ok, status: res.status }),
    () => ({ ok: false, status: 0 }),
  )
  return { ...hit, url }
}

async function ready(item: Spec) {
  for (const wait of [100, 100, 200, 300, 500, 800, 1_000, 1_000, 1_000]) {
    const hit = await health(item)
    if (hit.ok) return hit
    await Bun.sleep(wait)
  }
  return health(item)
}

function kill(pid: number) {
  try {
    process.kill(-pid, "SIGTERM")
  } catch (err) {
    if (!object(err) || err.code !== "ESRCH") throw err
  }
}

function pids(item: Spec) {
  const target = path.join(root, item.program)
  return fs
    .readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .flatMap((entry) => {
      const pid = Number(entry.name)
      if (pid === process.pid) return []
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
        const hit =
          cwd === path.join(root, "packages/app") &&
          cmd.includes(target) &&
          cmd.some((arg, index) => arg === "--port" && cmd[index + 1] === String(port(item)))
        return hit ? [{ pid, cmd }] : []
      } catch {
        return []
      }
    })
}

function rows(value: unknown, key: string) {
  if (!object(value) || !Array.isArray(value[key])) return []
  return value[key].filter(object)
}

function field(value: Json, names: string[]) {
  return names.map((name) => value[name]).find((item): item is string => typeof item === "string" && Boolean(item))
}

async function sessions(ide: Endpoint) {
  return rows(await tool(ide, "list_debug_sessions"), "sessions")
}

async function launch(ide: Endpoint, name: string) {
  await config(ide, name)
  const before = await sessions(ide)
  const result = await attempt(() => tool(ide, "start_debug_session", { configuration_name: name }, 10_000))
  if (result.ok) return result.value
  if (!/timed?\s*out|timeout/i.test(result.error)) throw new Error(result.error)
  const live = (await sessions(ide)).filter(
    (row) =>
      (row.name === name || row.runConfigurationName === name) &&
      !before.some((old) => field(old, ["id", "sessionId"]) === field(row, ["id", "sessionId"])),
  )
  if (live.length === 1)
    return {
      status: "started",
      verified: true,
      message: "Start reply timed out; verified the new session without launching again",
      session: live[0],
    }
  throw new Error(`Start reply timed out; launch outcome is unknown. Inspect debug sessions before repeating ${name}`)
}

async function run(item: Spec) {
  const dir = path.join(root, ".veritly/ide")
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, `${item.id}.log`)
  const host = (
    await command(
      ["kubectl", "get", "service", "kubernetes", "-n", "default", "-o", "jsonpath={.spec.clusterIP}"],
      root,
      2000,
    )
  ).trim()
  if (!host) throw new Error("Kubernetes API service has no cluster IP; frontend cluster proxies cannot start")
  const fd = fs.openSync(log, "a", 0o600)
  const proc = Bun.spawn(
    [
      "setsid",
      "node",
      path.join(root, item.program),
      "--configLoader",
      "runner",
      "--host",
      "127.0.0.1",
      "--port",
      String(port(item)),
      "--strictPort",
    ],
    {
      cwd: path.join(root, "packages/app"),
      env: { ...process.env, ...vars(), NODE_ENV: "development", KUBERNETES_SERVICE_HOST: host },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    },
  )
  fs.closeSync(fd)
  proc.unref()
  return { pid: proc.pid, log }
}

async function start(item: Spec) {
  const ide = await endpoint()
  await tunnel()
  const running = pids(item)
  const listener = (await sockets()).find((row) => row.port === port(item))
  if (listener && !running.some((row) => row.pid === listener.pid))
    throw new Error(
      `Port ${port(item)} belongs to ${listener.process || "an unverified process"} (PID ${listener.pid}); no intercept created`,
    )
  if (running.length) {
    const check = await health(item)
    if (!check.ok)
      throw new Error(`${item.id} is running but its health check failed; inspect .veritly/ide/${item.id}.log`)
    const route = await intercept(item)
    return {
      ok: check.ok,
      reused: true,
      service: item.id,
      mode: "run",
      ide: ide.id,
      env: file,
      port: port(item),
      processes: running,
      health: check,
      intercept: route.value,
    }
  }
  const launch = await run(item)
  try {
    const health = await ready(item)
    if (!health.ok) throw new Error(`${item.id} failed to become healthy; inspect .veritly/ide/${item.id}.log`)
    const route = await intercept(item)
    return {
      ok: health.ok,
      service: item.id,
      workload: item.workload,
      mode: "run",
      ide: ide.id,
      env: file,
      port: port(item),
      health,
      launch,
      intercept: route.value,
    }
  } catch (err) {
    if (object(launch) && typeof launch.pid === "number") kill(launch.pid)
    throw err
  }
}

async function stop(item: Spec) {
  const route = await detach(item)
  const local = pids(item)
  local.forEach((row) => kill(row.pid))
  return {
    ok: true,
    service: item.id,
    processes: local.map((row) => row.pid),
    intercept: route,
  }
}

async function state(item: Spec) {
  const live = await attempt(() => workloads())
  const route = live.ok ? live.value.find((row) => row.name === item.workload && intercepted(row)) : undefined
  const check = await health(item)
  return {
    service: item.id,
    workload: item.workload,
    mode: "run",
    env: file,
    port: port(item),
    running: pids(item),
    intercepted: Boolean(route),
    health: check,
  }
}

function record(dir: string) {
  const key = new Bun.CryptoHasher("sha256").update(dir).digest("hex").slice(0, 16)
  return path.join(root, ".veritly/ide/open", `${key}.json`)
}

function stamp(pid: number) {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")
    if (value[0] !== "Z") return value[19]
  } catch (err) {
    if (!object(err) || err.code !== "ENOENT") throw err
  }
}

async function settings(bin: string, dir: string) {
  const file = path.join(path.dirname(path.dirname(fs.realpathSync(bin))), "product-info.json")
  if (!fs.existsSync(file)) return
  const info: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!object(info) || typeof info.dataDirectoryName !== "string")
    throw new Error(`Invalid IDE product metadata: ${file}`)
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support/JetBrains")
      : path.join(os.homedir(), ".config/JetBrains")
  await command(
    [
      "python3",
      "-c",
      `
from pathlib import Path
from xml.etree import ElementTree as E
import sys
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
def load(name):
 p=root/name
 return p,E.parse(p).getroot() if p.exists() else E.Element('application')
def child(root,tag,attrs):
 value=next((x for x in root if x.tag==tag and all(x.get(k)==v for k,v in attrs.items())),None)
 return E.SubElement(root,tag,attrs) if value is None else value
p,tree=load('trusted-paths.xml')
c=child(tree,'component',{'name':'Trusted.Paths'})
m=child(child(c,'option',{'name':'TRUSTED_PROJECT_PATHS'}),'map',{})
child(m,'entry',{'key':sys.argv[2]}).set('value','true')
E.ElementTree(tree).write(p,encoding='unicode')
p,tree=load('other.xml')
c=child(tree,'component',{'name':'PropertiesComponent'})
child(c,'property',{'name':'power.save.mode'}).set('value','true')
E.ElementTree(tree).write(p,encoding='unicode')
`,
      path.join(base, info.dataDirectoryName, "options"),
      dir,
    ],
    root,
    2000,
  )
}

async function open(values: string[]) {
  const target = values.shift()
  if (!target && !project) throw new Error("open requires a component directory or source file")
  const cfg = project
    ? {
        project: path.resolve(project),
        source: path.resolve(root, target || project),
        file: fs.statSync(path.resolve(root, target || project)).isFile(),
        ide: chosen || "webstorm",
      }
    : scope(root, target!)
  const ide = ides.find((item) => item.id === (chosen || cfg.ide))
  if (!ide) throw new Error(`unknown IDE ${chosen || cfg.ide}`)
  const bin = launcher(ide)
  if (!bin) throw new Error(`${ide.name} is not installed; install it and the Debugger MCP plugin on this VM`)
  const line = values.shift()
  if (line && (!Number.isInteger(Number(line)) || Number(line) < 1)) throw new Error("line must be a positive integer")
  const listener = (await sockets()).find((row) => row.port === ide.port)
  if (listener) {
    const status = await owner(listener)
    if (!status.verified) throw new Error(`Port ${ide.port}: ${status.reason}; no IDE launched`)
  }
  if (!project) prepare(cfg as ReturnType<typeof scope>)
  if (url && ide.id !== "webstorm") throw new Error("--url requires WebStorm")
  if (url) browser(root, scope(root, cfg.source).component, cfg.project, url, Boolean(listener))
  if (!listener) await settings(bin, cfg.project)
  const file = record(cfg.project)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const previous: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined
  const display =
    process.env.DISPLAY ||
    (listener?.pid && process.platform === "linux"
      ? fs
          .readFileSync(`/proc/${listener.pid}/environ`, "utf8")
          .split("\0")
          .find((item) => item.startsWith("DISPLAY="))
          ?.slice(8)
      : undefined)
  const argv = [bin, cfg.project]
  if (process.platform === "linux" && !display) {
    if (!Bun.which("xvfb-run") || !Bun.which("xauth"))
      throw new Error("Headless IDE launch requires xvfb-run and xauth on this VM")
    argv.unshift("xvfb-run", "-a", "--server-args=-screen 0 1440x900x24 -nolisten tcp")
  }
  if (process.platform === "linux") argv.unshift("setsid")
  const log = file.replace(/\.json$/, ".log")
  const fd = fs.openSync(log, "a", 0o600)
  const proc = Bun.spawn(argv, {
    cwd: root,
    env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  })
  fs.closeSync(fd)
  proc.unref()
  const state = {
    ide: ide.id,
    project: cfg.project,
    source: cfg.source,
    pid: proc.pid,
    token: process.platform === "linux" ? stamp(proc.pid) : undefined,
    owned: process.platform === "linux" && !listener,
    ...(object(previous) &&
    previous.owned === true &&
    typeof previous.token === "string" &&
    previous.closed !== true &&
    typeof previous.pid === "number" &&
    stamp(previous.pid) === previous.token
      ? { pid: previous.pid, token: previous.token, owned: true }
      : {}),
    log,
    closed: false,
  }
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  const waiting = { reason: "Waiting for the IDE and Debugger MCP project to load" }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null && proc.exitCode !== 0)
      throw new Error(`${ide.name} launch failed (${proc.exitCode}); inspect ${log}`)
    const ready = await attempt(async () => {
      const live = (await endpoints()).find((item) => item.id === ide.id)
      if (!live)
        throw new Error(
          `Waiting for ${ide.name} Debugger MCP on port ${ide.port}; check ${log} if startup does not finish`,
        )
      const runs = rows(await tool(live, "list_run_configurations", { project_path: cfg.project }), "configurations")
      if (
        url &&
        !runs.some((item) => item.name === "Veritly Browser" && String(item.description).includes(new URL(url).href))
      )
        throw new Error("Waiting for WebStorm to load Veritly Browser; reopen this project if its configuration is stale")
      return live
    })
    if (ready.ok) {
      fs.writeFileSync(file, JSON.stringify({ ...state, bridge: ready.value.pid }), { mode: 0o600 })
      if (cfg.file) {
        const screen =
          display ||
          (process.platform === "linux" && ready.value.pid
            ? fs
                .readFileSync(`/proc/${ready.value.pid}/environ`, "utf8")
                .split("\0")
                .find((item) => item.startsWith("DISPLAY="))
                ?.slice(8)
            : undefined)
        await command([bin, "--line", line || "1", cfg.source], root, 5000, {
          ...process.env,
          ...(screen ? { DISPLAY: screen } : {}),
        })
      }
      return {
        ok: true,
        phase: "ide-ready",
        ide: ide.id,
        project: cfg.project,
        pid: ready.value.pid,
        port: ide.port,
        log,
        context: ["--ide", ide.id, "--project", cfg.project],
        ...(url ? { configuration: "Veritly Browser", url: new URL(url).href } : {}),
      }
    }
    waiting.reason = ready.error.slice(0, 600)
    await Bun.sleep(500)
  }
  return {
    ok: false,
    phase: "starting",
    ...state,
    reason: waiting.reason,
    context: ["--ide", ide.id, "--project", cfg.project],
  }
}

async function close(values: string[]) {
  const target = values.shift()
  if (!target && !project) throw new Error("close requires a component path or --project from open")
  const dir = project ? path.resolve(project) : scope(root, target!).project
  const file = record(dir)
  if (!fs.existsSync(file)) throw new Error(`No launcher-owned IDE record for ${dir}`)
  const state: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!object(state) || typeof state.pid !== "number" || typeof state.ide !== "string")
    throw new Error(`Invalid IDE ownership record: ${file}`)
  if (state.closed === true) return { ok: true, project: dir, phase: "already-closed" }
  const live = (await endpoints()).find((item) => item.id === state.ide)
  if (live) {
    const list = rows(await tool(live, "list_debug_sessions", { project_path: dir }), "sessions")
    for (const item of list) {
      const id = field(item, ["id", "sessionId"])
      if (!id) throw new Error("Debug session has no ID; cannot stop it safely")
      await tool(live, "stop_debug_session", { project_path: dir, session_id: id })
    }
  }
  const peers = fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(path.dirname(file), name))
    .filter((name) => name !== file)
    .map((name) => JSON.parse(fs.readFileSync(name, "utf8")) as unknown)
    .filter(object)
    .filter((item) => item.closed !== true && item.bridge && item.bridge === state.bridge)
  if (state.owned && peers.length) throw new Error("Other launcher projects use this IDE; close those projects first")
  const owned = state.owned === true && typeof state.token === "string" && stamp(state.pid) === state.token
  if (owned) {
    const pid = state.pid
    const token = live?.pid ? stamp(live.pid) : undefined
    kill(pid)
    const deadline = Date.now() + 5000
    const pending = () =>
      stamp(pid) === state.token ||
      (typeof live?.pid === "number" && typeof token === "string" && stamp(live.pid) === token)
    const listening = async () => (await sockets()).some((row) => row.port === live?.port)
    while (Date.now() < deadline && (pending() || (await listening()))) await Bun.sleep(100)
    if (pending() || (await listening()))
      return {
        ok: false,
        project: dir,
        phase: "stopping",
        reason: "IDE shutdown or debugger listener cleanup is still in progress",
      }
  }
  fs.writeFileSync(file, JSON.stringify({ ...state, closed: true }), { mode: 0o600 })
  return { ok: true, project: dir, phase: owned || !live ? "stopped" : "shared-ide-kept-running" }
}

async function doctor() {
  const context = await cluster()
  const [active, telepresence, kube, service, manager] = await Promise.all([
    endpoints(),
    attempt(async () => parse(await command(["telepresence", "status", "--format", "json"]))),
    attempt(() => command(["kubectl", "config", "current-context"])),
    attempt(async () => parse(await command(["kubectl", "get", "service", "-n", namespace, "-o", "json"]))),
    attempt(async () =>
      parse(
        await command(
          [
            "helm",
            "--kube-context",
            context,
            "--namespace",
            "ambassador",
            "get",
            "values",
            "traffic-manager",
            "--output",
            "json",
          ],
          root,
          5_000,
        ),
      ),
    ),
  ])
  const selected = chosen
    ? active.find((item) => item.id === chosen)
    : active.find((item) => item.id === "webstorm") || active[0]
  const runs = selected ? await attempt(() => configs(selected)) : { ok: false as const, error: "no active IDE" }
  const installed = ides.map((ide) => {
    const bin = launcher(ide)
    const live = active.find((item) => item.id === ide.id)
    return { id: ide.id, name: ide.name, installed: Boolean(bin), launcher: bin, active: Boolean(live), endpoint: live }
  })
  const names =
    service.ok && object(service.value) && Array.isArray(service.value.items)
      ? service.value.items.filter(object).map((item) => (object(item.metadata) ? item.metadata.name : undefined))
      : []
  const daemon =
    telepresence.ok && object(telepresence.value) && object(telepresence.value.user_daemon)
      ? telepresence.value.user_daemon
      : undefined
  const mapped = daemon && Array.isArray(daemon.mapped_namespaces) ? daemon.mapped_namespaces : []
  const agent = manager.ok && object(manager.value) && object(manager.value.agent) ? manager.value.agent : undefined
  const policies = agent && object(agent.mountPolicies) ? agent.mountPolicies : undefined
  const node =
    manager.ok && object(manager.value) && object(manager.value.nodeAgent) ? manager.value.nodeAgent : undefined
  const loaded = runs.ok
    ? runs.value.map((row) => row.name).filter((name): name is string => typeof name === "string")
    : []
  const checks = {
    env: fs.existsSync(file),
    bun: Boolean(Bun.which("bun")),
    helm: Boolean(Bun.which("helm")),
    kubectl: Boolean(Bun.which("kubectl")),
    setsid: Boolean(Bun.which("setsid")),
    telepresence: Boolean(Bun.which("telepresence")),
    context: kube.ok && kube.value === context,
    namespace: service.ok,
    tunnel: daemon?.status === "Connected" && daemon.kubernetes_context === context && mapped.includes(namespace),
    manager:
      node?.enabled === true &&
      policies?.["/workspace"] === "Ignore" &&
      policies?.["/workspace/node_modules"] === "Ignore",
    ide: Boolean(selected),
    project: runs.ok,
    services: specs.every((item) => names.includes(item.workload)),
  }
  return {
    ok: Object.values(checks).every(Boolean),
    root,
    env: file,
    namespace,
    context,
    checks,
    project: project ? path.resolve(project) : root,
    tunnel: daemon ? { status: daemon.status, context: daemon.kubernetes_context, namespaces: mapped } : telepresence,
    manager: manager.ok ? { ready: checks.manager } : manager,
    ides: installed.map((item) => ({
      id: item.id,
      installed: item.installed,
      active: item.active,
      port: item.endpoint?.port,
      tools: item.endpoint?.tools.length,
    })),
    selected: selected ? { id: selected.id, port: selected.port, tools: selected.tools.length } : undefined,
    configurations: runs.ok ? loaded : runs,
    services: specs.map((item) => ({
      id: item.id,
      workload: item.workload,
      mode: "run",
      port: fs.existsSync(file) ? port(item) : undefined,
      available: names.includes(item.workload),
    })),
  }
}

async function smoke() {
  const ide = await endpoint()
  await config(ide, "Veritly IDE Breakpoint Test")
  const target = path.join(root, "packages/veritly-ide/test/fixture.ts")
  const source = await Bun.file(target).text()
  const line = source.split("\n").findIndex((row) => row.includes("veritly-ide-breakpoint")) + 1
  if (line < 1) throw new Error("breakpoint fixture marker is missing")
  const breakpoint = await tool(ide, "set_breakpoint", { file_path: target, line })
  if (!object(breakpoint)) throw new Error("set_breakpoint returned no breakpoint")
  const bid = field(breakpoint, ["breakpointId", "breakpoint_id", "id"])
  try {
    const run = await tool(ide, "start_debug_session", { configuration_name: "Veritly IDE Breakpoint Test" }, 10_000)
    try {
      const paused = await tool(ide, "wait_for_pause", { timeout: 5 }, 7_000)
      const value = await tool(ide, "evaluate_expression", { expression: "value" })
      const ok = JSON.stringify(value).includes("42")
      if (!ok) throw new Error(`breakpoint evaluation did not return 42: ${JSON.stringify(value)}`)
      const inspection = await snapshot(ide, 0, ["input", "value"])
      if (!JSON.stringify(inspection.evaluated).includes("42"))
        throw new Error(`breakpoint variables did not include 42: ${JSON.stringify(inspection.evaluated)}`)
      const mutation = await tool(ide, "evaluate_expression", { expression: "value = 43" })
      const changed = await tool(ide, "evaluate_expression", { expression: "value" })
      if (!JSON.stringify(changed).includes("43"))
        throw new Error(`breakpoint mutation did not return 43: ${JSON.stringify(changed)}`)
      return {
        ok: true,
        ide: ide.id,
        port: ide.port,
        breakpoint,
        run,
        paused,
        expression: value,
        inspection,
        mutation,
        changed,
      }
    } finally {
      await attempt(() => tool(ide, "stop_debug_session"))
    }
  } finally {
    if (bid) await attempt(() => tool(ide, "remove_breakpoint", { breakpoint_id: bid }))
  }
}

async function values(ide: Endpoint, names: string[], frame = 0) {
  if (!names.length)
    throw new Error("Choose expressions with debug vars NAME...; use debug get-variables JSON for the full scope")
  const results: unknown[] = []
  for (const expression of names)
    results.push(await tool(ide, "evaluate_expression", { expression, frame_index: frame }))
  const first = results.find(object)
  return {
    sessionId: first?.sessionId,
    frameIndex: frame,
    variables: results.map((value) => (object(value) && object(value.result) ? value.result : value)),
  }
}

function pause(value: unknown) {
  if (!object(value)) throw new Error("debugger returned invalid session status")
  return Object.fromEntries(
    [
      "waitResult",
      "message",
      "sessionId",
      "name",
      "state",
      "pausedReason",
      "currentLocation",
      "breakpointHit",
      "totalStackDepth",
    ]
      .filter((key) => value[key] !== undefined && value[key] !== null)
      .map((key) => [key, value[key]]),
  )
}

async function snapshot(ide: Endpoint, frame = 0, names: string[] = [], value?: unknown) {
  const status =
    value === undefined
      ? await tool(ide, "get_debug_session_status", {
          include_source_context: true,
          include_variables: false,
          source_context_lines: 3,
          max_stack_frames: 5,
        })
      : value
  if (!object(status) || status.state !== "paused")
    throw new Error("variable inspection requires a paused session; use debug wait --inspect or debug pause")
  return {
    ...pause(status),
    stackSummary: Array.isArray(status.stackSummary) ? status.stackSummary.slice(0, 5) : [],
    sourceContext: status.sourceContext,
    ...(names.length ? { evaluated: await values(ide, names, frame) } : {}),
  }
}

const usage = `veritly-ide doctor [--ide ID] [--port PORT]
veritly-ide ides
veritly-ide connect
veritly-ide open PATH [LINE] [--ide ID] [--url URL]
veritly-ide close PATH | close --project PATH
veritly-ide services
veritly-ide start|stop|status frontend [--ide ID]
veritly-ide breakpoint set FILE LINE [JSON] | list | remove ID
veritly-ide debug configs|sessions|status|wait|inspect|vars|stack|source|console|threads|frame [...]
veritly-ide debug resume|pause|step-over|step-into|step-out|eval|set|start|run|stop [...]
veritly-ide debug commands [TOOL] | TOOL [JSON|-]
veritly-ide mcp tools | call TOOL [JSON|-]
veritly-ide test breakpoint

Use --project PATH, --session ID and --frame N to target context. Pass names to debug vars, or --inspect with debug wait.
open selects the component's IDE and waits up to 20s; exit 2 means it is still starting. close stops launcher-owned IDEs.
Native Rust uses RustRover run configurations; discover these with debug configs, then debug start NAME.
All result data is JSON on stdout. Errors are JSON on stderr.`

async function main() {
  const group = args.shift()
  if (!group || group === "help" || group === "--help" || group === "-h") {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (group === "doctor") {
    const value = await doctor()
    print(value)
    return value.ok ? 0 : 1
  }
  if (group === "ides") {
    const active = await endpoints()
    print(
      ides.map((ide) => {
        const bin = launcher(ide)
        const live = active.find((item) => item.id === ide.id)
        return {
          id: ide.id,
          installed: Boolean(bin),
          launcher: bin,
          port: ide.port,
          pid: live?.pid,
          active: Boolean(live),
          tools: live?.tools.length,
        }
      }),
    )
    return 0
  }
  if (group === "connect") {
    await tunnel()
    print({ ok: true, context: await cluster(), namespace })
    return 0
  }
  if (group === "open" || group === "launch") {
    const value = await open(args)
    print(value)
    return value.ok ? 0 : 2
  }
  if (group === "close") {
    const value = await close(args)
    print(value)
    return value.ok ? 0 : 2
  }
  if (group === "services") {
    print(
      specs.map((item) => ({
        id: item.id,
        workload: item.workload,
        mode: "run",
        key: item.key,
        env: file,
      })),
    )
    return 0
  }
  if (["start", "stop", "status"].includes(group)) {
    const item = spec(args.shift())
    if (group === "start") {
      const value = await start(item)
      print(value)
      return value.ok ? 0 : 1
    }
    print(group === "stop" ? await stop(item) : await state(item))
    return 0
  }
  if (group === "mcp") {
    const ide = await endpoint()
    const action = args.shift()
    if (action === "tools") print(ide.tools)
    else if (action === "call") {
      const name = args.shift()
      if (!name) throw new Error("mcp call requires a tool name")
      print(await tool(ide, name, await input(args), 30_000))
    } else throw new Error("mcp expects tools|call")
    return 0
  }
  if (group === "breakpoint") {
    const ide = await endpoint()
    const action = args.shift()
    if (action === "set") {
      const target = args.shift()
      const line = Number(args.shift())
      if (!target || !Number.isInteger(line) || line < 1) throw new Error("breakpoint set requires FILE LINE")
      print(await tool(ide, "set_breakpoint", { ...(await input(args)), file_path: path.resolve(root, target), line }))
    } else if (action === "list") print(await tool(ide, "list_breakpoints"))
    else if (action === "remove") {
      const id = args.shift()
      if (!id) throw new Error("breakpoint remove requires an ID")
      print(await tool(ide, "remove_breakpoint", { breakpoint_id: id }))
    } else throw new Error("breakpoint expects set|list|remove")
    return 0
  }
  if (group === "debug") {
    const ide = await endpoint()
    const action = args.shift()
    if (action === "commands") {
      const name = args.shift()?.replaceAll("-", "_")
      if (name && !ide.tools.some((item) => item.name === name)) throw new Error(`unknown debug command ${name}`)
      print(
        ide.tools
          .filter((item) => !name || item.name === name)
          .map((item) => ({
            command: typeof item.name === "string" ? item.name.replaceAll("_", "-") : item.name,
            ...(name ? { description: item.description, inputSchema: item.inputSchema } : {}),
          })),
      )
      return 0
    }
    const map: Record<string, string> = {
      configs: "list_run_configurations",
      sessions: "list_debug_sessions",
      status: "get_debug_session_status",
      resume: "resume_execution",
      pause: "pause_execution",
      "step-over": "step_over",
      "step-into": "step_into",
      "step-out": "step_out",
      stop: "stop_debug_session",
    }
    if (action && map[action])
      print(
        await tool(
          ide,
          map[action],
          {
            ...(action === "status"
              ? { include_variables: false, include_source_context: false, max_stack_frames: 5 }
              : {}),
            ...(await input(args)),
          },
          30_000,
        ),
      )
    else if (action === "wait") {
      const timeout = args[0] && /^\d+$/.test(args[0]) ? Number(args.shift()) : 5
      if (timeout < 1) throw new Error("debug wait timeout must be positive")
      const result = await tool(ide, "wait_for_pause", { timeout }, timeout * 1000 + 2000)
      if (!details && args.length) throw new Error("debug wait variable names require --inspect")
      print(
        details && object(result) && result.state === "paused"
          ? await snapshot(ide, index(), args, result)
          : pause(result),
      )
    } else if (action === "inspect") {
      const selected = args[0] && /^\d+$/.test(args[0]) ? Number(args.shift()) : index()
      print(await snapshot(ide, selected, args))
    } else if (action === "vars") {
      const raw = args.join(" ").trim()
      print(
        raw.startsWith("{") || raw === "-"
          ? await tool(ide, "get_variables", await input(args))
          : await values(ide, args, index()),
      )
    } else if (action === "stack") print(await tool(ide, "get_stack_trace", { max_frames: 5, ...(await input(args)) }))
    else if (action === "source")
      print(await tool(ide, "get_source_context", { lines_before: 3, lines_after: 3, ...(await input(args)) }))
    else if (action === "console")
      print(await tool(ide, "get_console_output", { lines: 20, max_chars: 4000, ...(await input(args)) }))
    else if (action === "threads") print(await tool(ide, "list_threads", await input(args)))
    else if (action === "frame") {
      const frame = Number(args.shift())
      if (!Number.isInteger(frame) || frame < 0) throw new Error("debug frame requires a non-negative index")
      print(await tool(ide, "select_stack_frame", { frame_index: frame }))
    } else if (action === "eval") {
      const expression = args.join(" ").trim()
      if (!expression) throw new Error("debug eval requires an expression")
      print(await tool(ide, "evaluate_expression", { expression, frame_index: index() }))
    } else if (action === "set") {
      const target = args.shift()
      const value = args.join(" ").trim()
      if (!target || !value) throw new Error("debug set requires TARGET EXPRESSION")
      print(await tool(ide, "evaluate_expression", { expression: `${target} = (${value})`, frame_index: index() }))
    } else if (action === "start") {
      const name = args.join(" ").trim()
      if (!name) throw new Error("debug start requires a configuration name")
      print(await launch(ide, name))
    } else if (action === "run") {
      const name = args.join(" ").trim()
      if (!name) throw new Error("debug run requires a configuration name")
      print(await tool(ide, "execute_run_configuration", { name, mode: "run" }, 10_000))
    } else {
      const name = action?.replaceAll("-", "_")
      if (!name || !ide.tools.some((item) => item.name === name)) throw new Error("unknown debug command")
      print(await tool(ide, name, await input(args), 30_000))
    }
    return 0
  }
  if (group === "test" && args.shift() === "breakpoint") {
    print(await smoke())
    return 0
  }
  throw new Error(`unknown command ${group}`)
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message(err) })}\n`)
    process.exit(1)
  },
)
