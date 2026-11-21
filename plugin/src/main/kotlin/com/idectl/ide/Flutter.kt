package com.idectl.ide

import com.google.gson.Gson
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import io.flutter.run.daemon.DeviceService
import kotlinx.coroutines.currentCoroutineContext

@Suppress("FunctionName", "unused")
class Flutter : McpToolset {
  private fun rows(service: DeviceService) = service.connectedDevices.map {
    mapOf("id" to it.deviceId(), "name" to it.deviceName(), "platform" to it.platform(), "emulator" to it.emulator(), "selected" to (it == service.selectedDevice))
  }

  @McpTool
  @McpDescription("List the devices Flutter run configurations can launch on in this project, and which one is selected.")
  suspend fun idectl_flutter_devices(): String {
    val service = DeviceService.getInstance(currentCoroutineContext().project)
    return Gson().toJson(mapOf("status" to service.status.toString(), "devices" to rows(service)))
  }

  @McpTool
  @McpDescription("Select the device Flutter run configurations launch on. The IDE otherwise uses whatever its toolbar selector holds.")
  suspend fun idectl_flutter_device(@McpDescription("Device id as `flutter devices` prints it, for example emulator-5554") device: String): String {
    val service = DeviceService.getInstance(currentCoroutineContext().project)
    val found = service.connectedDevices.firstOrNull { it.deviceId() == device }
      ?: return Gson().toJson(mapOf("selected" to false, "status" to service.status.toString(), "devices" to rows(service)))
    service.selectedDevice = found
    return Gson().toJson(mapOf("selected" to true, "device" to found.deviceId(), "name" to found.deviceName()))
  }
}
