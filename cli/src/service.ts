import fs from "node:fs"
import path from "node:path"
import { root, file, namespace, specs, object, parse, command, attempt, sockets } from "./core"
import type { Json, Spec, Endpoint } from "./core"

export function vars(target = file) {
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

export function spec(name?: string) {
  const found = specs.find((item) => item.id === name || item.workload === name)
  if (!found) throw new Error(`unknown service ${name || ""}; expected ${specs.map((item) => item.id).join("|")}`)
  return found
}

export function port(item: Spec) {
  if (routes[item.id]) return local(item.id)
  const value = Number(vars()[item.key])
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${item.key} in ${file} must be 1..65535`)
  return value
}

export function local(name: string) {
  const key = `IDE_${name.toUpperCase()}_PORT`
  const value = Number(vars()[key])
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${key} in ${file} must be 1..65535`)
  return value
}

export async function tunnel() {
  const context = await cluster()
  const status = await attempt(async () =>
    parse(await command(["telepresence", "status", "--format", "json"], root, 5_000)),
  )
  if (status.ok && object(status.value) && object(status.value.user_daemon)) {
    const daemon = status.value.user_daemon
    if (daemon.status === "Connected" && !Array.isArray(daemon.mapped_namespaces))
      throw new Error("Telepresence returned no mapped namespaces")
    const mapped = daemon.mapped_namespaces
    if (daemon.status === "Connected" && daemon.kubernetes_context === context && Array.isArray(mapped) && mapped.includes(namespace))
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

export async function cluster() {
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
  if (!Array.isArray(row.intercept_info) || !row.intercept_info.every(object))
    throw new Error("Telepresence returned invalid intercept details")
  const info = row.intercept_info.filter(object)
  return {
    name: row.name,
    namespace: row.namespace,
    intercepts: info.map((item) => {
      if (!object(item.spec)) throw new Error("Telepresence returned an intercept without a specification")
      return {
        id: item.id,
        pod: item.pod_name,
        mechanism: item.spec.mechanism,
        target_host: item.spec.target_host,
        target_port: item.spec.target_port,
        service_port: item.spec.service_port,
        node_agent: item.spec.node_agent,
      }
    }),
  }
}

async function intercept(item: Spec) {
  const rows = await workloads()
  const active = rows.find((row) => row.name === item.workload && intercepted(row))
  if (active) {
    const value = route(active)
    if (!value.intercepts.length || !value.intercepts.every((row) => row.target_host === "127.0.0.1" && row.target_port === port(item)))
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
      ...(item.service ? ["--service", item.service] : []),
      "--mount",
      "false",
      ...(item.id !== "frontend" ? ["--node-agent"] : []),
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

export function kill(pid: number) {
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
        if (!cmd.includes(target)) return []
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
        const hit =
          cwd === path.join(root, "packages/app") &&
          cmd.some((arg, index) => arg === "--port" && cmd[index + 1] === String(port(item)))
        return hit ? [{ pid, cmd }] : []
      } catch (err) {
        if (object(err) && (err.code === "ENOENT" || err.code === "ESRCH")) return []
        throw err
      }
    })
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

export async function start(item: Spec, endpoint: () => Promise<Endpoint>) {
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

export async function stop(item: Spec) {
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

export async function state(item: Spec) {
  const live = await workloads()
  const route = live.find((row) => row.name === item.workload && intercepted(row))
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

const routes: Record<string, { workload: string; health: string; binary: string; service?: string }> = {
  data: { workload: "data-runtime", health: "/readyz", binary: "packages/veritly-data/target/debug/veritly-data-runtime" },
  server: { workload: "opencode-api", health: "/readyz", binary: "packages/veritly-server/target/debug/veritly-server" },
  edge: { workload: "veritly-edge", service: "veritly-edge", health: "/readyz", binary: "packages/veritly-edge/target/debug/veritly-edge" },
  office: { workload: "office-server", health: "/readyz", binary: "packages/veritly-office/target/debug/veritly-office-server" },
  gateway: { workload: "veritly-ai-gateway", health: "/ready", binary: "packages/ai/target/debug/veritly-ai-gateway" },
  governor: { workload: "bifrost-governor", health: "/ready", binary: "packages/ai/target/debug/veritly-ai-governor" },
}

export async function localHealth(name: string) {
  const cfg = routes[name]
  if (!cfg) throw new Error(`Unknown Rust service ${name}`)
  const port = local(name)
  const listener = (await sockets()).find((row) => row.port === port)
  const target = path.join(root, cfg.binary)
  if (!listener?.pid || !fs.existsSync(target) || !fs.existsSync(`/proc/${listener.pid}/exe`)) return { ok: false, owner: false }
  if (fs.realpathSync(`/proc/${listener.pid}/exe`) !== fs.realpathSync(target)) return { ok: false, owner: false }
  const item = { id: name, workload: cfg.workload, key: "", remote: "http", program: "", health: cfg.health }
  return { ...(await health(item)), owner: true }
}

export async function routing(enable: boolean, name: string) {
  const cfg = routes[name]
  if (!cfg) throw new Error(`Unknown Rust service ${name}; expected ${Object.keys(routes).join("|")}`)
  const port = local(name)
  const check = await command(["bun", "script/local-k8s.ts", "doctor"], root, 10_000)
  if (check.includes("local guard: blocked")) throw new Error("Local cluster doctor rejected this Kubernetes target")
  await tunnel()
  const item = { id: name, workload: cfg.workload, key: "", remote: "http", program: "", health: cfg.health, service: cfg.service }
  const active = (await workloads()).find((row) => row.name === item.workload && intercepted(row))
  if (!enable) {
    if (!active) return { ok: true, detached: false }
    const existing = route(active)
    if (!existing.intercepts.length || !existing.intercepts.every((row) => row.target_host === "127.0.0.1" && row.target_port === port))
      throw new Error(`${name} traffic is intercepted by a different target; existing intercept preserved`)
    return { ok: true, ...(await detach(item)) }
  }
  const listener = (await sockets()).find((row) => row.port === port)
  const target = path.join(root, cfg.binary)
  if (!listener?.pid || !fs.existsSync(target) || fs.realpathSync(`/proc/${listener.pid}/exe`) !== fs.realpathSync(target))
    throw new Error(`The local ${name} binary is not listening on port ${port}; start its debugger first`)
  if (!(await health(item)).ok) throw new Error(`Local ${name} is not ready on port ${port}`)
  const result = await intercept(item)
  return { ok: true, created: result.created, intercept: result.value }
}

