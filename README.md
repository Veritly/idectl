# Veritly JetBrains lifecycle plugin

Adds run and debug lifecycle tools to the JetBrains MCP server. The plugin observes IDE executions and can stop an execution when its process handler is available. RustRover can start a Cargo build before the execution event and may not expose a matching build handler; cancellation during that interval is not supported yet.

Build from this directory with the JBR shipped with the target IDE:

```sh
JAVA_HOME=IDE_PATH/jbr ./gradlew buildPlugin -PidePath=IDE_PATH
```

Install the ZIP under `build/distributions` in the IDE. The plugin requires a JetBrains IDE with its bundled MCP server enabled.
