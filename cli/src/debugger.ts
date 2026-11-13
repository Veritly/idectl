import fs from "node:fs"
import path from "node:path"
import { browsers } from "./discovery"
import { native } from "./jetbrains"
import { ides, root, object, command, attempt, sockets, owner, identity, probe, rpc, opened, record, content, rows, field, preview, selection } from "./core"
import type { Endpoint, Json } from "./core"

type Options = { chosen?: string; override?: string; session?: string; project?: string; configuration?: string }

export function debuggerClient(opts: Options) {
  const chosen = opts.chosen
  const override = opts.override
  const session = opts.session
  const project = opts.project
  async function launchedBrowser(ide: Endpoint) {
    if (process.platform !== "linux") throw new Error("IDE browser discovery is supported on Linux VMs")
    if (ide.id !== "webstorm") throw new Error("Browser attachment requires --ide webstorm; a managed service's wait result already includes preview.arguments")
    if (!ide.pid) throw new Error("A verified WebStorm process is required; open packages/app --ide webstorm first")
    const dir = project ? path.resolve(project) : opened(ide)
    const file = dir ? record(dir) : undefined
    const state: unknown = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined
    if (object(state) && typeof state.endpoint === "string") {
      if (state.closed !== false || state.ide !== ide.id || state.bridge !== ide.pid) throw new Error("Recorded browser belongs to a different IDE project")
      const target = new URL(state.endpoint)
      if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !target.port) throw new Error("Recorded browser endpoint is invalid")
      const socket = (await sockets()).find((item) => item.port === Number(target.port))
      if (!socket?.pid) throw new Error("Recorded browser is not listening")
      const exe = path.basename(fs.realpathSync(`/proc/${socket.pid}/exe`))
      if (!/^(chrome|chromium|chrome-headless-shell|headless_shell|Google Chrome(?: for Testing| Canary)?)$/i.test(exe))
        throw new Error("Recorded browser listener is not Chromium")
      const response = await fetch(new URL("/json/version", target), { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(`Browser debug endpoint returned HTTP ${response.status}`)
      const data: unknown = await response.json()
      if (!object(data) || typeof data.Browser !== "string" || typeof data.webSocketDebuggerUrl !== "string")
        throw new Error("The browser listener is not a Chromium debugging endpoint")
      return { ok: true, pid: socket.pid, endpoint: target.origin, ...preview(target.origin) }
    }
    for (let count = 0; count < 30; count++) {
      const rows = browsers(await command(["ps", "-eo", "pid=,ppid=,args="], root, 1000), ide.pid)
      const live = await sockets()
      const found = rows.flatMap((row) => {
        const file = path.join(row.profile, "DevToolsActivePort")
        if (!fs.existsSync(file)) return []
        const port = Number(fs.readFileSync(file, "utf8").split("\n")[0])
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Browser wrote an invalid debugging port: ${file}`)
        if (!live.some((socket) => socket.pid === row.pid && socket.port === port)) return []
        return [{ pid: row.pid, endpoint: `http://127.0.0.1:${port}` }]
      })
      if (found.length > 1) throw new Error("WebStorm has multiple debug browsers; stop the other debug sessions first")
      if (found.length === 1) {
        const result = await fetch(`${found[0].endpoint}/json/version`, { signal: AbortSignal.timeout(3000) })
        if (!result.ok) throw new Error(`Browser debug endpoint returned HTTP ${result.status}`)
        const data: unknown = await result.json()
        if (!object(data) || typeof data.Browser !== "string" || typeof data.webSocketDebuggerUrl !== "string")
          throw new Error("The browser listener is not a Chromium debugging endpoint")
        return { ok: true, ...found[0], ...preview(found[0].endpoint) }
      }
      await Bun.sleep(150)
    }
    throw new Error("WebStorm has no listening debug browser; start its JavaScript debug configuration first")
  }

  async function endpoints(target?: string | number) {
    const live = await sockets()
    const map = new Map(live.filter((row) => identity(row.port, row.process)).map((row) => [row.port, row]))
    ides.forEach((ide) => {
      if (!map.has(ide.port)) map.set(ide.port, { port: ide.port })
    })
    if (override) {
      const port = Number(override)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be 1..65535")
      if (!map.has(port)) map.set(port, { port })
    }
    const rows = await Promise.all(
      [...map.values()].filter((row) => {
        if (target === undefined) return true
        if (typeof target === "number") return row.port === target
        const known = identity(row.port, row.process)
        return known?.id === target || known?.name.toLowerCase() === target.toLowerCase()
      }).map(async (row) => {
        if (!live.some((item) => item.port === row.port)) {
          if (override && row.port === Number(override))
            throw new Error(`Debugger port ${row.port} is not listening; start the IDE and enable Debugger MCP`)
          return
        }
        const status = await owner(row)
        if (!status.verified) throw new Error(`Debugger port ${row.port}: ${status.reason}; no probe sent`)
        return probe(row.port, row.process, row.pid)
      }),
    )
    return rows.filter((row): row is Endpoint => Boolean(row)).sort((a, b) => a.port - b.port)
  }

  async function endpoint() {
    const rows = await endpoints(override ? Number(override) : chosen)
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
    if (project) return selection(rows, project)
    if (!rows.length) throw new Error("no JetBrains Debugger MCP server found; launch an IDE and enable the Debugger MCP Server plugin")
    throw new Error(`Select --service NAME or --ide ID; active IDEs: ${rows.map((row) => row.id).join(", ")}`)
  }

  async function tool(ide: Endpoint, name: string, input: Json = {}, timeout = 60_000) {
    const schema = ide.tools.find((item) => item.name === name)
    if (!schema) {
      const alternate = name.replaceAll("-", "_")
      if (alternate !== name && ide.tools.some((item) => item.name === alternate))
        throw new Error(`${ide.name} does not expose ${name}; raw MCP tool names use underscores: ${alternate}`)
      throw new Error(`${ide.name} does not expose ${name}; use mcp tools to list available tool names`)
    }
    const args = { ...input }
    if (!object(schema.inputSchema)) throw new Error(`${name} has an invalid input schema`)
    const props = schema.inputSchema.properties
    if (props !== undefined && !object(props)) throw new Error(`${name} has invalid input properties`)
    if (session && props?.session_id && !args.session_id) args.session_id = session
    if (props?.project_path && !args.project_path) {
      const target = project ? path.resolve(project) : opened(ide)
      if (!target) throw new Error("No IDE project selected; open a project or pass --project")
      args.project_path = target
    }
    if (props?.session_id && !args.session_id && !(name === "get_source_context" && args.file_path)) {
      const result = content(
        await rpc(ide.port, "tools/call", {
          name: "list_debug_sessions",
          arguments: { project_path: args.project_path },
        }, timeout),
      )
      const all = rows(result, "sessions")
      const live = opts.configuration ? all.filter((row) => row.runConfigurationName === opts.configuration && ["running", "paused"].includes(String(row.state))) : all
      if (opts.configuration && !live.length) throw new Error(`No active ${opts.configuration} debug session; check debug jobs before starting another launch`)
      if (live.length > 1)
        throw new Error(
          `Select --session ID: ${JSON.stringify(live.map((row) => ({ id: row.id, name: row.name, state: row.state })))}; for frontend inspection select the paused Veritly Browser session and inspect before resuming`,
        )
      if (live.length === 1) args.session_id = field(live[0], ["id", "sessionId"])
    }
    if (ide.id === "rustrover" && ["step_over", "step_out", "step_into"].includes(name)) {
      const sessions = rows(content(await rpc(ide.port, "tools/call", {
        name: "list_debug_sessions", arguments: { project_path: args.project_path },
      }, timeout)), "sessions")
      const selected = sessions.find((item) => field(item, ["id", "sessionId"]) === args.session_id)
      const configuration = selected ? field(selected, ["runConfigurationName", "name"]) : undefined
      if (!configuration) throw new Error("Cannot identify the selected Rust debug configuration; check debug sessions")
      const client = await native(ide)
      return content(await client.call("veritly_debug_step", { configuration, action: name, projectPath: args.project_path }, timeout))
    }
    const result = content(await rpc(ide.port, "tools/call", { name, arguments: args }, timeout))
    if (["set_breakpoint", "remove_breakpoint"].includes(name)) {
      const client = await native(ide)
      await client.call("veritly_save_project", { projectPath: args.project_path }, timeout)
    }
    return result
  }

  async function configs(ide: Endpoint, target?: string) {
    const data = await tool(ide, "list_run_configurations", { project_path: target })
    return rows(data, "configurations")
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

  async function sessions(ide: Endpoint) {
    return rows(await tool(ide, "list_debug_sessions"), "sessions")
  }

  async function launch(ide: Endpoint, name: string) {
    await config(ide, name)
    const before = await sessions(ide)
    const result = await attempt(() => tool(ide, "start_debug_session", { configuration_name: name }, 60_000))
    if (result.ok) return result.value
    if (!/timed?\s*out|timeout/i.test(result.error)) throw new Error(result.error)
    const live = (await sessions(ide)).filter(
      (row) =>
        (row.name === name || row.runConfigurationName === name) &&
        !before.some((old) => field(old, ["id", "sessionId"]) === field(row, ["id", "sessionId"])),
    )
    if (live.length === 1)
      return {
        status: "started",
        verified: true,
        message: "Start reply timed out; verified the new session without launching again",
        session: live[0],
      }
    throw new Error(`Start reply timed out; launch outcome is unknown. Inspect debug sessions before repeating ${name}`)
  }


  return { launchedBrowser, endpoints, endpoint, tool, configs, config, sessions, launch }
}
