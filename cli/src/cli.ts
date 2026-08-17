#!/usr/bin/env bun
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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
  config: string
  mode: "debug" | "run"
  key: string
  remote: string
  program: string
  health: string
}
type Browser = {
  id: string
  config: string
  key: string
  path: string
}

const root = path.resolve(import.meta.dir, "../../..")
const file = path.join(root, ".env.local-cluster")
const officeRoot = path.resolve(process.env.VERITLY_OFFICE_ROOT || path.join(root, "../Veritly-Office"))
const namespace = "veritly"
const context = "k3d-veritly-dev"
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
    id: "backend",
    workload: "opencode-api",
    config: "Veritly Backend",
    mode: "debug",
    key: "DEV_BACKEND_PORT",
    remote: "http",
    program: "packages/opencode/src/server/main.ts",
    health: "/readyz",
  },
  {
    id: "frontend",
    workload: "opencode-frontend",
    config: "Veritly Frontend",
    mode: "run",
    key: "DEV_FRONTEND_PORT",
    remote: "http",
    program: "packages/app/script/dev.ts",
    health: "/",
  },
]
const browsers: Browser[] = [
  { id: "frontend", config: "Veritly Frontend Browser", key: "PUBLIC_BASE_URL", path: "/" },
  {
    id: "activepieces",
    config: "Veritly Activepieces Browser",
    key: "VITE_ACTIVEPIECES_WEB_URL",
    path: "/veritly/editor",
  },
  { id: "data", config: "Veritly Data Browser", key: "VITE_DATA_WEB_URL", path: "/veritly/workspace" },
  { id: "metabase", config: "Veritly Metabase Browser", key: "VITE_METABASE_WEB_URL", path: "/" },
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
const frame = option("--frame")
const details = flag("--inspect")

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

async function command(argv: string[], cwd = root, timeout?: number) {
  const proc = Bun.spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
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

async function office(values: string[]) {
  const entrypoint = path.join(officeRoot, "script/veritly-office")
  if (!fs.existsSync(entrypoint))
    throw new Error(`Veritly Office CLI was not found at ${entrypoint}; set VERITLY_OFFICE_ROOT`)
  const forwarded = [
    ...(chosen ? ["--ide", chosen] : []),
    ...(override ? ["--port", override] : []),
    ...(session ? ["--session", session] : []),
    ...(frame ? ["--frame", frame] : []),
    ...values,
  ]
  const proc = Bun.spawn([entrypoint, ...forwarded], {
    cwd: officeRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return code
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
  return
}

async function sockets() {
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
  const map = new Map(live.map((row) => [row.port, row]))
  ides.forEach((ide) => {
    if (!map.has(ide.port)) map.set(ide.port, { port: ide.port })
  })
  if (override) {
    const port = Number(override)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be 1..65535")
    if (!map.has(port)) map.set(port, { port })
  }
  const rows = await Promise.all(
    [...map.values()].map((row) => probe(row.port, row.process, row.pid).catch(() => undefined)),
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
    if (!args.project_path) args.project_path = root
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

function browser(name?: string) {
  const found = browsers.find((item) => item.id === name || item.config === name)
  if (!found) throw new Error(`unknown frontend ${name || ""}; expected ${browsers.map((item) => item.id).join("|")}|all`)
  return found
}

function address(item: Browser) {
  const base = vars()[item.key]
  if (!base) throw new Error(`${item.key} is required in ${file}`)
  return new URL(item.path, base).toString()
}

function port(item: Spec) {
  const value = Number(vars()[item.key])
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${item.key} in ${file} must be 1..65535`)
  return value
}

async function tunnel() {
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
  return parse(
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
    ),
  )
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
  if (active) return { created: false, value: route(active) }
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
        const hit = cmd.includes(target) || (cwd === root && cmd.includes(item.program))
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

function run(item: Spec) {
  const dir = path.join(root, ".veritly/ide")
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, `${item.id}.log`)
  const fd = fs.openSync(log, "a", 0o600)
  const proc = Bun.spawn(["setsid", "bun", "--no-install", item.program], {
    cwd: root,
    env: { ...process.env, ...vars(), NODE_ENV: "development" },
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  })
  fs.closeSync(fd)
  proc.unref()
  return { pid: proc.pid, log }
}

async function start(item: Spec) {
  const ide = await endpoint()
  if (item.mode === "debug") await config(ide, item.config)
  await tunnel()
  const route = await intercept(item)
  const running = pids(item)
  if (running.length) {
    const check = await health(item)
    return {
      ok: check.ok,
      reused: true,
      service: item.id,
      mode: item.mode,
      ide: ide.id,
      env: file,
      port: port(item),
      processes: running,
      health: check,
      intercept: route.value,
    }
  }
  try {
    const launch =
      item.mode === "debug"
        ? await tool(ide, "start_debug_session", { configuration_name: item.config }, 10_000)
        : run(item)
    const health = await ready(item)
    return {
      ok: health.ok,
      service: item.id,
      workload: item.workload,
      mode: item.mode,
      ide: ide.id,
      env: file,
      port: port(item),
      health,
      launch,
      intercept: route.value,
    }
  } catch (err) {
    if (route.created) await attempt(() => detach(item))
    throw err
  }
}

async function stop(item: Spec) {
  const ide = await attempt(() => endpoint())
  const stopped: unknown[] = []
  if (ide.ok && item.mode === "debug") {
    const live = await attempt(() => sessions(ide.value))
    if (live.ok) {
      for (const row of live.value.filter(
        (entry) => entry.name === item.config || entry.configurationName === item.config,
      )) {
        const id = field(row, ["sessionId", "session_id", "id"])
        stopped.push(await tool(ide.value, "stop_debug_session", id ? { session_id: id } : {}))
      }
    }
  }
  const local = pids(item)
  local.forEach((row) => process.kill(item.mode === "run" ? -row.pid : row.pid, "SIGTERM"))
  return {
    ok: true,
    service: item.id,
    sessions: stopped,
    processes: local.map((row) => row.pid),
    intercept: await detach(item),
  }
}

async function state(item: Spec) {
  const live = await attempt(() => workloads())
  const route = live.ok ? live.value.find((row) => row.name === item.workload && intercepted(row)) : undefined
  const check = await health(item)
  return {
    service: item.id,
    workload: item.workload,
    mode: item.mode,
    env: file,
    port: port(item),
    running: pids(item),
    intercepted: Boolean(route),
    health: check,
  }
}

async function open(values: string[]) {
  const active = await endpoints()
  const ide = chosen
    ? ides.find((item) => item.id === chosen)
    : ides.find((item) => item.id === active.find((row) => row.id === "webstorm")?.id) ||
      ides.find((item) => launcher(item))
  if (!ide) throw new Error(`unknown IDE ${chosen || ""}`)
  const bin = launcher(ide)
  if (!bin) throw new Error(`${ide.name} launcher was not found`)
  const target = path.resolve(root, values.shift() || ".")
  const line = values.shift()
  const argv = line ? [bin, "--line", line, target] : [bin, target]
  const proc = Bun.spawn(argv, { cwd: root, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  proc.unref()
  return { ok: true, ide: ide.id, launcher: bin, pid: proc.pid, path: target, ...(line ? { line: Number(line) } : {}) }
}

async function doctor() {
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
    configs:
      specs.every((item) => loaded.includes(item.config)) &&
      browsers.every((item) => loaded.includes(item.config)) &&
      loaded.includes("Veritly IDE Breakpoint Test"),
    services: specs.every((item) => names.includes(item.workload)),
  }
  return {
    ok: Object.values(checks).every(Boolean),
    root,
    env: file,
    namespace,
    context,
    checks,
    tunnel: telepresence,
    manager,
    ides: installed,
    selected: selected ? { id: selected.id, port: selected.port, tools: selected.tools.length } : undefined,
    configurations: runs,
    services: specs.map((item) => ({
      id: item.id,
      workload: item.workload,
      mode: item.mode,
      port: fs.existsSync(file) ? port(item) : undefined,
      configuration: item.config,
      available: names.includes(item.workload),
    })),
    frontends: browsers.map((item) => ({ id: item.id, url: address(item), configuration: item.config })),
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
      if (!JSON.stringify(inspection.variables).includes("42"))
        throw new Error(`breakpoint variables did not include 42: ${JSON.stringify(inspection.variables)}`)
      const mutation = await tool(ide, "evaluate_expression", { expression: "value = 43" })
      const changed = await tool(ide, "evaluate_expression", { expression: "value" })
      if (!JSON.stringify(changed).includes("43"))
        throw new Error(`breakpoint mutation did not return 43: ${JSON.stringify(changed)}`)
      return { ok: true, ide: ide.id, port: ide.port, breakpoint, run, paused, expression: value, inspection, mutation, changed }
    } finally {
      await attempt(() => tool(ide, "stop_debug_session"))
    }
  } finally {
    if (bid) await attempt(() => tool(ide, "remove_breakpoint", { breakpoint_id: bid }))
  }
}

async function values(ide: Endpoint, names: string[], frame = 0) {
  if (!names.length) return tool(ide, "get_variables", { frame_index: frame })
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

async function snapshot(ide: Endpoint, frame = 0, names: string[] = []) {
  const status = await tool(ide, "get_debug_session_status", { include_source_context: true, include_variables: true })
  if (!object(status) || status.state !== "paused")
    throw new Error("variable inspection requires a paused session; use debug wait --inspect or debug pause")
  const stack = await tool(ide, "get_stack_trace")
  const variables = await values(ide, names, frame)
  const source = await tool(ide, "get_source_context")
  const threads = await tool(ide, "list_threads")
  return { status, stack, variables, source, threads }
}

const usage = `veritly-ide doctor [--ide ID] [--port PORT]
veritly-ide office COMMAND... [--ide rustrover|vscode]
veritly-ide ides
veritly-ide open [PATH] [LINE] [--ide ID]
veritly-ide services
veritly-ide start|stop|status backend|frontend [--ide ID]
veritly-ide attach frontend|activepieces|data|metabase|all [--ide ID]
veritly-ide breakpoint set FILE LINE [JSON] | list | remove ID
veritly-ide debug configs|sessions|status|wait|inspect|vars|stack|source|threads|frame [...]
veritly-ide debug resume|pause|step-over|step-into|step-out|eval|set|start|run|stop [...]
veritly-ide debug commands | TOOL [JSON|-]
veritly-ide mcp tools | call TOOL [JSON|-]
veritly-ide test breakpoint

Use --session ID and --frame N to target context. Pass names to debug vars, or --inspect with debug wait.
All result data is JSON on stdout. Errors are JSON on stderr.`

async function main() {
  const group = args.shift()
  if (!group || group === "help" || group === "--help" || group === "-h") {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (group === "office") return office(args)
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
        return { ...ide, installed: Boolean(bin), launcher: bin, endpoint: active.find((item) => item.id === ide.id) }
      }),
    )
    return 0
  }
  if (group === "open" || group === "launch") {
    print(await open(args))
    return 0
  }
  if (group === "services") {
    print(
      specs.map((item) => ({
        id: item.id,
        workload: item.workload,
        mode: item.mode,
        port: port(item),
        env: file,
        configuration: item.config,
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
  if (group === "attach") {
    const name = args.shift()
    const targets = name === "all" ? browsers : [browser(name)]
    const ide = await endpoint()
    await Promise.all(targets.map((item) => config(ide, item.config)))
    const sessions = []
    for (const item of targets) {
      sessions.push({
        frontend: item.id,
        url: address(item),
        session: await tool(ide, "start_debug_session", { configuration_name: item.config }, 10_000),
      })
    }
    print({ sessions })
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
      print(
        ide.tools.map((item) => ({
          command: typeof item.name === "string" ? item.name.replaceAll("_", "-") : item.name,
          tool: item.name,
          description: item.description,
          inputSchema: item.inputSchema,
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
    if (action && map[action]) print(await tool(ide, map[action], await input(args), 30_000))
    else if (action === "wait") {
      const timeout = args[0] && /^\d+$/.test(args[0]) ? Number(args.shift()) : 5
      if (timeout < 1) throw new Error("debug wait timeout must be positive")
      const pause = await tool(ide, "wait_for_pause", { timeout }, 30_000)
      if (!details && args.length) throw new Error("debug wait variable names require --inspect")
      print(details ? { pause, ...(await snapshot(ide, index(), args)) } : pause)
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
    } else if (action === "stack") print(await tool(ide, "get_stack_trace", await input(args)))
    else if (action === "source") print(await tool(ide, "get_source_context", await input(args)))
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
      print(await tool(ide, "start_debug_session", { configuration_name: name }, 10_000))
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
