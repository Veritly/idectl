import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Json = Record<string, unknown>
export type Ide = {
  id: string
  name: string
  port: number
  bins: string[]
  apps: string[]
}
export type Endpoint = {
  id: string
  name: string
  port: number
  url: string
  pid?: number
  process?: string
  tools: Json[]
}
export type Spec = {
  id: string
  workload: string
  key: string
  remote: string
  program: string
  health: string
  service?: string
}

export const root = path.resolve(import.meta.dir, "../../..")
export const file = path.join(root, ".env.local-cluster")
export const namespace = "veritly"
export const ides: Ide[] = [
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
export const specs: Spec[] = [
  {
    id: "frontend",
    workload: "veritly-frontend-dev",
    key: "DEV_FRONTEND_PORT",
    remote: "http",
    program: "packages/app/node_modules/vite/bin/vite.js",
    health: "/",
  },
]


export function object(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function preview(endpoint: string) {
  return {
    preview: {
      before: "preview_status",
      tool: "preview_open",
      arguments: { debugEndpoint: endpoint, reuseExistingTab: false },
    },
    hint: "Use T3 preview_status then preview_open with these arguments; native CUA browser discovery is separate.",
  }
}

export function message(value: unknown) {
  if (value instanceof Error) return value.message
  return String(value)
}


export function parse(value: string) {
  if (!value.trim()) throw new Error("command returned empty output")
  const data: unknown = JSON.parse(value)
  return data
}

export async function command(argv: string[], cwd = root, timeout?: number, env = process.env) {
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

export async function attempt<T>(run: () => Promise<T>) {
  try {
    return { ok: true as const, value: await run() }
  } catch (err) {
    return { ok: false as const, error: message(err) }
  }
}

export function launcher(ide: Ide) {
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
    if (!object(data) || !Array.isArray(data.launch) || !data.launch.every(object))
      throw new Error(`Invalid JetBrains product metadata: ${file}`)
    const launch = data.launch
      .filter(object)
      .find((item) => item.os === (process.platform === "linux" ? "Linux" : "macOS"))
    if (!launch || typeof launch.launcherPath !== "string") throw new Error(`No launcher for this platform in ${file}`)
    const bin = path.join(opt, dir, launch.launcherPath)
    if (!fs.existsSync(bin) && !fs.existsSync(`${bin}.sh`)) throw new Error(`JetBrains launcher is missing: ${bin}`)
    return fs.existsSync(`${bin}.sh`) ? `${bin}.sh` : bin
  }
  return
}

export async function sockets(): Promise<{ port: number; process?: string; pid?: number }[]> {
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
  const data = await command(["ss", "-H", "-ltnp"])
  return data
    .split("\n")
    .map((line) => {
      const port = line.match(/\s(?:\[[^\]]+\]|\S+):(\d+)\s/)
      if (!port) return
      const proc = line.match(/users:\(\(\"([^\"]+)\",pid=(\d+)/)
      return {
        port: Number(port[1]),
        process: proc ? proc[1] : undefined,
        pid: proc ? Number(proc[2]) : undefined,
      }
    })
    .filter((row) => row !== undefined)
}


export async function owner(row: { port: number; pid?: number; process?: string }) {
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

export async function rpc(port: number, method: string, params: Json, timeout = 5_000) {
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

export function identity(port: number, proc?: string) {
  const name = proc?.toLowerCase()
  if (name) {
    const found = ides.find((ide) => ide.bins.some((bin) => name.includes(bin)))
    if (found) return found
    if (name.includes("idea")) return ides[0]
  }
  return ides.find((ide) => ide.port === port)
}

export async function probe(port: number, proc?: string, pid?: number): Promise<Endpoint> {
  const result = await rpc(port, "tools/list", {}, 3000)
  if (!object(result) || !Array.isArray(result.tools)) throw new Error("Debugger MCP returned an invalid tool list")
  const tools = result.tools.filter(object)
  if (!tools.some((tool) => tool.name === "set_breakpoint")) throw new Error("Debugger MCP does not expose breakpoints")
  const ide = identity(port, proc)
  return {
    id: ide ? ide.id : proc || `port-${port}`,
    name: ide ? ide.name : proc || `JetBrains IDE on ${port}`,
    port,
    url: `http://127.0.0.1:${port}/debugger-mcp/streamable-http`,
    pid,
    process: proc,
    tools,
  } satisfies Endpoint
}


export function content(result: unknown) {
  if (!object(result)) throw new Error("MCP returned an invalid tool result")
  if (result.isError === true) {
    if (!Array.isArray(result.content)) throw new Error("MCP returned an invalid tool error")
    const rows = result.content.filter(object)
    const text = rows
      .map((row) => row.text)
      .filter((value): value is string => typeof value === "string")
      .join("\n")
    throw new Error(text || "Debugger MCP tool failed")
  }
  if (result.structuredContent !== undefined) return result.structuredContent
  if (!Array.isArray(result.content)) throw new Error("MCP returned a tool result without content")
  const rows = result.content.filter(object)
  const text = rows.find((row) => typeof row.text === "string")?.text
  if (typeof text !== "string") return result
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}


export function rows(value: unknown, key: string) {
  if (!object(value) || !Array.isArray(value[key])) throw new Error(`Debugger MCP returned an invalid ${key} list`)
  if (!value[key].every(object)) throw new Error(`Debugger MCP returned an invalid entry in ${key}`)
  return value[key].filter(object)
}

export function field(value: Json, names: string[]) {
  return names.map((name) => value[name]).find((item): item is string => typeof item === "string" && Boolean(item))
}


export function record(dir: string) {
  const key = new Bun.CryptoHasher("sha256").update(dir).digest("hex").slice(0, 16)
  return path.join(root, ".veritly/ide/open", `${key}.json`)
}

export function projects(ide: Endpoint) {
  const dir = path.join(root, ".veritly/ide/open")
  if (!ide.pid || !fs.existsSync(dir)) return []
  const projects = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).flatMap((file) => {
    const name = path.join(dir, file)
    const state: unknown = JSON.parse(fs.readFileSync(name, "utf8"))
    if (!object(state)) throw new Error(`Invalid IDE project record: ${name}`)
    if (state.closed === true || state.ide !== ide.id || state.bridge !== ide.pid) return []
    if (state.closed !== false || typeof state.project !== "string") throw new Error(`Invalid IDE project record: ${name}`)
    return [state.project]
  })
  return [...new Set(projects)]
}

export function opened(ide: Endpoint) {
  const unique = projects(ide)
  if (unique.length > 1) throw new Error(`Multiple ${ide.name} projects are recorded (${unique.join(", ")}); select --project PATH or --service NAME`)
  return unique[0]
}

export function stamp(pid: number) {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")
    if (value[0] !== "Z") return value[19]
  } catch (err) {
    if (!object(err) || err.code !== "ENOENT") throw err
  }
}


export async function input(values: string[]) {
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

