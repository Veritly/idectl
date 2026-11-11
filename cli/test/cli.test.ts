import { expect, test } from "bun:test"
import path from "node:path"

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
  expect(await new Response(help.stdout).text()).toContain("debug configs|sessions|status|wait|inspect|vars")
  expect(await help.exited).toBe(0)

  const list = Bun.spawn(["bun", cli, "services"], { stdout: "pipe", stderr: "pipe" })
  const services = (await new Response(list.stdout).json()) as { env: string }[]
  expect(await list.exited).toBe(0)
  expect(services.every((item) => item.env.endsWith("/.env.local-cluster"))).toBe(true)

  const skill = await Bun.file(path.resolve(import.meta.dir, "../../../.agents/skills/veritly-ide/SKILL.md")).text()
  expect(skill).toContain("DEBUG.md")
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
