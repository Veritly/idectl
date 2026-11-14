import fs from "node:fs"
import path from "node:path"
import { root, object, stamp, rows, field, preview } from "./core"
import { scope } from "./project"
import { debuggerClient } from "./debugger"
import { jobs, enqueue, cancel, service, launchable } from "./job"
import { vars, preflight, attach as link, detach as unlink } from "./service"
import { adapter } from "./adapter"
import { cfg, known, service as find, shm } from "./config"
import { login } from "./auth"
import { close as closeBrowser } from "./browser"

const components = Object.fromEntries(Object.values(cfg.services).map((item) => [item.id, item.project]))
const base = shm("sessions")
const cli = [process.execPath, path.join(import.meta.dir, "cli.ts")]
const front = cfg.frontend

function dir(name: string) {
  if (!components[name]) throw new Error(`Unknown service ${name}; expected ${Object.keys(components).join("|")}`)
  const hash = new Bun.CryptoHasher("sha256").update(`${root}\0${name}`).digest("hex").slice(0, 24)
  return path.join(base, hash)
}

function read(folder: string) {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(folder, "state.json"), "utf8"))
  if (!object(value)) throw new Error("Invalid debugging session state")
  return value
}

export function context(name: string) {
  if (name === "frontend") {
    const active = owner()
    throw new Error(`--service selects a Rust backend; use ${active ? active.context.join(" ") : `--ide webstorm --project ${front.project} --session ID`} for frontend debugger commands. The managed session's ready result includes browser.context with the exact selection.`)
  }
  const key = known(name) ? find(name).id : undefined
  if (!key) throw new Error(`Unknown service ${name}; expected ${Object.keys(components).join("|")}`)
  const folder = dir(key)
  const state = fs.existsSync(folder) ? read(folder) : undefined
  return { project: scope(root, components[key]).project, source: components[key], state }
}

export async function browser(name: string) {
  const state = context(name).state
  if (!state || state.phase !== "ready" || !object(state.browser) || typeof state.browser.endpoint !== "string")
    throw new Error(`Managed browser is not ready; use wait session ${name} --json, or debug up ${name} if no session is active`)
  if (typeof state.pid !== "number" || typeof state.token !== "string" || stamp(state.pid) !== state.token)
    throw new Error(`Managed session supervisor exited; use debug down ${name} to clean up`)
  const debug = debuggerClient({ chosen: "webstorm", project: scope(root, front.project).project })
  const result = await debug.launchedBrowser(await debug.endpoint(), { endpoint: state.browser.endpoint })
  if (result.pid !== state.browser.pid || result.token !== state.browser.token) throw new Error("WebStorm browser does not match the selected managed session")
  return { ...result, service: name, ...selector(state) }
}

function selector(state: Record<string, unknown>) {
  const project = scope(root, front.project).project
  const context = ["--ide", "webstorm", "--project", project]
  if (object(state.browser) && typeof state.browser.id === "string") context.push("--session", state.browser.id)
  return { project, context }
}

export function owner() {
  const active = Object.keys(components).flatMap((name) => {
    const state = context(name).state
    return state && state.cleanup !== "complete" ? [{ name, state }] : []
  })
  if (active.length > 1) throw new Error("Multiple managed sessions own the frontend; inspect and clean up those sessions")
  if (!active.length) return
  return { service: active[0].name, ...selector(active[0].state) }
}

export async function blocked(id: string) {
  const active = owner()
  if (!active || !active.context.includes("--session") || active.context.at(-1) !== id) return
  const found = context(active.service)
  if (!found.state || found.state.phase !== "ready" || typeof found.state.pid !== "number" || typeof found.state.token !== "string" || stamp(found.state.pid) !== found.state.token) return
  const debug = debuggerClient({ chosen: "rustrover", project: found.project })
  const ide = await debug.endpoint()
  const paused = rows(await debug.tool(ide, "list_debug_sessions"), "sessions")
    .filter((row) => (row.runConfigurationName === service(active.service) || row.name === service(active.service)) && row.state === "paused")
  if (!paused.length) return
  return {
    service: active.service,
    sessions: paused.map((row) => {
      const session = field(row, ["id", "sessionId"])
      if (!session) throw new Error("Paused backend session has no ID")
      return {
        session,
        inspect: `${cfg.cli} debug stack --service ${active.service} --session ${session}`,
        resume: `${cfg.cli} debug resume --service ${active.service} --session ${session}`,
      }
    }),
    hint: "The browser is still running while its managed backend is paused. Inspect the backend using the printed command, resume it when ready, then run debug wait with the browser's same selectors; do not issue another step while the previous step is running.",
  }
}

