import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { close, errors, inspect, mounted, tab } from "../src/browser"
import { inject } from "../src/auth"
import { stamp } from "../src/core"

test("groups repeated errors without exposing their text or URLs", () => {
  const result = errors([
    { text: "net::ERR_NETWORK_CHANGED at https://private.example/a?token=secret", source: "network", time: 2 },
    { text: "net::ERR_NETWORK_CHANGED at https://private.example/b", source: "network", time: 5 },
    { text: "TypeError: secret", source: "javascript", time: 4 },
  ])
  expect(result.groups).toEqual([
    { code: "net::ERR_NETWORK_CHANGED", source: "network", count: 2, first: 2, last: 5 },
    { code: "TypeError", source: "javascript", count: 1, first: 4, last: 4 },
  ])
  expect(JSON.stringify(result)).not.toContain("secret")
  expect(result.truncated).toBe(false)
})

test.skipIf(!Bun.which("chromium"))("observes an actual browser before and after the app mounts", async () => {
  const state = { mounted: false, authenticated: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.headers.get("cookie")?.includes("veritly-session=test-session")) state.authenticated = true
      if (new URL(req.url).pathname === "/state") return Response.json(state)
      return new Response(`<!doctype html><div id="root"></div><script>
        setInterval(async () => {
          if (!(await (await fetch('/state')).json()).mounted) return
          document.getElementById('root').innerHTML = '<main>ready</main>'
          document.documentElement.dataset.veritlyMount = 'complete'
        }, 50)
      </script>`, { headers: { "Content-Type": "text/html" } })
    },
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veritly-ide-browser-"))
  const url = `http://127.0.0.1:${server.port}/`
  const proc = Bun.spawn([Bun.which("chromium")!, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${dir}`, url], { stdout: "ignore", stderr: "ignore" })
  try {
    const file = path.join(dir, "DevToolsActivePort")
    const deadline = Date.now() + 4000
    while (!fs.existsSync(file) && Date.now() < deadline) await Bun.sleep(50)
    if (!fs.existsSync(file)) throw new Error("Chromium did not start its debug endpoint")
    const endpoint = `http://127.0.0.1:${fs.readFileSync(file, "utf8").split("\n")[0]}`
    await inject(endpoint, url, [{ name: "veritly-session", value: "test-session" }])
    const limit = Date.now() + 3000
    while (!state.authenticated && Date.now() < limit) await Bun.sleep(50)
    expect(state.authenticated).toBe(true)
    await expect(tab(endpoint, "http://127.0.0.1:1/")).rejects.toThrow("may have redirected for sign-in")
    const first = await inspect(endpoint, url)
    expect(mounted(first.page)).toBe(false)
    state.mounted = true
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const next = await inspect(endpoint, url)
      if (mounted(next.page)) {
        const token = stamp(proc.pid)
        if (!token) throw new Error("Browser process disappeared")
        await close(endpoint, proc.pid, `${token}-different`)
        expect(stamp(proc.pid)).toBe(token)
        await close(endpoint, proc.pid, token)
        expect(await proc.exited).toBe(0)
        return
      }
      await Bun.sleep(50)
    }
    throw new Error("Browser did not report the app mount")
  } finally {
    if (proc.exitCode === null) proc.kill()
    await proc.exited
    server.stop(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 10000)
