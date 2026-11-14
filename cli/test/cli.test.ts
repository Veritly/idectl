import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { browsers } from "../src/discovery"
import { address, browser, prepare, scope } from "../src/project"
import { rows, record, selection } from "../src/core"
import { wait, enqueue, recover } from "../src/job"
import { context } from "../src/session"
import { Repair } from "../src/core"
import { load } from "../src/config"

const cli = path.resolve(import.meta.dir, "../src/cli.ts")
const example = path.resolve(import.meta.dir, "../../example")

test("replace-mode services launch only inside a managed session and request repair otherwise", async () => {
  const before = context("worker").state
  expect(() => enqueue("Example Worker", "/unused")).toThrow(Repair)
  expect(() => recover("Example Worker", "/unused")).toThrow(Repair)
  expect(context("worker").state).toEqual(before)
  const proc = Bun.spawn(["bun", cli, "route", "worker", "--json"], { cwd: example, stdout: "pipe", stderr: "pipe" })
  const output = new Response(proc.stdout).text()
  const error = await new Response(proc.stderr).json()
  expect(await proc.exited).toBe(1)
  expect(await output).toBe("")
  expect(error).toMatchObject({ code: "environment_repair_required", retryable: false })
  expect(error.error).toContain("debug up worker")
  expect(context("worker").state).toEqual(before)
})

test("project config is validated and owns every service definition", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-config-"))
  const target = { project: "app", configuration: "App", health: "/", port: "APP_PORT", workload: "app", agent: "sidecar", mode: "intercept" }
  const write = (value: unknown) => fs.writeFileSync(path.join(dir, "idectl.json"), JSON.stringify(value))
  const base = {
    cli: "idectl",
    env: ".env", state: ".state", adapter: { type: "none" },
    frontend: { ...target, browser: "Browser", url: "APP_URL", mounted: "true" },
    services: { api: { ...target, configuration: "Api", ide: "rustrover", binary: "target/api", container: "api" } },
  }
  try {
    write(base)
    const value = load(dir)
    expect(value.adapter).toEqual({ type: "none" })
    expect(value.services.api).toMatchObject({ id: "api", configuration: "Api", mode: "intercept" })
    expect(value.env).toBe(path.join(dir, ".env"))
    write({ ...base, services: { api: { ...base.services.api, mode: "swap" } } })
    expect(() => load(dir)).toThrow("services.api.mode must be intercept or replace")
    write({ ...base, services: { api: { ...base.services.api, ide: "webstorm" } } })
    expect(() => load(dir)).toThrow("services.api.binary applies to rustrover services only")
    write({ ...base, services: { api: { ...base.services.api, ide: "webstorm", binary: undefined } } })
    expect(load(dir).services.api).toMatchObject({ ide: "webstorm", binary: undefined })
    write({ ...base, services: { frontend: base.services.api } })
    expect(() => load(dir)).toThrow("frontend is reserved")
    const attach = { project: "drivers", configuration: "Drivers", port: "9229", file: ".state/inspect" }
    write({ ...base, attach: { drivers: attach } })
    expect(load(dir).attach.drivers).toEqual(attach)
    write({ ...base, attach: { drivers: { ...attach, port: "x" } } })
    expect(() => load(dir)).toThrow("attach.drivers.port must be a number string")
    write({ ...base, adapter: { type: "kubernetes", namespace: "dev" } })
    expect(() => load(dir)).toThrow("adapter.skip")
  } finally {
    fs.rmSync(dir, { recursive: true })
  }
})

test("startup selection errors are JSON and explain frontend debugger selection", async () => {
  for (const args of [["--service"], ["--service", "unknown"], ["--service", "frontend"]]) {
    const proc = Bun.spawn(["bun", cli, "debug", "status", ...args], { cwd: example, stdout: "pipe", stderr: "pipe" })
    const output = new Response(proc.stdout).text()
    const error = await new Response(proc.stderr).json()
    expect(await proc.exited).toBe(1)
    expect(await output).toBe("")
    expect(error.ok).toBe(false)
    expect(error.hint).toContain("--help")
    if (args[1] === "frontend") {
      expect(error.error).toContain("--ide webstorm --project")
      expect(error.error).toContain("browser.context")
    }
  }
})

