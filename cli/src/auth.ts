import { object } from "./core"
import { cfg } from "./config"

export type Cookie = { name: string; value: string; httpOnly?: boolean; sameSite?: "Strict" | "Lax" | "None" }

export async function login(endpoint: string, url: string) {
  if (!cfg.hooks.login) return { ok: true, skipped: true }
  const proc = Bun.spawn(cfg.hooks.login, { cwd: cfg.root, env: { ...process.env, IDECTL_URL: url }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [text, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`Login hook failed: ${err.trim().split("\n").slice(-5).join(" ") || `exit ${code}`}`)
  const value: unknown = JSON.parse(text)
  if (!object(value) || !Array.isArray(value.cookies) || !value.cookies.length ||
      !value.cookies.every((row) => object(row) && typeof row.name === "string" && row.name && typeof row.value === "string"))
    throw new Error("Login hook must print {\"cookies\":[{\"name\",\"value\"}]}")
  await inject(endpoint, url, value.cookies as Cookie[])
  return { ok: true, cookies: value.cookies.length }
}

export async function inject(endpoint: string, url: string, cookies: Cookie[]) {
  const base = new URL(endpoint)
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !base.port)
    throw new Error("Browser endpoint must be a verified loopback listener")
  const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`Browser target list returned HTTP ${response.status}`)
  const data: unknown = await response.json()
  if (!Array.isArray(data)) throw new Error("Browser target list is invalid")
  const pages = data.filter((item) => object(item) && item.type === "page")
  if (pages.length !== 1 || !object(pages[0]) || typeof pages[0].webSocketDebuggerUrl !== "string")
    throw new Error("Expected exactly one IDE browser page for login")
  const target = new URL(pages[0].webSocketDebuggerUrl)
  if (target.protocol !== "ws:" || target.hostname !== base.hostname || target.port !== base.port)
    throw new Error("Browser page endpoint does not match the verified listener")
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(target.href)
    const timer = setTimeout(() => { ws.close(); reject(new Error("Browser login timed out")) }, 5000)
    const fail = () => { clearTimeout(timer); ws.close(); reject(new Error("Browser login failed")) }
    ws.addEventListener("error", fail, { once: true })
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Network.setCookies", params: {
      cookies: cookies.map((row) => ({ ...row, url, secure: new URL(url).protocol === "https:" })),
    } })))
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      const row: unknown = JSON.parse(event.data)
      if (!object(row) || typeof row.id !== "number") return
      if (row.error) return fail()
      if (row.id === 1) { ws.send(JSON.stringify({ id: 2, method: "Page.navigate", params: { url } })); return }
      if (row.id === 2) { clearTimeout(timer); ws.close(); resolve() }
    })
  })
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw new Error(`Browser target list returned HTTP ${response.status}`)
    const rows: unknown = await response.json()
    if (!Array.isArray(rows)) throw new Error("Browser target list is invalid")
    if (rows.some((row) => object(row) && row.type === "page" && typeof row.url === "string" && row.url.startsWith(new URL(url).origin + "/"))) return
    await Bun.sleep(100)
  }
  throw new Error("Authenticated browser did not open the application")
}
