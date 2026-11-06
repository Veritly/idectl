import { expect, test } from "bun:test"
import path from "node:path"

const cli = path.resolve(import.meta.dir, "../src/cli.ts")

test("lists the local service presets as JSON", async () => {
  const proc = Bun.spawn(["bun", cli, "services"], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(proc.stdout).json()
  expect(await proc.exited).toBe(0)
  expect(output).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "backend", mode: "debug", port: 4096 }),
      expect.objectContaining({ id: "frontend", mode: "run", port: 4444 }),
    ]),
  )
})

test("prints shell-friendly help", async () => {
  const proc = Bun.spawn(["bun", cli, "help"], { stdout: "pipe", stderr: "pipe" })
  const help = await new Response(proc.stdout).text()
  expect(help).toContain("veritly-ide mcp tools")
  expect(help).toContain("veritly-ide debug commands | TOOL [JSON|-]")
  expect(help).toContain("attach frontend|activepieces|data|all")
  expect(help).toContain("veritly-ide office COMMAND")
  expect(await proc.exited).toBe(0)
})

test("delegates Office commands through the canonical submodule", async () => {
  const proc = Bun.spawn(["bun", cli, "office", "help", "--ide", "vscode", "--port", "3999"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(output).toContain("veritly-office")

  const source = await Bun.file(cli).text()
  expect(source).toContain('path.join(root, "vendor/veritly-office")')
  expect(source).not.toContain("VERITLY_OFFICE_ROOT")
})

test("documents the inspection commands and one shared env", async () => {
  const help = Bun.spawn(["bun", cli, "help"], { stdout: "pipe", stderr: "pipe" })
  expect(await new Response(help.stdout).text()).toContain("debug configs|sessions|status|wait|inspect|vars")
  expect(await help.exited).toBe(0)

  const list = Bun.spawn(["bun", cli, "services"], { stdout: "pipe", stderr: "pipe" })
  const services = (await new Response(list.stdout).json()) as { env: string }[]
  expect(await list.exited).toBe(0)
  expect(services.every((item) => item.env.endsWith("/.env.local-cluster"))).toBe(true)

  const backend = await Bun.file(path.resolve(import.meta.dir, "../../../.run/Veritly_Backend.run.xml")).text()
  const frontend = await Bun.file(path.resolve(import.meta.dir, "../../../.run/Veritly_Frontend.run.xml")).text()
  expect(backend.match(/--env-file=/g)).toHaveLength(1)
  expect(frontend.match(/--env-file=/g)).toHaveLength(1)
  expect(`${backend}${frontend}`).not.toContain(".veritly/ide/backend.env")
  expect(`${backend}${frontend}`).not.toContain(".veritly/ide/frontend.env")

  const frames = await Promise.all(
    ["Activepieces", "Data"].map((name) =>
      Bun.file(path.resolve(import.meta.dir, `../../../.run/Veritly_${name}_Browser.run.xml`)).exists(),
    ),
  )
  expect(frames.every(Boolean)).toBe(true)

  const skill = await Bun.file(path.resolve(import.meta.dir, "../../../.agents/skills/veritly-ide/SKILL.md")).text()
  expect(skill).toContain("Every Debugger MCP tool is wrapped")
  expect(skill).toContain("attach all")
})
