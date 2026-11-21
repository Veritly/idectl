import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cfg, name } from "./config"
import { root, ides, command } from "./core"
import type { Endpoint } from "./core"

const dir = path.join(os.homedir(), ".config/systemd/user")
const key = new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 8)
const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` }
const unit = (id: string) => `${name}-${id}-${key}.service`

function find(id: string) {
  const ide = ides.find((item) => item.id === id)
  if (!ide) throw new Error(`Unknown IDE ${id}`)
  return ide
}

/** The project the IDE starts on: later projects are opened into the running IDE. */
function start(id: string) {
  const item = (id === "webstorm" ? cfg.frontend?.project : undefined) ?? Object.values(cfg.services).find((row) => row.ide === id)?.project
  if (!item) throw new Error(`No ${id} project is configured in idectl.json`)
  return item
}

/** Keeps one IDE running: starts it through `open` whenever its debugger connection is absent, so IDE settings and the plugin check stay in one place. */
export async function keep(id: string, endpoints: () => Promise<Endpoint[]>) {
  find(id)
  const project = start(id)
  for (;;) {
    if (!(await endpoints()).some((item) => item.id === id)) {
      const result = await command([cfg.cli, "open", project, "--ide", id], root, 60_000).then((out) => out, (err: unknown) => String(err))
      process.stdout.write(`${new Date().toISOString()} open ${id}: ${result.slice(0, 200)}\n`)
    }
    await Bun.sleep(10_000)
  }
}

/** Installs a systemd user unit per IDE so the IDEs run from boot instead of being launched by the first agent that needs one. */
export async function install(id: string) {
  find(id)
  start(id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, unit(id))
  fs.writeFileSync(file, `[Unit]
Description=${name} ${id} for ${root}

[Service]
WorkingDirectory=${root}
Environment=PATH=${process.env.PATH}
${process.env.DISPLAY ? `Environment=DISPLAY=${process.env.DISPLAY}\n` : ""}${process.env.XAUTHORITY ? `Environment=XAUTHORITY=${process.env.XAUTHORITY}\n` : ""}ExecStart=${path.resolve(root, cfg.cli)} ide keep ${id}
Restart=always
RestartSec=10
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=default.target
`)
  await command(["systemctl", "--user", "daemon-reload"], root, 10_000, env)
  await command(["systemctl", "--user", "enable", "--now", unit(id)], root, 10_000, env)
  return { ok: true, ide: id, unit: unit(id) }
}

export async function uninstall(id: string) {
  find(id)
  await command(["systemctl", "--user", "disable", "--now", unit(id)], root, 30_000, env).catch(() => undefined)
  fs.rmSync(path.join(dir, unit(id)), { force: true })
  await command(["systemctl", "--user", "daemon-reload"], root, 10_000, env)
  return { ok: true, ide: id, unit: unit(id), phase: "removed" }
}
