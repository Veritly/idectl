import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
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
  expect(help).toContain("attach frontend|activepieces|data|metabase|all")
  expect(help).toContain("veritly-ide office COMMAND")
  expect(await proc.exited).toBe(0)
})

test("delegates Office commands without changing their CLI shape", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "veritly-office-cli-"))
  try {
    const script = path.join(fixture, "script/veritly-office")
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(
      script,
      `#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n")\n`,
    )
    fs.chmodSync(script, 0o755)
    const proc = Bun.spawn(["bun", cli, "office", "doctor", "--ide", "vscode", "--port", "3999"], {
      env: { ...process.env, VERITLY_OFFICE_ROOT: fixture },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = (await new Response(proc.stdout).json()) as { args: string[]; cwd: string }
    expect(await proc.exited).toBe(0)
    expect(output.args).toEqual(["--ide", "vscode", "--port", "3999", "doctor"])
    expect(output.cwd).toBe(fixture)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
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
    ["Activepieces", "Data", "Metabase"].map((name) =>
      Bun.file(path.resolve(import.meta.dir, `../../../.run/Veritly_${name}_Browser.run.xml`)).exists(),
    ),
  )
  expect(frames.every(Boolean)).toBe(true)

  const skill = await Bun.file(path.resolve(import.meta.dir, "../../../.agents/skills/veritly-ide/SKILL.md")).text()
  expect(skill).toContain("Every Debugger MCP tool is wrapped")
  expect(skill).toContain("attach all")
})