test("optional JSON never waits on an open stdin unless - is passed", async () => {
  const proc = Bun.spawn(["bun", "-e", `import { input } from "${path.resolve(import.meta.dir, "../src/core")}"; console.log(JSON.stringify(await input([])))`], {
    cwd: example,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), 3000)
  expect(await proc.exited).toBe(0)
  clearTimeout(timer)
  expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({})
  proc.stdin.end()
})

test("JSON stdin accepts a piped object and rejects an empty pipe", async () => {
  for (const value of ["", '{"condition":"name === \\"projects\\""}']) {
    const proc = Bun.spawn(["bun", "-e", `import { input } from "${path.resolve(import.meta.dir, "../src/core")}"; console.log(JSON.stringify(await input(["-"])))`], {
      cwd: example,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write(value)
    proc.stdin.end()
    const output = new Response(proc.stdout).text()
    const error = new Response(proc.stderr).text()
    expect(await proc.exited).toBe(value ? 0 : 1)
    if (value) expect(JSON.parse(await output)).toEqual(JSON.parse(value))
    if (!value) expect(await error).toContain("JSON stdin is empty")
  }
})

test("an explicit project selects its recorded active IDE and rejects ambiguity", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ide-selection-"))
  const file = record(project)
  const ide = { id: "selection-test", name: "Selection test", pid: process.pid, port: 1, url: "http://127.0.0.1:1", tools: [] }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, JSON.stringify({ ide: ide.id, bridge: ide.pid, project, closed: false }))
    expect(selection([{ ...ide, id: "other" }, ide], project)).toBe(ide)
    expect(() => selection([{ ...ide, id: "other" }], project)).toThrow("not recorded")
    expect(() => selection([ide, { ...ide, port: 2 }], project)).toThrow("multiple active IDEs")
    fs.writeFileSync(file, JSON.stringify({ ide: ide.id, bridge: ide.pid, project, closed: true }))
    expect(() => selection([ide], project)).toThrow("not recorded")
  } finally {
    fs.rmSync(file)
    fs.rmdirSync(project)
  }
})

test("readiness reports a missing service instead of claiming it is ready", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ide-wait-"))
  try {
    expect(await wait("api", project, 0.1)).toMatchObject({ ok: false, phase: "missing", service: "api" })
    await expect(wait("unknown", project, 0.1)).rejects.toThrow("Unknown service")
    await expect(wait("api", project, 0)).rejects.toThrow("--timeout")
  } finally {
    fs.rmdirSync(project)
  }
})

test("rejects malformed debugger lists instead of reporting them as empty", () => {
  expect(() => rows({}, "sessions")).toThrow("invalid sessions list")
  expect(() => rows({ sessions: [{}, "invalid"] }, "sessions")).toThrow("invalid entry in sessions")
  expect(rows({ sessions: [] }, "sessions")).toEqual([])
})

test("prints shell-friendly help", async () => {
  const proc = Bun.spawn(["bun", cli, "help"], { cwd: example, stdout: "pipe", stderr: "pipe" })
  const help = await new Response(proc.stdout).text()
  expect(help).toContain("idectl mcp tools")
  expect(help).toContain("idectl debug commands [TOOL] | TOOL [JSON|-]")
  expect(help).toContain("idectl debug up|down api|worker")
  expect(await proc.exited).toBe(0)
})

test("nested debugger help works without selecting or contacting an IDE", async () => {
  const proc = Bun.spawn(["bun", cli, "debug", "vars", "--help", "--port", "1"], { cwd: example, stdout: "pipe", stderr: "pipe" })
  expect(await new Response(proc.stdout).text()).toContain("debug browser|configs|sessions|status|wait|inspect|vars")
  expect(await new Response(proc.stderr).text()).toBe("")
  expect(await proc.exited).toBe(0)
})

test("documents the inspection commands and the project config", async () => {
  const help = Bun.spawn(["bun", cli, "help"], { cwd: example, stdout: "pipe", stderr: "pipe" })
  const text = await new Response(help.stdout).text()
  expect(text).toContain("debug browser|configs|sessions|status|wait|inspect|vars")
  expect(text).toContain("idectl.json")
  expect(await help.exited).toBe(0)

})

test("finds only debug browsers owned by the selected IDE", () => {
  const rows = [
    "10 1 webstorm",
    "11 10 /usr/lib/chromium/chromium --user-data-dir=/tmp/ide profile --remote-debugging-port=0 about:blank",
    "12 11 /usr/lib/chromium/chromium --type=renderer --user-data-dir=/tmp/ide profile --remote-debugging-port=0",
    "13 1 /usr/lib/chromium/chromium --user-data-dir=/tmp/other --remote-debugging-port=0",
    "14 10 /usr/lib/chromium/chromium --user-data-dir=/tmp/normal",
  ].join("\n")
  expect(browsers(rows, 10)).toEqual([{ pid: 11, profile: "/tmp/ide profile" }])
})

