#!/usr/bin/env bun
import path from "node:path"
import { dispatch } from "./jetbrains"
import { root, file, namespace, ides, specs, object, print, message, attempt, launcher, input, opened, rows, field } from "./core"
import { lifecycle } from "./lifecycle"
import { debuggerClient } from "./debugger"
import { doctor } from "./doctor"
import { checks } from "./checks"
import { spec, tunnel, cluster, kill, start, stop, state, routing } from "./service"
import { enqueue, jobs, cancel, recover, wait, service, managed } from "./job"
import { retry as retryPlugin, wait as waitPlugin } from "./plugin"
import { up as sessionUp, down as sessionDown, wait as sessionWait, browser as sessionBrowser, context as sessionContext, matching as sessionMatching, owner as sessionOwner } from "./session"
import { start as requestStart, wait as requestWait } from "./request"
import { scope as projectScope } from "./project"

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

const explicit = option("--ide")
const override = option("--port")
const explicitSession = option("--session")
const selected = option("--project")
const scope = option("--service")
if (scope && (explicit && explicit !== "rustrover" || override)) throw new Error("--service selects RustRover; do not combine it with a different IDE or port")
const context = scope ? sessionContext(scope) : (!explicit || explicit === "rustrover") && args[0] === "breakpoint" && args[1] === "set" && args[2] ? sessionMatching(args[2]) : undefined
const project = selected ? (path.resolve(selected).startsWith(`${root}${path.sep}`) || path.resolve(selected) === root ? projectScope(root, selected).project : path.resolve(selected)) : context?.project
const job = scope && context && (!selected || project === context.project)
  ? jobs(context.project).find((item) => item.name === service(scope) && ["running", "paused"].includes(String(item.phase)))
  : undefined
const session = explicitSession || (typeof job?.session === "string" || typeof job?.session === "number" ? String(job.session) : undefined)
const web = args[0] === "debug" && ["start", "cancel"].includes(args[1] || "") && args[2] === "frontend" ||
  ["start", "stop", "status"].includes(args[0] || "") && args[1] === "frontend"
const chosen = explicit || (scope || args[0] === "breakpoint" && args[1] === "set" && path.extname(args[2] || "") === ".rs" ? "rustrover" : web ? "webstorm" : undefined)
const timeout = option("--timeout")
const until = option("--until")
const frame = option("--frame")
const details = flag("--inspect")
const full = flag("--full")
const once = flag("--once")
const condition = option("--condition")
flag("--json")
const url = option("--url")
const attach = option("--attach")

function index() {
  if (!frame) return 0
  const value = Number(frame)
  if (!Number.isInteger(value) || value < 0) throw new Error("--frame must be a non-negative integer")
  return value
}


const debug = debuggerClient({ chosen, override, session: scope ? explicitSession : session, project, configuration: scope && context && (!selected || project === context.project) ? service(scope) : undefined })
const { launchedBrowser, endpoints, endpoint, tool, config, launch } = debug
const { smoke, readiness, diagnosis, browserSmoke, values, pause, snapshot, frontend } = checks(debug, { project, url })

const usage = `veritly-ide doctor [--ide ID] [--port PORT]
veritly-ide plugin retry
veritly-ide ready PATH --url URL
veritly-ide wait plugin|frontend|data|server|edge|office|gateway|governor [--timeout SECONDS] [--json]
veritly-ide ides
veritly-ide connect
veritly-ide open PATH [LINE] [--ide ID] [--url URL] [--attach ENDPOINT]
veritly-ide close PATH | close --project PATH
veritly-ide services
veritly-ide start|stop|status frontend [--ide ID]
veritly-ide route|unroute data|server|edge|office|gateway|governor
veritly-ide breakpoint set FILE LINE [--once] [--condition EXPRESSION] [JSON] | list | remove ID
veritly-ide debug browser|configs|sessions|status|wait|inspect|vars|stack|source|console|threads|frame [...]
veritly-ide debug up|down data|server|edge|office|gateway|governor
veritly-ide debug request SERVICE /PATH [--timeout SECONDS]
veritly-ide wait session SERVICE [--until ready|stopped] [--timeout SECONDS] [--json]
veritly-ide wait request ID [--timeout SECONDS] [--json]
veritly-ide debug resume|pause|step-over|step-into|step-out|eval|set|start|run|stop [...]
veritly-ide debug jobs | builds | cancel|recover CONFIGURATION --ide rustrover
veritly-ide debug commands [TOOL] | TOOL [JSON|-]
veritly-ide mcp tools | call TOOL [JSON|-]
veritly-ide jetbrains tools [FILTER] | schema TOOL | call TOOL [JSON|-] [--timeout SECONDS]
veritly-ide jetbrains status | configs | output [SESSION]
veritly-ide test breakpoint
veritly-ide test browser --project PATH --url URL

Use --service NAME for a Rust service's project and debugger, --project PATH to select its recorded IDE, --session ID for a specific session, and --frame N for a stack frame. Rust breakpoint files select RustRover automatically.
At a frontend pause, select the browser session and inspect variables before resuming; raw MCP tool names use underscores.
Attach managed browsers with T3 preview_status then preview_open using preview.arguments; available:false with tabId:null means open the preview, not an attachment failure.
Use debug browser --service NAME to retrieve that managed session's verified browser attachment recipe.
Read the attached tab with T3 preview_snapshot and click its controls with T3 preview_act (action=click, tabId, locator=aria-ref); discover preview_act by name if needed.
open selects the component's IDE and waits up to 20s; exit 2 means it is still starting. close stops launcher-owned IDEs.
JetBrains tools are listed by name; use schema for details and --full for unbounded output.
Native Rust uses RustRover run configurations; discover these with debug configs, then debug start NAME.
Waits return immediately when their condition is met, with a default maximum of 60s; --timeout sets a shorter maximum. Steps wait for the next pause.
All result data is JSON on stdout. Errors are JSON on stderr.`

