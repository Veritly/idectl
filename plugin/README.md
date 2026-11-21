# idectl JetBrains lifecycle plugin

Adds run and debug lifecycle tools to the JetBrains MCP server. The plugin observes IDE executions and can stop an execution when its process handler is available. In RustRover, `idectl_cargo_attach` attaches a Cargo manifest and reports whether its project model is ready.

Cargo attachment enables Rust stepping filters for the standard library and external crates.
`debuggerPatch` builds the pinned Debugger MCP 5.4.0 dependency with corrected frame scope collection and atomic command history trimming; it requires `-PdebuggerPath=PATH_TO_VERIFIED_UPSTREAM_JAR`.
The patched sources under `src/debugger` derive from hechtcarmel/jetbrains-debugger-mcp-plugin revision `411dc38420824a6b59a56d6685285a7b02a0a053`; its license is preserved there.

RustRover's standard Cargo build task emits a separate `Build ` execution with its own ID. IDs are assigned per IDE execution because some JetBrains build events use execution ID zero. Only cancel an execution while its `cancellable` field is true. Stopping uses the IDE Stop button's own path, so a configuration that reconnects after a disconnect stays stopped.

`idectl_trust_project` trusts a specific generated project inside `~/.local/share/idectl/projects`; it does not change the IDE's general project-trust policy. `idectl_reload_project` reloads `.idea` files that idectl rewrote while the project is open. `idectl_open_windows` selects the new-window preference for additional projects.

Build from this directory with the JBR shipped with the target IDE:

```sh
JAVA_HOME=IDE_PATH/jbr ./gradlew buildPlugin -PidePath=IDE_PATH
```

Install the ZIP under `build/distributions` in the IDE. The plugin requires a JetBrains IDE with its bundled MCP server enabled.

In an IDE with the Flutter plugin, `idectl_flutter_devices` lists the devices Flutter can launch on and `idectl_flutter_device` selects one; a Flutter run configuration launches on the IDE's selected device.

Build properties: `-Prust=false` leaves out the Cargo toolset for an IDE without the Rust plugin, `-PmcpServerPath=DIR` and `-PflutterPath=DIR` point at those plugins when they are installed rather than bundled, and `-PsinceBuild=N` sets the oldest supported platform build.
