import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { cfg, needFrontend } from "./config"

export function scope(cwd: string, target: string, home = os.homedir()) {
  const root = fs.realpathSync(cwd)
  const source = fs.realpathSync(path.resolve(root, target))
  const relative = path.relative(root, source)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Choose a component directory or source file inside this checkout, rather than the repository root")
  const file = fs.statSync(source).isFile()
  const dir = file ? path.dirname(source) : source
  const rust = path.extname(source) === ".rs"
  const dart = path.extname(source) === ".dart"
  const component = ancestors(dir, root).find(
    (dir) =>
      fs.existsSync(path.join(dir, rust ? "Cargo.toml" : dart ? "pubspec.yaml" : "package.json")) ||
      fs.existsSync(path.join(dir, "Cargo.toml")) ||
      fs.existsSync(path.join(dir, "pubspec.yaml")),
  )
  if (!component || component === root) throw new Error(`No component manifest found for ${source}`)
  if (!rust && !fs.existsSync(path.join(component, "Cargo.toml")) && fs.existsSync(path.join(component, "pubspec.yaml")) && (dart || !fs.existsSync(path.join(component, "package.json")))) {
    // Dart and Flutter packages debug in Android Studio. A pub workspace resolves every member's packages from the
    // workspace root, so all its members share one IDE project rooted there (as a Cargo workspace does in RustRover).
    const workspace = ancestors(component, root).filter((dir) => fs.existsSync(path.join(dir, "pubspec.yaml")) && /^workspace:/m.test(fs.readFileSync(path.join(dir, "pubspec.yaml"), "utf8"))).at(-1)
    const content = workspace || component
    const key = new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 12)
    const project = path.join(home, ".local/share/idectl/projects", key, path.relative(root, content) || "_workspace")
    return { root, source, file, component, content, project, ide: "android-studio" }
  }
  const ide = rust || fs.existsSync(path.join(component, "Cargo.toml")) ? "rustrover" : "webstorm"
  if (ide === "rustrover" && !fs.existsSync(path.join(component, "src")))
    throw new Error(`Choose a Rust component with a src directory, rather than a workspace: ${component}`)
  const workspace = ide === "rustrover"
    ? ancestors(component, root).filter((dir) => dir !== root && fs.existsSync(path.join(dir, "Cargo.toml")) && /^\[workspace\]/m.test(fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8"))).at(-1)
    : undefined
  const content = workspace || (fs.existsSync(path.join(component, "src")) ? path.join(component, "src") : component)
  const key = new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 12)
  const project = path.join(home, ".local/share/idectl/projects", key, path.relative(root, component))
  return { root, source, file, component, content, project, ide }
}

