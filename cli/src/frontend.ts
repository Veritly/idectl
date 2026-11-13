import { command, root } from "./core"
import { tunnel, vars } from "./service"
import path from "node:path"
import fs from "node:fs"

export function spawn(args: string[], cwd: string, env: Record<string, string | undefined>, log: string) {
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(log, "w", 0o600)
  const proc = Bun.spawn(args, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  async function copy(stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) {
    for await (const chunk of stream) {
      fs.writeSync(fd, chunk)
      target.write(chunk)
    }
  }
  const output = Promise.all([copy(proc.stdout, process.stdout), copy(proc.stderr, process.stderr)])
  return { proc, exit: proc.exited.then(async (code) => {
    await output
    fs.writeSync(fd, `[veritly-ide] Frontend exited with code ${code}\n`)
    fs.closeSync(fd)
    return code
  }) }
}

async function main() {
  await command(["bun", "script/local-k8s.ts", "doctor"], root, 60_000)
  await tunnel()
  const host = (await command(["kubectl", "get", "service", "kubernetes", "-n", "default", "-o", "jsonpath={.spec.clusterIP}"], root, 3000)).trim()
  if (!host) throw new Error("Kubernetes API service has no cluster IP")
  const env = vars()
  if (!env.DEV_FRONTEND_HOST || !env.DEV_FRONTEND_PORT) throw new Error("DEV_FRONTEND_HOST and DEV_FRONTEND_PORT are required")
  const node = Bun.which("node")
  if (!node) throw new Error("Node.js is required")
  if (process.platform !== "linux") throw new Error("The local frontend launcher requires Linux")
  const child = spawn([
    "python3", "-c",
    "import ctypes,os,signal,sys; libc=ctypes.CDLL(None,use_errno=True); assert libc.prctl(1,signal.SIGTERM)==0; assert os.getppid()!=1; os.execvp(sys.argv[1],sys.argv[1:])",
    node, path.join(root, "packages/app/node_modules/vite/bin/vite.js"), "--configLoader", "runner",
    "--host", env.DEV_FRONTEND_HOST, "--port", env.DEV_FRONTEND_PORT, "--strictPort",
  ], path.join(root, "packages/app"), { ...process.env, ...env, NODE_ENV: "development", KUBERNETES_SERVICE_HOST: host }, path.join(root, ".veritly/ide/frontend.log"))
  process.exit(await child.exit)
}

if (import.meta.main) await main()
