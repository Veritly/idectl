import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function scope(cwd: string, target: string, home = os.homedir()) {
  const root = fs.realpathSync(cwd)
  const source = fs.realpathSync(path.resolve(root, target))
  const relative = path.relative(root, source)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Choose a component directory or source file inside this checkout, rather than the repository root")
  const file = fs.statSync(source).isFile()
  const dir = file ? path.dirname(source) : source
  const rust = path.extname(source) === ".rs"
  const component = ancestors(dir, root).find(
    (dir) =>
      fs.existsSync(path.join(dir, rust ? "Cargo.toml" : "package.json")) ||
      fs.existsSync(path.join(dir, "Cargo.toml")),
  )
  if (!component || component === root) throw new Error(`No component manifest found for ${source}`)
  const ide = rust || fs.existsSync(path.join(component, "Cargo.toml")) ? "rustrover" : "webstorm"
  const content = path.join(component, "src")
  if (!fs.existsSync(content))
    throw new Error(`Choose a component with a src directory, rather than a workspace: ${component}`)
  const key = new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 12)
  const project = path.join(home, ".local/share/veritly-debugger", key, path.relative(root, component))
  return { source, file, component, content, project, ide }
}

function ancestors(dir: string, root: string): string[] {
  if (dir === root) return [root]
  return [dir, ...ancestors(path.dirname(dir), root)]
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function prepare(value: ReturnType<typeof scope>) {
  const dir = path.join(value.project, ".idea")
  fs.mkdirSync(dir, { recursive: true })
  save(
    path.join(dir, "source.iml"),
    `<module type="WEB_MODULE" version="4"><component name="NewModuleRootManager"><content url="${xml(pathToFileURL(value.content).href)}"><excludePattern pattern="node_modules"/><excludePattern pattern="target"/><excludePattern pattern="dist"/></content><orderEntry type="sourceFolder" forTests="false"/></component></module>`,
  )
  save(
    path.join(dir, "modules.xml"),
    '<project version="4"><component name="ProjectModuleManager"><modules><module fileurl="file://$PROJECT_DIR$/.idea/source.iml" filepath="$PROJECT_DIR$/.idea/source.iml"/></modules></component></project>',
  )
  if (value.ide === "webstorm")
    save(
      path.join(dir, "compiler.xml"),
      '<project version="4"><component name="TypeScriptCompiler"><option name="useService" value="false"/></component></project>',
    )
}

export function address(url: string) {
  const value = new URL(url)
  if (
    value.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) ||
    !value.port ||
    Number(value.port) < 1 ||
    value.pathname !== "/" ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  )
    throw new Error("Attach requires a loopback HTTP browser endpoint with an explicit port")
  return value
}

export function browser(
  root: string,
  component: string,
  project: string,
  url: string,
  active = false,
  attach?: string,
) {
  const page = new URL(url)
  if (!["http:", "https:"].includes(page.protocol)) throw new Error("Browser debugging requires an HTTP(S) URL")
  const mappings = [
    [`${page.origin}/src`, path.join(component, "src")],
    [`${page.origin}/@fs//workspace`, root],
    [`${page.origin}/@fs/workspace`, root],
    [`${page.origin}/@fs/${root}`, root],
    [`${page.origin}/@fs${root}`, root],
  ]
  const dir = path.join(project, ".idea/runConfigurations")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "Veritly_Browser.xml")
  const target = attach ? address(attach) : undefined
  const type = target
    ? `type="ChromiumRemoteDebugType" host="${xml(target.hostname.replace(/^\[|\]$/g, ""))}" port="${target.port}"`
    : `type="JavascriptDebugType" uri="${xml(page.href)}" useFirstLineBreakpoints="true"`
  const text = `<component name="ProjectRunConfigurationManager"><configuration default="false" name="Veritly Browser" ${type}>${mappings.map(([url, file]) => `<mapping url="${xml(url)}" local-file="${xml(file)}"/>`).join("")}<method v="2"/></configuration></component>`
  if (active && (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text))
    throw new Error("Browser mappings changed; close this IDE project and reopen it to load the new configuration")
  return save(file, text)
}

function save(file: string, value: string) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === value) return false
  fs.writeFileSync(file, value)
  return true
}