function ancestors(dir: string, root: string): string[] {
  if (dir === root) return [root]
  return [dir, ...ancestors(path.dirname(dir), root)]
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** The Dart SDK: Flutter's bundled one when Flutter is installed, else the SDK that owns `dart` on PATH. */
function dartSdk() {
  const flutter = Bun.which("flutter")
  const bundled = flutter ? path.join(path.dirname(path.dirname(fs.realpathSync(flutter))), "bin/cache/dart-sdk") : undefined
  if (bundled && fs.existsSync(path.join(bundled, "lib"))) return bundled
  const dart = Bun.which("dart")
  const own = dart ? path.dirname(path.dirname(fs.realpathSync(dart))) : undefined
  if (own && fs.existsSync(path.join(own, "lib/core"))) return own
  throw new Error("Dart SDK is missing; install Flutter or Dart on this VM and put it on PATH")
}

function configured() {
  return new Set([...(cfg.frontend ? [cfg.frontend.configuration, cfg.frontend.browser] : []), ...Object.values(cfg.services).map((item) => item.configuration), ...Object.values(cfg.attach).map((item) => item.configuration)])
}

export function prepare(value: ReturnType<typeof scope>) {
  const dir = path.join(value.project, ".idea")
  fs.mkdirSync(dir, { recursive: true })
  const dart = value.ide === "android-studio"
  // The IDE also loads run configurations it finds under a content root, where $PROJECT_DIR$ would mean this generated
  // project; the checkout's .run templates are copied below with real paths, so keep the originals out of the module.
  const run = path.join(value.root, ".run")
  const excluded = run.startsWith(`${value.content}${path.sep}`) ? `<excludeFolder url="${xml(pathToFileURL(run).href)}"/>` : ""
  save(
    path.join(dir, "source.iml"),
    dart
      ? `<module type="WEB_MODULE" version="4"><component name="NewModuleRootManager"><content url="${xml(pathToFileURL(value.content).href)}"><excludePattern pattern=".dart_tool"/><excludePattern pattern="build"/><excludePattern pattern="node_modules"/>${excluded}</content><orderEntry type="sourceFolder" forTests="false"/><orderEntry type="library" name="Dart SDK" level="project"/><orderEntry type="library" name="Dart Packages" level="project"/></component></module>`
      : `<module type="WEB_MODULE" version="4"><component name="NewModuleRootManager"><content url="${xml(pathToFileURL(value.content).href)}"><excludePattern pattern="node_modules"/><excludePattern pattern="target"/><excludePattern pattern="dist"/></content><orderEntry type="sourceFolder" forTests="false"/></component></module>`,
  )
  if (dart) {
    // The Dart plugin treats a project as Dart-enabled when its module depends on a project library named "Dart SDK".
    const sdk = dartSdk()
    const roots = fs.readdirSync(path.join(sdk, "lib"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    fs.mkdirSync(path.join(dir, "libraries"), { recursive: true })
    save(
      path.join(dir, "libraries/Dart_SDK.xml"),
      `<component name="libraryTable"><library name="Dart SDK"><CLASSES>${roots.map((name) => `<root url="${xml(pathToFileURL(path.join(sdk, "lib", name)).href)}"/>`).join("")}</CLASSES><JAVADOC/><SOURCES/></library></component>`,
    )
  }
  save(
    path.join(dir, "modules.xml"),
    '<project version="4"><component name="ProjectModuleManager"><modules><module fileurl="file://$PROJECT_DIR$/.idea/source.iml" filepath="$PROJECT_DIR$/.idea/source.iml"/></modules></component></project>',
  )
  if (value.ide === "webstorm") {
    save(
      path.join(dir, "compiler.xml"),
      '<project version="4"><component name="TypeScriptCompiler"><option name="useService" value="false"/></component></project>',
    )
    const bun = Bun.which("bun")
    if (!bun) throw new Error("Bun is missing; install it on this VM")
    save(path.join(dir, "bun.xml"), `<project version="4"><component name="BunSettings"><option name="bunPath" value="${xml(bun)}" /></component></project>`)
  }
  if (value.ide === "rustrover") {
    const file = path.join(dir, "workspace.xml")
    const workspace = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : '<project version="4"></project>'
    if (!workspace.includes('name="RustProjectSettings"')) {
      const cargo = Bun.which("cargo")
      if (!cargo) throw new Error("Rust toolchain is missing; install cargo on this VM")
      const settings = `<component name="RustProjectSettings"><option name="toolchainHomeDirectory" value="${xml(path.dirname(cargo))}" /></component>`
      if (!workspace.includes("</project>")) throw new Error(`Invalid RustRover project settings: ${file}`)
      fs.writeFileSync(file, workspace.replace("</project>", `${settings}</project>`), { mode: 0o600 })
    }
  }
  const configs = path.join(dir, "runConfigurations")
  fs.mkdirSync(configs, { recursive: true })
  const shared = path.join(value.root, ".run")
  if (!fs.existsSync(shared)) return
  for (const name of fs.readdirSync(shared)) {
    if (!name.endsWith(".run.xml")) continue
    const template = fs.readFileSync(path.join(value.root, ".run", name), "utf8")
    const types: Record<string, string[]> = {
      rustrover: ["CargoCommandRunConfiguration"],
      webstorm: ["BunRunConfiguration", "JavascriptDebugType", "NodeJSConfigurationType", "ChromiumRemoteDebugType"],
      "android-studio": ["DartCommandLineRunConfigurationType", "FlutterRunConfigurationType", "DartTestRunConfigurationType"],
    }
    if (!(types[value.ide] || []).some((type) => template.includes(`type="${type}"`))) continue
    // A configuration with a missing program makes the IDE open a modal editor that blocks every later launch.
    const label = template.match(/<configuration[^>]* name="([^"]+)"/)?.[1]
    const program = template.match(/<option name="program" value="([^"]+)"/)?.[1] || template.match(/ path-to-js-file="([^"]+)"/)?.[1]
    if (value.ide === "webstorm" && label && program && configured().has(label) && !fs.existsSync(program.replaceAll("$PROJECT_DIR$", value.root)))
      throw new Error(`.run/${name}: program ${program} does not exist; fix the path before launching ${label}`)
    save(path.join(configs, name.replace(".run.xml", ".xml")), template.replaceAll("$PROJECT_DIR$", xml(value.root)))
  }
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
  const file = path.join(dir, `${needFrontend().browser.replace(/[^A-Za-z0-9]+/g, "_")}.xml`)
  const target = attach ? address(attach) : undefined
  const type = target
    ? `type="ChromiumRemoteDebugType" host="${xml(target.hostname.replace(/^\[|\]$/g, ""))}" port="${target.port}"`
    : `type="JavascriptDebugType" uri="${xml(page.href)}" useFirstLineBreakpoints="false" useTemporaryUserDataDir="true"`
  const text = `<component name="ProjectRunConfigurationManager"><configuration default="false" name="${xml(needFrontend().browser)}" ${type}>${mappings.map(([url, file]) => `<mapping url="${xml(url)}" local-file="${xml(file)}"/>`).join("")}<method v="2"/></configuration></component>`
  return save(file, text)
}

function save(file: string, value: string) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === value) return false
  fs.writeFileSync(file, value)
  return true
}
