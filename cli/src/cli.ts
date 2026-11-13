#!/usr/bin/env bun
import { message } from "./core"

import("./command").then((entry) => entry.main()).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message(err), hint: "Use veritly-ide --help for syntax, or debug commands TOOL with the same IDE/service selector for tool arguments." })}\n`)
    process.exit(1)
  },
)