async function main() {
  const group = args.shift()
  if (!group || group === "help" || group === "--help" || group === "-h" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (group === "doctor") {
    const value = await doctor(debug, { chosen, project, source: context?.source, service: scope })
    print(value)
    return value.ok ? 0 : 1
  }
  if (group === "plugin") {
    if (args.shift() !== "retry" || args.length) throw new Error("plugin expects retry")
    print(retryPlugin())
    return 0
  }
  if (group === "ready") {
    const target = args.shift()
    if (!target) throw new Error("ready requires a component path")
    const value = await readiness(target)
    print(value)
    return value.ok ? 0 : 1
  }
  if (group === "wait") {
    const name = args.shift()
    if (name === "request") {
      const id = args.shift()
      if (!id || args.length) throw new Error("wait request requires one request ID")
      const result = await requestWait(id, timeout ? Number(timeout) : 60)
      print(result)
      return result.ok ? 0 : "phase" in result && result.phase === "waiting" ? 2 : 1
    }
    if (name === "session") {
      const service = args.shift()
      if (!service || args.length) throw new Error("wait session requires one service name")
      const result = await sessionWait(service, timeout ? Number(timeout) : 60, until)
      print(result)
      return result.ok ? 0 : ["waiting", "stopping", "paused"].includes(String(result.phase)) ? 2 : 1
    }
    if (!name || args.length) throw new Error("wait requires one service name")
    if (name === "plugin") {
      const ide = ides.find((item) => item.id === (chosen || "rustrover"))
      if (!ide) throw new Error(`Unknown IDE ${chosen}`)
      const bin = launcher(ide)
      if (!bin) throw new Error(`${ide.name} is not installed`)
      const result = await waitPlugin(ide, bin, timeout ? Number(timeout) : 60)
      print(result)
      return result.ok ? 0 : result.phase === "plugin_failed" ? 1 : 2
    }
    if (name === "frontend") {
      const result = await frontend(timeout ? Number(timeout) : 60)
      print(result)
      return result.ok ? 0 : ["waiting", "paused"].includes(String(result.phase)) ? 2 : 1
    }
    if (!chosen && !project && !override && managed(name)) {
      const current = sessionContext(name).state
      if (current && !["stopped", "failed"].includes(String(current.phase))) {
        const result = await sessionWait(name, timeout ? Number(timeout) : 60)
        print(result)
        return result.ok ? 0 : ["waiting", "stopping", "paused"].includes(String(result.phase)) ? 2 : 1
      }
    }
    const ide = (await endpoints()).find((item) => item.id === "rustrover")
    if (!ide) throw new Error("RustRover is not running; open the service's source first")
    const target = project ? path.resolve(project) : opened(ide)
    if (!target) throw new Error("No RustRover project selected; open the service's source first")
    const result = await wait(name, target, timeout ? Number(timeout) : 60)
    print(result)
    return result.ok ? 0 : ["waiting", "paused"].includes(String(result.phase)) ? 2 : 1
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
    if (value.phase === "plugin_failed") return 1
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
    const name = args.shift()
    if (!name) throw new Error("route expects a service name")
    print(await routing(group === "route", name))
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
    return dispatch(await endpoint(), args, { project, timeout, full, session, frame: index() })
  }
  if (group === "breakpoint") {
    const ide = await endpoint()
    const action = args.shift()
    if (action === "set") {
      const target = args.shift()
      const line = Number(args.shift())
      if (!target || !Number.isInteger(line) || line < 1) throw new Error("breakpoint set requires FILE LINE")
      const ext = path.extname(target)
      const owner = ext === ".rs" ? "rustrover" : [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext) ? "webstorm" : undefined
      if (owner && owner !== ide.id)
        throw new Error(`${target} belongs in ${owner}, but this selector chose ${ide.id}; use breakpoint set ${target} ${line}${once ? " --once" : ""} --ide ${owner} without --service`)
      const managed = ide.id === "webstorm" ? sessionOwner() : undefined
      if (managed) {
        const current = project || (await attempt(async () => opened(ide))).value
        if (current !== managed.project)
          throw new Error(`The managed ${managed.service} browser belongs to ${managed.project}; set frontend breakpoints using ${managed.context.join(" ")}. Shared-source breakpoints belong to this browser project too.`)
      }
      const opts = await input(args)
      if (condition !== undefined) {
        if (!condition.trim()) throw new Error("--condition requires a nonempty expression")
        if (opts.condition !== undefined) throw new Error("Pass the condition with --condition or JSON, not both")
        opts.condition = condition
      }
      const result = await tool(ide, "set_breakpoint", { ...opts, ...(once ? { temporary: true } : {}), file_path: path.resolve(root, target), line })
      print(object(result) ? { ...result, binding: "unknown", bindingNote: "IDE acceptance does not prove breakpoint binding; a hit verifies it", hint: "Trigger the action after setting breakpoints; adding a breakpoint while paused does not advance execution, so resume or step to it and inspect the next pause before judging the request." } : result)
    } else if (action === "list") print(await tool(ide, "list_breakpoints"))
    else if (action === "remove") {
      const id = args.shift()
      if (!id) throw new Error("breakpoint remove requires an ID")
      print(await tool(ide, "remove_breakpoint", { breakpoint_id: id }))
    } else throw new Error("breakpoint expects set|list|remove")
    return 0
  }
  if (group === "debug") {
    const action = args.shift()
    if (action === "request") {
      const name = args.shift()
      const route = args.shift()
      if (!name || !route || args.length) throw new Error("debug request requires SERVICE /PATH")
      print(await requestStart(name, route, timeout ? Number(timeout) : undefined))
      return 0
    }
    if (action === "up" || action === "down") {
      const name = args.shift()
      if (!name || args.length) throw new Error(`debug ${action} requires one service name`)
      print(action === "up" ? sessionUp(name) : sessionDown(name))
      return 0
    }
    if (action === "browser" && scope) {
      if (args.length || explicit || selected || explicitSession) throw new Error("A managed browser is selected by --service NAME; omit positional arguments, --ide, --project and --session")
      print(await sessionBrowser(scope))
      return 0
    }
    const rust = action && ["start", "cancel", "recover"].includes(action) && managed(args.join(" ").trim())
    const ide = !chosen && !override && rust ? (await endpoints()).find((item) => item.id === "rustrover") : await endpoint()
    if (!ide) throw new Error("RustRover is not running; open the service's source first")
    if (ide.id === "rustrover") {
      if (!action) throw new Error("debug requires a command")
      if (action === "run") throw new Error("Use debug start for Rust so runtime setup is applied")
      if (action === "builds") return dispatch(ide, [action, ...args], { project, timeout, full, session, frame: index() })
      if (["start", "jobs", "cancel", "recover"].includes(action)) {
        const name = service(args.join(" ").trim())
        const target = project ? path.resolve(project) : name && managed(name) ? sessionContext(args.join(" ").trim()).project : opened(ide)
        if (!target) throw new Error("No IDE project selected; open a project or pass --project")
        if (action === "jobs") { print({ jobs: scope ? jobs(target).filter((item) => item.name === service(scope)) : jobs(target) }); return 0 }
        if (!name) throw new Error(`debug ${action} requires a configuration name`)
        if (action === "start") { print(enqueue(name, target)); return 0 }
        if (action === "recover") { print(recover(name, target)); return 0 }
        print(cancel(name, target))
        return 0
      }
    }
    if (action === "browser") {
      print(await launchedBrowser(ide))
      return 0
    }
    if (action === "cancel") {
      const name = args.join(" ").trim()
      const cfg = name === "frontend" ? "Veritly Frontend" : name === "browser" ? "Veritly Browser" : name
      if (!cfg) throw new Error("debug cancel requires a configuration name")
      const sessions = rows(await tool(ide, "list_debug_sessions"), "sessions")
        .filter((item) => item.runConfigurationName === cfg && ["running", "paused"].includes(String(item.state)))
      if (!sessions.length) { print({ ok: true, name: cfg, phase: "stopped" }); return 0 }
      if (sessions.length !== 1) throw new Error(`Multiple sessions for ${cfg}; select --session ID and use debug stop`)
      const id = field(sessions[0], ["id", "sessionId"])
      if (!id) throw new Error("Debug session has no ID")
      print(await tool(ide, "stop_debug_session", { session_id: id }))
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
    if (action === "commands") {
      const query = args.shift()
      const name = query ? map[query] || query.replaceAll("-", "_") : undefined
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
    if (action && ["step-over", "step-into", "step-out"].includes(action)) {
      const seconds = timeout ? Number(timeout) : 60
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error("Step timeout must be 1..60 seconds")
      const result = await tool(ide, map[action], await input(args), 30_000)
      const waited = await tool(ide, "wait_for_pause", { timeout: seconds }, seconds * 1000 + 2000)
      print(object(waited) ? {
        ...pause(waited),
        action,
        result,
        hint: waited.state === "stopped"
          ? "The debugger reported this session stopped; check debug sessions and debug jobs with the same selector before relaunching."
          : waited.state === "paused"
          ? "Inspect this frame, step again, or resume; the application remains paused."
          : "The step is still running; check debug status before issuing another step.",
      } : waited)
    } else if (action === "resume") {
      const result = await tool(ide, map.resume, await input(args), 30_000)
      const status = await attempt(() => tool(ide, "get_debug_session_status", {
        session_id: object(result) ? result.sessionId : undefined,
        include_variables: false, include_source_context: false, max_stack_frames: 1,
      }))
      print({
        ...(object(result) ? result : { result }),
        observation: status.ok ? pause(status.value) : status,
        hint: status.ok && object(status.value) && status.value.state === "paused"
          ? "Execution paused again; inspect this location and its values before resuming the same request."
          : "Resume was accepted; check both backend and browser debugger status before judging the request, since another breakpoint can pause it again.",
      })
    } else if (action && map[action])
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
      const seconds = args[0] && /^\d+$/.test(args[0]) ? Number(args.shift()) : timeout ? Number(timeout) : 60
      if (!Number.isFinite(seconds) || seconds < 1) throw new Error("debug wait timeout must be positive")
      const waited = await tool(ide, "wait_for_pause", { timeout: seconds }, seconds * 1000 + 2000)
      if (!details && args.length) throw new Error("debug wait variable names require --inspect")
      const status = object(waited) && waited.state !== "paused" ? await tool(ide, "get_debug_session_status", { include_variables: false, include_source_context: false, max_stack_frames: 5 }) : undefined
      if (status !== undefined && !object(status)) throw new Error("Debugger returned an invalid session status")
      const result = object(status) && status.state === "paused" ? status : waited
      print(
        details && object(result) && result.state === "paused"
          ? await snapshot(ide, index(), args, result)
          : object(result) && result.state !== "paused"
            ? { ...pause(result), diagnosis: await diagnosis(ide), hint: "Trigger the operation after setting breakpoints (reload the same app page for load requests), then wait again; no pause alone does not prove a binding failure." }
            : pause(result),
      )
    } else if (action === "inspect") {
      const selected = args[0] && /^\d+$/.test(args[0]) ? Number(args.shift()) : index()
      print(await snapshot(ide, selected, args))
    } else if (action === "vars") {
      const raw = args.join(" ").trim()
      const result = !raw
        ? await tool(ide, "get_variables", { frame_index: index() })
        : raw.startsWith("{") || raw === "-"
          ? await tool(ide, "get_variables", await input(args))
          : await values(ide, args, index())
      print(object(result) && Array.isArray(result.variables) && result.variables.length === 0
        ? { ...result, hint: "This frame exposes no locals; inspect another stack frame or evaluate a specific expression." }
        : result)
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
      const value = args.join(" ").trim()
      const name = value === "frontend" ? "Veritly Frontend" : value === "browser" ? "Veritly Browser" : value
      if (!name) throw new Error("debug start requires a configuration name")
      const cfg = await config(ide, name)
      const prior = ide.id === "webstorm" && cfg.typeId === "JavascriptDebugType" ? (await debug.browserProcesses(ide)).map((row) => row.pid) : undefined
      const result = await launch(ide, name)
      if (ide.id === "webstorm" && cfg.typeId === "JavascriptDebugType") {
        const browser = await launchedBrowser(ide, { prior })
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
    process.stderr.write(`${JSON.stringify({ ok: false, error: message(err), hint: "Use veritly-ide --help for syntax, or debug commands TOOL with the same IDE/service selector for tool arguments." })}\n`)
    process.exit(1)
  },
)
