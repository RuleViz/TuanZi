/**
 * TuanZi Desktop — Renderer Process Entry
 */

import "highlight.js/styles/github.css"
import "@xterm/xterm/css/xterm.css"
import { bootstrapRendererApp } from "./app/bootstrap"
import { createRendererRuntime } from "./app/renderer-runtime"
import { showError } from "./app/toast"

const runtime = createRendererRuntime()

async function init(): Promise<void> {
  await bootstrapRendererApp(runtime)
}

document.addEventListener("DOMContentLoaded", () => {
  void init().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    showError(`初始化失败: ${message}`)
  })
})
