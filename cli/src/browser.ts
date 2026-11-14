import { sockets, stamp } from "./core"
import { cfg } from "./config"

type Json = Record<string, unknown>

function object(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function mounted(value: Json) {
  return value.mounted === true
}

export function errors(rows: { text: string; time: number; source: string }[]) {
  const groups = new Map<string, { code: string; source: string; count: number; first: number; last: number }>()
  const state = { dropped: false }
  for (const row of rows) {
    const code = row.text.match(/net::ERR_[A-Z_]+/)?.[0] || row.text.match(/\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/)?.[0] || (/\bCORS\b/i.test(row.text) ? "cors_error" : "browser_error")
    const key = `${row.source}:${code}`
    const found = groups.get(key)
    if (found) {
      found.count++
      found.first = Math.min(found.first, row.time)
      found.last = Math.max(found.last, row.time)
      continue
    }
    if (groups.size < 5) groups.set(key, { code, source: row.source, count: 1, first: row.time, last: row.time })
    else state.dropped = true
  }
  return { groups: [...groups.values()], total: rows.length, truncated: rows.length >= 200 || state.dropped }
}

export async function tab(endpoint: string, url: string) {
  const base = new URL(endpoint)
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !base.port)
    throw new Error("Browser endpoint must be a verified loopback listener")
  const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`Browser target list returned HTTP ${response.status}`)
  const data: unknown = await response.json()
  if (!Array.isArray(data)) throw new Error("Browser target list is invalid")
  const origin = new URL(url).origin
  const pages = data.filter((item): item is Json => {
    if (!object(item)) throw new Error("Browser returned an invalid target")
    if (item.type !== "page") return false
    if (typeof item.url !== "string") throw new Error("Browser page has no URL")
    return true
  })
  const found = pages.filter((item) => typeof item.url === "string" && new URL(item.url).origin === origin)
  if (!found.length && pages.length === 1 && typeof pages[0].url === "string")
    throw new Error(`Browser is at ${new URL(pages[0].url).origin} instead of ${origin}; it may have redirected for sign-in`)
  if (found.length !== 1) throw new Error(`Expected one browser tab for ${origin}; found ${found.length}`)
  const value = found[0].webSocketDebuggerUrl
  if (typeof value !== "string") throw new Error("Browser tab has no debugging endpoint")
  const socket = new URL(value)
  if (socket.protocol !== "ws:" || socket.hostname !== base.hostname || socket.port !== base.port)
    throw new Error("Browser tab debugging endpoint does not match the verified listener")
  return socket.href
}

export async function inspect(endpoint: string, url: string) {
  const target = await tab(endpoint, url)
  const rows: { text: string; time: number; source: string }[] = []
  const ws = new WebSocket(target)
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const state: { reject?: (error: Error) => void } = {}
  const opened = new Promise<void>((resolve, reject) => {
    state.reject = reject
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("Browser debugging connection failed")), { once: true })
  })
  const timeout = setTimeout(() => {
    ws.close()
    const error = new Error("Browser inspection timed out; the page may be paused")
    state.reject?.(error)
    pending.forEach((item) => item.reject(error))
  }, 3000)
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return
    const data: unknown = JSON.parse(event.data)
    if (!object(data)) return
    if (typeof data.id === "number") {
      const item = pending.get(data.id)
      if (!item) return
      pending.delete(data.id)
      if (data.error) item.reject(new Error("Browser debugging command failed"))
      else item.resolve(data.result)
      return
    }
    if (data.method !== "Log.entryAdded" || !object(data.params) || !object(data.params.entry)) return
    const entry = data.params.entry
    if (entry.level !== "error" || rows.length >= 200) return
    rows.push({ text: typeof entry.text === "string" ? entry.text : "", time: typeof entry.timestamp === "number" ? entry.timestamp : 0, source: typeof entry.source === "string" ? entry.source : "other" })
  })
  const send = (id: number, method: string, params: Json = {}) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    await opened
    await send(1, "Log.enable")
    const value = await send(2, "Runtime.evaluate", {
      expression: `({document:document.readyState,mounted:Boolean(${cfg.frontend.mounted}),elements:document.body?.querySelectorAll("*").length || 0})`,
      returnByValue: true,
    })
    if (!object(value) || !object(value.result) || !object(value.result.value)) throw new Error("Browser page state is unavailable")
    return { page: value.result.value, errors: errors(rows), scope: "browser log cache; may include earlier events" }
  } finally {
    clearTimeout(timeout)
    ws.close()
  }
}

export async function reload(endpoint: string, url: string) {
  const target = await tab(endpoint, url)
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(target)
    const timer = setTimeout(() => { ws.close(); reject(new Error("Browser reload timed out")) }, 3000)
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Page.reload" })))
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser reload connection failed")) }, { once: true })
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      const data: unknown = JSON.parse(event.data)
      if (!object(data) || data.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (data.error) reject(new Error("Browser reload failed"))
      else resolve()
    })
  })
}

export async function close(endpoint: string, pid: number, token: string) {
  if (stamp(pid) !== token) return
  const base = new URL(endpoint)
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !base.port)
    throw new Error("Browser endpoint must be a verified loopback listener")
  const live = await sockets()
  if (stamp(pid) !== token) return
  if (!live.some((row) => row.port === Number(base.port) && row.pid === pid))
    throw new Error("Owned browser listener changed; it was preserved")
  const response = await fetch(new URL("/json/version", base), { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`Browser version returned HTTP ${response.status}`)
  const data: unknown = await response.json()
  if (!object(data) || typeof data.webSocketDebuggerUrl !== "string") throw new Error("Browser has no debugging endpoint")
  const target = new URL(data.webSocketDebuggerUrl)
  if (target.protocol !== "ws:" || target.hostname !== base.hostname || target.port !== base.port)
    throw new Error("Browser debugging endpoint does not match its owned listener")
  if (stamp(pid) !== token) return
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(target.href)
    const state = { sent: false }
    const finish = (err?: Error) => { clearTimeout(timer); ws.close(); if (err) reject(err); else resolve() }
    const timer = setTimeout(() => finish(new Error("Browser close timed out")), 3000)
    ws.addEventListener("open", () => {
      state.sent = true
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }))
    }, { once: true })
    ws.addEventListener("error", () => finish(new Error("Browser close connection failed")), { once: true })
    ws.addEventListener("close", () => finish(state.sent ? undefined : new Error("Browser close disconnected before sending")), { once: true })
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      const row: unknown = JSON.parse(event.data)
      if (object(row) && row.id === 1) finish(row.error ? new Error("Browser rejected close") : undefined)
    })
  })
  const until = Date.now() + 5000
  while (stamp(pid) === token && Date.now() < until) await Bun.sleep(100)
  if (stamp(pid) === token) throw new Error("Owned browser is still stopping; retry debug down")
}
