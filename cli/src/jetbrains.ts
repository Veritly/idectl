import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { root, ides, object, sockets, opened, input, content, print, attempt } from "./core"
import type { Endpoint, Json } from "./core"
import { runtime } from "./setup"
import { tunnel } from "./service"

export const aliases: Record<string, string> = { status: "xdebug_get_debugger_status", sessions: "xdebug_get_debugger_status", configs: "get_run_configurations", output: "xdebug_get_process_output", console: "xdebug_get_process_output", start: "xdebug_start_debugger_session", stop: "xdebug_control_session", pause: "xdebug_control_session", resume: "xdebug_control_session", wait: "xdebug_control_session", "step-over": "xdebug_control_session", "step-into": "xdebug_control_session", "step-out": "xdebug_control_session", stack: "xdebug_get_stack", vars: "xdebug_get_frame_values", eval: "xdebug_evaluate_expression", threads: "xdebug_get_threads" }

async function runs(client: Awaited<ReturnType<typeof jetbrains>>, project: unknown) {
  const data = content(await client.call("veritly_run_status", { projectPath: project }))
  if (!object(data) || !Array.isArray(data.runs) || !data.runs.every(object)) throw new Error("IDE lifecycle plugin returned invalid executions")
  return data.runs.filter(object)
}

function builds(rows: Json[]) {
  return rows.flatMap((row) => {
    if (typeof row.name !== "string" || typeof row.id !== "string") return []
    if (row.phase !== "running" && row.phase !== "stopping") return []
    const match = /^Build `(.+)`$/.exec(row.name)
    if (!match) return []
    return [{ id: row.id, name: match[1], cancellable: row.cancellable === true }]
  })
}

export async function jetbrains(port: number) {
  const url = `http://127.0.0.1:${port}/stream`
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" }
  let next = 0
  async function send(method: string, params: Json, notify = false, timeout = 5000) {
    const response = await fetch(url, {
      method: "POST", headers, signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({ jsonrpc: "2.0", id: notify ? undefined : ++next, method, params }),
    })
    if (!response.ok) throw new Error(`JetBrains MCP returned HTTP ${response.status}`)
    if (!headers["mcp-session-id"]) {
      const session = response.headers.get("mcp-session-id")
      if (!session) throw new Error("JetBrains MCP did not return a session")
      headers["mcp-session-id"] = session
    }
    if (notify) return
    const text = await response.text()
    const line = text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").find((item) => item.startsWith("data:"))?.slice(5).trim()
      : text
    if (!line) throw new Error("JetBrains MCP returned an empty response")
    const body: unknown = JSON.parse(line)
    if (!object(body)) throw new Error("JetBrains MCP returned invalid JSON-RPC")
    if (body.error !== undefined) {
      if (!object(body.error) || typeof body.error.message !== "string") throw new Error("JetBrains MCP returned an invalid error")
      throw new Error(body.error.message)
    }
    return body.result
  }
  await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "veritly-ide", version: "1" } })
  await send("notifications/initialized", {}, true)
  return {
    async close() {
      await fetch(url, { method: "DELETE", headers: { "mcp-session-id": headers["mcp-session-id"] }, signal: AbortSignal.timeout(3000) })
    },
    async tools() {
      const tools: Json[] = []
      let cursor: string | undefined
      do {
        const result = await send("tools/list", { cursor })
        if (!object(result) || !Array.isArray(result.tools)) throw new Error("JetBrains MCP returned an invalid tool list")
        if (!result.tools.every(object)) throw new Error("JetBrains MCP returned an invalid tool")
        tools.push(...result.tools.filter(object))
        if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") throw new Error("JetBrains MCP returned an invalid cursor")
        cursor = result.nextCursor || undefined
      } while (cursor)
      return tools
    },
    async call(name: string, args: Json, timeout = 10_000) {
      const result = await send("tools/call", { name, arguments: args }, false, timeout)
      if (!object(result)) throw new Error("JetBrains MCP returned an invalid tool result")
      if (result.isError === true) {
        if (!Array.isArray(result.content)) throw new Error("JetBrains MCP returned an invalid tool error")
        const rows = result.content.filter(object)
        throw new Error(rows.map((row) => typeof row.text === "string" ? row.text : "").join("\n") || "JetBrains MCP tool failed")
      }
      return result
    },
  }
}

