import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { root, namespace, object, command, attempt, parse } from "./core"
import type { Ide } from "./core"
import { local, vars } from "./service"

export async function settings(bin: string, dir: string, ide: Ide) {
  const file = path.join(path.dirname(path.dirname(fs.realpathSync(bin))), "product-info.json")
  if (!fs.existsSync(file)) throw new Error(`JetBrains product metadata is missing: ${file}`)
  const info: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!object(info) || typeof info.dataDirectoryName !== "string")
    throw new Error(`Invalid IDE product metadata: ${file}`)
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support/JetBrains")
      : path.join(os.homedir(), ".config/JetBrains")
  await command(
    [
      "python3",
      "-c",
      `
from pathlib import Path
from xml.etree import ElementTree as E
import sys
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
def load(name):
 p=root/name
 return p,E.parse(p).getroot() if p.exists() else E.Element('application')
def child(root,tag,attrs):
 value=next((x for x in root if x.tag==tag and all(x.get(k)==v for k,v in attrs.items())),None)
 return E.SubElement(root,tag,attrs) if value is None else value
p,tree=load('trusted-paths.xml')
c=child(tree,'component',{'name':'Trusted.Paths'})
m=child(child(c,'option',{'name':'TRUSTED_PROJECT_PATHS'}),'map',{})
child(m,'entry',{'key':sys.argv[2]}).set('value','true')
E.ElementTree(tree).write(p,encoding='unicode')
p,tree=load('other.xml')
c=child(tree,'component',{'name':'PropertiesComponent'})
child(c,'property',{'name':'power.save.mode'}).set('value','true')
E.ElementTree(tree).write(p,encoding='unicode')
p,tree=load('mcpServer.xml')
c=child(tree,'component',{'name':'McpServerSettings'})
for name,value in [('consent','GRANTED'),('enableBraveMode','true'),('enableMcpServer','true'),('mcpServerPort',sys.argv[3])]:
 child(c,'option',{'name':name}).set('value',value)
E.ElementTree(tree).write(p,encoding='unicode')
`,
      path.join(base, info.dataDirectoryName, "options"),
      dir,
      String(ide.port + 300),
    ],
    root,
    2000,
  )
}

const targets: Record<string, { id: string; workload: string; container: string; mounts: string[] }> = {
  "Veritly Data": { id: "data", workload: "data-runtime", container: "runtime", mounts: [] },
  "Veritly Server": { id: "server", workload: "opencode-api", container: "server", mounts: ["/etc/veritly", "/run/secrets/veritly", "/run/secrets/veritly-attachments", "/run/secrets/veritly-ai"] },
  "Veritly Edge": { id: "edge", workload: "veritly-edge", container: "edge", mounts: ["/run/secrets/agent-validation"] },
  "Veritly Office": { id: "office", workload: "office-server", container: "server", mounts: [] },
  "Veritly AI Gateway": { id: "gateway", workload: "veritly-ai-gateway", container: "gateway", mounts: ["/run/secrets/database", "/run/secrets/agent-validation"] },
  "Veritly AI Governor": { id: "governor", workload: "bifrost-governor", container: "governor", mounts: ["/run/secrets/database", "/run/secrets/bifrost"] },
}

