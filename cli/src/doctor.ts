import fs from "node:fs"
import path from "node:path"
import { root, file, namespace, ides, specs, object, parse, command, attempt, launcher, sockets, opened } from "./core"
import { cluster, port } from "./service"
import { jetbrains } from "./jetbrains"
import { inspect } from "./plugin"
import type { debuggerClient } from "./debugger"

export async function doctor(debug: ReturnType<typeof debuggerClient>, opts: { chosen?: string; project?: string }) {
  const chosen = opts.chosen
  const project = opts.project
  const endpoints = debug.endpoints
  const configs = debug.configs
  const context = await cluster()
  const [active, telepresence, kube, service, manager] = await Promise.all([
    endpoints(),
    attempt(async () => parse(await command(["telepresence", "status", "--format", "json"]))),
    attempt(() => command(["kubectl", "config", "current-context"])),
    attempt(async () => parse(await command(["kubectl", "get", "service", "-n", namespace, "-o", "json"]))),
    attempt(async () =>
      parse(
        await command(
          [
            "helm",
            "--kube-context",
            context,
            "--namespace",
            "ambassador",
            "get",
            "values",
            "traffic-manager",
            "--output",
            "json",
          ],
          root,
          5_000,
        ),
      ),
    ),
  ])
  const selected = chosen
    ? active.find((item) => item.id === chosen)
    : active.find((item) => item.id === "webstorm") || active[0]
  const known = selected ? ides.find((item) => item.id === selected.id) : undefined
  const bin = known ? launcher(known) : undefined
  const plugin = known && bin ? await attempt(async () => inspect(known, bin)) : { ok: false as const, error: "No IDE selected" }
  const mcp = known ? known.port + 300 : undefined
  const listener = mcp ? (await sockets()).find((item) => item.port === mcp) : undefined
  const bridge = mcp && selected?.pid && listener?.pid === selected.pid
    ? await attempt(async () => {
        const client = await jetbrains(mcp)
        try {
          return (await client.tools()).length
        } finally {
          await client.close()
        }
      })
    : { ok: false as const, error: "JetBrains MCP is not running in the selected IDE" }
  const target = project ? path.resolve(project) : selected ? opened(selected) : undefined
  const runs = selected && target ? await attempt(() => configs(selected, target)) : { ok: false as const, error: "No IDE project selected; open a project or pass --project" }
  const installed = ides.map((ide) => {
    const bin = launcher(ide)
    const live = active.find((item) => item.id === ide.id)
    return { id: ide.id, name: ide.name, installed: Boolean(bin), launcher: bin, active: Boolean(live), endpoint: live }
  })
  if (!service.ok) throw new Error(`Cannot inspect Kubernetes services: ${service.error}`)
  if (!object(service.value) || !Array.isArray(service.value.items) || !service.value.items.every(object))
    throw new Error("Kubernetes returned an invalid service list")
  const names = service.value.items.map((item) => {
    if (!object(item.metadata) || typeof item.metadata.name !== "string") throw new Error("Kubernetes returned a service without a name")
    return item.metadata.name
  })
  const daemon =
    telepresence.ok && object(telepresence.value) && object(telepresence.value.user_daemon)
      ? telepresence.value.user_daemon
      : undefined
  if (daemon?.status === "Connected" && !Array.isArray(daemon.mapped_namespaces))
    throw new Error("Telepresence returned no mapped namespaces")
  const mapped = daemon && Array.isArray(daemon.mapped_namespaces) ? daemon.mapped_namespaces : undefined
  const agent = manager.ok && object(manager.value) && object(manager.value.agent) ? manager.value.agent : undefined
  const policies = agent && object(agent.mountPolicies) ? agent.mountPolicies : undefined
  const node =
    manager.ok && object(manager.value) && object(manager.value.nodeAgent) ? manager.value.nodeAgent : undefined
  const loaded = runs.ok ? runs.value.map((row) => {
    if (typeof row.name !== "string") throw new Error("Debugger returned a run configuration without a name")
    return row.name
  }) : undefined
  const checks = {
    env: fs.existsSync(file),
    bun: Boolean(Bun.which("bun")),
    helm: Boolean(Bun.which("helm")),
    kubectl: Boolean(Bun.which("kubectl")),
    setsid: Boolean(Bun.which("setsid")),
    telepresence: Boolean(Bun.which("telepresence")),
    context: kube.ok && kube.value === context,
    namespace: service.ok,
    tunnel: daemon?.status === "Connected" && daemon.kubernetes_context === context && Boolean(mapped?.includes(namespace)),
    manager:
      node?.enabled === true &&
      policies?.["/workspace"] === "Ignore" &&
      policies?.["/workspace/node_modules"] === "Ignore",
    ide: Boolean(selected),
    jetbrains: bridge.ok,
    plugin: plugin.ok && plugin.value.ok,
    project: runs.ok,
    services: specs.every((item) => names.includes(item.workload)),
  }
  return {
    ok: Object.values(checks).every(Boolean),
    root,
    env: file,
    namespace,
    context,
    checks,
    project: target,
    tunnel: daemon ? { status: daemon.status, context: daemon.kubernetes_context, namespaces: mapped } : telepresence,
    manager: manager.ok ? { ready: checks.manager } : manager,
    ides: installed.map((item) => ({
      id: item.id,
      installed: item.installed,
      active: item.active,
      port: item.endpoint?.port,
      tools: item.endpoint?.tools.length,
    })),
    selected: selected ? { id: selected.id, port: selected.port, tools: selected.tools.length } : undefined,
    jetbrains: bridge.ok ? { port: mcp, tools: bridge.value } : bridge,
    plugin: plugin.ok ? plugin.value : plugin,
    configurations: runs.ok ? loaded : runs,
    services: specs.map((item) => ({
      id: item.id,
      workload: item.workload,
      mode: "run",
      port: fs.existsSync(file) ? port(item) : undefined,
      available: names.includes(item.workload),
    })),
  }
}

