package com.veritly.ide

import com.intellij.openapi.application.PathManager
import java.nio.file.Files
import java.security.MessageDigest
import com.jetbrains.cidr.execution.debugger.CidrDebugProcess
import com.jetbrains.cidr.execution.debugger.CidrDebugProcessConfigurator
import com.jetbrains.cidr.execution.debugger.backend.lldb.LLDBDriverConfiguration
import com.jetbrains.cidr.execution.debugger.stepFilters.NonUserFileStepFilterRule
import com.jetbrains.cidr.execution.debugger.stepFilters.StepFilterRule
import com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersProvider
import com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersProviderContext

class Stepping : StepFiltersProvider, CidrDebugProcessConfigurator {
  override fun configure(process: CidrDebugProcess) {
    if (process.runParameters.debuggerDriverConfiguration !is LLDBDriverConfiguration) return
    // Native IDE filters do not intercept inline steps inside the same machine frame.
    process.postCommand { driver ->
      driver.executeInterpreterCommand(-1, -1, "settings set target.process.thread.step-avoid-regexp ^<?(std|core|alloc)::")
      driver.executeInterpreterCommand(-1, -1, "command script import \"$script\"")
    }
  }

  companion object {
    private val script by lazy {
      val bytes = Stepping::class.java.getResourceAsStream("/lldb/veritly_step.py")!!.use { it.readBytes() }
      val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
      val file = PathManager.getSystemDir().resolve("veritly-ide/lldb/$hash/veritly_step.py")
      Files.createDirectories(file.parent)
      Files.write(file, bytes)
      file
    }
  }

  override suspend fun getStepFilters(context: StepFiltersProviderContext): List<StepFilterRule> = listOf(
    // Rust debug information uses /rustc paths before the IDE maps them to its source cache.
    NonUserFileStepFilterRule(Regex(".*/rustc/[^/]+/library/.*")),
    NonUserFileStepFilterRule(Regex(".*/stdlib-local-copy/.*")),
    NonUserFileStepFilterRule(Regex(".*/lib/rustlib/src/rust/library/.*")),
    NonUserFileStepFilterRule(Regex(".*/(?:registry/src|git/checkouts)/.*")),
  )
}
