import fs from "node:fs"
import path from "node:path"
import { browsers } from "./discovery"
import { scope, prepare, browser, address } from "./project"
import { root, ides, object, command, attempt, launcher, sockets, owner, record, stamp, rows, field } from "./core"
import type { Json, Endpoint } from "./core"
import { settings } from "./setup"

type Context = {
  project?: string
  chosen?: string
  attach?: string
  url?: string
  tunnel: () => Promise<unknown>
  endpoints: () => Promise<Endpoint[]>
  tool: (ide: Endpoint, name: string, input?: Json, timeout?: number) => Promise<unknown>
  kill: (pid: number) => void
}

export function lifecycle(ctx: Context) {
  const project = ctx.project
  const chosen = ctx.chosen
  const attach = ctx.attach
  const url = ctx.url
  const tunnel = ctx.tunnel
  const endpoints = ctx.endpoints
  const tool = ctx.tool
  const kill = ctx.kill
  async function open(values: string[]) {
    const target = values.shift()
    if (!target && !project) throw new Error("open requires a component directory or source file")
    if (project && !chosen) throw new Error("open with --project requires --ide")
    const cfg = project
      ? {
          project: path.resolve(project),
          source: path.resolve(root, target || project),
          file: fs.statSync(path.resolve(root, target || project)).isFile(),
          ide: chosen!,
        }
      : scope(root, target!)
    const ide = ides.find((item) => item.id === (chosen || cfg.ide))
    if (!ide) throw new Error(`unknown IDE ${chosen || cfg.ide}`)
    if (attach) {
      if (!url) throw new Error("--attach requires --url with the application URL for source mappings")
      if (ide.id !== "webstorm") throw new Error("--attach requires WebStorm")
      const target = address(attach)
      const socket = (await sockets()).find((row) => row.port === Number(target.port))
      if (!socket?.pid)
        throw new Error("Browser endpoint is not listening or its process ownership is unavailable; no probe sent")
      const exe =
        process.platform === "linux"
          ? fs.realpathSync(`/proc/${socket.pid}/exe`)
          : (await command(["ps", "-p", String(socket.pid), "-o", "comm="], root, 1000)).trim()
      if (
        !/^(chrome|chromium|chrome-headless-shell|headless_shell|Google Chrome(?: for Testing| Canary)?)$/i.test(
          path.basename(exe),
        )
      )
        throw new Error("Attach port does not belong to Chromium; no probe sent")
      const res = await fetch(new URL("json/version", target), { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(`Browser debug endpoint returned HTTP ${res.status}`)
      const data: unknown = await res.json()
      if (!object(data) || typeof data.Browser !== "string" || typeof data.webSocketDebuggerUrl !== "string")
        throw new Error("Chromium listener did not return a browser debugging endpoint")
    }
    const bin = launcher(ide)
    if (!bin) throw new Error(`${ide.name} is not installed; install it and the Debugger MCP plugin on this VM`)
    const line = values.shift()
    if (line && (!Number.isInteger(Number(line)) || Number(line) < 1)) throw new Error("line must be a positive integer")
    const listener = (await sockets()).find((row) => row.port === ide.port)
    if (listener) {
      const status = await owner(listener)
      if (!status.verified) throw new Error(`Port ${ide.port}: ${status.reason}; no IDE launched`)
    }
    if (!project) prepare(cfg as ReturnType<typeof scope>)
    if (url && ide.id !== "webstorm") throw new Error("--url requires WebStorm")
    if (url) browser(root, scope(root, cfg.source).component, cfg.project, url, attach)
    if (!listener) await settings(bin, cfg.project, ide)
    const file = record(cfg.project)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const previous: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined
    const environment = listener?.pid && process.platform === "linux"
      ? fs.readFileSync(`/proc/${listener.pid}/environ`, "utf8").split("\0")
      : []
    const display = process.env.DISPLAY || environment.find((item) => item.startsWith("DISPLAY="))?.slice(8)
    const auth = process.env.XAUTHORITY || (!process.env.DISPLAY ? environment.find((item) => item.startsWith("XAUTHORITY="))?.slice(11) : undefined)
    const argv = [bin, cfg.project]
    if (process.platform === "linux" && !display) {
      if (!Bun.which("xvfb-run") || !Bun.which("xauth"))
        throw new Error("Headless IDE launch requires xvfb-run and xauth on this VM")
      argv.unshift("xvfb-run", "-a", "--server-args=-screen 0 1440x900x24 -nolisten tcp")
    }
    if (process.platform === "linux") argv.unshift("setsid")
    const log = file.replace(/\.json$/, ".log")
    const fd = fs.openSync(log, "a", 0o600)
    const proc = Bun.spawn(argv, {
      cwd: root,
      env: { ...process.env, DISPLAY: display, XAUTHORITY: auth },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    })
    fs.closeSync(fd)
    proc.unref()
    const old = object(previous) && previous.owned === true && typeof previous.token === "string" &&
      previous.closed !== true && typeof previous.pid === "number" && stamp(previous.pid) === previous.token
      ? { pid: previous.pid, token: previous.token }
      : undefined
    const state = {
      ide: ide.id,
      project: cfg.project,
      source: cfg.source,
      pid: old ? old.pid : proc.pid,
      token: old ? old.token : process.platform === "linux" ? stamp(proc.pid) : undefined,
      owned: Boolean(old) || (process.platform === "linux" && !listener),
      log,
      closed: false,
      url: url ? new URL(url).href : object(previous) && typeof previous.url === "string" ? previous.url : undefined,
      endpoint: attach ? address(attach).origin : url ? undefined : object(previous) && typeof previous.endpoint === "string" ? previous.endpoint : undefined,
    }
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
    const waiting = { reason: "Waiting for the IDE and Debugger MCP project to load" }
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (proc.exitCode !== null && proc.exitCode !== 0)
        throw new Error(`${ide.name} launch failed (${proc.exitCode}); inspect ${log}`)
      const ready = await attempt(async () => {
        const live = (await endpoints()).find((item) => item.id === ide.id)
        if (!live)
          throw new Error(
            `Waiting for ${ide.name} Debugger MCP on port ${ide.port}; check ${log} if startup does not finish`,
          )
        const runs = rows(await tool(live, "list_run_configurations", { project_path: cfg.project }), "configurations")
        if (
          url &&
          !runs.some(
            (item) =>
              item.name === "Veritly Browser" &&
              (attach
                ? item.typeId === "ChromiumRemoteDebugType"
                : String(item.description).includes(new URL(url).href)),
          )
        )
          throw new Error("Waiting for WebStorm to load Veritly Browser; reopen this project if its configuration is stale")
        return live
      })
      if (ready.ok) {
        fs.writeFileSync(file, JSON.stringify({ ...state, bridge: ready.value.pid }), { mode: 0o600 })
        if (cfg.file) {
          const screen =
            display ||
            (process.platform === "linux" && ready.value.pid
              ? fs
                  .readFileSync(`/proc/${ready.value.pid}/environ`, "utf8")
                  .split("\0")
                  .find((item) => item.startsWith("DISPLAY="))
                  ?.slice(8)
              : undefined)
          await command([bin, "--line", line || "1", cfg.source], root, 5000, {
            ...process.env,
            DISPLAY: screen,
            XAUTHORITY: auth,
          })
        }
        return {
          ok: true,
          phase: "ide-ready",
          ide: ide.id,
          project: cfg.project,
          pid: ready.value.pid,
          port: ide.port,
          log,
          context: ["--ide", ide.id, "--project", cfg.project],
          configuration: url ? "Veritly Browser" : undefined,
          url: url ? new URL(url).href : undefined,
          endpoint: attach ? address(attach).origin : undefined,
        }
      }
      waiting.reason = ready.error.slice(0, 600)
      await Bun.sleep(500)
    }
    return {
      ok: false,
      phase: "starting",
      ...state,
      reason: waiting.reason,
      context: ["--ide", ide.id, "--project", cfg.project],
    }
  }

  async function close(values: string[]) {
    const target = values.shift()
    if (!target && !project) throw new Error("close requires a component path or --project from open")
    const dir = project ? path.resolve(project) : scope(root, target!).project
    const file = record(dir)
    if (!fs.existsSync(file)) throw new Error(`No launcher-owned IDE record for ${dir}`)
    const state: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!object(state) || typeof state.pid !== "number" || typeof state.ide !== "string")
      throw new Error(`Invalid IDE ownership record: ${file}`)
    if (state.closed === true) return { ok: true, project: dir, phase: "already-closed" }
    const live = (await endpoints()).find((item) => item.id === state.ide)
    const children =
      process.platform === "linux" && state.owned && live?.pid && state.ide === "webstorm"
        ? browsers(await command(["ps", "-eo", "pid=,ppid=,args="], root, 1000), live.pid)
            .map((item) => ({ pid: item.pid, token: stamp(item.pid) }))
            .filter((item) => item.token)
        : []
    if (live) {
      const list = rows(await tool(live, "list_debug_sessions", { project_path: dir }), "sessions")
      for (const item of list) {
        const id = field(item, ["id", "sessionId"])
        if (!id) throw new Error("Debug session has no ID; cannot stop it safely")
        await tool(live, "stop_debug_session", { project_path: dir, session_id: id })
      }
    }
    const peers = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(path.dirname(file), name))
      .filter((name) => name !== file)
      .map((name) => JSON.parse(fs.readFileSync(name, "utf8")) as unknown)
      .filter(object)
      .filter((item) => item.closed !== true && item.bridge && item.bridge === state.bridge)
    if (state.owned && peers.length) throw new Error("Other launcher projects use this IDE; close those projects first")
    const owned = state.owned === true && typeof state.token === "string" && stamp(state.pid) === state.token
    if (owned) {
      const until = Date.now() + 3000
      const running = () => children.some((item) => stamp(item.pid) === item.token)
      while (Date.now() < until && running()) await Bun.sleep(100)
      if (running())
        return { ok: false, project: dir, phase: "stopping", reason: "WebStorm's browser is still shutting down" }
      const pid = state.pid
      const token = live?.pid ? stamp(live.pid) : undefined
      kill(pid)
      const deadline = Date.now() + 5000
      const pending = () =>
        stamp(pid) === state.token ||
        (typeof live?.pid === "number" && typeof token === "string" && stamp(live.pid) === token)
      const listening = async () => (await sockets()).some((row) => row.port === live?.port)
      while (Date.now() < deadline && (pending() || (await listening()))) await Bun.sleep(100)
      if (pending() || (await listening()))
        return {
          ok: false,
          project: dir,
          phase: "stopping",
          reason: "IDE shutdown or debugger listener cleanup is still in progress",
        }
    }
    fs.writeFileSync(file, JSON.stringify({ ...state, closed: true }), { mode: 0o600 })
    return { ok: true, project: dir, phase: owned || !live ? "stopped" : "shared-ide-kept-running" }
  }

  return { open, close }
}
