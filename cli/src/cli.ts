#!/usr/bin/env bun
import path from "node:path"
import { dispatch } from "./jetbrains"
import { root, file, namespace, ides, specs, object, print, message, attempt, launcher, input } from "./core"
import { lifecycle } from "./lifecycle"
import { debuggerClient } from "./debugger"
import { doctor } from "./doctor"
import { checks } from "./checks"
import { spec, tunnel, cluster, kill, start, stop, state, routing } from "./service"

const args = process.argv.slice(2)

function option(name: string) {
  const inline = args.findIndex((arg) => arg.startsWith(`${name}=`))
  if (inline !== -1) return args.splice(inline, 1)[0].slice(name.length + 1)
  const pos = args.indexOf(name)
  if (pos === -1) return
  const value = args[pos + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  args.splice(pos, 2)
  return value
}

function flag(name: string) {
  const pos = args.indexOf(name)
  if (pos === -1) return false
  args.splice(pos, 1)
  return true
}

const chosen = option("--ide")
const override = option("--port")
const session = option("--session")
const project = option("--project")
const timeout = option("--timeout")
const frame = option("--frame")
const details = flag("--inspect")
const full = flag("--full")
const url = option("--url")
const attach = option("--attach")

function index() {
  if (!frame) return 0
  const value = Number(frame)
  if (!Number.isInteger(value) || value < 0) throw new Error("--frame must be a non-negative integer")
  return value
}


const debug = debuggerClient({ chosen, override, session, project })
const { launchedBrowser, endpoints, endpoint, tool, config, launch } = debug
const { smoke, readiness, diagnosis, browserSmoke, values, pause, snapshot } = checks(debug, { project, url })

const usage = `veritly-ide doctor [--ide ID] [--port PORT]
veritly-ide ready PATH --url URL
veritly-ide ides
veritly-ide connect
veritly-ide open PATH [LINE] [--ide ID] [--url URL] [--attach ENDPOINT]
veritly-ide close PATH | close --project PATH
veritly-ide services
veritly-ide start|stop|status frontend [--ide ID]
veritly-ide route|unroute data
veritly-ide breakpoint set FILE LINE [JSON] | list | remove ID
veritly-ide debug browser|configs|sessions|status|wait|inspect|vars|stack|source|console|threads|frame [...]
veritly-ide debug resume|pause|step-over|step-into|step-out|eval|set|start|run|stop [...]
veritly-ide debug commands [TOOL] | TOOL [JSON|-]
veritly-ide mcp tools | call TOOL [JSON|-]
veritly-ide jetbrains tools [FILTER] | schema TOOL | call TOOL [JSON|-] [--timeout SECONDS]
veritly-ide jetbrains status | configs | output [SESSION] | start CONFIGURATION
veritly-ide test breakpoint
veritly-ide test browser --project PATH --url URL

Use --project PATH, --session ID and --frame N to target context. Pass names to debug vars, or --inspect with debug wait.
open selects the component's IDE and waits up to 20s; exit 2 means it is still starting. close stops launcher-owned IDEs.
JetBrains tools are listed by name; use schema for details and --full for unbounded output.
Native Rust uses RustRover run configurations; discover these with debug configs, then debug start NAME.
All result data is JSON on stdout. Errors are JSON on stderr.`

async function main() {
  const group = args.shift()
  if (!group || group === "help" || group === "--help" || group === "-h") {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (group === "doctor") {
    const value = await doctor(debug, { chosen, project })
    print(value)
    return value.ok ? 0 : 1
  }
  if (group === "ready") {
    const target = args.shift()
    if (!target) throw new Error("ready requires a component path")
    const value = await readiness(target)
    print(value)
    return value.ok ? 0 : 1
  }
  if (group === "ides") {
    const active = await endpoints()
    print(
      ides.map((ide) => {
        const bin = launcher(ide)
        const live = active.find((item) => item.id === ide.id)
        return {
          id: ide.id,
          installed: Boolean(bin),
          launcher: bin,
          port: ide.port,
          pid: live?.pid,
          active: Boolean(live),
          tools: live?.tools.length,
        }
      }),
    )
    return 0
  }
  if (group === "connect") {
    await tunnel()
    print({ ok: true, context: await cluster(), namespace })
    return 0
  }
  if (group === "open" || group === "launch") {
    const value = await lifecycle({ project, chosen, attach, url, tunnel, endpoints, tool, kill }).open(args)
    print(value)
    return value.ok ? 0 : 2
  }
  if (group === "close") {
    const value = await lifecycle({ project, chosen, attach, url, tunnel, endpoints, tool, kill }).close(args)
    print(value)
    return value.ok ? 0 : 2
  }
  if (group === "services") {
    print(
      specs.map((item) => ({
        id: item.id,
        workload: item.workload,
        mode: "run",
        key: item.key,
        env: file,
      })),
    )
    return 0
  }
  if (group === "route" || group === "unroute") {
    if (args.shift() !== "data") throw new Error("route expects data")
    print(await routing(group === "route"))
    return 0
  }
  if (["start", "stop", "status"].includes(group)) {
    const item = spec(args.shift())
    if (group === "start") {
      const value = await start(item, endpoint)
      print(value)
      return value.ok ? 0 : 1
    }
    print(group === "stop" ? await stop(item) : await state(item))
    return 0
  }
  if (group === "mcp") {
    const ide = await endpoint()
    const action = args.shift()
    if (action === "tools") print(full ? ide.tools : ide.tools.map((item) => item.name))
    else if (action === "call") {
      const name = args.shift()
      if (!name) throw new Error("mcp call requires a tool name")
      print(await tool(ide, name, await input(args), 30_000))
    } else throw new Error("mcp expects tools|call")
    return 0
  }
  if (group === "jetbrains" || group === "jb") {
    return dispatch(await endpoint(), args, { project, timeout, full })
  }
  if (group === "breakpoint") {
    const ide = await endpoint()
    const action = args.shift()
    if (action === "set") {
      const target = args.shift()
      const line = Number(args.shift())
      if (!target || !Number.isInteger(line) || line < 1) throw new Error("breakpoint set requires FILE LINE")
      const result = await tool(ide, "set_breakpoint", { ...(await input(args)), file_path: path.resolve(root, target), line })
      print(ide.id === "webstorm" && object(result) ? { ...result, binding: "unknown", bindingNote: "IDE acceptance does not prove browser binding; a hit verifies it" } : result)
    } else if (action === "list") print(await tool(ide, "list_breakpoints"))
    else if (action === "remove") {
      const id = args.shift()
      if (!id) throw new Error("breakpoint remove requires an ID")
      print(await tool(ide, "remove_breakpoint", { breakpoint_id: id }))
    } else throw new Error("breakpoint expects set|list|remove")
    return 0
  }
  if (group === "debug") {
    const ide = await endpoint()
    const action = args.shift()
    if (action === "browser") {
      print(await launchedBrowser(ide))
      return 0
    }
    if (action === "commands") {
      const name = args.shift()?.replaceAll("-", "_")
      if (name && !ide.tools.some((item) => item.name === name)) throw new Error(`unknown debug command ${name}`)
      print(
        ide.tools
          .filter((item) => !name || item.name === name)
          .map((item) => ({
            command: typeof item.name === "string" ? item.name.replaceAll("_", "-") : item.name,
            description: name ? item.description : undefined,
            inputSchema: name ? item.inputSchema : undefined,
          })),
      )
      return 0
    }
    const map: Record<string, string> = {
      configs: "list_run_configurations",
      sessions: "list_debug_sessions",
      status: "get_debug_session_status",
      resume: "resume_execution",
      pause: "pause_execution",
      "step-over": "step_over",
      "step-into": "step_into",
      "step-out": "step_out",
      stop: "stop_debug_session",
    }
    if (action && map[action])
      print(
        await tool(
          ide,
          map[action],
          {
            include_variables: action === "status" ? false : undefined,
            include_source_context: action === "status" ? false : undefined,
            max_stack_frames: action === "status" ? 5 : undefined,
            ...(await input(args)),
          },
          30_000,
        ),
      )
    else if (action === "wait") {
      const timeout = args[0] && /^\d+$/.test(args[0]) ? Number(args.shift()) : 5
      if (timeout < 1) throw new Error("debug wait timeout must be positive")
      const waited = await tool(ide, "wait_for_pause", { timeout }, timeout * 1000 + 2000)
      if (!details && args.length) throw new Error("debug wait variable names require --inspect")
      const status = object(waited) && waited.state !== "paused" ? await tool(ide, "get_debug_session_status", { include_variables: false, include_source_context: false, max_stack_frames: 5 }) : undefined
      if (status !== undefined && !object(status)) throw new Error("Debugger returned an invalid session status")
      const result = object(status) && status.state === "paused" ? status : waited
      print(
        details && object(result) && result.state === "paused"
          ? await snapshot(ide, index(), args, result)
          : object(result) && result.state !== "paused"
            ? { ...pause(result), diagnosis: await diagnosis(ide) }
            : pause(result),
      )
    } else if (action === "inspect") {
      const selected = args[0] && /^\d+$/.test(args[0]) ? Number(args.shift()) : index()
      print(await snapshot(ide, selected, args))
    } else if (action === "vars") {
      const raw = args.join(" ").trim()
      print(
        raw.startsWith("{") || raw === "-"
          ? await tool(ide, "get_variables", await input(args))
          : await values(ide, args, index()),
      )
    } else if (action === "stack") print(await tool(ide, "get_stack_trace", { max_frames: 5, ...(await input(args)) }))
    else if (action === "source")
      print(await tool(ide, "get_source_context", { lines_before: 3, lines_after: 3, ...(await input(args)) }))
    else if (action === "console")
      print(await tool(ide, "get_console_output", { lines: 20, max_chars: 4000, ...(await input(args)) }))
    else if (action === "threads") print(await tool(ide, "list_threads", await input(args)))
    else if (action === "frame") {
      const frame = Number(args.shift())
      if (!Number.isInteger(frame) || frame < 0) throw new Error("debug frame requires a non-negative index")
      print(await tool(ide, "select_stack_frame", { frame_index: frame }))
    } else if (action === "eval") {
      const expression = args.join(" ").trim()
      if (!expression) throw new Error("debug eval requires an expression")
      print(await tool(ide, "evaluate_expression", { expression, frame_index: index() }))
    } else if (action === "set") {
      const target = args.shift()
      const value = args.join(" ").trim()
      if (!target || !value) throw new Error("debug set requires TARGET EXPRESSION")
      print(await tool(ide, "evaluate_expression", { expression: `${target} = (${value})`, frame_index: index() }))
    } else if (action === "start") {
      const name = args.join(" ").trim()
      if (!name) throw new Error("debug start requires a configuration name")
      const cfg = await config(ide, name)
      const result = await launch(ide, name)
      if (ide.id === "webstorm" && cfg.typeId === "JavascriptDebugType") {
        const browser = await launchedBrowser(ide)
        print({ ...(object(result) ? result : { result }), browser })
      } else print(result)
    } else if (action === "run") {
      const name = args.join(" ").trim()
      if (!name) throw new Error("debug run requires a configuration name")
      print(await tool(ide, "execute_run_configuration", { name, mode: "run" }, 10_000))
    } else {
      const name = action?.replaceAll("-", "_")
      if (!name || !ide.tools.some((item) => item.name === name)) throw new Error("unknown debug command")
      print(await tool(ide, name, await input(args), 30_000))
    }
    return 0
  }
  if (group === "test") {
    const action = args.shift()
    if (action === "breakpoint") print(await smoke())
    else if (action === "browser") print(await browserSmoke())
    else throw new Error("test expects breakpoint|browser")
    return 0
  }
  throw new Error(`unknown command ${group}`)
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message(err) })}\n`)
    process.exit(1)
  },
)