async function sidecar(name: string, env: Record<string, string>) {
  if (name !== "Veritly Server" && name !== "Veritly Office") return
  if (process.env.VERITLY_IDE_JOB) fs.writeFileSync(path.join(process.env.VERITLY_IDE_JOB, "phase"), "building helper", { mode: 0o600 })
  const workspace = name === "Veritly Server" ? "packages/veritly-server" : "packages/veritly-office"
  env.CARGO_TARGET_DIR = path.join(root, workspace, "target")
  process.stderr.write(`${name}: building the spreadsheet helper; Cargo reports progress below\n`)
  const proc = Bun.spawn(["cargo", "build", "--locked", "--manifest-path", path.join(root, "packages/genoffice/apps/sheets/native/xlsx-engine/Cargo.toml"), "--package", "xlsx-sidecar", "--bin", "xlsx-sidecar"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
  })
  const reader = proc.stderr.getReader()
  const decoder = new TextDecoder()
  const state = { last: 0, tail: "" }
  while (true) {
    const part = await reader.read()
    if (part.done) break
    state.tail = (state.tail + decoder.decode(part.value)).slice(-4000)
    if (Date.now() - state.last > 5000) {
      process.stderr.write(`${name}: building spreadsheet helper (${state.tail.trim().split("\n").at(-1)})\n`)
      state.last = Date.now()
    }
  }
  if (await proc.exited !== 0) throw new Error(`${name}: spreadsheet helper build failed:\n${state.tail}`)
  process.stderr.write(`${name}: spreadsheet helper is ready\n`)
}

