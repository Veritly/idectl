# Veritly JetBrains lifecycle plugin

Adds run and debug lifecycle tools to the JetBrains MCP server. The plugin observes IDE executions and can stop an execution when its process handler is available. In RustRover, `veritly_cargo_attach` attaches a Cargo manifest and reports whether its project model is ready.

RustRover's standard Cargo build task emits a separate `Build ` execution with its own ID. IDs are assigned per IDE execution because some JetBrains build events use execution ID zero. Only cancel an execution while its `cancellable` field is true.

`veritly_trust_project` trusts a specific generated project inside `~/.local/share/veritly-debugger`; it does not change the IDE's general project-trust policy. `veritly_open_windows` selects the new-window preference for additional projects.

Build from this directory with the JBR shipped with the target IDE:

```sh
JAVA_HOME=IDE_PATH/jbr ./gradlew buildPlugin -PidePath=IDE_PATH
```

Install the ZIP under `build/distributions` in the IDE. The plugin requires a JetBrains IDE with its bundled MCP server enabled.
