import path from "node:path"
import { scope } from "./project"
import { inspect, mounted, reload, tab } from "./browser"
import { root, object, attempt, rows, field, record } from "./core"
import type { Endpoint } from "./core"
import type { debuggerClient } from "./debugger"
import { port, spec } from "./service"

export function checks(debug: ReturnType<typeof debuggerClient>, opts: { project?: string; url?: string }) {
  const project = opts.project
  const url = opts.url
  const endpoint = debug.endpoint
  const endpoints = debug.endpoints
  const tool = debug.tool
  const configs = debug.configs
  const config = debug.config
  const launchedBrowser = debug.launchedBrowser
  async function frontend(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("--timeout must be between 0 and 60 seconds")
    const until = Date.now() + seconds * 1000
    while (true) {
      const ide = (await endpoints("webstorm")).find((item) => item.id === "webstorm")
      if (!ide) return { ok: false, phase: "missing", service: "frontend", reason: "WebStorm is not running" }
      const data = await tool(ide, "list_debug_sessions")
      const sessions = rows(data, "sessions").filter((item) => item.runConfigurationName === "Veritly Frontend" && ["running", "paused"].includes(String(item.state)))
      if (!sessions.length) return { ok: false, phase: "missing", service: "frontend", reason: "Start the frontend debug session first" }
      if (sessions.length > 1) return { ok: false, phase: "unknown", service: "frontend", reason: "Multiple frontend sessions are active" }
      if (sessions[0].state === "paused") return { ok: false, phase: "paused", service: "frontend", session: sessions[0] }
      const url = `http://127.0.0.1:${port(spec("frontend"))}/`
      const health = await fetch(url, { signal: AbortSignal.timeout(500) }).then((res) => ({ ok: res.ok, status: res.status }), () => ({ ok: false, status: 0 }))
      if (health.ok) return { ok: true, phase: "ready", service: "frontend", session: sessions[0], health: { ...health, url } }
      if (Date.now() >= until) return { ok: false, phase: "waiting", service: "frontend", session: sessions[0], health: { ...health, url } }
      await Bun.sleep(Math.min(250, until - Date.now()))
    }
  }
  async function smoke() {
    const ide = await endpoint()
    await config(ide, "Veritly IDE Breakpoint Test")
    const target = path.join(root, "packages/veritly-ide/test/fixture.ts")
    const source = await Bun.file(target).text()
    const line = source.split("\n").findIndex((row) => row.includes("veritly-ide-breakpoint")) + 1
    if (line < 1) throw new Error("breakpoint fixture marker is missing")
    const breakpoint = await tool(ide, "set_breakpoint", { file_path: target, line })
    if (!object(breakpoint)) throw new Error("set_breakpoint returned no breakpoint")
    const bid = field(breakpoint, ["breakpointId", "breakpoint_id", "id"])
    try {
      const run = await tool(ide, "start_debug_session", { configuration_name: "Veritly IDE Breakpoint Test" }, 10_000)
      try {
        const paused = await tool(ide, "wait_for_pause", { timeout: 5 }, 7_000)
        const value = await tool(ide, "evaluate_expression", { expression: "value" })
        const ok = JSON.stringify(value).includes("42")
        if (!ok) throw new Error(`breakpoint evaluation did not return 42: ${JSON.stringify(value)}`)
        const inspection = await snapshot(ide, 0, ["input", "value"])
        if (!JSON.stringify(inspection.evaluated).includes("42"))
          throw new Error(`breakpoint variables did not include 42: ${JSON.stringify(inspection.evaluated)}`)
        const mutation = await tool(ide, "evaluate_expression", { expression: "value = 43" })
        const changed = await tool(ide, "evaluate_expression", { expression: "value" })
        if (!JSON.stringify(changed).includes("43"))
          throw new Error(`breakpoint mutation did not return 43: ${JSON.stringify(changed)}`)
        return {
          ok: true,
          ide: ide.id,
          port: ide.port,
          breakpoint,
          run,
          paused,
          expression: value,
          inspection,
          mutation,
          changed,
        }
      } finally {
        await attempt(() => tool(ide, "stop_debug_session"))
      }
    } finally {
      if (bid) await attempt(() => tool(ide, "remove_breakpoint", { breakpoint_id: bid }))
    }
  }

  async function readiness(target: string) {
    const cfg = scope(root, target)
    if (cfg.ide !== "webstorm") throw new Error("ready currently checks a WebStorm browser project")
    if (!url) throw new Error("ready requires --url with the application URL")
    new URL(url)
    const active = await attempt(() => endpoints("webstorm"))
    const ide = active.ok ? active.value.find((item) => item.id === "webstorm") : undefined
    const [runs, live, web, http] = await Promise.all([
      ide ? attempt(() => tool(ide, "list_run_configurations", { project_path: cfg.project })) : undefined,
      ide ? attempt(() => tool(ide, "list_debug_sessions", { project_path: cfg.project })) : undefined,
      ide ? attempt(() => launchedBrowser(ide)) : undefined,
      attempt(async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        return { ok: res.ok, status: res.status }
      }),
    ])
    const selected = runs?.ok ? rows(runs.value, "configurations").find((item) => item.name === "Veritly Browser") : undefined
    const saved = await attempt(async () => await Bun.file(record(cfg.project)).json() as unknown)
    const matches = typeof selected?.description === "string" && selected.description.includes(new URL(url).href) ||
      selected?.typeId === "ChromiumRemoteDebugType" && saved.ok && object(saved.value) && saved.value.url === new URL(url).href && typeof saved.value.endpoint === "string"
    const sessions = live?.ok ? rows(live.value, "sessions").filter((item) => item.runConfigurationName === "Veritly Browser") : undefined
    const state = sessions?.length === 1 ? sessions[0].state : undefined
    const found = web?.ok ? await attempt(() => tab(web.value.endpoint, url)) : undefined
    const page = web?.ok && found?.ok && state !== "paused" ? await attempt(() => inspect(web.value.endpoint, url)) : undefined
    const stages = {
      ide: { ok: Boolean(ide), error: active.ok ? undefined : active.error },
      project: { ok: Boolean(selected) && matches, error: runs && !runs.ok ? runs.error : undefined },
      session: { ok: sessions?.length === 1 && ["running", "paused"].includes(String(state)), state, count: sessions?.length, error: live && !live.ok ? live.error : undefined },
      browser: { ok: Boolean(web?.ok && found?.ok), error: found && !found.ok ? found.error : web && !web.ok ? web.error : undefined },
      http: http.ok ? http.value : { ok: false, error: http.error },
      app: {
        ok: Boolean(page?.ok && mounted(page.value.page)),
        state: state === "paused" ? "paused" : page?.ok ? (mounted(page.value.page) ? "mounted" : "not_mounted") : "unknown",
        document: page?.ok ? page.value.page.document : undefined,
        elements: page?.ok ? page.value.page.elements : undefined,
        error: page && !page.ok ? page.error : undefined,
      },
      breakpoint: { ok: Boolean(ide?.tools.some((item) => item.name === "set_breakpoint")), binding: "unknown" },
    }
    return {
      ok: Object.values(stages).every((stage) => stage.ok),
      project: cfg.project,
      url,
      stages,
      errors: page?.ok ? page.value.errors : undefined,
      errorScope: page?.ok ? page.value.scope : undefined,
      browser: web?.ok ? web.value : undefined,
    }
  }

  async function diagnosis(ide: Endpoint) {
    if (ide.id !== "webstorm") return { reason: "no_pause", binding: "unknown" }
    const [list, runs, web] = await Promise.all([
      attempt(() => tool(ide, "list_breakpoints")),
      attempt(() => configs(ide)),
      attempt(() => launchedBrowser(ide)),
    ])
    const cfg = runs.ok ? runs.value.find((item) => item.name === "Veritly Browser") : undefined
    const match = typeof cfg?.description === "string" ? cfg.description.match(/uri: (\S+), engine:/) : undefined
    const address = url || match?.[1]
    const page = address && web.ok ? await attempt(() => inspect(web.value.endpoint, address)) : undefined
    const enabled = list.ok ? rows(list.value, "breakpoints").filter((item) => item.type === "line" && item.enabled === true) : undefined
    return {
      reason: !page?.ok ? "page_state_unknown" : !mounted(page.value.page) ? "app_not_mounted" : enabled?.length === 0 ? "no_enabled_breakpoints" : "no_breakpoint_hit",
      app: page?.ok ? { document: page.value.page.document, mounted: mounted(page.value.page), elements: page.value.page.elements } : { state: "unknown", error: page && !page.ok ? page.error : undefined },
      breakpoints: { enabled: enabled ? enabled.length : null, binding: "unknown", error: list.ok ? undefined : list.error },
      errors: page?.ok ? page.value.errors : undefined,
      errorScope: page?.ok ? page.value.scope : undefined,
    }
  }

  async function browserSmoke() {
    if (!url) throw new Error("test browser requires --url")
    const cfg = scope(root, "packages/app")
    if (!project || path.resolve(project) !== cfg.project) throw new Error(`test browser requires --project ${cfg.project}`)
    const ide = await endpoint()
    if (ide.id !== "webstorm") throw new Error("test browser requires WebStorm")
    const ready = await readiness("packages/app")
    if (!ready.ok || !ready.browser) throw new Error(`Browser is not ready: ${JSON.stringify(ready.stages)}`)
    const sessions = rows(await tool(ide, "list_debug_sessions"), "sessions")
      .filter((item) => item.runConfigurationName === "Veritly Browser" && ["running", "paused"].includes(String(item.state)))
    if (sessions.length !== 1) throw new Error(`Expected one active browser debug session; found ${sessions.length}`)
    const session = field(sessions[0], ["id", "sessionId"])
    if (!session) throw new Error("Browser debug session has no ID")
    const list = rows(await tool(ide, "list_breakpoints"), "breakpoints")
    if (list.some((item) => item.enabled === true)) throw new Error("Disable existing breakpoints before test browser")
    const target = path.join(root, "packages/app/src/entry.tsx")
    const source = await Bun.file(target).text()
    const line = source.split("\n").findIndex((row) => row.trim() === "render(") + 1
    if (!line) throw new Error("App render location not found")
    const point = await tool(ide, "set_breakpoint", { file_path: target, line })
    if (!object(point)) throw new Error("IDE returned an invalid breakpoint")
    const id = field(point, ["breakpointId", "breakpoint_id", "id"])
    if (!id) throw new Error("IDE did not return a breakpoint ID; inspect breakpoints before retrying")
    const state = { paused: false }
    try {
      await reload(ready.browser.endpoint, url)
      const hit = await tool(ide, "wait_for_pause", { session_id: session, timeout: 5 }, 7000)
      if (!object(hit) || hit.state !== "paused" || !object(hit.breakpointHit) || hit.breakpointHit.breakpointId !== id)
        throw new Error(`App breakpoint did not hit: ${JSON.stringify(pause(hit))}; ${JSON.stringify(await diagnosis(ide))}`)
      state.paused = true
      const value = await tool(ide, "evaluate_expression", { session_id: session, expression: "root.tagName", frame_index: 0 })
      if (!object(value) || !object(value.result) || value.result.error || value.result.value !== '"DIV"')
        throw new Error("Could not inspect the app root at the breakpoint")
      await tool(ide, "step_over", { session_id: session })
      const step = await tool(ide, "wait_for_pause", { session_id: session, timeout: 5 }, 7000)
      if (!object(step) || step.state !== "paused" || step.pausedReason !== "step")
        throw new Error(`Debugger did not pause after stepping: ${JSON.stringify(pause(step))}`)
      return { ok: true, breakpoint: pause(hit), expression: value, step: pause(step) }
    } finally {
      const removed = await attempt(() => tool(ide, "remove_breakpoint", { breakpoint_id: id }))
      const status = await attempt(() => tool(ide, "get_debug_session_status", { session_id: session, include_variables: false, include_source_context: false, max_stack_frames: 1 }))
      const paused = status.ok && object(status.value) && status.value.state === "paused" && (state.paused || (object(status.value.breakpointHit) && status.value.breakpointHit.breakpointId === id))
      const resumed = paused ? await attempt(() => tool(ide, "resume_execution", { session_id: session })) : undefined
      if (!removed.ok || !status.ok || (resumed && !resumed.ok))
        throw new Error(`Browser test cleanup failed: ${JSON.stringify({ removed, status, resumed })}`)
    }
  }

  async function values(ide: Endpoint, names: string[], frame = 0) {
    if (!names.length)
      throw new Error("While paused, use debug vars NAME or debug eval EXPRESSION with the same IDE and session selectors; use debug get-variables '{}' for the full scope before resuming")
    const results: unknown[] = []
    for (const expression of names)
      results.push(await tool(ide, "evaluate_expression", { expression, frame_index: frame }))
    const first = results.find(object)
    return {
      sessionId: first?.sessionId,
      frameIndex: frame,
      variables: results.map((value) => (object(value) && object(value.result) ? value.result : value)),
    }
  }

  function pause(value: unknown) {
    if (!object(value)) throw new Error("debugger returned invalid session status")
    const result = Object.fromEntries(
      [
        "waitResult",
        "message",
        "sessionId",
        "name",
        "state",
        "pausedReason",
        "currentLocation",
        "breakpointHit",
        "totalStackDepth",
      ]
        .filter((key) => value[key] !== undefined && value[key] !== null)
        .map((key) => [key, value[key]]),
    )
    if (value.state === "paused") result.hint = "Inspect paused values with debug vars or debug eval; a paused browser cannot run page JavaScript."
    return result
  }

  async function snapshot(ide: Endpoint, frame = 0, names: string[] = [], value?: unknown) {
    const status =
      value === undefined
        ? await tool(ide, "get_debug_session_status", {
            include_source_context: true,
            include_variables: false,
            source_context_lines: 3,
            max_stack_frames: 5,
          })
        : value
    if (!object(status) || status.state !== "paused")
      throw new Error("Variable inspection requires a paused session; trigger a breakpoint or use debug pause, then inspect before resuming")
    if (!Array.isArray(status.stackSummary)) throw new Error("Debugger returned no stack summary for the paused session")
    const variables = await tool(ide, "get_variables", { frame_index: frame })
    if (!object(variables) || !Array.isArray(variables.variables)) throw new Error("Debugger returned no variables for the paused frame")
    return {
      ...pause(status),
      stackSummary: status.stackSummary.slice(0, 5),
      sourceContext: status.sourceContext,
      variables: variables.variables,
      evaluated: names.length ? await values(ide, names, frame) : undefined,
      hint: "Inspect values with debug vars NAME or debug eval EXPRESSION using the same selectors before resuming.",
    }
  }


  return { smoke, readiness, diagnosis, browserSmoke, values, pause, snapshot, frontend }
}