export async function runtime(name: string, tunnel: () => Promise<unknown>) {
  const target = targets[name]
  if (!target) return
  if (name === "Veritly Data") {
    const fonts = await attempt(() => command(["pkg-config", "--exists", "fontconfig"], root, 3000))
    if (!fonts.ok) throw new Error("Data's local Rust build needs fontconfig development headers; install libfontconfig1-dev on Debian")
  }
  const check = await command(["bun", "script/local-k8s.ts", "doctor"], root, 10_000)
  if (check.includes("local guard: blocked")) throw new Error("Local cluster doctor rejected this Kubernetes target")
  await tunnel()
  const deployment = parse(await command(["kubectl", "-n", namespace, "get", "deployment", target.workload, "-o", "json"], root, 3000))
  if (!object(deployment) || !object(deployment.spec) || !object(deployment.spec.template) ||
      !object(deployment.spec.template.spec) || !Array.isArray(deployment.spec.template.spec.containers))
    throw new Error("Data deployment has invalid container configuration")
  const container = deployment.spec.template.spec.containers.filter(object).find((item) => item.name === target.container)
  if (!container || !Array.isArray(container.env)) throw new Error(`${name} deployment has no runtime environment`)
  const entries = container.env.filter(object)
  const profile = vars()
  const generated = entries.filter((item) => typeof item.name === "string" && item.name.startsWith("WORKOS_AGENT_") && item.name !== "WORKOS_AGENT_BLUEPRINT_ID" && item.name !== "WORKOS_AGENT_API_KEY")
  const config = generated.length
    ? parse(await command(["kubectl", "-n", namespace, "get", "configmap", "veritly-config", "-o", "json"], root, 3000))
    : undefined
  if (generated.length && (!object(config) || !object(config.data))) throw new Error("Cluster agent configuration is missing")
  const env: Record<string, string> = {}
  for (const item of entries) {
    const name = item.name
    if (typeof name !== "string") throw new Error(`${target.workload} has an unnamed environment variable`)
    if (name.startsWith("CARGO_") || name.startsWith("GIT_CONFIG_") || name === "PORT") continue
    if (typeof item.value === "string") { env[name] = item.value; continue }
    if (!object(item.valueFrom)) throw new Error(`${name} has no supported configuration source`)
    const ref = object(item.valueFrom.secretKeyRef) ? item.valueFrom.secretKeyRef : item.valueFrom.configMapKeyRef
    if (!object(ref) || typeof ref.key !== "string") throw new Error(`${name} has no supported configuration reference`)
    const key = ref.key === "api-key" ? "WORKOS_API_KEY" : ref.key
    const value = name === "CHATWOOT_HMAC_SECRET"
      ? createHash("sha256").update(`${namespace}:${root}:chatwoot`).digest("hex")
      : generated.includes(item) && object(config) && object(config.data) ? config.data[key] : profile[key]
    if (typeof value !== "string") {
      if (ref.optional === true) continue
      throw new Error(`${key} is required in .env.local-cluster`)
    }
    env[name] = value
  }
  env.PORT = String(local(target.id))
  if (target.mounts.length) {
    const dir = process.env.VERITLY_IDE_JOB
      ? fs.mkdtempSync(path.join(process.env.VERITLY_IDE_JOB, "secret-"))
      : fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "veritly-ide-"))
    fs.chmodSync(dir, 0o700)
    const mapped: Record<string, Record<string, string>> = {
      "/run/secrets/veritly": { "database-url": "DATABASE_URL" },
      "/run/secrets/veritly-attachments": {
        "internal-endpoint": "VERITLY_FILES_S3_ENDPOINT", "public-endpoint": "VERITLY_FILES_S3_PUBLIC_ENDPOINT",
        region: "VERITLY_FILES_S3_REGION", bucket: "VERITLY_FILES_S3_BUCKET",
        "access-key": "VERITLY_FILES_S3_ACCESS_KEY", "secret-key": "VERITLY_FILES_S3_SECRET_KEY",
      },
      "/run/secrets/database": { url: "DATABASE_URL" },
      "/run/secrets/bifrost": { username: "BIFROST_ADMIN_USERNAME", password: "BIFROST_ADMIN_PASSWORD" },
    }
    for (const mount of target.mounts) {
      if (!mapped[mount]) continue
      for (const [name, key] of Object.entries(mapped[mount])) {
        if (!profile[key]) throw new Error(`${key} is required in .env.local-cluster`)
        const dest = path.join(dir, mount, name)
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
        fs.writeFileSync(dest, profile[key], { mode: 0o600 })
      }
    }
    const script = "import os,sys,json,base64; print(json.dumps({os.path.join(p,f):base64.b64encode(open(os.path.join(p,f),'rb').read()).decode() for d in sys.argv[1:] for p,_,files in os.walk(d) for f in files if not f.startswith('..')}))"
    const files = parse(await command(["kubectl", "-n", namespace, "exec", `deployment/${target.workload}`, "-c", target.container, "--", "python3", "-c", script, ...target.mounts.filter((mount) => !mapped[mount])], root, 5000))
    if (!object(files)) throw new Error(`${name} returned invalid mounted files`)
    for (const [source, value] of Object.entries(files)) {
      if (typeof value !== "string" || !target.mounts.some((mount) => source.startsWith(`${mount}/`))) throw new Error("Invalid mounted file")
      const dest = path.join(dir, source)
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
      fs.writeFileSync(dest, Buffer.from(value, "base64"), { mode: 0o600 })
    }
    for (const key of Object.keys(env)) if (target.mounts.some((mount) => env[key].startsWith(`${mount}/`))) env[key] = path.join(dir, env[key])
    if (name === "Veritly Server") {
      if (!env.VERITLY_SERVER_CONFIG) throw new Error("Server config is missing")
      const text = fs.readFileSync(env.VERITLY_SERVER_CONFIG, "utf8")
      const cfg = Bun.TOML.parse(text)
      if (!object(cfg) || typeof cfg.listen !== "string") throw new Error("Server config has no root listen address")
      const index = text.search(/^[ \t]*\[/m)
      const head = index < 0 ? text : text.slice(0, index)
      const tail = index < 0 ? "" : text.slice(index)
      const lines = [...head.matchAll(/^[ \t]*listen[ \t]*=.*$/gm)]
      if (lines.length !== 1) throw new Error("Server config must have one root listen address")
      const config = head.replace(/^[ \t]*listen[ \t]*=.*$/m, `listen = "127.0.0.1:${local(target.id)}"`) + tail
      fs.writeFileSync(env.VERITLY_SERVER_CONFIG, target.mounts.reduce((text, mount) => text.replaceAll(`${mount}/`, `${path.join(dir, mount)}/`), config), { mode: 0o600 })
    }
  }
  for (const key of Object.keys(env)) if (env[key].startsWith("/workspace/")) env[key] = path.join(root, env[key].slice("/workspace/".length))
  await sidecar(name, env)
  return env
}

