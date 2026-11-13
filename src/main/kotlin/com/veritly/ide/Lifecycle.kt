package com.veritly.ide

import com.google.gson.Gson
import com.intellij.execution.ExecutionListener
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.ide.GeneralSettings
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.application.ApplicationManager
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.currentCoroutineContext

data class Run(val id: String, val name: String, val executor: String, val phase: String, val exit: Int? = null)

@Service(Service.Level.PROJECT)
class Runs {
  val rows = ConcurrentHashMap<String, Run>()
  val handlers = ConcurrentHashMap<String, ProcessHandler>()
  private val ids = Collections.synchronizedMap(IdentityHashMap<ExecutionEnvironment, String>())

  fun id(env: ExecutionEnvironment): String = synchronized(ids) {
    ids.getOrPut(env) { UUID.randomUUID().toString() }
  }

  fun release(env: ExecutionEnvironment) { ids.remove(env) }
}

class Listener : ExecutionListener {
  private fun record(executor: String, env: ExecutionEnvironment, phase: String, exit: Int? = null) {
    val runs = env.project.service<Runs>()
    val id = runs.id(env)
    runs.rows[id] = Run(id, env.runProfile.name, executor, phase, exit)
    if (runs.rows.size > 256) {
      runs.rows.values.firstOrNull { it.id != id && (it.phase == "stopped" || it.phase == "failed") }?.let { runs.rows.remove(it.id, it) }
    }
  }

  override fun processStartScheduled(executorId: String, env: ExecutionEnvironment) = record(executorId, env, "starting")
  override fun processNotStarted(executorId: String, env: ExecutionEnvironment) {
    record(executorId, env, "failed")
    env.project.service<Runs>().release(env)
  }
  override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
    val runs = env.project.service<Runs>()
    runs.handlers[runs.id(env)] = handler
    record(executorId, env, "running")
  }
  override fun processTerminating(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) = record(executorId, env, "stopping")
  override fun processTerminated(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler, exitCode: Int) {
    val runs = env.project.service<Runs>()
    runs.handlers.remove(runs.id(env), handler)
    record(executorId, env, "stopped", exitCode)
    runs.release(env)
  }
}

@Suppress("FunctionName", "unused")
class Lifecycle : McpToolset {
  @McpTool
  @McpDescription("Trust one existing Veritly debugger project before opening it. The directory must be inside the Veritly debugger project directory.")
  fun veritly_trust_project(@McpDescription("Absolute path to the generated Veritly debugger project") directory: String): String {
    val base = Path.of(System.getProperty("user.home"), ".local", "share", "veritly-debugger").toRealPath()
    val path = Path.of(directory).toRealPath()
    require(path != base && path.startsWith(base) && Files.isDirectory(path.resolve(".idea"))) { "Expected a generated Veritly debugger project" }
    TrustedProjects.setProjectTrusted(path, true)
    return Gson().toJson(mapOf("trusted" to TrustedProjects.isProjectTrusted(path)))
  }

  @McpTool
  @McpDescription("Configure the IDE to open additional projects in a new window without prompting, preserving existing projects.")
  fun veritly_open_windows(): String {
    GeneralSettings.getInstance().confirmOpenNewProject = GeneralSettings.OPEN_PROJECT_NEW_WINDOW
    ApplicationManager.getApplication().saveSettings()
    return Gson().toJson(mapOf("openProjects" to "newWindow"))
  }

  @McpTool
  @McpDescription("Persist the selected project's IDE settings, including breakpoint changes, before restarting the IDE. Does not save source documents.")
  suspend fun veritly_save_project(): String {
    val project = currentCoroutineContext().project
    ApplicationManager.getApplication().invokeAndWait { project.save() }
    return Gson().toJson(mapOf("saved" to true))
  }

  @McpTool
  @McpDescription("List IDE run and debug executions observed since the project opened. Each has a unique ID, name, executor, phase and cancellable flag. RustRover may report a build separately as Build `configuration name`.")
  suspend fun veritly_run_status(): String {
    val runs = currentCoroutineContext().project.service<Runs>()
    val rows = runs.rows.values.map { run ->
      mapOf("id" to run.id, "name" to run.name, "executor" to run.executor, "phase" to run.phase, "exit" to run.exit,
        "cancellable" to runs.handlers.containsKey(run.id))
    }
    return Gson().toJson(mapOf("runs" to rows))
  }

  @McpTool
  @McpDescription("Stop an IDE execution by the unique ID from veritly_run_status. The IDE must have provided a process handler; check cancellable before calling.")
  suspend fun veritly_run_stop(@McpDescription("Execution ID returned by veritly_run_status") id: String): String {
    val runs = currentCoroutineContext().project.service<Runs>()
    val run = runs.rows[id] ?: error("Execution $id was not found")
    val handler = runs.handlers[id] ?: error("Execution $id is ${run.phase}; no process handler is available")
    handler.destroyProcess()
    return Gson().toJson(mapOf("id" to id, "phase" to "stopping"))
  }
}
