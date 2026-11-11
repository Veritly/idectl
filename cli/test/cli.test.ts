import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { browsers } from "../src/discovery"
import { address, browser, prepare, scope } from "../src/project"

const cli = path.resolve(import.meta.dir, "../src/cli.ts")

test("lists the local service presets as JSON", async () => {
  const proc = Bun.spawn(["bun", cli, "services"], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(proc.stdout).json()
  expect(await proc.exited).toBe(0)
  expect(output).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "frontend", mode: "run", key: "DEV_FRONTEND_PORT" })]),
  )
})

test("prints shell-friendly help", async () => {
  const proc = Bun.spawn(["bun", cli, "help"], { stdout: "pipe", stderr: "pipe" })
  const help = await new Response(proc.stdout).text()
  expect(help).toContain("veritly-ide mcp tools")
  expect(help).toContain("veritly-ide debug commands [TOOL] | TOOL [JSON|-]")
  expect(await proc.exited).toBe(0)
})

test("documents the inspection commands and one shared env", async () => {
  const help = Bun.spawn(["bun", cli, "help"], { stdout: "pipe", stderr: "pipe" })
  expect(await new Response(help.stdout).text()).toContain("debug browser|configs|sessions|status|wait|inspect|vars")
  expect(await help.exited).toBe(0)

  const list = Bun.spawn(["bun", cli, "services"], { stdout: "pipe", stderr: "pipe" })
  const services = (await new Response(list.stdout).json()) as { env: string }[]
  expect(await list.exited).toBe(0)
  expect(services.every((item) => item.env.endsWith("/.env.local-cluster"))).toBe(true)

  const skill = await Bun.file(path.resolve(import.meta.dir, "../../../.agents/skills/veritly-ide/SKILL.md")).text()
  expect(skill).toContain("DEBUG.md")
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


test("maps browser source URLs to this checkout without changing the indexing scope", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-browser-")))
  try {
    const root = path.join(dir, "repo")
    const component = path.join(root, "packages/web")
    const project = path.join(dir, "project")
    expect(browser(root, component, project, "https://preview.test/assets/frame.html?a=1&b=2")).toBe(true)
    const file = path.join(project, ".idea/runConfigurations/Veritly_Browser.xml")
    const xml = fs.readFileSync(file, "utf8")
    expect(xml).toContain('uri="https://preview.test/assets/frame.html?a=1&amp;b=2"')
    expect(xml).toContain('useFirstLineBreakpoints="false"')
    expect(xml).toContain(`url="https://preview.test/src" local-file="${component}/src"`)
    for (const url of ["/@fs//workspace", "/@fs/workspace", `/@fs/${root}`, `/@fs${root}`])
      expect(xml).toContain(`url="https://preview.test${url}" local-file="${root}"`)
    expect(fs.existsSync(path.join(project, ".idea/source.iml"))).toBe(false)
    const stamp = fs.statSync(file, { bigint: true }).mtimeNs
    expect(browser(root, component, project, "https://preview.test/assets/frame.html?a=1&b=2", true)).toBe(false)
    expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(stamp)
    expect(() => browser(root, component, project, "https://different.test/", true)).toThrow("reopen")
    expect(fs.readFileSync(file, "utf8")).toBe(xml)
    expect(() => browser(root, component, project, "file:///tmp/frame.html")).toThrow("HTTP(S)")
    browser(root, component, project, "https://preview.test/", false, "http://127.0.0.1:35139")
    const attached = fs.readFileSync(file, "utf8")
    expect(attached).toContain('type="ChromiumRemoteDebugType" host="127.0.0.1" port="35139"')
    expect(attached).toContain(`url="https://preview.test/src" local-file="${component}/src"`)
    expect(attached).not.toContain('uri=')
    expect(() => browser(root, component, project, "https://preview.test/", true, "http://127.0.0.1:35140")).toThrow("reopen")
    expect(fs.readFileSync(file, "utf8")).toBe(attached)
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
    const proc = Bun.spawn(["bun", cli, "open", path.resolve(import.meta.dir, ".."), "--url", "https://preview.test/", "--attach", `http://127.0.0.1:${server.port}`], { stdout: "pipe", stderr: "pipe" })
    const error = await new Response(proc.stderr).json()
    expect(await proc.exited).toBe(1)
    expect(error.error).toContain("no probe sent")
    expect(calls).toHaveLength(0)
  } finally {
    server.stop(true)
  }
})
