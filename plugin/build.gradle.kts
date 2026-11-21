plugins {
  kotlin("jvm") version "2.4.21"
  id("org.jetbrains.intellij.platform") version "2.20.1"
}

repositories {
  mavenCentral()
  intellijPlatform { defaultRepositories() }
}

dependencies {
  intellijPlatform {
    local(providers.gradleProperty("idePath"))
    bundledPlugin("com.intellij.mcpServer")
    bundledPlugin("com.jetbrains.rust")
    bundledPlugin("com.intellij.nativeDebug")
  }
}

kotlin { jvmToolchain(25) }

val debugger by sourceSets.creating {
  compileClasspath += sourceSets.main.get().compileClasspath + files(providers.gradleProperty("debuggerPath"))
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
    ideaVersion { sinceBuild = "263" }
  }
}
