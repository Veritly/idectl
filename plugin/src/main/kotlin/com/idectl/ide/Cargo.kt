package com.idectl.ide

import com.google.gson.Gson
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.components.service
import com.intellij.openapi.components.Service
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.currentCoroutineContext
import org.rust.cargo.project.model.CargoProjectsService
import org.rust.cargo.project.model.CargoProject
import org.rust.debugger.settings.RsDebuggerSettings
import com.intellij.xdebugger.XDebuggerManager
import com.jetbrains.cidr.execution.debugger.CidrDebugProcess
import kotlinx.coroutines.future.await

@Service(Service.Level.PROJECT)
class CargoState {
  val pending = ConcurrentHashMap.newKeySet<Path>()
  val errors = ConcurrentHashMap<Path, String>()
}

@Suppress("FunctionName", "unused")
class Cargo : McpToolset {
  @McpTool
  @McpDescription("Read the native IDE stepping-filter decision for the top frame of one paused configuration. Does not resume or step the process.")
  suspend fun idectl_debug_filter(configuration: String): String {
    val project = currentCoroutineContext().project
    val sessions = XDebuggerManager.getInstance(project).debugSessions.filter { !it.isStopped && it.sessionName == configuration }
    require(sessions.size == 1) { "Select exactly one active native debug configuration" }
    val session = sessions.single()
    require(session.isSuspended) { "Stepping filters require a paused session" }
    val process = session.debugProcess as? CidrDebugProcess ?: error("Configuration does not use the native debugger")
    val context = session.suspendContext as? com.jetbrains.cidr.execution.debugger.CidrSuspendContext ?: error("Native suspend context is unavailable")
    val stack = context.currentExecutionStack
    val frame = stack.topFrame?.frame ?: error("Native top frame is unavailable")
    val logger = com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersLogger(process, com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersDiagnosticsLevel.DISABLED)
    val rules = com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersProvider.getAllStepFilters(
      com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersProviderContext(project, null, logger)
    )
    val manager = com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersManager(rules, logger, 0)
    val paths = if (frame.module != null) com.jetbrains.cidr.execution.debugger.modules.CidrDebuggerModulesStorage.getInstance(process).getModulesPathByName(frame.module!!) else emptyList()
    val module = if (paths.size == 1) paths.single() else frame.module
    val enabled = com.intellij.openapi.util.registry.Registry.`is`("cidr.debugger.stepFilters") && !session.isMixedMode
    return Gson().toJson(mapOf(
      "allowed" to (!enabled || manager.canStepInto(module, frame.file, frame.function)),
      "enabled" to enabled,
      "cause" to (stack.suspensionCause != null),
      "thread" to stack.thread.tid,
      "location" to mapOf("file" to frame.file, "line" to frame.line + 1, "function" to frame.function)
    ))
  }

  @McpTool
  @McpDescription("Execute a native debugger console command in one explicitly named active run configuration. Returns the debugger response.")
  suspend fun idectl_debug_command(configuration: String, command: String): String {
    require(command.isNotBlank()) { "A debugger command is required" }
    val project = currentCoroutineContext().project
    val sessions = XDebuggerManager.getInstance(project).debugSessions.filter { !it.isStopped && it.sessionName == configuration }
    require(sessions.size == 1) { "Select exactly one active native debug configuration" }
    val process = sessions.single().debugProcess as? CidrDebugProcess ?: error("Configuration does not use the native debugger")
    return process.postCommand<String> { driver -> driver.executeInterpreterCommand(-1, -1, command) }.await()
  }

  @McpTool
  @McpDescription("Attach an absolute Cargo.toml path to this IDE project. Returns whether its Cargo model is ready; retry while loading.")
  suspend fun idectl_cargo_attach(@McpDescription("Absolute path to Cargo.toml") manifest: String): String {
    val settings = RsDebuggerSettings.Helper.getInstance()
    settings.skipStdlibInStepping = true
    settings.skipExternalCratesInStepping = true
    val path = Path.of(manifest).toAbsolutePath().normalize()
    require(path.fileName.toString() == "Cargo.toml" && Files.isRegularFile(path)) { "A Cargo.toml file is required" }
    val cargo = currentCoroutineContext().project.service<CargoProjectsService>()
    val state = currentCoroutineContext().project.service<CargoState>()
    val existing = cargo.allProjects.find { it.manifest.normalize() == path }
    if (existing == null) {
      val err = state.errors.remove(path)
      if (err != null) error("Cargo project attachment failed: $err")
      if (state.pending.add(path)) {
        cargo.attachCargoProject(path).invokeOnCompletion { cause ->
          state.pending.remove(path)
          if (cause != null) state.errors[path] = cause.message ?: cause.javaClass.simpleName
        }
      }
      return Gson().toJson(mapOf("phase" to "attaching"))
    }
    val status = existing.workspaceStatus
    if (status is CargoProject.UpdateStatus.UpdateFailed) error("Cargo project failed to load: ${status.reason}")
    return Gson().toJson(mapOf("phase" to if (existing.workspace != null) "ready" else "loading"))
  }
}
