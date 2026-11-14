import type { Adapter } from "../adapter"

export function none(): Adapter {
  return {
    type: "none",
    async connect() {
      return {}
    },
    async doctor() {
      return { checks: {}, details: {} }
    },
    async env() {
      return { env: {}, paths: [] }
    },
    async attach(item, port) {
      return { created: false, ids: [], attachments: [], local: `http://127.0.0.1:${port}`, target: item.id }
    },
    async detach() {
      return { detached: false }
    },
    async routed() {
      return undefined
    },
    async url(item) {
      throw new Error(`${item.id} has no environment to route requests through; call the local service directly`)
    },
  }
}
