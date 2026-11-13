#!/usr/bin/env bun
import { message, Repair } from "./core"

import("./command").then((entry) => entry.main()).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message(err), ...(err instanceof Repair
      ? { code: err.code, retryable: err.retryable, hint: err.hint }
      : { hint: "Use veritly-ide --help for syntax, or debug commands TOOL with the same IDE/service selector for tool arguments." }) })}\n`)
    process.exit(1)
  },
)