function workspace(project: string) {
  const dirs = ancestors(path.join(root, project)).filter((dir) => {
    const file = path.join(dir, "Cargo.toml")
    return fs.existsSync(file) && /^\[workspace\]/m.test(fs.readFileSync(file, "utf8"))
  })
  return dirs.at(-1) || path.join(root, project)
}

function ancestors(dir: string): string[] {
  if (dir === root || !dir.startsWith(`${root}${path.sep}`)) return []
  return [dir, ...ancestors(path.dirname(dir))]
}

export function matching(file: string) {
  const target = path.resolve(root, file)
  const inside = (dir: string) => target.startsWith(`${dir}${path.sep}`)
  const candidates = Object.keys(components).filter((name) => inside(workspace(components[name])))
  const active = Object.keys(components).filter((name) => {
    const folder = dir(name)
    if (!fs.existsSync(folder)) return false
    return !["stopped", "failed"].includes(String(read(folder).phase))
  })
  const live = candidates.filter((name) => active.includes(name))
  const direct = candidates.filter((name) => inside(path.join(root, components[name])))
  const found = live.length === 1 ? live[0] : direct.length === 1 ? direct[0] : candidates.length === 1 ? candidates[0] : undefined
  if (!found || (active.length && !active.includes(found))) return
  return context(found)
}

function save(folder: string, state: Record<string, unknown>) {
  const file = path.join(folder, `state-${process.pid}.tmp`)
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(file, path.join(folder, "state.json"))
}

export function up(name: string) {
  launchable(name, true)
  const folder = dir(name)
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const lock = path.join(base, "launch.lock")
  try { fs.mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error("Another session launch is being prepared; retry shortly") }
  try {
    for (const service of Object.keys(components)) {
      if (service === name) continue
      const other = dir(service)
      if (!fs.existsSync(other)) continue
      const state = read(other)
      if (state.cleanup !== "complete") throw new Error(`${service} already has a managed session; stop it before starting ${name}`)
    }
    if (fs.existsSync(folder)) {
      const state = read(folder)
      if (!["stopped", "failed"].includes(String(state.phase))) throw new Error(`${name} already has a debugging session; use wait session ${name}`)
      if (state.cleanup !== "complete") throw new Error("Previous session still owns resources; use debug down before retrying")
      fs.renameSync(folder, `${folder}-${Date.now()}`)
    }
    fs.mkdirSync(folder, { mode: 0o700 })
    const created = Date.now()
    save(folder, { root, service: name, phase: "queued", cleanup: "not_requested", created })
    const log = fs.openSync(path.join(folder, "worker.log"), "a", 0o600)
    const proc = Bun.spawn(["setsid", process.execPath, import.meta.path, "worker", name], { cwd: root, stdin: "ignore", stdout: log, stderr: log })
    fs.closeSync(log)
    proc.unref()
    return { ok: true, service: name, phase: "queued", created, pid: proc.pid, wait: `wait session ${name}` }
  } finally { fs.rmdirSync(lock) }
}

export function down(name: string) {
  const folder = dir(name)
  if (!fs.existsSync(folder)) return { ok: true, service: name, phase: "stopped" }
  const state = read(folder)
  if (state.cleanup === "complete") return { ok: true, service: name, phase: state.phase }
  fs.writeFileSync(path.join(folder, "stop"), "", { mode: 0o600 })
  if (state.phase === "queued" && typeof state.created === "number" && Date.now() - state.created < 10000)
    return { ok: true, service: name, phase: "stopping", cleanup: "requested", created: state.created, wait: `wait session ${name} --until stopped` }
  if (typeof state.pid !== "number" || typeof state.token !== "string" || stamp(state.pid) !== state.token) {
    const log = fs.openSync(path.join(folder, "worker.log"), "a", 0o600)
    const proc = Bun.spawn(["setsid", process.execPath, import.meta.path, "cleanup", name], { cwd: root, stdin: "ignore", stdout: log, stderr: log })
    fs.closeSync(log)
    proc.unref()
  }
  return { ok: true, service: name, phase: "stopping", cleanup: "requested", created: state.created, wait: `wait session ${name} --until stopped` }
}

