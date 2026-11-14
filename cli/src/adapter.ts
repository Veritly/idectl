import { cfg } from "./config"
import type { Service, Target } from "./config"
import type { Json } from "./core"
import { kubernetes } from "./adapters/kubernetes"
import { none } from "./adapters/none"

export type Attachment = { id: string; host: unknown; port: unknown; replace: boolean } & Json
export type Route = { ids: string[]; attachments: Attachment[] }

export type Adapter = {
  type: string
  connect(): Promise<Json>
  doctor(targets: Target[]): Promise<{ checks: Record<string, boolean>; details: Json }>
  env(item: Service, dir: string): Promise<{ env: Record<string, string>; paths: { from: string; to: string }[] }>
  attach(item: Target, port: number, note: (text: string) => void): Promise<Route & { created: boolean }>
  detach(item: Target, port: number, note: (text: string) => void): Promise<{ detached: boolean; restored?: boolean }>
  routed(item: Target): Promise<Route | undefined>
  url(item: Target): Promise<string>
}

export const adapter: Adapter = cfg.adapter.type === "kubernetes" ? kubernetes(cfg.adapter) : none()
