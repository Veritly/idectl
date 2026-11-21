plugins {
  kotlin("jvm") version "2.4.21"
  id("org.jetbrains.intellij.platform") version "2.20.1"
}

repositories {
  mavenCentral()
  intellijPlatform { defaultRepositories() }
}

// -Prust=false builds for an IDE without the Rust plugin (the Cargo toolset is left out); -PmcpServerPath=DIR points at
// the MCP Server plugin when the IDE installs it from the Marketplace instead of bundling it (Android Studio).
val rust = providers.gradleProperty("rust").map { it.toBoolean() }.getOrElse(true)
val mcpServerPath = providers.gradleProperty("mcpServerPath").orNull
// -PflutterPath=DIR adds the Flutter toolset (device selection) when the IDE has the Flutter plugin installed.
val flutterPath = providers.gradleProperty("flutterPath").orNull

dependencies {
  intellijPlatform {
    local(providers.gradleProperty("idePath"))
    if (mcpServerPath != null) localPlugin(mcpServerPath) else bundledPlugin("com.intellij.mcpServer")
    if (flutterPath != null) localPlugin(flutterPath)
    if (rust) {
      bundledPlugin("com.jetbrains.rust")
      bundledPlugin("com.intellij.nativeDebug")
    }
  }
}

if (!rust) sourceSets.main { kotlin.exclude("**/Cargo.kt") }
if (flutterPath == null) sourceSets.main { kotlin.exclude("**/Flutter.kt") }

kotlin { jvmToolchain(25) }

val debugger by sourceSets.creating {
  compileClasspath += sourceSets.main.get().compileClasspath + files(providers.gradleProperty("debuggerPath").orElse(""))
}

tasks.register<Jar>("debuggerPatch") {
  dependsOn(tasks.named(debugger.classesTaskName))
  archiveFileName = "debugger-patched.jar"
  destinationDirectory = layout.buildDirectory.dir("distributions")
  isPreserveFileTimestamps = false
  isReproducibleFileOrder = true
  from(zipTree(providers.gradleProperty("debuggerPath"))) {
    exclude(
      "META-INF/MANIFEST.MF",
      "com/github/hechtcarmel/jetbrainsdebuggermcpplugin/tools/util/FrameVariablesCollector*",
      "com/github/hechtcarmel/jetbrainsdebuggermcpplugin/history/CommandHistoryService*",
    )
  }
  from(debugger.output) {
    include(
      "com/github/hechtcarmel/jetbrainsdebuggermcpplugin/tools/util/FrameVariablesCollector*.class",
      "com/github/hechtcarmel/jetbrainsdebuggermcpplugin/history/CommandHistoryService*.class",
    )
  }
}

intellijPlatform {
  pluginConfiguration {
    ideaVersion { sinceBuild = providers.gradleProperty("sinceBuild").orElse("263") }
  }
}
