import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { root, namespace, object, command, attempt, parse } from "./core"
import type { Ide } from "./core"

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

export async function data(tunnel: () => Promise<unknown>) {
  const fonts = await attempt(() => command(["pkg-config", "--exists", "fontconfig"], root, 3000))
  if (!fonts.ok) throw new Error("Data's local Rust build needs fontconfig development headers; install libfontconfig1-dev on Debian")
  const check = await command(["bun", "script/local-k8s.ts", "doctor"], root, 10_000)
  if (check.includes("local guard: blocked")) throw new Error("Local cluster doctor rejected this Kubernetes target")
  await tunnel()
  const deployment = parse(await command(["kubectl", "-n", namespace, "get", "deployment", "data-runtime", "-o", "json"], root, 3000))
  if (!object(deployment) || !object(deployment.spec) || !object(deployment.spec.template) ||
      !object(deployment.spec.template.spec) || !Array.isArray(deployment.spec.template.spec.containers))
    throw new Error("Data deployment has invalid container configuration")
  const container = deployment.spec.template.spec.containers.filter(object).find((item) => item.name === "runtime")
  if (!container || !Array.isArray(container.env)) throw new Error("Data deployment has no runtime environment")
  const names = container.env.filter(object).map((item) => item.name).filter((name): name is string => typeof name === "string")
  const values = parse(await command(["kubectl", "-n", namespace, "exec", "deployment/data-runtime", "-c", "runtime", "--",
    "python3", "-c", "import json,os;print(json.dumps(dict(os.environ)))"], root, 5000))
  if (!object(values)) throw new Error("Data runtime returned an invalid environment")
  const env: Record<string, string> = {}
  for (const name of names) {
    if (name.startsWith("CARGO_") || name.startsWith("GIT_CONFIG_") || name === "PORT") continue
    if (typeof values[name] !== "string") throw new Error(`Data runtime is missing configured variable ${name}`)
    env[name] = values[name]
  }
  if (!env.DATABASE_URL) throw new Error("Data runtime is missing DATABASE_URL")
  return env
}

