package com.veritly.ide

import com.jetbrains.cidr.execution.debugger.stepFilters.NonUserFileStepFilterRule
import com.jetbrains.cidr.execution.debugger.stepFilters.StepFilterRule
import com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersProvider
import com.jetbrains.cidr.execution.debugger.stepFilters.StepFiltersProviderContext

class Stepping : StepFiltersProvider {
  override suspend fun getStepFilters(context: StepFiltersProviderContext): List<StepFilterRule> = listOf(
    // Rust debug information uses /rustc paths before the IDE maps them to its source cache.
    NonUserFileStepFilterRule(Regex(".*/rustc/[^/]+/library/.*")),
    NonUserFileStepFilterRule(Regex(".*/stdlib-local-copy/.*")),
    NonUserFileStepFilterRule(Regex(".*/lib/rustlib/src/rust/library/.*")),
    NonUserFileStepFilterRule(Regex(".*/(?:registry/src|git/checkouts)/.*")),
  )
}
