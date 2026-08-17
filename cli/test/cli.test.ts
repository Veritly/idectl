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
  expect(await new Response(proc.stdout).text()).toContain("veritly-ide mcp tools")
  expect(await proc.exited).toBe(0)
})