test("rejects a non-IDE listener without sending it an MCP request", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      calls.push(req.url)
      return Response.json({})
    },
  })
  try {
    const proc = Bun.spawn(["bun", cli, "debug", "status", "--port", String(server.port)], {
      cwd: example,
      stdout: "pipe",
      stderr: "pipe",
    })
    const error = await new Response(proc.stderr).json()
    expect(await proc.exited).toBe(1)
    expect(error.error).toContain("no probe sent")
    expect(calls).toHaveLength(0)
  } finally {
    server.stop(true)
  }
})

test("selects each runtime and points the small project at real source without copying it", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-project-")))
  try {
    const root = path.join(dir, "repo")
    for (const [name, manifest, file, ide] of [
      ["ui", "package.json", "main.tsx", "webstorm"],
      ["api", "Cargo.toml", "main.rs", "rustrover"],
    ]) {
      const component = path.join(root, name)
      fs.mkdirSync(path.join(component, "src"), { recursive: true })
      fs.writeFileSync(path.join(component, manifest), "")
      fs.writeFileSync(path.join(component, "src", file), "actual source")
      const value = scope(root, path.join(component, "src", file), dir)
      expect(value.ide).toBe(ide)
      expect(value.content).toBe(path.join(component, "src"))
      prepare(value)
      expect(fs.readFileSync(path.join(value.project, ".idea/source.iml"), "utf8")).toContain(value.content)
      const cfg = path.join(value.project, ".idea/source.iml")
      const stamp = fs.statSync(cfg, { bigint: true }).mtimeNs
      prepare(value)
      expect(fs.statSync(cfg, { bigint: true }).mtimeNs).toBe(stamp)
      expect(fs.existsSync(path.join(value.project, "src"))).toBe(false)
      expect(scope(root, component, dir).project).toBe(value.project)
    }
    expect(() => scope(root, root, dir)).toThrow("repository root")
    expect(() => scope(root, dir, dir)).toThrow("repository root")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a Rust project indexes its whole Cargo workspace so sibling crates are searchable", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-workspace-")))
  try {
    const base = path.join(root, "packages/data")
    for (const crate of ["runtime", "service"]) {
      fs.mkdirSync(path.join(base, crate, "src"), { recursive: true })
      fs.writeFileSync(path.join(base, crate, "Cargo.toml"), `[package]\nname = "${crate}"\n`)
    }
    fs.writeFileSync(path.join(base, "Cargo.toml"), "[workspace]\nmembers = [\"runtime\", \"service\"]\n")
    const value = scope(root, path.join(base, "runtime"), root)
    expect(value.content).toBe(base)
    expect(value.component).toBe(path.join(base, "runtime"))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("prepares a shared Cargo configuration and Rust toolchain without copying credentials", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-data-")))
  try {
    const component = path.join(root, "packages/data/runtime")
    fs.mkdirSync(path.join(component, "src"), { recursive: true })
    fs.mkdirSync(path.join(root, ".run"))
    fs.writeFileSync(path.join(component, "Cargo.toml"), "")
    fs.writeFileSync(path.join(root, ".run/Data.run.xml"), `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Data" type="CargoCommandRunConfiguration" factoryName="Cargo Command">
    <option name="command" value="run --locked --package data-runtime --bin data-runtime" />
    <option name="workingDirectory" value="file://$PROJECT_DIR$/packages/data" />
  </configuration>
</component>`)
    const value = scope(root, component, root)
    prepare(value)
    const cfg = fs.readFileSync(path.join(value.project, ".idea/runConfigurations/Data.xml"), "utf8")
    expect(cfg).toContain(`file://${root}/packages/data`)
    expect(cfg).toContain("data-runtime")
    expect(cfg).not.toContain("DATABASE_URL")
    expect(fs.readFileSync(path.join(value.project, ".idea/workspace.xml"), "utf8")).toContain("toolchainHomeDirectory")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})


test("maps browser source URLs to this checkout without changing the indexing scope", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-browser-")))
  try {
    const root = path.join(dir, "repo")
    const component = path.join(root, "packages/web")
    const project = path.join(dir, "project")
    expect(browser(root, component, project, "https://preview.test/assets/frame.html?a=1&b=2")).toBe(true)
    const file = path.join(project, ".idea/runConfigurations/Example_Browser.xml")
    const xml = fs.readFileSync(file, "utf8")
    expect(xml).toContain('uri="https://preview.test/assets/frame.html?a=1&amp;b=2"')
    expect(xml).toContain('useFirstLineBreakpoints="false"')
    expect(xml).toContain(`url="https://preview.test/src" local-file="${component}/src"`)
    for (const url of ["/@fs//workspace", "/@fs/workspace", `/@fs/${root}`, `/@fs${root}`])
      expect(xml).toContain(`url="https://preview.test${url}" local-file="${root}"`)
    expect(fs.existsSync(path.join(project, ".idea/source.iml"))).toBe(false)
    const stamp = fs.statSync(file, { bigint: true }).mtimeNs
    expect(browser(root, component, project, "https://preview.test/assets/frame.html?a=1&b=2")).toBe(false)
    expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(stamp)
    expect(browser(root, component, project, "https://different.test/")).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toContain('uri="https://different.test/"')
    expect(() => browser(root, component, project, "file:///tmp/frame.html")).toThrow("HTTP(S)")
    browser(root, component, project, "https://preview.test/", "http://127.0.0.1:35139")
    const attached = fs.readFileSync(file, "utf8")
    expect(attached).toContain('type="ChromiumRemoteDebugType" host="127.0.0.1" port="35139"')
    expect(attached).toContain(`url="https://preview.test/src" local-file="${component}/src"`)
    expect(attached).not.toContain('uri=')
    expect(browser(root, component, project, "https://preview.test/", "http://127.0.0.1:35140")).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toContain('port="35140"')
    for (const url of ["http://example.test:35139", "http://127.0.0.1:0", "http://127.0.0.1:35139/path", "ws://127.0.0.1:35139"])
      expect(() => address(url)).toThrow("loopback HTTP")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})


test("rejects a non-browser attach listener without sending it HTTP", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      calls.push(req.url)
      return Response.json({})
    },
  })
  try {
    const proc = Bun.spawn(["bun", cli, "open", path.join(example, "web"), "--url", "https://preview.test/", "--attach", `http://127.0.0.1:${server.port}`], { cwd: example, stdout: "pipe", stderr: "pipe" })
    const error = await new Response(proc.stderr).json()
    expect(await proc.exited).toBe(1)
    expect(error.error).toContain("no probe sent")
    expect(calls).toHaveLength(0)
  } finally {
    server.stop(true)
  }
})

