import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { root, object, command } from "./core"
import type { Ide } from "./core"
import { cfg, known, service } from "./config"
import { adapter } from "./adapter"
import { port, preflight } from "./service"

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

export async function runtime(name: string) {
  if (!known(name)) return
  const item = service(name)
  await preflight()
  await adapter.connect()
  const job = process.env.IDECTL_JOB
  const dir = job ? fs.mkdtempSync(path.join(job, "secret-")) : fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "idectl-"))
  fs.chmodSync(dir, 0o700)
  const resolved = await adapter.env(item, dir)
  const env = { ...resolved.env, PORT: String(port(item)) }
  if (!cfg.hooks.runtime) return env
  const proc = Bun.spawn(cfg.hooks.runtime, {
    cwd: cfg.root,
    env: { ...process.env, IDECTL_PHASE: job ? path.join(job, "phase") : "" },
    stdin: new Blob([JSON.stringify({ service: item.id, configuration: item.configuration, port: port(item), dir, paths: resolved.paths, env })]),
    stdout: "pipe",
    stderr: "inherit",
  })
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`${item.id}: runtime hook ${cfg.hooks.runtime.join(" ")} exited ${code}`)
  const value: unknown = JSON.parse(text)
  if (!object(value) || !Object.values(value).every((row) => typeof row === "string"))
    throw new Error(`${item.id}: runtime hook must print a JSON object of environment strings`)
  return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, String(row)]))
}
