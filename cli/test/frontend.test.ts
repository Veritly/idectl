import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "../src/frontend"

test("owns Vite input until shutdown and retains private output after exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-vite-"))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  fs.writeFileSync(path.join(dir, "index.html"), "<main>frontend lifecycle</main>")
  fs.writeFileSync(path.join(dir, "vite.config.mjs"), "process.stdin.resume(); export default {}")
  const log = path.join(dir, "output.log")
  const child = spawn([
    "node", path.resolve(import.meta.dir, "../../app/node_modules/vite/bin/vite.js"),
    "--host", "127.0.0.1", "--port", String(port), "--strictPort", "--clearScreen", "false",
  ], dir, { ...process.env, CI: "false" }, log)
  try {
    const url = `http://127.0.0.1:${port}/`
    const until = Date.now() + 3000
    while (true) {
      const response = await fetch(url, { signal: AbortSignal.timeout(200) }).catch(() => undefined)
      if (response?.ok) {
        expect(await response.text()).toContain("frontend lifecycle")
        break
      }
      if (Date.now() >= until) throw new Error("Vite did not start")
      await Bun.sleep(50)
    }
    expect(child.proc.exitCode).toBeNull()
    expect(fs.statSync(log).mode & 0o777).toBe(0o600)
    child.proc.stdin.end()
    expect(await child.exit).toBe(0)
    expect(await Bun.file(log).text()).toContain("ready in")
  } finally {
    child.proc.kill()
    await child.exit
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 5000)
