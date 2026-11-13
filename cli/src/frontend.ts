import { command, root } from "./core"
import { tunnel, vars } from "./service"
import path from "node:path"

await command(["bun", "script/local-k8s.ts", "doctor"], root, 60_000)
await tunnel()
const host = (await command(["kubectl", "get", "service", "kubernetes", "-n", "default", "-o", "jsonpath={.spec.clusterIP}"], root, 3000)).trim()
if (!host) throw new Error("Kubernetes API service has no cluster IP")
const env = vars()
if (!env.DEV_FRONTEND_HOST || !env.DEV_FRONTEND_PORT) throw new Error("DEV_FRONTEND_HOST and DEV_FRONTEND_PORT are required")
const node = Bun.which("node")
if (!node) throw new Error("Node.js is required")
if (process.platform !== "linux") throw new Error("The local frontend launcher requires Linux")
const proc = Bun.spawn([
  "python3", "-c",
  "import ctypes,os,signal,sys; libc=ctypes.CDLL(None,use_errno=True); assert libc.prctl(1,signal.SIGTERM)==0; assert os.getppid()!=1; os.execvp(sys.argv[1],sys.argv[1:])",
  node, path.join(root, "packages/app/node_modules/vite/bin/vite.js"), "--configLoader", "runner",
  "--host", env.DEV_FRONTEND_HOST, "--port", env.DEV_FRONTEND_PORT, "--strictPort",
], { cwd: path.join(root, "packages/app"), env: { ...process.env, ...env, NODE_ENV: "development", KUBERNETES_SERVICE_HOST: host }, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
process.exit(await proc.exited)
