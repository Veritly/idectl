import { expect, test } from "bun:test"
import { policy, step } from "../src/stepping"

const origin = { allowed: true, cause: false, thread: "5", location: { file: "/app/route.rs", line: 10, function: "handler" } }
const library = { ...origin, allowed: false, location: { file: "/rust/alloc/sync.rs", line: 24, function: "deref" } }
const helper = { ...origin, location: { file: "/app/auth.rs", line: 5, function: "scope" } }
const paused = { state: "paused", pausedReason: "step" }

// Replay the native stop sequence through the production coordinator.
async function replay(decisions: unknown[], stops: unknown[]) {
  const calls: string[] = []
  const result = await step({
    action: "step_into", seconds: 5, params: { session_id: "owned" },
    filter: async () => decisions.shift(),
    call: async (name, params) => {
      expect(params.session_id).toBe("owned")
      calls.push(name)
      return name === "wait_for_pause" ? stops.shift() : { status: "success" }
    },
  })
  return { result, calls }
}

test("unwinds nested filtered callers and continues into the requested application helper", async () => {
  const result = await replay([origin, library, { ...library, location: { ...library.location, function: "outer" } }, origin, helper], Array(4).fill(paused))
  expect(result.calls.filter((name) => name !== "wait_for_pause")).toEqual(["step_into", "step_out", "step_out", "step_into"])
  expect(result.result.filtering).toMatchObject({ outcome: "visible", skipped: [library.location, { ...library.location, function: "outer" }] })
})

test("preserves explicit breakpoints and exceptions inside filtered code", async () => {
  for (const stop of [{ ...paused, pausedReason: "breakpoint" }, { ...paused, breakpointHit: { breakpointId: "user" } }, { ...paused, pausedReason: "exception" }]) {
    const result = await replay([origin], [stop])
    expect(result.calls).toEqual(["step_into", "wait_for_pause"])
    expect(result.result.filtering?.outcome).toBe("interrupted")
  }
})

test("does not follow another thread or auto-resume a running request", async () => {
  const changed = await replay([origin, { ...library, thread: "6" }], [paused])
  expect(changed.result.filtering?.outcome).toBe("thread_changed")
  expect(changed.calls).toHaveLength(2)
  const running = await replay([origin], [{ state: "running", waitResult: "timeout" }])
  expect(running.result.filtering?.outcome).toBe("not_paused")
  expect(running.calls).toHaveLength(2)
})

test("bounds non-progressing library recovery and leaves the final stop paused", async () => {
  const result = await replay([origin, ...Array(33).fill(library)], Array(33).fill(paused))
  expect(result.result.filtering?.outcome).toBe("limit")
  expect(result.calls.filter((name) => name === "step_out")).toHaveLength(32)
  expect(result.result.waited).toEqual(paused)
})

test("rejects missing filter metadata instead of guessing ownership", () => {
  expect(() => policy({ allowed: false })).toThrow("invalid native stepping-filter decision")
})
