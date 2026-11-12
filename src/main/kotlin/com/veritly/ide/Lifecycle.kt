package com.veritly.ide

import com.google.gson.Gson
import com.intellij.build.BuildViewManager
import com.intellij.build.DefaultBuildDescriptor
import com.intellij.build.events.FinishBuildEvent
import com.intellij.build.events.StartBuildEvent
import com.intellij.execution.ExecutionListener
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.currentCoroutineContext

data class Run(val id: Long, val name: String, val executor: String, val phase: String, val exit: Int? = null)

@Service(Service.Level.PROJECT)
class Runs(project: Project) : Disposable {
  val rows = ConcurrentHashMap<Long, Run>()
  val handlers = ConcurrentHashMap<Long, ProcessHandler>()
  val builds = ConcurrentHashMap<Any, Pair<Long, ProcessHandler>>()

  init {
    project.service<BuildViewManager>().addListener({ id, event ->
      if (event is StartBuildEvent) {
        val descriptor = event.buildDescriptor as? DefaultBuildDescriptor
        val env = descriptor?.executionEnvironment
        val handler = descriptor?.processHandler
        if (env != null && env.executionId > 0 && handler != null) builds[id] = env.executionId to handler
      }
      if (event is FinishBuildEvent) builds.remove(id)
    }, this)
  }

  override fun dispose() = Unit
}

class Listener : ExecutionListener {
  private fun record(executor: String, env: ExecutionEnvironment, phase: String, exit: Int? = null) {
    env.project.service<Runs>().rows[env.executionId] = Run(env.executionId, env.runProfile.name, executor, phase, exit)
  }

  override fun processStartScheduled(executorId: String, env: ExecutionEnvironment) = record(executorId, env, "starting")
  override fun processNotStarted(executorId: String, env: ExecutionEnvironment) = record(executorId, env, "failed")
  override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
    env.project.service<Runs>().handlers[env.executionId] = handler
    record(executorId, env, "running")
  }
  override fun processTerminating(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) = record(executorId, env, "stopping")
  override fun processTerminated(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler, exitCode: Int) {
    env.project.service<Runs>().handlers.remove(env.executionId)
    record(executorId, env, "stopped", exitCode)
  }
}

@Suppress("FunctionName", "unused")
class Lifecycle : McpToolset {
  @McpTool
  @McpDescription("List IDE run and debug executions observed since the project opened, including their execution ID, phase and whether a matching process can be stopped.")
  suspend fun veritly_run_status(): String {
    val runs = currentCoroutineContext().project.service<Runs>()
    val rows = runs.rows.values.sortedBy { it.id }.map { run ->
      mapOf("id" to run.id, "name" to run.name, "executor" to run.executor, "phase" to run.phase, "exit" to run.exit,
        "cancellable" to (runs.handlers.containsKey(run.id) || runs.builds.values.any { it.first == run.id }))
    }
    return Gson().toJson(mapOf("runs" to rows))
  }

  @McpTool
  @McpDescription("Stop an IDE execution by its numeric execution ID. Starting executions can be stopped only when the IDE exposes an associated build process handler.")
  suspend fun veritly_run_stop(@McpDescription("Execution ID returned by veritly_run_status") id: Long): String {
    val runs = currentCoroutineContext().project.service<Runs>()
    val run = runs.rows[id] ?: error("Execution $id was not found")
    val handler = runs.handlers[id] ?: runs.builds.values.singleOrNull { it.first == id }?.second
      ?: error("Execution $id is ${run.phase}; no associated process handler is available")
    handler.destroyProcess()
    return Gson().toJson(mapOf("id" to id, "phase" to "stopping"))
  }
}
