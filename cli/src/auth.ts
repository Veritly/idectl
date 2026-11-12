import { createCipheriv, randomBytes } from "node:crypto"
import { createWorkOSClient } from "../../auth-shared/src/index"
import { object } from "./core"
import { vars } from "./service"

export async function login(endpoint: string, url: string) {
  const env = vars()
  const email = env.E2E_WORKOS_EMAIL || env.STAGING_TEST_EMAIL
  const encoded = env.E2E_WORKOS_PASSWORD_B64 || env.STAGING_TEST_PASSWORD_B64
  const password = encoded ? Buffer.from(encoded, "base64").toString("utf8") : env.E2E_WORKOS_PASSWORD || env.STAGING_TEST_PASSWORD
  if (!email || !password || !env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID || !/^[a-f\d]{64}$/i.test(env.COOKIE_PASSWORD || ""))
    throw new Error("Test-account credentials and the WorkOS cookie key are required in .env.local-cluster")
  const workos = createWorkOSClient({ apiKey: env.WORKOS_API_KEY, clientId: env.WORKOS_CLIENT_ID })
  const auth = await workos.userManagement.authenticateWithPassword({ clientId: env.WORKOS_CLIENT_ID, email, password })
  const user = auth.user
  const data = { access_token: auth.accessToken, refresh_token: auth.refreshToken, user: {
    object: "user", id: user.id, email: user.email, email_verified: user.emailVerified,
    first_name: user.firstName, last_name: user.lastName, profile_picture_url: user.profilePictureUrl,
    created_at: user.createdAt, updated_at: user.updatedAt,
  } }
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(env.COOKIE_PASSWORD, "hex"), nonce)
  const cookie = Buffer.concat([nonce, cipher.update(JSON.stringify(data)), cipher.final(), cipher.getAuthTag()]).toString("base64")
  const origin = new URL(url)
  const response = await fetch(new URL("/auth/session", origin), {
    headers: { cookie: `veritly-session=${cookie}` }, signal: AbortSignal.timeout(5000), redirect: "manual",
  })
  if (!response.ok) throw new Error(`Test-account session was rejected by Edge (HTTP ${response.status})`)
  await inject(endpoint, origin.href, cookie)
}

export async function inject(endpoint: string, url: string, cookie: string) {
  const base = new URL(endpoint)
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !base.port)
    throw new Error("Browser endpoint must be a verified loopback listener")
  const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`Browser target list returned HTTP ${response.status}`)
  const data: unknown = await response.json()
  if (!Array.isArray(data)) throw new Error("Browser target list is invalid")
  const pages = data.filter((item) => object(item) && item.type === "page")
  if (pages.length !== 1 || !object(pages[0]) || typeof pages[0].webSocketDebuggerUrl !== "string")
    throw new Error("Expected exactly one IDE browser page for test-account login")
  const target = new URL(pages[0].webSocketDebuggerUrl)
  if (target.protocol !== "ws:" || target.hostname !== base.hostname || target.port !== base.port)
    throw new Error("Browser page endpoint does not match the verified listener")
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(target.href)
    const timer = setTimeout(() => { ws.close(); reject(new Error("Browser login timed out")) }, 5000)
    const fail = () => { clearTimeout(timer); ws.close(); reject(new Error("Browser login failed")) }
    ws.addEventListener("error", fail, { once: true })
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Network.setCookie", params: {
      name: "veritly-session", value: cookie, url, httpOnly: true, secure: new URL(url).protocol === "https:", sameSite: "Lax",
    } })))
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      const row: unknown = JSON.parse(event.data)
      if (!object(row) || typeof row.id !== "number") return
      if (row.error || row.id === 1 && (!object(row.result) || row.result.success !== true)) return fail()
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
