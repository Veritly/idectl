import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { install, installDebugger } from "../src/plugin"

test("installs a verified plugin only after the IDE stops", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idectl-plugin-test-"))
  try {
    const dir = path.join(root, "build")
    const target = path.join(root, "plugins", "idectl-lifecycle")
    fs.mkdirSync(dir)
    const bytes = Buffer.from("plugin artifact")
    fs.writeFileSync(path.join(dir, "plugin.jar"), bytes)
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ phase: "ready", build: "263.1.1", sha256: createHash("sha256").update(bytes).digest("hex") }))
    expect(install(target, dir, true, "RustRover", "263.1.1").phase).toBe("plugin_restart_required")
    expect(fs.existsSync(target)).toBe(false)
    expect(install(target, dir, false, "RustRover", "263.1.1").phase).toBe("installed")
    expect(fs.readFileSync(path.join(target, "lib/idectl-lifecycle.jar"))).toEqual(bytes)
    fs.writeFileSync(path.join(dir, "plugin.jar"), "corrupted")
    expect(() => install(target, dir, false, "RustRover", "263.1.1")).toThrow("artifact is missing or invalid")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("rejects a corrupted debugger archive before touching the installed plugin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idectl-debugger-test-"))
  try {
    const dir = path.join(root, "build")
    const target = path.join(root, "plugin")
    fs.mkdirSync(dir)
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, "keep"), "existing")
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ phase: "ready" }))
    fs.writeFileSync(path.join(dir, "debugger.zip"), "corrupted")
    expect(() => installDebugger(target, dir, false, "RustRover")).toThrow("archive is missing or invalid")
    expect(fs.readFileSync(path.join(target, "keep"), "utf8")).toBe("existing")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