export async function wait(name: string, seconds: number, goal = "ready") {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("--timeout must be between 0 and 60 seconds")
  if (!["ready", "stopped"].includes(goal)) throw new Error("--until must be ready or stopped")
  const folder = dir(name)
  const until = Date.now() + seconds * 1000
  while (true) {
    if (!fs.existsSync(folder)) return { ok: false, service: name, phase: "missing" }
    const state = read(folder)
    if (fs.existsSync(path.join(folder, "stop")) && !["failed", "stopped"].includes(String(state.phase)))
      Object.assign(state, { phase: "stopping", cleanup: state.cleanup === "running" ? "running" : "requested" })
    if (state.phase === "failed") return { ok: false, ...state, hint: state.cleanup === "complete" ? "Cleanup completed; inspect the error before starting again." : `Run debug down ${name}, then wait session ${name} --until stopped to complete cleanup.` }
    if (state.phase === "stopped") return { ok: goal === "stopped" && state.cleanup === "complete", ...state, hint: state.cleanup === "complete" ? "Cleanup completed." : `Run debug down ${name} to complete cleanup.` }
    if (typeof state.pid === "number" && typeof state.token === "string" && stamp(state.pid) !== state.token)
      return { ok: false, ...state, phase: "unknown", error: "Session supervisor exited; use debug down to clean up" }
    if (state.phase === "queued" && typeof state.created === "number" && Date.now() - state.created > 10000)
      return { ok: false, ...state, phase: "unknown", error: "Session supervisor did not start; use debug down to clean up" }
    if (state.phase === "paused" && goal === "ready") return { ok: false, ...state, hint: "Inspect the paused session or resume it to continue startup." }
    if (state.phase === "stopping" && goal === "ready") return { ok: false, ...state, hint: `Cleanup was requested; wait session ${name} --until stopped before starting another session.` }
    if (state.phase === "ready" && goal === "ready") {
      if (!object(state.browser) || typeof state.browser.endpoint !== "string") throw new Error("Ready session has no browser endpoint")
      return { ok: true, ...state, browser: { ...state.browser, ...selector(state) }, ...preview(state.browser.endpoint), next: `Set breakpoints and trigger the app action; the ${adapter.type} adapter routes ${name}'s traffic to the IDE process${find(name).mode === "replace" ? " and keeps its cluster copy stopped" : ""}. Run debug down only when finished.` }
    }
    if (Date.now() >= until) return { ok: false, ...state, phase: "waiting", stage: state.phase, hint: goal === "stopped" ? `Run wait session ${name} --until stopped again; cleanup is still progressing.` : `Run wait session ${name} again; the existing launch is still progressing.` }
    await Bun.sleep(Math.min(250, until - Date.now()))
  }
}

