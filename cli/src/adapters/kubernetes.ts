import fs from "node:fs"
import path from "node:path"
import { cfg } from "../config"
import type { Kubernetes, Service, Target } from "../config"
import { object, parse, command, attempt } from "../core"
import type { Json } from "../core"
import type { Adapter } from "../adapter"

export function kubernetes(opts: Kubernetes): Adapter {
  const ns = opts.namespace
  const root = cfg.root

  async function context() {
    const value = (await command(["kubectl", "config", "current-context"], root, 1000)).trim()
    if (!value) throw new Error("Select this machine's Kubernetes context before connecting")
    return value
  }

  /** Deployments and StatefulSets share the pod template and selector this adapter reads; names are unique across both in these namespaces. */
  async function workload(name: string, timeout: number) {
    const list = parse(await command(["kubectl", "-n", ns, "get", "deployments,statefulsets", "-o", "json"], root, timeout))
    const items = object(list) && Array.isArray(list.items) ? list.items.filter(object) : []
    const found = items.filter((row) => object(row.metadata) && row.metadata.name === name)
    if (found.length !== 1) throw new Error(`Expected one Deployment or StatefulSet named ${name}; found ${found.length}`)
    return found[0]
  }

  async function status() {
    return parse(await command(["telepresence", "status", "--format", "json"], root, 5000))
  }

  async function connect() {
    const ctx = await context()
    const current = await attempt(status)
    if (current.ok && object(current.value) && object(current.value.user_daemon)) {
      const daemon = current.value.user_daemon
      if (daemon.status === "Connected" && !Array.isArray(daemon.mapped_namespaces))
        throw new Error("Telepresence returned no mapped namespaces")
      const mapped = daemon.mapped_namespaces
      if (daemon.status === "Connected" && daemon.kubernetes_context === ctx && Array.isArray(mapped) && mapped.includes(ns)) {
        if (daemon.namespace === ns) return { context: ctx, namespace: ns }
        // Short service names resolve only in the connected namespace; local processes (the frontend proxy) need them.
        await command(["telepresence", "quit"], root, 10_000)
      } else if (daemon.status === "Connected")
        throw new Error(`Telepresence is connected to ${String(daemon.kubernetes_context)} without ${ns} mapped`)
    }
    await command(["telepresence", "connect", "--context", ctx, "--namespace", ns, "--mapped-namespaces", ns, "--format", "json", "--progress", "quiet"], root, 10_000)
    const after = await status()
    if (!object(after) || !object(after.user_daemon) || after.user_daemon.status !== "Connected")
      throw new Error("Telepresence connect returned without a connected daemon; run telepresence status")
    return { context: ctx, namespace: ns }
  }

  async function workloads() {
    const data = parse(await command(["telepresence", "list", "--namespace", ns, "--format", "json", "--progress", "quiet"], root, 5000))
    if (!Array.isArray(data)) throw new Error("telepresence list returned invalid JSON")
    return data.filter(object)
  }

  function attachments(row: Json) {
    if (row.intercept_info === undefined) return []
    if (!Array.isArray(row.intercept_info) || !row.intercept_info.every(object))
      throw new Error("Telepresence returned invalid attachment details")
    return row.intercept_info.filter(object).map((item) => {
      if (!object(item.spec)) throw new Error("Telepresence returned an attachment without a specification")
      if (typeof item.id !== "string" || !item.id) throw new Error("Telepresence attachment has no stable identifier")
      return {
        id: item.id,
        pod: item.pod_name,
        replace: item.spec.replace === true,
        mechanism: item.spec.mechanism,
        host: item.spec.target_host,
        port: item.spec.target_port,
        agent: item.spec.node_agent,
      }
    })
  }

  async function routed(item: Target) {
    const row = (await workloads()).find((row) => row.name === item.workload)
    const list = row ? attachments(row) : []
    if (!list.length) return
    return { ids: list.map((row) => row.id).sort(), attachments: list }
  }

  function mine(item: Target, port: number, list: ReturnType<typeof attachments>) {
    return list.every((row) => row.host === "127.0.0.1" && row.replace === (item.mode === "replace") && (item.mode === "replace" || row.port === port))
  }

  async function summary(item: Target) {
    const list = await pods(item)
    return list.filter((pod) => !(object(pod.status) && pod.status.phase === "Failed")).map((pod) => {
      const name = object(pod.metadata) && typeof pod.metadata.name === "string" ? pod.metadata.name.split("-").at(-1) : "pod"
      const gone = object(pod.metadata) && Boolean(pod.metadata.deletionTimestamp)
      const rows = object(pod.status) && Array.isArray(pod.status.containerStatuses) ? pod.status.containerStatuses.filter(object) : []
      const containers = object(pod.spec) && Array.isArray(pod.spec.containers)
        ? pod.spec.containers.filter(object).map((row) => `${String(row.name)}${rows.some((state) => state.name === row.name && state.ready === true) ? "" : " (starting)"}`)
        : []
      return `pod ${name}${gone ? " terminating" : ""}: ${containers.join(", ") || "pending"}`
    }).join("; ") || "no pods yet"
  }

  async function budget(item: Target) {
    const deployment = await workload(item.workload, 5000)
    const labels = object(deployment) && object(deployment.spec) && object(deployment.spec.template) && object(deployment.spec.template.metadata) && object(deployment.spec.template.metadata.labels)
      ? deployment.spec.template.metadata.labels
      : {}
    const list = parse(await command(["kubectl", "-n", ns, "get", "poddisruptionbudgets", "-o", "json"], root, 5000))
    const items = object(list) && Array.isArray(list.items) ? list.items.filter(object) : []
    return items.some((row) => object(row.spec) && object(row.spec.selector) && object(row.spec.selector.matchLabels) &&
      Object.entries(row.spec.selector.matchLabels).every(([key, value]) => labels[key] === value) &&
      object(row.status) && row.status.disruptionsAllowed === 0)
  }

  async function watch(item: Target, run: Promise<unknown>, note: (text: string) => void, label: string) {
    const state = { done: false }
    const result = run.finally(() => { state.done = true })
    while (!state.done) {
      const text = await attempt(() => summary(item))
      if (!state.done && text.ok) note(`${label}; ${text.value}`)
      await Promise.race([result.catch(() => undefined), Bun.sleep(2000)])
    }
    return result
  }

  async function attach(item: Target, port: number, note: (text: string) => void) {
    const before = await routed(item)
    if (before) {
      if (!mine(item, port, before.attachments))
        throw new Error(`${item.workload} is already attached to a different target; run telepresence list to inspect its owner, and preserve the existing attachment`)
      return { created: false, ids: before.ids, attachments: before.attachments }
    }
    if (item.mode === "replace" && item.agent === "node") throw new Error(`${item.id}: Telepresence replace requires agent "sidecar"`)
    const args = item.mode === "replace"
      ? ["telepresence", "replace", item.workload, "--namespace", ns, "--container", item.container || "", "--mount", "false"]
      : ["telepresence", "intercept", item.workload, "--namespace", ns, "--port", `${port}:http`, ...(item.service ? ["--service", item.service] : []), "--mount", "false", ...(item.agent === "node" ? ["--node-agent"] : [])]
    if (item.mode === "replace" && !item.container) throw new Error(`${item.id}: replace requires a container`)
    const run = command([...args, "--format", "json", "--progress", "quiet"], root, item.mode === "replace" ? 330_000 : 20_000)
    if (item.mode === "replace") {
      const blocked = await attempt(() => budget(item))
      await watch(item, run, note, `Stopping ${item.workload}/${item.container}${blocked.ok && blocked.value ? "; its disruption budget allows no eviction, so Telepresence restarts the workload after about 30s" : ""}`)
    }
    await run
    const after = await routed(item)
    if (!after || !mine(item, port, after.attachments)) throw new Error(`Telepresence did not attach ${item.workload} to the local process`)
    return { created: true, ids: after.ids, attachments: after.attachments }
  }

  async function pods(item: Target) {
    const deployment = await workload(item.workload, 5000)
    if (!object(deployment) || !object(deployment.spec) || !object(deployment.spec.selector) || !object(deployment.spec.selector.matchLabels))
      throw new Error(`${item.workload} has no pod selector`)
    const selector = Object.entries(deployment.spec.selector.matchLabels).map(([key, value]) => `${key}=${String(value)}`).join(",")
    const list = parse(await command(["kubectl", "-n", ns, "get", "pods", "-l", selector, "-o", "json"], root, 5000))
    if (!object(list) || !Array.isArray(list.items)) throw new Error(`Kubernetes returned invalid pods for ${item.workload}`)
    return list.items.filter(object)
  }

  async function restored(item: Target) {
    const list = await pods(item)
    return list.some((pod) => object(pod.status) && pod.status.phase === "Running" && Array.isArray(pod.status.containerStatuses) &&
      pod.status.containerStatuses.filter(object).some((row) => row.name === item.container && row.ready === true)) &&
      !list.some((pod) => object(pod.spec) && Array.isArray(pod.spec.containers) && !pod.spec.containers.filter(object).some((row) => row.name === item.container) && !(object(pod.metadata) && pod.metadata.deletionTimestamp))
  }

  // A replace that fails midway leaves a pod with only the traffic agent: deleting it lets the Deployment recreate the original.
  async function repair(item: Target) {
    if (item.mode !== "replace") return
    for (const pod of await pods(item)) {
      const meta = object(pod.metadata) ? pod.metadata : undefined
      const notes = meta && object(meta.annotations) ? meta.annotations : {}
      if (meta && typeof meta.name === "string" && Object.keys(notes).some((key) => key.endsWith("replaced-container")))
        await command(["kubectl", "-n", ns, "delete", "pod", meta.name, "--wait=false"], root, 20_000)
    }
  }

  async function detach(item: Target, port: number, note: (text: string) => void) {
    const current = await routed(item)
    if (!current) return { detached: false }
    if (!mine(item, port, current.attachments))
      throw new Error(`${item.id} is attached to a different target; existing attachment preserved`)
    await command(["telepresence", "detach", item.workload, "--namespace", ns, "--format", "json", "--progress", "quiet"], root, 10_000)
    if (item.mode !== "replace") return { detached: true }
    const blocked = await attempt(() => budget(item))
    const label = `Restoring ${item.workload}/${item.container}${blocked.ok && blocked.value ? "; its disruption budget allows no eviction, so Telepresence restarts the workload after about 30s" : ""}`
    // A restored container must pass its readiness probe; some workloads delay that for 90s on top of the eviction wait.
    const until = Date.now() + 300_000
    while (Date.now() < until) {
      if (await restored(item)) return { detached: true, restored: true }
      const text = await attempt(() => summary(item))
      if (text.ok) note(`${label}; ${text.value}`)
      await Bun.sleep(2000)
    }
    throw new Error(`${item.workload} was detached but its ${item.container} container is not ready again after 5 minutes; check kubectl -n ${ns} get pods`)
  }

  async function url(item: Target) {
    const [deployment, services] = await Promise.all([
      workload(item.workload, 5000),
      command(["kubectl", "-n", ns, "get", "services", "-o", "json"], root, 5000).then(parse),
    ])
    if (!object(deployment) || !object(deployment.spec) || !object(deployment.spec.template) || !object(deployment.spec.template.metadata) || !object(deployment.spec.template.metadata.labels))
      throw new Error("Kubernetes deployment has no pod labels")
    const labels = deployment.spec.template.metadata.labels
    if (!object(services) || !Array.isArray(services.items)) throw new Error("Kubernetes returned invalid services")
    const found = services.items.filter(object).flatMap((row) => {
      if (!object(row.metadata) || typeof row.metadata.name !== "string" || !object(row.spec) || !object(row.spec.selector) || !Array.isArray(row.spec.ports)) return []
      if (item.service && row.metadata.name !== item.service) return []
      const selectors = Object.entries(row.spec.selector)
      if (!selectors.length || !selectors.every(([key, value]) => labels[key] === value)) return []
      const ports = row.spec.ports.filter(object).filter((port) => port.name === "http" && typeof port.port === "number")
      if (ports.length !== 1) return []
      return [{ name: row.metadata.name, port: ports[0].port }]
    })
    if (found.length !== 1) throw new Error(`Expected one HTTP Service for ${item.workload}; found ${found.map((row) => row.name).join(", ") || "none"}`)
    return `http://${found[0].name}.${ns}.svc.cluster.local:${found[0].port}`
  }

  async function get(kind: string, name: string) {
    const value = parse(await command(["kubectl", "-n", ns, "get", kind, name, "-o", "json"], root, 3000))
    if (!object(value)) throw new Error(`Kubernetes returned an invalid ${kind} ${name}`)
    const data = object(value.data) ? value.data : {}
    return Object.fromEntries(Object.entries(data).flatMap(([key, raw]) => typeof raw === "string"
      ? [[key, kind === "secret" ? Buffer.from(raw, "base64").toString("utf8") : raw]]
      : []))
  }

  async function env(item: Service, dir: string) {
    const deployment = await workload(item.workload, 3000)
    if (!object(deployment.spec) || !object(deployment.spec.template) || !object(deployment.spec.template.spec) ||
        !Array.isArray(deployment.spec.template.spec.containers))
      throw new Error(`${item.workload} has invalid container configuration`)
    const spec = deployment.spec.template.spec
    const container = (Array.isArray(spec.containers) ? spec.containers : []).filter(object).find((row) => row.name === item.container)
    if (!container) throw new Error(`${item.workload} has no container ${item.container}`)
    const cache = new Map<string, Promise<Record<string, string>>>()
    const load = (kind: string, name: string) => {
      const key = `${kind}/${name}`
      if (!cache.has(key)) cache.set(key, get(kind, name))
      return cache.get(key)!
    }
    const volumes = Array.isArray(spec.volumes) ? spec.volumes.filter(object) : []
    const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts.filter(object) : []
    const paths: { from: string; to: string }[] = []
    for (const mount of mounts) {
      if (typeof mount.name !== "string" || typeof mount.mountPath !== "string") throw new Error(`${item.workload} has an invalid volume mount`)
      const volume = volumes.find((row) => row.name === mount.name)
      if (!volume) throw new Error(`${item.workload} mounts unknown volume ${mount.name}`)
      if (object(volume.hostPath) && typeof volume.hostPath.path === "string") {
        if (fs.existsSync(volume.hostPath.path) && fs.realpathSync(volume.hostPath.path) === fs.realpathSync(root)) paths.push({ from: mount.mountPath, to: root })
        continue
      }
      const sources = object(volume.secret) ? [{ kind: "secret", name: volume.secret.secretName, items: volume.secret.items }]
        : object(volume.configMap) ? [{ kind: "configmap", name: volume.configMap.name, items: volume.configMap.items }]
        : object(volume.projected) && Array.isArray(volume.projected.sources)
          ? volume.projected.sources.filter(object).map((row) => object(row.secret)
            ? { kind: "secret", name: row.secret.name, items: row.secret.items }
            : object(row.configMap) ? { kind: "configmap", name: row.configMap.name, items: row.configMap.items }
            : (() => { throw new Error(`${item.workload} volume ${mount.name} has an unsupported projected source`) })())
          : object(volume.emptyDir) ? [] : undefined
      const sub = typeof mount.subPath === "string" ? mount.subPath : undefined
      if (!sources || (sub && !sources.length)) continue
      const target = path.join(dir, mount.mountPath)
      if (!sub) fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      paths.push({ from: mount.mountPath, to: target })
      for (const source of sources) {
        if (typeof source.name !== "string") throw new Error(`${item.workload} volume ${mount.name} has no source name`)
        const data = await load(source.kind, source.name)
        const items = Array.isArray(source.items)
          ? source.items.filter(object).map((row) => ({ key: String(row.key), path: String(row.path) }))
          : Object.keys(data).map((key) => ({ key, path: key }))
        for (const entry of items) {
          if (sub && sub !== entry.path) continue
          if (data[entry.key] === undefined) throw new Error(`${source.kind} ${source.name} has no key ${entry.key}`)
          const dest = sub ? target : path.join(target, entry.path)
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
          fs.writeFileSync(dest, data[entry.key], { mode: 0o600 })
        }
      }
    }
    const result: Record<string, string> = {}
    for (const row of Array.isArray(container.env) ? container.env.filter(object) : []) {
      const key = row.name
      if (typeof key !== "string") throw new Error(`${item.workload} has an unnamed environment variable`)
      if (opts.skip.some((prefix) => key.startsWith(prefix))) continue
      if (typeof row.value === "string") { result[key] = row.value; continue }
      if (!object(row.valueFrom)) throw new Error(`${key} has no supported configuration source`)
      const secret = object(row.valueFrom.secretKeyRef)
      const ref = secret ? row.valueFrom.secretKeyRef : row.valueFrom.configMapKeyRef
      if (!object(ref) || typeof ref.key !== "string" || typeof ref.name !== "string") throw new Error(`${key} has no supported configuration reference`)
      const data = await load(secret ? "secret" : "configmap", ref.name).catch((err: unknown) => {
        if (ref.optional === true) return {} as Record<string, string>
        throw err
      })
      const value = data[ref.key]
      if (value === undefined) {
        if (ref.optional === true) continue
        throw new Error(`${secret ? "Secret" : "ConfigMap"} ${ref.name} has no key ${ref.key} for ${key}`)
      }
      result[key] = value
    }
    const sorted = paths.sort((a, b) => b.from.length - a.from.length)
    for (const key of Object.keys(result)) {
      const hit = sorted.find((row) => result[key] === row.from || result[key].startsWith(`${row.from}/`))
      if (hit) result[key] = hit.to + result[key].slice(hit.from.length)
    }
    return { env: result, paths: sorted }
  }

  async function doctor(targets: Target[]) {
    const ctx = await attempt(context)
    const [daemon, list, manager] = await Promise.all([
      attempt(status),
      attempt(async () => parse(await command(["kubectl", "get", "deployments,statefulsets", "-n", ns, "-o", "json"], root, 5000))),
      opts.manager && ctx.ok
        ? attempt(async () => parse(await command(["helm", "--kube-context", ctx.value, "--namespace", opts.manager!.namespace, "get", "values", opts.manager!.release, "--all", "--output", "json"], root, 5000)))
        : Promise.resolve(undefined),
    ])
    const user = daemon.ok && object(daemon.value) && object(daemon.value.user_daemon) ? daemon.value.user_daemon : undefined
    const mapped = user && Array.isArray(user.mapped_namespaces) ? user.mapped_namespaces : undefined
    const names = list.ok && object(list.value) && Array.isArray(list.value.items)
      ? list.value.items.filter(object).flatMap((row) => object(row.metadata) && typeof row.metadata.name === "string" ? [row.metadata.name] : [])
      : []
    const node = manager?.ok && object(manager.value) && object(manager.value.nodeAgent) ? manager.value.nodeAgent.enabled === true : undefined
    const timeout = await attempt(async () => {
      const view = parse(await command(["telepresence", "config", "view", "--format", "json"], root, 3000))
      const value = object(view) && object(view.clientConfig) && object(view.clientConfig.timeouts) ? view.clientConfig.timeouts.intercept : undefined
      return typeof value === "string" ? value : undefined
    })
    const replace = targets.some((item) => item.mode === "replace")
    const seconds = timeout.ok && timeout.value ? duration(timeout.value) : 30
    const arrival = manager?.ok && object(manager.value) && object(manager.value.timeouts) && typeof manager.value.timeouts.agentArrival === "string"
      ? duration(manager.value.timeouts.agentArrival)
      : undefined
    return {
      checks: {
        kubectl: Boolean(Bun.which("kubectl")),
        telepresence: Boolean(Bun.which("telepresence")),
        context: ctx.ok,
        namespace: list.ok,
        tunnel: Boolean(user && ctx.ok && user.status === "Connected" && user.kubernetes_context === ctx.value && mapped?.includes(ns)),
        workloads: targets.every((item) => names.includes(item.workload)),
        ...(targets.some((item) => item.agent === "node") ? { agent: node === true } : {}),
        ...(replace ? { timeout: seconds >= 120, ...(opts.manager ? { arrival: (arrival || 0) >= 120 } : {}) } : {}),
      },
      details: {
        namespace: ns,
        context: ctx.ok ? ctx.value : ctx.error,
        tunnel: user ? { status: user.status, context: user.kubernetes_context, namespaces: mapped } : daemon.ok ? daemon.value : daemon.error,
        missing: targets.filter((item) => !names.includes(item.workload)).map((item) => item.workload),
        timeout: replace && seconds < 120
          ? `Telepresence timeouts.intercept is ${seconds}s; replace restarts the workload, so set timeouts.intercept to at least 2m in ~/.config/telepresence/config.yml`
          : undefined,
        arrival: replace && opts.manager && (arrival || 0) < 120
          ? `Traffic manager timeouts.agentArrival is ${arrival === undefined ? "unknown" : `${arrival}s`}; replace waits for the workload's disruption budget, so run telepresence helm upgrade --reuse-values --set timeouts.agentArrival=3m`
          : undefined,
      },
    }
  }

  return { type: "kubernetes", connect, doctor, env, attach, detach, routed, repair, url }
}

function duration(value: string) {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(h|m|s|ms)/g)]
  if (!parts.length) throw new Error(`Unsupported Telepresence duration ${value}`)
  return parts.reduce((sum, row) => sum + Number(row[1]) * ({ h: 3600, m: 60, s: 1, ms: 0.001 }[row[2]] || 0), 0)
}
