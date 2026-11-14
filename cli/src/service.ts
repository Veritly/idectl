import fs from "node:fs"
import path from "node:path"
import { cfg } from "./config"
import type { Target, Service, Frontend } from "./config"
import { object, command, sockets } from "./core"
import { adapter } from "./adapter"

export function vars() {
  if (!fs.existsSync(cfg.env)) throw new Error(`${cfg.env} is required`)
  return fs
    .readFileSync(cfg.env, "utf8")
    .split("\n")
    .reduce<Record<string, string>>((all, line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
      if (!match) return all
      const raw = match[2].trim()
      all[match[1]] = raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw
      return all
    }, {})
}

export function port(item: Target) {
  const value = Number(vars()[item.port])
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${item.port} in ${cfg.env} must be 1..65535`)
  return value
}

export async function preflight() {
  if (cfg.preflight) await command(cfg.preflight, cfg.root, 10_000)
}

export async function health(item: Target) {
  const url = `http://127.0.0.1:${port(item)}${item.health}`
  const hit = await fetch(url, { signal: AbortSignal.timeout(500) }).then(
    (res) => ({ ok: res.ok, status: res.status }),
    () => ({ ok: false, status: 0 }),
  )
  return { ...hit, url }
}

export function kill(pid: number) {
  try {
    process.kill(-pid, "SIGTERM")
  } catch (err) {
    if (!object(err) || err.code !== "ESRCH") throw err
  }
}

async function owned(item: Service) {
  const listener = (await sockets()).find((row) => row.port === port(item))
  const target = path.join(cfg.root, item.binary)
  if (!listener?.pid || !fs.existsSync(target) || !fs.existsSync(`/proc/${listener.pid}/exe`)) return false
  return fs.realpathSync(`/proc/${listener.pid}/exe`) === fs.realpathSync(target)
}

export async function local(item: Service) {
  if (!(await owned(item))) return { ok: false, owner: false }
  return { ...(await health(item)), owner: true }
}

export async function detach(item: Target) {
  await preflight()
  await adapter.connect()
  return { ok: true, ...(await adapter.detach(item, port(item))) }
}

export async function attach(item: Service | Frontend) {
  await preflight()
  await adapter.connect()
  if (item.mode === "intercept" && "binary" in item && !(await owned(item)))
    throw new Error(`The local ${item.id} binary is not listening on port ${port(item)}; run debug start ${item.id}, then wait ${item.id} --service ${item.id}`)
  if (item.mode === "intercept" && !(await health(item)).ok)
    throw new Error(`Local ${item.id} is not ready on port ${port(item)}; wait for it before routing`)
  return { ok: true, ...(await adapter.attach(item, port(item))) }
}
