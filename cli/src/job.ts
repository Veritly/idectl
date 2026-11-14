import fs from "node:fs"
import path from "node:path"
import { root, object, stamp, Repair } from "./core"
import { cfg, known, service as find, shm } from "./config"
import { local } from "./service"

const base = shm("jobs")
const cli = [process.execPath, path.join(import.meta.dir, "cli.ts")]

export function service(name: string) {
  return known(name) ? find(name).configuration : name
}

function id(name: string) {
  return Object.values(cfg.services).find((item) => item.configuration === service(name))?.id
}

export function launchable(name: string, session: boolean) {
  if (!known(name) || session) return
  const item = find(name)
  if (item.mode === "replace")
    throw new Repair(`${item.id} replaces its cluster workload while it runs locally; start it with debug up ${item.id} so the session stops and restores the cluster copy. No new launch was started.`)
}

export function managed(name: string) {
  return known(name)
}

export async function wait(name: string, project: string, seconds: number) {
  const target = service(name)
  const key = id(name)
  if (!key) throw new Error(`Unknown service ${name}; expected ${Object.keys(cfg.services).join("|")}`)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("--timeout must be between 0 and 60 seconds")
  const until = Date.now() + seconds * 1000
  while (true) {
    const job = jobs(project).find((item) => item.name === target)
    if (!job) return { ok: false, phase: "missing", service: name, reason: "Start the service before waiting" }
    if (job.phase === "running" && object(job.health) && job.health.ok === true) {
      const health = await local(find(key))
      if (health.ok) return { ok: true, phase: "ready", service: name, job: { ...job, health } }
    }
    if (["failed", "stopped", "unknown"].includes(String(job.phase)))
      return { ok: false, phase: job.phase, service: name, job }
    if (job.phase === "paused") {
      return { ok: false, phase: "paused", service: name, job, hint: `Run debug inspect --service ${key}, then debug resume --service ${key} to continue.` }
    }
    if (Date.now() >= until) {
      return { ok: false, phase: "waiting", service: name, job, hint: `Run debug jobs --service ${key} or wait ${key} --service ${key} again; do not start a second launch.` }
    }
    await Bun.sleep(Math.min(250, until - Date.now()))
  }
}

function dir(name: string, project: string) {
  const hash = new Bun.CryptoHasher("sha256").update(`${root}\0${project}\0${name}`).digest("hex").slice(0, 24)
  return path.join(base, hash)
}

function read(dir: string) {
  const file = path.join(dir, "state.json")
  if (!fs.existsSync(file)) throw new Error("Launch state is missing")
  const state: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!object(state)) throw new Error("Launch state is invalid")
  return state
}

function save(dir: string, state: Record<string, unknown>) {
  const file = path.join(dir, `state-${process.pid}.tmp`)
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(file, path.join(dir, "state.json"))
}

export function jobs(project: string) {
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).flatMap((name) => {
    if (!/^[a-f0-9]{24}$/.test(name)) return []
    const folder = path.join(base, name)
    const state = read(folder)
    if (state.root !== root || state.project !== project) return []
    if (typeof state.pid === "number" && typeof state.token === "string" && stamp(state.pid) !== state.token && !["stopped", "failed"].includes(String(state.phase)))
      return [{ ...state, phase: "unknown", message: "Launch supervisor exited; inspect IDE builds and sessions before restarting" }]
    if (state.phase === "stopped") {
      const key = typeof state.name === "string" ? id(state.name) : undefined
      return [{ ...state, hint: key ? `The previous launch is stopped; run debug up ${key} to start a new managed session.` : "The previous launch is stopped; start a new launch when needed." }]
    }
    return [state]
  })
}

export function enqueue(name: string, project: string, session = false) {
  launchable(name, session)
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const folder = dir(name, project)
  if (fs.existsSync(folder)) {
    const state = read(folder)
    if (!["stopped", "failed"].includes(String(state.phase))) throw new Error(`${name} already has a launch; inspect debug jobs`)
    if (fs.readdirSync(folder).some((item) => item.startsWith("secret-"))) throw new Error(`${name} has retained credentials; inspect its previous launch`)
    fs.renameSync(folder, `${folder}-${Date.now()}`)
  }
  fs.mkdirSync(folder, { mode: 0o700 })
  save(folder, { root, name, project, phase: "queued" })
  const fd = fs.openSync(path.join(folder, "worker.log"), "a", 0o600)
  const proc = Bun.spawn(["setsid", process.execPath, import.meta.path, "worker", folder], {
    cwd: root, stdin: "ignore", stdout: fd, stderr: fd,
  })
  fs.closeSync(fd)
  proc.unref()
  return { ok: true, name, phase: "queued", pid: proc.pid }
}

