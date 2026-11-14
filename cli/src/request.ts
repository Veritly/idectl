import fs from "node:fs"
import path from "node:path"
import { root, object, stamp } from "./core"
import { context } from "./session"
import { adapter } from "./adapter"
import { service, shm } from "./config"

const base = shm("requests")

function folder(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid request ID")
  return path.join(base, id)
}

function save(dir: string, state: Record<string, unknown>) {
  const file = path.join(dir, `state-${process.pid}.tmp`)
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(file, path.join(dir, "state.json"))
}

function read(dir: string) {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))
  if (!object(value) || value.root !== root) throw new Error("Invalid request state or different checkout")
  return value
}

export async function start(name: string, route: string, seconds?: number) {
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60)) throw new Error("--timeout must be between 0 and 60 seconds")
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("#")) throw new Error("Request path must begin with a single / and contain no fragment")
  const state = context(name).state
  if (!state || state.phase !== "ready" || typeof state.created !== "number") throw new Error(`Start and wait for the managed ${name} session before sending a request`)
  const origin = new URL(await adapter.url(service(name)))
  const target = new URL(route, origin)
  if (target.origin !== origin.origin) throw new Error("Request must target the selected cluster Service")
  const id = crypto.randomUUID()
  const dir = folder(id)
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  fs.mkdirSync(dir, { mode: 0o700 })
  const created = Date.now()
  const expires = seconds === undefined ? undefined : created + seconds * 1000
  save(dir, { root, id, service: name, session: state.created, phase: "queued", created, expires })
  const proc = Bun.spawn(["setsid", process.execPath, import.meta.path, "worker", id, target.href, String(seconds === undefined ? 0 : seconds)], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  proc.unref()
  return { ok: true, id, service: name, phase: "queued", expires, wait: `wait request ${id}` }
}

export async function wait(id: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("--timeout must be between 0 and 60 seconds")
  const dir = folder(id)
  if (!fs.existsSync(dir)) throw new Error("Request not found")
  const until = Date.now() + seconds * 1000
  while (true) {
    const state = read(dir)
    if (state.phase === "complete") return { ...state, ok: state.ok === true }
    if (state.phase === "failed") return { ...state, ok: false }
    if (typeof state.pid === "number" && typeof state.token === "string" && stamp(state.pid) !== state.token)
      return { ...state, ok: false, phase: "unknown", error: "Request worker exited unexpectedly" }
    if (state.phase === "queued" && typeof state.created === "number" && Date.now() - state.created > 10000)
      return { ...state, ok: false, phase: "unknown", error: "Request worker did not start" }
    if (Date.now() >= until) return { ...state, ok: false, phase: "waiting", hint: `Check debug status --service ${String(state.service)}; if paused, inspect and resume, then run wait request ${id} again.` }
    await Bun.sleep(Math.min(250, until - Date.now()))
  }
}

async function worker(id: string, url: string, seconds: number) {
  const dir = folder(id)
  const state = read(dir)
  const token = stamp(process.pid)
  if (!token) throw new Error("Cannot identify request worker")
  Object.assign(state, { phase: "running", pid: process.pid, token })
  save(dir, state)
  if (typeof state.service !== "string" || typeof state.session !== "number") throw new Error("Request has no managed session")
  const name = state.service
  const controller = new AbortController()
  const timer = seconds > 0 ? setTimeout(() => controller.abort(new Error("Request timed out")), seconds * 1000) : undefined
  const watcher = setInterval(() => {
    try {
      const session = context(name).state
      if (!session || session.created !== state.session || ["stopping", "stopped", "failed"].includes(String(session.phase)) ||
          typeof session.pid === "number" && typeof session.token === "string" && stamp(session.pid) !== session.token)
        controller.abort(new Error("Debug session ended"))
    } catch { controller.abort(new Error("Debug session is unavailable")) }
  }, 1000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    if (reader) while (true) {
      const part = await reader.read()
      if (part.done) break
      const remaining = 16384 - size
      chunks.push(part.value.subarray(0, remaining))
      size += Math.min(part.value.length, remaining)
      if (part.value.length > remaining || size === 16384) { truncated = true; await reader.cancel(); break }
    }
    Object.assign(state, { phase: "complete", ok: response.ok, status: response.status, body: Buffer.concat(chunks).toString("utf8"), truncated })
  } catch (err) {
    Object.assign(state, { phase: "failed", ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (timer) clearTimeout(timer)
    clearInterval(watcher)
  }
  save(dir, state)
}

if (import.meta.main) {
  if (process.argv[2] !== "worker" || !process.argv[3] || !process.argv[4] || !process.argv[5]) throw new Error("Invalid request worker invocation")
  await worker(process.argv[3], process.argv[4], Number(process.argv[5]))
}
