import { vars } from "./service"
import { start } from "../../veritly-downloads/server"

const env = vars()
if (!env.DOWNLOADS_PORT) throw new Error("DOWNLOADS_PORT is required in .env.local-cluster")
Object.assign(process.env, env, { PORT: env.DOWNLOADS_PORT })
start()
