import { vars } from "./service"

Object.assign(process.env, vars())
await import("../../opencode/script/dev")
