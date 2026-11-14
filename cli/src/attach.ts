import fs from "node:fs"
import path from "node:path"
import { cfg, name } from "./config"
import { root, command, parse, object, rows, field, stamp } from "./core"
import { scope } from "./project"

function find(id: string) {
  const item = cfg.attach[id]
  if (!item) throw new Error(`Unknown attach ${id}; expected ${Object.keys(cfg.attach).join("|") || "none configured"}`)
  return item
}

const run = async (...args: string[]) => parse(await command([cfg.cli, ...args], root, 60_000))
const pidfile = (id: string) => path.join(cfg.state, `attach-${id}.json`)

function loop(id: string) {
  const file = pidfile(id)
  if (!fs.existsSync(file)) return
  const row: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!object(row) || typeof row.pid !== "number" || typeof row.token !== "string") return
  return stamp(row.pid) === row.token ? { pid: row.pid, token: row.token } : undefined
}

async function sessions(project: string, configuration: string) {
  const list = await run("debug", "sessions", "--ide", "webstorm", "--project", project)
  return rows(list, "sessions").filter((row) => row.runConfigurationName === configuration && ["running", "paused"].includes(String(row.state)))
}

async function begin(project: string, configuration: string) {
  if ((await sessions(project, configuration)).length) return
  await run("debug", "start", configuration, "--ide", "webstorm", "--project", project)
}

async function end(project: string, configuration: string) {
  for (const row of await sessions(project, configuration)) {
    const session = field(row, ["id", "sessionId"])
    if (session) await run("debug", "stop", "--ide", "webstorm", "--project", project, "--session", session)
  }
}

/** Writes the inspect port for the spawner and keeps a WebStorm attach session open: each spawned process pauses at start until a debugger connects, so a session ending must be followed by a new one. */
export async function on(id: string) {
  const item = find(id)
  const file = path.join(root, item.file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${item.port}\n`)
  const project = scope(root, item.project).project
  const until = Date.now() + 120_000
  for (;;) {
    const opened = await run("open", item.project, "--ide", "webstorm").then(() => true, (err: unknown) => err)
    if (opened === true) break
    if (Date.now() > until) throw opened
  }
  await run("jetbrains", "call", "idectl_reload_project", "{}", "--ide", "webstorm", "--project", project)
  await begin(project, item.configuration)
  if (!loop(id)) {
    const child = Bun.spawn([cfg.cli, "debug", "attach-loop", id], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    child.unref()
  }
  return { ok: true, attach: id, phase: "attached", port: item.port }
}

/** Runs until the port file is removed; reattaches whenever the session ended because the spawned process exited. */
export async function watch(id: string) {
  const item = find(id)
  const project = scope(root, item.project).project
  const token = stamp(process.pid)
  if (!token) throw new Error("Cannot identify the attach supervisor")
  fs.mkdirSync(cfg.state, { recursive: true })
  fs.writeFileSync(pidfile(id), JSON.stringify({ pid: process.pid, token }))
  while (fs.existsSync(path.join(root, item.file))) {
    await begin(project, item.configuration).catch(() => undefined)
    await Bun.sleep(500)
  }
  await end(project, item.configuration).catch(() => undefined)
  fs.rmSync(pidfile(id), { force: true })
}

/** Removes the port file first so no new process pauses, then waits for the supervisor to stop the session. */
export async function off(id: string) {
  const item = find(id)
  fs.rmSync(path.join(root, item.file), { force: true })
  const project = scope(root, item.project).project
  const until = Date.now() + 5000
  while (loop(id) && Date.now() < until) await Bun.sleep(100)
  const stale = loop(id)
  if (stale) process.kill(stale.pid)
  fs.rmSync(pidfile(id), { force: true })
  await end(project, item.configuration)
  if ((await sessions(project, item.configuration)).length) throw new Error(`${item.configuration} is still attached; inspect it with ${name} debug sessions --ide webstorm --project ${project}`)
  return { ok: true, attach: id, phase: "detached" }
}
