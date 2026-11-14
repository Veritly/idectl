import fs from "node:fs"
import path from "node:path"
import { root, ides, attempt, launcher, sockets, opened, selection, projects, quote } from "./core"
import { cfg, name } from "./config"
import { adapter } from "./adapter"
import { port, preflight } from "./service"
import { jetbrains } from "./jetbrains"
import { inspect } from "./plugin"
import type { debuggerClient } from "./debugger"

export async function doctor(debug: ReturnType<typeof debuggerClient>, opts: { chosen?: string; project?: string; source?: string; service?: string }) {
  const chosen = opts.chosen
  const project = opts.project
  const endpoints = debug.endpoints
  const configs = debug.configs
  const targets = [cfg.frontend, ...Object.values(cfg.services)]
  const [active, environment, guard] = await Promise.all([
    endpoints(),
    adapter.doctor(targets),
    cfg.preflight ? attempt(preflight) : Promise.resolve(undefined),
  ])
  const selected = chosen
    ? active.find((item) => item.id === chosen)
    : project ? selection(active, project) : active.length === 1 ? active[0] : undefined
  if (!selected && active.length > 1 || selected && !project && projects(selected).length > 1) {
    return {
      ok: false,
      phase: "selection_required",
      reason: "Multiple open IDE projects are expected; choose the project for this task before checking its health.",
      choices: (selected ? [selected] : active).flatMap((ide) => projects(ide).map((project) => ({
        ide: ide.id, project, command: `${name} doctor --ide ${ide.id} --project ${quote(project)}`,
      }))),
      hint: "Run the matching command from choices, then continue your task; selection_required is not an IDE or MCP health failure. For a Rust service, doctor --service NAME selects its project explicitly.",
    }
  }
  const known = selected ? ides.find((item) => item.id === selected.id) : undefined
  const bin = known ? launcher(known) : undefined
  const plugin = known && bin ? await attempt(async () => inspect(known, bin)) : { ok: false as const, error: "No IDE selected" }
  const mcp = known ? known.port + 300 : undefined
  const listener = mcp ? (await sockets()).find((item) => item.port === mcp) : undefined
  const bridge = mcp && selected?.pid && listener?.pid === selected.pid
    ? await attempt(async () => {
        const client = await jetbrains(mcp)
        try {
          return (await client.tools()).length
        } finally {
          await client.close()
        }
      })
    : { ok: false as const, error: "JetBrains MCP is not running in the selected IDE" }
  const target = project ? path.resolve(project) : selected ? opened(selected) : undefined
  const runs = selected && target ? await attempt(() => configs(selected, target)) : { ok: false as const, error: "No IDE project selected; open a project or pass --project" }
  const missing = !runs.ok && runs.error.includes('"project_not_found"')
  const installed = ides.map((ide) => {
    const bin = launcher(ide)
    const live = active.find((item) => item.id === ide.id)
    return { id: ide.id, name: ide.name, installed: Boolean(bin), launcher: bin, active: Boolean(live), endpoint: live }
  })
  const loaded = runs.ok ? runs.value.map((row) => {
    if (typeof row.name !== "string") throw new Error("Debugger returned a run configuration without a name")
    return row.name
  }) : undefined
  const checks = {
    env: fs.existsSync(cfg.env),
    bun: Boolean(Bun.which("bun")),
    setsid: Boolean(Bun.which("setsid")),
    ...(guard ? { preflight: guard.ok } : {}),
    ...environment.checks,
    ide: Boolean(selected),
    jetbrains: bridge.ok,
    plugin: plugin.ok && plugin.value.ok,
    project: runs.ok,
  }
  return {
    ok: Object.values(checks).every(Boolean),
    phase: missing ? "project_not_open" : undefined,
    hint: missing
      ? `${opts.source && selected ? `Run ${name} open ${quote(opts.source)} --ide ${selected.id}, then repeat doctor` : `Open the selected source component with ${name} open, then repeat doctor`}${opts.service ? `; debug up ${opts.service} also opens its required IDE projects automatically` : ""}. An unopened project is a preparation step, not a missing IDE installation.`
      : undefined,
    root,
    env: cfg.env,
    adapter: { type: adapter.type, ...environment.details },
    preflight: guard && !guard.ok ? guard.error : undefined,
    selection: !selected && active.length > 1 ? `Multiple IDEs are active; use --ide to check ${active.map((item) => item.id).join(" or ")}` : undefined,
    checks,
    project: target,
    ides: installed.map((item) => ({
      id: item.id,
      installed: item.installed,
      active: item.active,
      port: item.endpoint?.port,
      tools: item.endpoint?.tools.length,
    })),
    selected: selected ? { id: selected.id, port: selected.port, tools: selected.tools.length } : undefined,
    jetbrains: bridge.ok ? { port: mcp, tools: bridge.value } : bridge,
    plugin: plugin.ok ? plugin.value : plugin,
    configurations: runs.ok ? loaded : runs,
    services: targets.map((item) => ({
      id: item.id,
      workload: item.workload,
      mode: item.mode,
      port: fs.existsSync(cfg.env) ? port(item) : undefined,
    })),
  }
}