export function recover(name: string, project: string) {
  launchable(name, false)
  const folder = dir(name, project)
  const state = read(folder)
  if (typeof state.pid === "number" && typeof state.token === "string" && stamp(state.pid) === state.token)
    throw new Error("Launch supervisor is already running")
  if (["stopped", "failed"].includes(String(state.phase))) throw new Error("Only an unfinished launch can be recovered")
  const fd = fs.openSync(path.join(folder, "worker.log"), "a", 0o600)
  const proc = Bun.spawn(["setsid", process.execPath, import.meta.path, "recover", folder], { cwd: root, stdin: "ignore", stdout: fd, stderr: fd })
  fs.closeSync(fd)
  proc.unref()
  return { ok: true, name, phase: "recovering", pid: proc.pid }
}

export function cancel(name: string, project: string) {
  const folder = dir(name, project)
  const state = read(folder)
  if (["stopped", "failed"].includes(String(state.phase))) return { ok: true, name, phase: state.phase }
  if (state.phase === "queued" && state.pid === undefined) {
    fs.writeFileSync(path.join(folder, "cancel"), "", { mode: 0o600 })
    return { ok: true, name, phase: "cancelling" }
  }
  if (typeof state.pid !== "number" || typeof state.token !== "string" || stamp(state.pid) !== state.token)
    throw new Error("Launch supervisor is not running; inspect IDE builds and sessions before cleanup")
  fs.writeFileSync(path.join(folder, "cancel"), "", { mode: 0o600 })
  return { ok: true, name, phase: "cancelling" }
}