test("an unsupported Rust method evaluation suggests stored fields rather than function entry", async () => {
  const debug = await import("../src/debugger")
  expect(debug.evaluation("ERROR: error: not calling a function")).toContain("stored fields")
  expect(debug.evaluation("ERROR: error: not calling a function")).not.toContain("function entry")
})

test("line breakpoints are checked for a statement to bind to", async () => {
  const { unbound } = await import("../src/lines")
  expect(unbound("  const x = 1")).toBeUndefined()
  expect(unbound("  return fetch(url)")).toBeUndefined()
  expect(unbound("  const f = async () => {")).toBeUndefined()
  expect(unbound("  home: () => json({ ok: true }),")).toContain("arrow function")
  expect(unbound("  const name = () => value")).toContain("arrow function")
  expect(unbound("    port: 8080,")).toContain("object property")
  expect(unbound("  }")).toContain("closing")
  expect(unbound("  // note")).toContain("empty")
})

test("an attach can name the service that must run locally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-attach-"))
  const target = { project: "app", configuration: "App", health: "/", port: "APP_PORT", workload: "app", agent: "sidecar", mode: "intercept" }
  try {
    fs.writeFileSync(path.join(dir, "idectl.json"), JSON.stringify({
      cli: "idectl", env: ".env", state: ".state", adapter: { type: "none" },
      frontend: { ...target, browser: "Browser", url: "APP_URL", mounted: "true" },
      services: { api: { ...target, configuration: "Api", ide: "rustrover", binary: "target/api", container: "api" } },
      attach: { drivers: { project: "d", configuration: "D", port: "9229", file: ".state/inspect", service: "api" } },
    }))
    expect(load(dir).attach.drivers.service).toBe("api")
  } finally {
    fs.rmSync(dir, { recursive: true })
  }
})
