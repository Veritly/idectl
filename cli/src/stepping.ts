import { object } from "./core"
import type { Json } from "./core"

type Policy = { allowed: boolean; cause: boolean; thread: string; location: { file: string; line: number; function: string } }

export function policy(value: unknown): Policy {
  if (!object(value) || typeof value.allowed !== "boolean" || typeof value.cause !== "boolean" || typeof value.thread !== "string"
    || !object(value.location) || typeof value.location.file !== "string" || typeof value.location.line !== "number" || typeof value.location.function !== "string")
    throw new Error("IDE returned an invalid native stepping-filter decision")
  return value as Policy
}

type Call = (name: string, params: Json, timeout: number) => Promise<unknown>

export async function observe(call: Call, params: Json, deadline: number, blocked?: () => Promise<unknown>) {
  while (true) {
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
    const timeout = blocked ? Math.min(5, seconds) : seconds
    const waited = await call("wait_for_pause", { ...params, timeout }, timeout * 1000 + 1000)
    if (!object(waited) || waited.state === "paused" || waited.state === "stopped") return waited
    const blocker = blocked ? await blocked() : undefined
    if (blocker) return { ...waited, waitResult: "blocked", blocker }
    if (!blocked || Date.now() >= deadline) return waited
  }
}

export async function step(opts: {
  action: string
  seconds: number
  params: Json
  call: Call
  filter?: () => Promise<unknown>
  blocked?: () => Promise<unknown>
}) {
  const deadline = Date.now() + opts.seconds * 1000
  const origin = opts.filter ? policy(await opts.filter()) : undefined
  const skipped: (Policy["location"] & { reason: "ide_filter" | "no_source" })[] = []
  const run = async (action: string) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Step deadline expired before execution; the debugger remains paused")
    const result = await opts.call(action, opts.params, remaining)
    return { result, waited: await observe(opts.call, opts.params, deadline, opts.blocked) }
  }
  let current = await run(opts.action)
  if (!origin || !opts.filter) return { ...current, filtering: undefined }
  for (let count = 0; ; count++) {
    const waited = current.waited
    const finish = (outcome: string, interruption?: string, frame?: Policy) => ({
      ...current,
      filtering: { source: "ide", skipped, outcome, interruption, frame: frame?.location, threads: frame ? { from: origin.thread, to: frame.thread } : undefined },
    })
    if (!object(waited) || waited.state !== "paused") return finish("not_paused")
    if (waited.pausedReason !== "step" || waited.breakpointHit) return finish("interrupted", waited.breakpointHit ? "breakpoint" : String(waited.pausedReason))
    const next = policy(await opts.filter())
    if (next.cause) return finish("interrupted", "native", next)
    if (next.thread !== origin.thread) return finish("thread_changed", undefined, next)
    // Continue Step Into when an automatic unwind returns to its original call site.
    const retry = opts.action === "step_into" && skipped.length > 0
      && next.location.file === origin.location.file && next.location.line === origin.location.line
      && next.location.function === origin.location.function
    if (next.allowed && next.location.line > 0 && !retry) return finish("visible", undefined, next)
    if (count === 32) return finish("limit", undefined, next)
    if (Date.now() >= deadline) return finish("deadline", undefined, next)
    if (!next.allowed || next.location.line < 1) skipped.push({ ...next.location, reason: next.allowed ? "no_source" : "ide_filter" })
    current = await run(next.allowed ? opts.action : "step_out")
  }
}
