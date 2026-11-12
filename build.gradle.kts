plugins {
  kotlin("jvm") version "2.3.21"
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
    bundledModule("intellij.platform.buildView")
  }
}

kotlin { jvmToolchain(25) }

intellijPlatform {
  pluginConfiguration {
    ideaVersion { sinceBuild = "263" }
  }
}
