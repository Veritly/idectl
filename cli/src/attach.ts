import fs from "node:fs"
import path from "node:path"
import { cfg, name } from "./config"
import { root, command, parse, object, rows, field } from "./core"
import { scope } from "./project"
import { local } from "./service"

function find(id: string) {
  const item = cfg.attach[id]
  if (!item) throw new Error(`Unknown attach ${id}; expected ${Object.keys(cfg.attach).join("|") || "none configured"}`)
  return item
}

const run = async (...args: string[]) => parse(await command([cfg.cli, ...args], root, 60_000))
const call = (project: string, tool: string, input: object) => run("jetbrains", "call", tool, JSON.stringify(input), "--ide", "webstorm", "--project", project)

async function sessions(project: string, configuration: string) {
  const list = await run("debug", "sessions", "--ide", "webstorm", "--project", project)
  return rows(list, "sessions").filter((row) => row.runConfigurationName === configuration && ["running", "paused"].includes(String(row.state)))
}

/** Writes the inspect port for the spawner and attaches WebStorm. The run configuration reconnects by itself, so one session catches every process the service spawns while the port file exists. */
export async function on(id: string) {
  const item = find(id)
  const owner = item.service ? cfg.services[item.service] : undefined
  if (item.service && !owner) throw new Error(`attach ${id} names the unknown service ${item.service}`)
  if (owner && !(await local(owner)).owner)
    throw new Error(`${id} needs the local ${owner.id} process: the cluster copy starts these processes inside its pod, where the IDE cannot reach their inspector. Run ${name} debug up ${owner.id}, wait for it to be ready, then attach again`)
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
  await call(project, "idectl_reload_project", {})
  if (!(await sessions(project, item.configuration)).length) await run("debug", "start", item.configuration, "--ide", "webstorm", "--project", project)
  // Breakpoints persist in the IDE between sessions; a forgotten one pauses the first request that reaches it and the app times out.
  const left = rows(await run("breakpoint", "list", "--ide", "webstorm", "--project", project), "breakpoints").filter((row) => row.type === "line")
  const lines = left.map((row) => ({ id: row.id, file: row.file, line: row.line }))
  return {
    ok: true, attach: id, phase: "attached", port: item.port, project,
    ...(lines.length ? { breakpoints: lines, warning: `${lines.length} line breakpoint(s) are already set in this project and will pause the first request that reaches them; remove stale ones with ${name} breakpoint remove ID --ide webstorm --project ${project}` } : {}),
  }
}

/** Removes the port file first so no new process pauses, then stops the session the way the IDE's Stop button does; the debugger API's stop would be answered by a reconnect. */
export async function off(id: string) {
  const item = find(id)
  fs.rmSync(path.join(root, item.file), { force: true })
  const project = scope(root, item.project).project
  const status = await call(project, "idectl_run_status", {})
  const active = object(status) && Array.isArray(status.runs) ? status.runs.filter(object).filter((row) => row.name === item.configuration && row.cancellable === true) : []
  for (const row of active) await call(project, "idectl_run_stop", { id: row.id })
  const until = Date.now() + 5000
  while ((await sessions(project, item.configuration)).length && Date.now() < until) await Bun.sleep(250)
  if ((await sessions(project, item.configuration)).length) throw new Error(`${item.configuration} is still attached; inspect it with ${name} debug sessions --ide webstorm --project ${project}`)
  return { ok: true, attach: id, phase: "detached" }
}
