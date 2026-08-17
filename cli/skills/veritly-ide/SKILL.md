---
name: veritly-ide
description: Start Veritly frontend or backend services locally through Telepresence and control real JetBrains IDE debugging through the Debugger MCP Server. Use for source breakpoints, stepping, expressions, debug sessions, IDE discovery, or local service replacement in the dev cluster.
---

# Veritly IDE

Run `./script/veritly-ide doctor` first.

Use `start backend` for IDE debug mode and `start frontend` for normal Vite mode. Each layers `.env.local-cluster` with the intercepted workload environment. Use `attach frontend` for browser breakpoints. Stop either with `stop SERVICE`.

Use `breakpoint`, `debug`, and `mcp call` for debugger control. Keep stdout as JSON and filter with `jq`.

Prove the full integration with `./script/veritly-ide test breakpoint`.
