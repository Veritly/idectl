import { object } from "./core"
import type { Json } from "./core"

type Policy = { allowed: boolean; cause: boolean; thread: string; location: { file: string; line: number; function: string } }

export function policy(value: unknown): Policy {
  if (!object(value) || typeof value.allowed !== "boolean" || typeof value.cause !== "boolean" || typeof value.thread !== "string"
    || !object(value.location) || typeof value.location.file !== "string" || typeof value.location.line !== "number" || typeof value.location.function !== "string")
    throw new Error("IDE returned an invalid native stepping-filter decision")
  return value as Policy
}

export async function step(opts: {
  action: string
  seconds: number
  params: Json
  call: (name: string, params: Json, timeout: number) => Promise<unknown>
  filter?: () => Promise<unknown>
}) {
  const deadline = Date.now() + opts.seconds * 1000
  const origin = opts.filter ? policy(await opts.filter()) : undefined
  const skipped: Policy["location"][] = []
  const run = async (action: string) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Step deadline expired before execution; the debugger remains paused")
    const result = await opts.call(action, opts.params, remaining)
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
    return { result, waited: await opts.call("wait_for_pause", { ...opts.params, timeout: seconds }, seconds * 1000 + 1000) }
  }
  let current = await run(opts.action)
  if (!origin || !opts.filter) return { ...current, filtering: undefined }
  for (let count = 0; ; count++) {
    const waited = current.waited
    const finish = (outcome: string) => ({ ...current, filtering: { source: "ide", skipped, outcome } })
    if (!object(waited) || waited.state !== "paused") return finish("not_paused")
    if (waited.pausedReason !== "step" || waited.breakpointHit) return finish("interrupted")
    const next = policy(await opts.filter())
    if (next.cause) return finish("interrupted")
    if (next.thread !== origin.thread) return finish("thread_changed")
    // Continue Step Into when an automatic unwind returns to its original call site.
    const retry = opts.action === "step_into" && skipped.length > 0
      && next.location.file === origin.location.file && next.location.line === origin.location.line
      && next.location.function === origin.location.function
    if (next.allowed && !retry) return finish("visible")
    if (count === 32) return finish("limit")
    if (Date.now() >= deadline) return finish("deadline")
    if (!next.allowed) skipped.push(next.location)
    current = await run(next.allowed ? opts.action : "step_out")
  }
}
