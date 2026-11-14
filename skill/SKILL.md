---
name: idectl
description: Debug a project through JetBrains IDE breakpoints, variables, expressions, stack frames and stepping, with local services routed into a shared environment.
---

Read [docs/debugging.md](../docs/debugging.md) for the workflow, and the project's `idectl.json` for its services, adapter and CLI entrypoint (`cli`).
Start with `doctor --service NAME`, then `debug up NAME` and `wait session NAME`. Attach the managed browser with T3 `preview_status`, then `preview_open` using the CLI's `preview.arguments`; `available:false` with `tabId:null` means no preview is open yet, so still call `preview_open`.
Use breakpoints before diagnostics, and bounded commands first. `help` lists commands, `debug commands NAME` shows debugger schemas, and `jetbrains schema NAME` shows native integration tools.
Always finish with `debug down NAME` and `wait session NAME --until stopped` reporting `cleanup: complete`.
An `environment_repair_required` error means stop and request repair; do not retry or launch around it.