export async function dispatch(ide: Endpoint, args: string[], opts: { project?: string; timeout?: string; full: boolean; session?: string; frame?: number }) {
  const project = opts.project
  const timeout = opts.timeout
  const full = opts.full
  const known = ides.find((item) => item.id === ide.id)
  if (!known || !ide.pid) throw new Error("Cannot identify the selected JetBrains process")
  const port = known.port + 300
  const listener = (await sockets()).find((item) => item.port === port)
  if (!listener || listener.pid !== ide.pid)
    throw new Error(`JetBrains MCP is not listening on ${port} in ${ide.name}; reopen the IDE with veritly-ide open`)
  const client = await jetbrains(port)
  try {
    const tools = await client.tools()
    const action = args.shift()
    if (ide.id === "rustrover" && ["builds", "cancel", "start"].includes(action || "") &&
      !["veritly_run_status", "veritly_run_stop", "veritly_cargo_attach"].every((name) => tools.some((item) => item.name === name)))
      throw new Error("Install the current Veritly JetBrains lifecycle plugin in RustRover and reopen the IDE")
    if (action === "tools") {
      const query = args.join(" ").trim().toLowerCase()
      const found = tools.filter((item) => typeof item.name === "string" && item.name.toLowerCase().includes(query))
      print(full ? found : found.map((item) => item.name))
      return 0
    }
    if (action === "inspect") {
      if (args.length) throw new Error("debug inspect accepts --frame, --service, --project and --session")
      const target = project ? path.resolve(project) : opened(ide)
      if (!target) throw new Error("No IDE project selected; open a project or pass --project")
      const context = { projectPath: target, sessionId: opts.session }
      const [stack, variables] = await Promise.all([
        client.call("xdebug_get_stack", { ...context, limit: 5 }),
        client.call("xdebug_get_frame_values", { ...context, frameIndex: opts.frame }),
      ])
      print({ stack: content(stack), variables: content(variables) })
      return 0
    }
    if (ide.id === "rustrover" && (action === "builds" || action === "cancel")) {
      const target = project ? path.resolve(project) : opened(ide)
      if (!target) throw new Error("No IDE project selected; open a project or pass --project")
      const live = builds(await runs(client, target))
      if (action === "builds") { print({ builds: live }); return 0 }
      const name = args.join(" ").trim()
      if (!name) throw new Error("debug cancel requires a configuration name")
      const found = live.filter((item) => item.name === name && item.cancellable)
      if (found.length !== 1) throw new Error(`Expected one cancellable IDE build for ${name}; found ${found.length}`)
      await client.call("veritly_run_stop", { id: found[0].id, projectPath: target })
      print({ ok: true, phase: "cancelling", build: found[0] })
      return 0
    }

    const name = aliases[action || ""] || args.shift()?.replaceAll("-", "_")
    if (!name) throw new Error("jetbrains expects tools [FILTER], schema TOOL, or call TOOL [JSON|-]")
    const schema = tools.find((item) => item.name === name)
    if (!schema) throw new Error(`JetBrains MCP does not expose ${name}; use ${action && aliases[action] ? `debug ${action === "output" ? "console" : action} with the same IDE/service selector` : "jetbrains tools to discover native integration tools"}`)
    if (action === "schema") {
      print(full ? schema : { name: schema.name, description: typeof schema.description === "string" ? schema.description.slice(0, 400) : undefined, inputSchema: schema.inputSchema })
      return 0
    }
    if (action !== "call" && !aliases[action || ""]) throw new Error("jetbrains expects tools|schema|call|status|configs|output|start")
    const seconds = timeout ? Number(timeout) : 5
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error("--timeout must be between 0 and 3600 seconds")
    const controls: Record<string, string> = { stop: "STOP", pause: "PAUSE", resume: "RESUME", wait: "WAIT_FOR_PAUSE", "step-over": "STEP_OVER", "step-into": "STEP_INTO", "step-out": "STEP_OUT" }
    const values: Json = action === "start"
      ? { configurationName: args.join(" ").trim(), timeout: seconds * 1000, graceWaitMs: 0 }
      : action && controls[action]
        ? { action: controls[action], timeout: action === "resume" ? 0 : seconds * 1000 }
      : action === "eval"
        ? { expression: args.join(" ").trim(), frameIndex: opts.frame }
      : action === "vars"
        ? { frameIndex: opts.frame, ...(await input(args)) }
      : action === "stack"
        ? { limit: 5, ...(await input(args)) }
      : action === "output" && args[0] && args[0] !== "-" && !args[0].startsWith("{")
        ? { sessionId: args.shift(), maxLines: 30 }
        : await input(args)
    if (action === "start" && !values.configurationName) throw new Error("jetbrains start requires a configuration name")
    if (!object(schema.inputSchema)) throw new Error(`${name} has an invalid input schema`)
    const props = schema.inputSchema.properties
    if (props !== undefined && !object(props)) throw new Error(`${name} has invalid input properties`)
    if (props?.sessionId && opts.session && !values.sessionId) values.sessionId = opts.session
    if (props?.projectPath && !values.projectPath) {
      const target = project ? path.resolve(project) : opened(ide)
      if (!target) throw new Error("No IDE project selected; open a project or pass --project")
      values.projectPath = target
    }
    if (ide.id === "rustrover" && action === "resume") {
      const status = content(await client.call("xdebug_get_debugger_status", { projectPath: values.projectPath }))
      if (!object(status) || !Array.isArray(status.sessions)) throw new Error("IDE returned invalid debugger sessions")
      const paused = status.sessions.filter(object).filter((item) => item.state === "paused" && (!opts.session || item.sessionId === opts.session))
      if (paused.length === 1 && object(paused[0].currentPosition)) {
        const position = paused[0].currentPosition
        const breaks = content(await client.call("xdebug_list_breakpoints", { projectPath: values.projectPath }))
        if (!object(breaks) || !Array.isArray(breaks.breakpoints)) throw new Error("IDE returned invalid breakpoints")
        const file = (value: unknown) => {
          if (typeof value !== "string") return
          if (value.startsWith("file://")) return fileURLToPath(value)
          if (path.isAbsolute(value)) return path.normalize(value)
        }
        const target = file(position.filePath)
        const once = breaks.breakpoints.filter(object).filter((item) => target && file(item.file) === target && item.line === position.line && item.owner === "agent" && item.temporary === true && item.enabled === true && typeof item.id === "string")
        if (once.length) {
          const result = content(await client.call("xdebug_remove_breakpoints", { projectPath: values.projectPath, breakpoints: once.map((item) => ({ breakpointId: item.id, owner: "agent" })) }))
          if (!object(result) || !Array.isArray(result.results) || result.results.length !== once.length || !result.results.every((item) => object(item) && item.success === true))
            throw new Error("Could not remove the hit one-shot breakpoint; session remains paused")
        }
      }
    }
    if (action === "start" && typeof values.configurationName === "string") {
      if (ide.id === "rustrover" && !process.env.VERITLY_IDE_JOB)
        throw new Error("Use debug start for Rust so preparation and cleanup are supervised")
      const configs = content(await client.call("get_run_configurations", { projectPath: values.projectPath }))
      if (!object(configs) || !Array.isArray(configs.configurations)) throw new Error("IDE returned invalid run configurations")
      const selected = configs.configurations.filter(object).find((item) => item.name === values.configurationName)
      if (!selected) throw new Error(`Run configuration ${values.configurationName} is not loaded; reopen the project`)
      const existing = ide.id === "rustrover" ? builds(await runs(client, values.projectPath)).find((item) => item.name === values.configurationName) : undefined
      if (existing) throw new Error(`${values.configurationName} is already building; check debug builds`)
      const status = content(await client.call("xdebug_get_debugger_status", { projectPath: values.projectPath }))
      if (!object(status) || !Array.isArray(status.sessions)) throw new Error("IDE returned invalid debugger sessions")
      if (status.sessions.filter(object).some((item) => item.runConfigurationName === values.configurationName && (item.state === "running" || item.state === "paused")))
        throw new Error(`${values.configurationName} already has an active debug session; check debug status`)
      if (ide.id === "rustrover") {
        if (typeof selected.workingDirectory !== "string") throw new Error("Run configuration has no working directory")
        const manifest = path.join(selected.workingDirectory, "Cargo.toml")
        if (!fs.existsSync(manifest)) throw new Error(`Cargo manifest not found in ${selected.workingDirectory}`)
        if (process.env.VERITLY_IDE_JOB) fs.writeFileSync(path.join(process.env.VERITLY_IDE_JOB, "phase"), "loading Cargo project", { mode: 0o600 })
        while (true) {
          const cargo = content(await client.call("veritly_cargo_attach", { manifest, projectPath: values.projectPath }))
          if (!object(cargo) || typeof cargo.phase !== "string") throw new Error("IDE returned invalid Cargo project state")
          if (cargo.phase === "ready") break
          if (cargo.phase !== "loading" && cargo.phase !== "attaching") throw new Error(`Cargo project is ${cargo.phase}`)
          await Bun.sleep(500)
        }
      }
      const env = await runtime(values.configurationName, tunnel)
      if (env) {
        if (selected.supportsDynamicLaunchOverrides !== true) throw new Error(`${values.configurationName} does not support per-launch environment overrides`)
        values.envs = env
      }
      if (process.env.VERITLY_IDE_JOB) fs.writeFileSync(path.join(process.env.VERITLY_IDE_JOB, "phase"), "starting IDE", { mode: 0o600 })
    }
    const reply = await attempt(() => client.call(name, values, seconds * 1000 + (action === "start" ? 2000 : 0)))
    if (!reply.ok) {
      if (action === "start" && reply.error.toLowerCase().includes("timed out")) {
        const live = await runs(client, values.projectPath)
        const found = builds(live).find((item) => item.name === values.configurationName)
        if (found) { print({ ok: true, phase: "building", build: found }); return 0 }
        if (live.some((item) => item.name === values.configurationName && item.phase === "starting")) {
          print({ ok: true, phase: "starting IDE" }); return 0
        }
        throw new Error(`Start reply timed out; launch outcome is unknown. Inspect jetbrains status before repeating ${values.configurationName}`)
      }
      throw new Error(reply.error)
    }
    const response = content(reply.value)
    if (ide.id === "rustrover" && action === "start" && object(response) && response.state === "failed_to_start") {
      const live = await runs(client, values.projectPath)
      const build = builds(live).find((item) => item.name === values.configurationName)
      if (build || live.some((item) => item.name === values.configurationName && item.phase === "starting")) {
        print({ ok: true, phase: build ? "building" : "starting IDE", build })
        return 0
      }
    }
    const result = name === "get_run_configurations" && object(response) && Array.isArray(response.configurations)
      ? { ...response, configurations: response.configurations.map((item) => {
          if (!object(item) || !object(item.environment)) return item
          return { ...item, environment: Object.fromEntries(Object.keys(item.environment).map((key) => [key, "[redacted]"])) }
        }) }
      : response
    const described = name === "xdebug_set_breakpoints" && object(result) && Array.isArray(result.results) && result.results.some((item) => object(item) && item.success === true)
      ? { ...result, hint: "Trigger the user action and wait for a hit; breakpoint acceptance alone does not prove it will bind." }
      : result
    const text = JSON.stringify(described)
    print(!full && text.length > 12000 ? { truncated: true, preview: text.slice(0, 12000), hint: "Use --full for the complete result" } : described)
    return 0
  } finally {
    await attempt(() => client.close())
  }
}