async function call(args: string[]) {
  const proc = Bun.spawn([...cli, ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const output = new Response(proc.stdout).text()
  const error = new Response(proc.stderr).text()
  const code = await proc.exited
  const text = await output
  const err = await error
  const value: unknown = text.trim() ? JSON.parse(text) : undefined
  if (!object(value)) throw new Error(`${args.join(" ")}: ${err.trim().slice(-2000) || `Command exited ${code}`}`)
  if (code !== 0 && code !== 2 && args[0] !== "wait") throw new Error(`${args.join(" ")}: ${typeof value.error === "string" ? value.error : err.trim() || `Command exited ${code}`}`)
  return value
}

async function worker(name: string, cleanup: boolean) {
  const folder = dir(name)
  const state = read(folder)
  if (state.root !== root || state.service !== name) throw new Error("Session belongs to another checkout")
  const token = stamp(process.pid)
  if (!token) throw new Error("Cannot identify session supervisor")
  Object.assign(state, { pid: process.pid, token })
  const update = (phase: string, extra: Record<string, unknown> = {}) => { Object.assign(state, extra, { phase }); save(folder, state) }
  const stopped = () => fs.existsSync(path.join(folder, "stop"))
  const item = find(name)
  const web = scope(root, front.project).project
  const rust = scope(root, item.project).project
  const debug = debuggerClient({ chosen: "webstorm", project: web })
  const webarg = ["--ide", "webstorm", "--project", web]
  const rustarg = ["--ide", "rustrover", "--project", rust]
  async function sessions() {
    const ide = await debug.endpoint()
    return rows(await debug.tool(ide, "list_debug_sessions", { project_path: web }), "sessions")
  }
  async function startWeb(cfg: string, key: string) {
    const all = await sessions()
    const before = all.filter((item) => item.runConfigurationName === cfg && ["running", "paused"].includes(String(item.state)))
    if (before.length > 1) throw new Error(`Multiple ${cfg} sessions are active`)
    if (before.length === 1) {
      const browser = key === "browser" ? await debug.launchedBrowser(await debug.endpoint()) : undefined
      state[key] = { id: field(before[0], ["id", "sessionId"]), owned: false, ...(browser ? { endpoint: browser.endpoint, pid: browser.pid, token: browser.token } : {}) }
      return
    }
    const prior = all.map((item) => field(item, ["id", "sessionId"])).filter(Boolean)
    update(`starting ${key}`, { [key]: { owned: true, phase: "starting", prior } })
    const result = await call(["debug", "start", cfg, ...webarg]).catch(async (err: unknown) => {
      const found = (await sessions()).filter((item) => item.runConfigurationName === cfg && ["running", "paused"].includes(String(item.state)) && !prior.includes(field(item, ["id", "sessionId"])))
      if (found.length === 1) {
        const id = field(found[0], ["id", "sessionId"])
        if (id) { state[key] = { id, owned: true }; save(folder, state) }
      }
      throw err
    })
    const session = object(result.session) ? result.session : undefined
    const id = session ? field(session, ["id", "sessionId"]) : undefined
    if (!id) throw new Error(`${cfg} started without an identifiable session; inspect WebStorm before cleanup`)
    state[key] = { id, owned: true, ...(key === "browser" && object(result.browser) ? { endpoint: result.browser.endpoint, pid: result.browser.pid, token: result.browser.token } : {}) }
    save(folder, state)
  }
  async function stopWeb(key: string) {
    const item = state[key]
    if (!object(item) || item.owned !== true) return
    if (typeof item.id !== "string") {
      const cfg = key === "browser" ? front.browser : front.configuration
      const active = (await sessions()).filter((row) => row.runConfigurationName === cfg && ["running", "paused"].includes(String(row.state)))
      const prior = Array.isArray(item.prior) ? item.prior : undefined
      const created = prior ? active.filter((row) => !prior.includes(field(row, ["id", "sessionId"]))) : []
      if (created.length === 1) {
        const id = field(created[0], ["id", "sessionId"])
        if (id) { state[key] = { id, owned: true }; save(folder, state); return stopWeb(key) }
      }
      if (active.length)
        throw new Error(`Cannot identify the ${key} session; inspect WebStorm`)
      state[key] = undefined
      save(folder, state)
      return
    }
    if (key === "browser") {
      if (typeof item.endpoint !== "string" || typeof item.pid !== "number" || typeof item.token !== "string")
        throw new Error("Owned browser has no process identity; inspect WebStorm browser sessions before cleanup")
      await closeBrowser(item.endpoint, item.pid, item.token)
    }
    const found = (await sessions()).find((row) => field(row, ["id", "sessionId"]) === item.id && ["running", "paused"].includes(String(row.state)))
    if (found) {
      const ide = await debug.endpoint()
      await debug.tool(ide, "stop_debug_session", { project_path: web, session_id: item.id }, 5000)
      const until = Date.now() + 5000
      while (Date.now() < until) {
        const active = (await sessions()).some((row) => field(row, ["id", "sessionId"]) === item.id && ["running", "paused"].includes(String(row.state)))
        if (!active) break
        await Bun.sleep(250)
      }
      if ((await sessions()).some((row) => field(row, ["id", "sessionId"]) === item.id && ["running", "paused"].includes(String(row.state))))
        throw new Error(`${key} is still stopping; retry debug down`)
    }
    state[key] = undefined
    save(folder, state)
  }
  async function attach(phase: string) {
    update(phase, { route: { phase: "creating" } })
    const value = await link(item, (detail) => update(phase, { detail }))
    state.route = { owned: value.created, ids: value.ids, mode: item.mode }
    state.detail = undefined
    save(folder, state)
  }
  async function clean() {
    update("stopping", { cleanup: "running" })
    const errors: string[] = []
    const attempt = async (run: () => Promise<void>) => {
      try { await run() } catch (err) { errors.push(err instanceof Error ? err.message : String(err)) }
    }
    const unroute = async () => {
      if (!object(state.route)) return
      if (state.route.phase === "creating") {
        if (await adapter.routed(item)) await unlink(item)
        state.route = undefined
        save(folder, state)
        return
      }
      if (state.route.owned !== true) { state.route = undefined; save(folder, state); return }
      const current = await adapter.routed(item)
      if (current && JSON.stringify(current.ids) !== JSON.stringify(state.route.ids)) throw new Error("The attachment changed; it was preserved")
      if (current) await unlink(item, (detail) => update("stopping", { cleanup: "running", detail }))
      state.route = undefined
      save(folder, state)
    }
    if (item.mode !== "replace") await attempt(unroute)
    await attempt(async () => {
      if (!object(state.frontendRoute)) return
      if (state.frontendRoute.phase === "creating") {
        if (await adapter.routed(front)) await unlink(front)
        state.frontendRoute = undefined
        save(folder, state)
        return
      }
      if (state.frontendRoute.owned !== true) { state.frontendRoute = undefined; save(folder, state); return }
      const current = await adapter.routed(front)
      if (current && JSON.stringify(current.ids) !== JSON.stringify(state.frontendRoute.ids)) throw new Error("The frontend attachment changed; it was preserved")
      if (current) await unlink(front)
      state.frontendRoute = undefined
      save(folder, state)
    })
    await attempt(() => stopWeb("browser"))
    await attempt(async () => {
      if (!object(state.backend) || state.backend.owned !== true) return
      const job = jobs(rust).find((row) => row.name === service(name))
      if (job && job.pid !== state.backend.pid) throw new Error("The backend launch changed; it was preserved")
      if (job && !["stopped", "failed"].includes(String(job.phase))) {
        cancel(service(name), rust)
        const until = Date.now() + 5000
        while (Date.now() < until) {
          const value = jobs(rust).find((row) => row.name === service(name))
          if (value && ["stopped", "failed"].includes(String(value.phase))) break
          await Bun.sleep(250)
        }
        const value = jobs(rust).find((row) => row.name === service(name))
        if (value && !["stopped", "failed"].includes(String(value.phase))) throw new Error("Backend is still stopping; retry debug down")
      }
      state.backend = undefined
      save(folder, state)
    })
    if (item.mode === "replace") await attempt(async () => {
      if (object(state.backend) && state.backend.owned === true) throw new Error(`${item.workload} stays replaced until the local backend stops; retry debug down`)
      await unroute()
    })
    await attempt(() => stopWeb("frontend"))
    if (state.frontendStatus || state.backendStatus) await attempt(async () => {
      await Promise.all([webarg, rustarg].map((args) => call(["jetbrains", "call", "idectl_save_project", "{}", ...args])))
    })
    if (errors.length) throw new Error(errors.join("; "))
    update("stopped", { cleanup: "complete", cleanupError: undefined, detail: undefined })
  }

  try {
    if (cleanup || stopped()) { await clean(); return }
    const publicUrl = vars()[front.url]
    if (!publicUrl) throw new Error(`${front.url} is required in ${cfg.env}`)
    const url = new URL("/", publicUrl).href
    update("opening frontend")
    let opened = await call(["open", front.project, "--ide", "webstorm", "--url", url])
    while (opened.phase === "plugin_installing") {
      if (stopped()) { await clean(); return }
      await Bun.sleep(500)
      opened = await call(["open", front.project, "--ide", "webstorm", "--url", url])
    }
    if (!opened.ok) throw new Error(`WebStorm is ${String(opened.phase)}: ${String(opened.reason || opened.message || "inspect open status")}`)
    update("opening backend")
    opened = await call(["open", item.project, "--ide", "rustrover"])
    while (opened.phase === "plugin_installing") {
      if (stopped()) { await clean(); return }
      await Bun.sleep(500)
      opened = await call(["open", item.project, "--ide", "rustrover"])
    }
    if (!opened.ok) throw new Error(`RustRover is ${String(opened.phase)}: ${String(opened.reason || opened.message || "inspect open status")}`)
    if (stopped()) { await clean(); return }
    update("connecting environment")
    await preflight()
    await adapter.connect()
    await startWeb(front.configuration, "frontend")
    const existing = jobs(rust).find((row) => row.name === service(name) && !["stopped", "failed"].includes(String(row.phase)))
    if (item.mode === "replace" && !existing) {
      if (stopped()) { await clean(); return }
      await attach("replacing cluster workload")
    }
    if (existing) state.backend = { pid: existing.pid, owned: false }
    else {
      update("starting backend", { backend: { owned: true, phase: "starting" } })
      const launch = enqueue(service(name), rust, true)
      state.backend = { pid: launch.pid, owned: true }
    }
    update("starting services")
    while (true) {
      if (stopped()) { await clean(); return }
      const [front, back] = await Promise.all([call(["wait", "frontend", ...webarg, "--timeout", "3"]), call(["wait", name, ...rustarg, "--timeout", "3"])])
      if (front.phase === "missing") throw new Error(`Frontend debug session disappeared during startup; inspect ${path.join(cfg.state, "frontend.log")} for its retained output`)
      if (["failed", "stopped", "unknown"].includes(String(back.phase))) throw new Error(`Backend ${String(back.phase)}: ${object(back.job) ? String(back.job.error || "inspect debug jobs") : "inspect debug jobs"}`)
      if (front.ok && back.ok) break
      const paused = back.phase === "paused" ? name : front.phase === "paused" ? "frontend" : undefined
      update(paused ? "paused" : "starting services", {
        frontendStatus: front.phase, backendStatus: back.phase, backendJob: back.job,
        reason: paused ? `${paused} paused during startup; inspect and resume. If a readiness probe hits the breakpoint repeatedly, remove or disable it` : undefined,
        resume: paused === name ? `debug resume --service ${name}` : paused ? `debug resume --ide webstorm --project ${web}` : undefined,
      })
    }
    if (stopped()) { await clean(); return }
    update("routing frontend", { frontendRoute: { phase: "creating" } })
    const routed = await link(front)
    state.frontendRoute = { owned: routed.created, ids: routed.ids }
    save(folder, state)
    if (stopped()) { await clean(); return }
    if (!object(state.route)) await attach("routing backend")
    if (stopped()) { await clean(); return }
    await startWeb(front.browser, "browser")
    const ide = await debug.endpoint()
    if (!object(state.browser) || typeof state.browser.endpoint !== "string") throw new Error("Browser launch did not report its endpoint")
    const browser = await debug.launchedBrowser(ide, { endpoint: state.browser.endpoint })
    update("authenticating browser")
    await login(browser.endpoint, url)
    update("ready", { detail: undefined, url, frontendStatus: "ready", backendStatus: "ready", backendJob: undefined, reason: undefined, resume: undefined, browser: { ...(object(state.browser) ? state.browser : {}), endpoint: browser.endpoint }, cleanup: "not_requested" })
    while (!stopped()) {
      await Bun.sleep(3000)
      if (stopped()) break
      const active = await sessions().catch((err: unknown) => {
        if (!(err instanceof Error) || !/timed?\s*out|timeout/i.test(err.message)) throw err
        update("ready", { monitor: "IDE status temporarily unavailable; retrying" })
        return undefined
      })
      if (!active) continue
      if (state.monitor) update("ready", { monitor: undefined })
      for (const key of ["frontend", "browser"]) {
        const item = state[key]
        if (!object(item) || typeof item.id !== "string" || !active.some((row) => field(row, ["id", "sessionId"]) === item.id && ["running", "paused"].includes(String(row.state))))
          throw new Error(`${key} debug session stopped`)
      }
      const job = jobs(rust).find((row) => row.name === service(name))
      if (!job || ["stopped", "failed", "unknown"].includes(String(job.phase))) throw new Error(`Backend debug session ${String(job?.phase || "disappeared")}`)
    }
    await clean()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    try { await clean(); update("failed", { error, cleanup: "complete" }) }
    catch (failure) { update("failed", { error, cleanup: "required", cleanupError: failure instanceof Error ? failure.message : String(failure) }) }
  }
}

if (import.meta.main) {
  if (!["worker", "cleanup"].includes(process.argv[2]) || !process.argv[3]) throw new Error("Invalid session supervisor invocation")
  await worker(process.argv[3], process.argv[2] === "cleanup")
}
