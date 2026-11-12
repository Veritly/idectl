import { expect, test } from "bun:test"
import { jetbrains } from "../src/jetbrains"

test("negotiates a session, reads every tool page and reports tool errors", async () => {
  const seen: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "DELETE") {
        seen.push("close")
        return new Response(null, { status: 200 })
      }
      const body = await req.json() as { id?: number; method: string; params?: { cursor?: string; name?: string } }
      seen.push(body.method)
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "mcp-session-id": "test-session" } })
      if (req.headers.get("mcp-session-id") !== "test-session") return new Response("missing session", { status: 400 })
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: body.params?.cursor
        ? { tools: [{ name: "second" }] }
        : { tools: [{ name: "first" }], nextCursor: "next" } })
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.params?.name === "bad"
        ? { isError: true, content: [{ type: "text", text: "tool failed" }] }
        : { structuredContent: { ok: true } } })
    },
  })
  try {
    if (!server.port) throw new Error("Test server has no port")
    const client = await jetbrains(server.port)
    expect((await client.tools()).map((item) => item.name)).toEqual(["first", "second"])
    expect(await client.call("first", {})).toEqual({ structuredContent: { ok: true } })
    await expect(client.call("bad", {})).rejects.toThrow("tool failed")
    expect(seen.slice(0, 4)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"])
    await client.close()
    expect(seen.at(-1)).toBe("close")
  } finally {
    server.stop(true)
  }
})