async function call(args: string[]) {
  const proc = Bun.spawn([...cli, ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const out = new Response(proc.stdout).text()
  const err = new Response(proc.stderr).text()
  const code = await proc.exited
  const text = await out
  const error = await err
  if (code !== 0) throw new Error(error.trim().slice(-2000) || `CLI exited ${code}`)
  const data: unknown = JSON.parse(text)
  if (!object(data)) throw new Error("IDE returned invalid launch data")
  return data
}

async function worker(folder: string, recover: boolean) {
  const initial = read(folder)
  if (typeof initial.name !== "string" || typeof initial.project !== "string" || initial.root !== root || dir(initial.name, initial.project) !== folder)
    throw new Error("Invalid launch record")
  const name = initial.name
  const project = initial.project
  const token = stamp(process.pid)
  if (!token) throw new Error("Cannot identify launch supervisor")
  const state: Record<string, unknown> = { ...initial, pid: process.pid, token, phase: "preparing" }
  const update = (phase: string, fields: Record<string, unknown> = {}) => {
    Object.assign(state, { error: undefined }, fields, { phase })
    save(folder, state)
  }
  const args = ["--ide", "rustrover", "--project", project]
  const stopped = () => fs.existsSync(path.join(folder, "cancel"))
  const clean = () => {
    for (const item of fs.readdirSync(folder).filter((item) => /^secret-[A-Za-z0-9]+$/.test(item))) {
      const target = path.join(folder, item)
      if (!fs.lstatSync(target).isDirectory()) throw new Error("Invalid credentials directory")
      fs.rmSync(target, { recursive: true })
    }
  }
  update(recover ? "recovering" : "checking IDE", { stage: recover ? "recovering" : "checking" })
  const before = await call(["jetbrains", "status", ...args])
  if (!Array.isArray(before.sessions) || !before.sessions.every(object)) throw new Error("IDE returned invalid session list")
  const prior = before.sessions.filter(object).filter((item) => !recover || (item.runConfigurationName !== name && item.name !== name) || (item.state !== "running" && item.state !== "paused"))
  if (!recover && prior.some((item) => (item.runConfigurationName === name || item.name === name) && (item.state === "running" || item.state === "paused"))) {
    update("failed", { error: "This configuration already has an active IDE session" })
    return
  }
  const initialRuns = await call(["jetbrains", "call", "idectl_run_status", "{}", ...args])
  if (!Array.isArray(initialRuns.runs) || !initialRuns.runs.every(object)) throw new Error("IDE returned invalid execution list")
  const priorRuns = recover ? [] : initialRuns.runs.filter(object).map((item) => item.id)
  const active = await call(["jetbrains", "builds", ...args])
  if (!Array.isArray(active.builds) || !active.builds.every(object)) throw new Error("IDE returned invalid build list")
  if (!recover && active.builds.filter(object).some((item) => item.name === name)) {
    update("failed", { error: "This configuration already has an active IDE build" })
    return
  }
  if (recover) {
    const build = active.builds.filter(object).find((item) => item.name === name)
    const live = before.sessions.filter(object).filter((item) => (item.runConfigurationName === name || item.name === name) && (item.state === "running" || item.state === "paused"))
    if (live.length > 1 || (!live.length && (!build || !object(initial.build) || build.id !== initial.build.id)))
      throw new Error("Cannot verify the original build or session; inspect the IDE before cleanup")
    update("recovering", { error: undefined })
  }
  if (!recover) {
    if (stopped()) { update("stopped"); return }
    const proc = Bun.spawn(["setsid", ...cli, "jetbrains", "start", name, ...args], {
      cwd: root, env: { ...process.env, IDECTL_JOB: folder }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const output = new Response(proc.stdout).text()
    const errors = new Response(proc.stderr).text()
    const statefile = path.join(folder, "phase")
    const killed = { before: false }
    update("preparing", { stage: "preparing" })
    while (proc.exitCode === null) {
      const phase = fs.existsSync(statefile) ? fs.readFileSync(statefile, "utf8") : "preparing"
      update(stopped() ? "cancelling" : phase)
      if (stopped() && phase !== "starting IDE") {
        killed.before = true
        try { process.kill(-proc.pid, "SIGTERM") } catch (err) {
          if (!object(err) || err.code !== "ESRCH") throw err
          try { proc.kill("SIGTERM") } catch (err) { if (!object(err) || err.code !== "ESRCH") throw err }
        }
      }
      await Bun.sleep(250)
    }
    const out = await output
    const err = await errors
    if (stopped() && killed.before) {
      const until = Date.now() + 3000
      const running = () => {
        try { process.kill(-proc.pid, 0); return true } catch (err) {
          if (object(err) && err.code === "ESRCH") return false
          throw err
        }
      }
      while (running() && Date.now() < until) await Bun.sleep(100)
      if (running()) throw new Error("Preparation processes are still stopping; credentials retained")
      clean()
      update("stopped")
      return
    }
    if (proc.exitCode !== 0 && !stopped()) {
      if (fs.existsSync(statefile) && fs.readFileSync(statefile, "utf8") === "starting IDE") {
        update("unknown", { error: "IDE launch outcome is unknown; inspect builds and sessions" })
        return
      }
      clean()
      update("failed", { error: err.trim().slice(-2000) || `Launcher exited ${proc.exitCode}` })
      return
    }
    const reply: unknown = out.trim() ? JSON.parse(out) : {}
    if (!object(reply)) throw new Error("IDE returned invalid launch result")
    if (reply.state === "failed_to_start" && !stopped()) {
      clean()
      const file = path.join(folder, "output.log")
      if (typeof reply.output === "string") fs.writeFileSync(file, reply.output, { mode: 0o600 })
      update("failed", { error: "IDE failed to start the debugger", output: typeof reply.output === "string" ? file : undefined })
      return
    }
    if (typeof reply.sessionId === "string") state.session = reply.sessionId
  }
  state.stage = "monitoring"
  const cancelled = { build: "" }
  while (true) {
    try {
      const status = await call(["jetbrains", "status", ...args])
      if (!Array.isArray(status.sessions) || !status.sessions.every(object)) throw new Error("IDE returned invalid session list")
      const sessions = status.sessions.filter(object).filter((item) =>
        (item.runConfigurationName === name || item.name === name) &&
        !prior.some((old) => old.sessionId === item.sessionId),
      )
      const session = sessions.find((item) => item.state === "running" || item.state === "paused")
      const ended = sessions.find((item) => item.state === "stopped" || item.state === "failed_to_start")
      const execution = await call(["jetbrains", "call", "idectl_run_status", "{}", ...args])
      if (!Array.isArray(execution.runs) || !execution.runs.every(object)) throw new Error("IDE returned invalid execution list")
      const current = execution.runs.filter(object).filter((item) => !priorRuns.includes(item.id))
      const parent = current.find((item) => item.name === name && (item.phase === "starting" || item.phase === "running"))
      const failed = current.find((item) => item.name === name && item.phase === "failed")
      const builds = await call(["jetbrains", "builds", ...args])
      if (!Array.isArray(builds.builds) || !builds.builds.every(object)) throw new Error("IDE returned invalid build list")
      const build = builds.builds.filter(object).find((item) => item.name === name && !priorRuns.includes(item.id))
      if (session && typeof session.sessionId === "string") {
        state.session = session.sessionId
        if (stopped()) {
          await call(["jetbrains", "stop", "--session", session.sessionId, ...args])
          continue
        }
        const key = id(name)
        const health = key && session.state === "running" && (!object(state.health) || state.health.ok !== true)
          ? await local(find(key))
          : state.health
        update(String(session.state), { session: session.sessionId, health })
      } else if (build) {
        if (stopped() && !cancelled.build) {
          await call(["jetbrains", "cancel", name, ...args])
          cancelled.build = String(build.id)
        }
        update(stopped() ? "cancelling" : "building", { build })
      } else if (typeof state.session === "string" || ended || (failed && !parent)) {
        clean()
        update(!stopped() && (failed || (ended && ended.exitCode && ended.exitCode !== 0)) ? "failed" : "stopped", { health: undefined, build: undefined, exitCode: ended?.exitCode, error: failed && !stopped() ? "IDE build or debugger launch failed" : undefined })
        return
      } else {
        update(stopped() ? "cancelling" : "starting IDE", { build: undefined })
      }
    } catch (err) {
      update("checking IDE", { error: err instanceof Error ? err.message : String(err) })
    }
    await Bun.sleep(1000)
  }
}

if (import.meta.main) {
  const folder = process.argv[3]
  if (!folder || !["worker", "recover"].includes(process.argv[2])) throw new Error("Invalid worker invocation")
  worker(folder, process.argv[2] === "recover").catch((err: unknown) => {
    const state = read(folder)
    save(folder, { ...state, phase: state.stage === "checking" ? "failed" : "unknown", error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
}
