import path from "node:path"
import { root, ides, object, sockets, opened, input, content, print, attempt } from "./core"
import type { Endpoint, Json } from "./core"

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

export async function dispatch(ide: Endpoint, args: string[], opts: { project?: string; timeout?: string; full: boolean }) {
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
    if (action === "tools") {
      const query = args.join(" ").trim().toLowerCase()
      const found = tools.filter((item) => typeof item.name === "string" && item.name.toLowerCase().includes(query))
      print(full ? found : found.map((item) => item.name))
      return 0
    }
    const alias: Record<string, string> = { status: "xdebug_get_debugger_status", configs: "get_run_configurations", output: "xdebug_get_process_output", start: "xdebug_start_debugger_session" }
    const name = alias[action || ""] || args.shift()?.replaceAll("-", "_")
    if (!name) throw new Error("jetbrains expects tools [FILTER], schema TOOL, or call TOOL [JSON|-]")
    const schema = tools.find((item) => item.name === name)
    if (!schema) throw new Error(`JetBrains MCP does not expose ${name}`)
    if (action === "schema") {
      print(full ? schema : { name: schema.name, description: typeof schema.description === "string" ? schema.description.slice(0, 400) : undefined, inputSchema: schema.inputSchema })
      return 0
    }
    if (action !== "call" && !alias[action || ""]) throw new Error("jetbrains expects tools|schema|call|status|configs|output|start")
    const seconds = timeout ? Number(timeout) : 5
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error("--timeout must be between 0 and 3600 seconds")
    const values = action === "start"
      ? { configurationName: args.join(" ").trim(), timeout: seconds * 1000, graceWaitMs: 0 }
      : action === "output" && args[0] && args[0] !== "-" && !args[0].startsWith("{")
        ? { sessionId: args.shift(), maxLines: 30 }
        : await input(args)
    if (action === "start" && !values.configurationName) throw new Error("jetbrains start requires a configuration name")
    if (!object(schema.inputSchema)) throw new Error(`${name} has an invalid input schema`)
    const props = schema.inputSchema.properties
    if (props !== undefined && !object(props)) throw new Error(`${name} has invalid input properties`)
    if (props?.projectPath && !values.projectPath) {
      const target = project ? path.resolve(project) : opened(ide)
      if (!target) throw new Error("No IDE project selected; open a project or pass --project")
      values.projectPath = target
    }
    const response = content(await client.call(name, values, seconds * 1000 + (action === "start" ? 2000 : 0)))
    const result = name === "get_run_configurations" && object(response) && Array.isArray(response.configurations)
      ? { ...response, configurations: response.configurations.map((item) => {
          if (!object(item) || !object(item.environment)) return item
          return { ...item, environment: Object.fromEntries(Object.keys(item.environment).map((key) => [key, "[redacted]"])) }
        }) }
      : response
    const text = JSON.stringify(result)
    print(!full && text.length > 12000 ? { truncated: true, preview: text.slice(0, 12000), hint: "Use --full for the complete result" } : result)
    return 0
  } finally {
    await attempt(() => client.close())
  }
}
