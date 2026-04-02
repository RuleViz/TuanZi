/**
 * rust-tool-bridge.ts — TypeScript ↔ Rust native module bridge.
 *
 * This module provides a feature-flagged bridge that can either:
 *   1. Call the Rust native module for I/O-heavy tools (read/ls/glob/grep)
 *   2. Fall back to the pure-TypeScript implementation seamlessly
 *
 * The bridge is designed to be a drop-in wrapper: the ToolRegistry is completely
 * unaware of whether a tool runs in TS or Rust.
 */

import type { JsonObject, Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";

// ── Native module interface ──

interface NativeToolModule {
  ping(): string;
  executeTool(requestJson: string): Promise<string>;
}

// ── Bridge configuration ──

export interface RustBridgeConfig {
  /** Enable the Rust native backend. When false, all calls go to TS fallback. */
  enabled: boolean;
  /** Specific tools to run via Rust. Tools not listed use TS fallback. */
  enabledTools: Set<string>;
}

const DEFAULT_CONFIG: RustBridgeConfig = {
  enabled: true,
  enabledTools: new Set(["read", "ls", "glob", "grep", "write", "edit", "delete_file", "bash_exec", "checkpoint_create", "checkpoint_restore", "checkpoint_list", "checkpoint_diff", "checkpoint_update_tool_calls", "agent_run_save", "agent_run_load", "agent_run_clear", "subagent_session_save", "subagent_session_load", "mcp_stdio_start", "mcp_stdio_stop", "mcp_stdio_list_tools", "mcp_stdio_call_tool", "mcp_stop_all"]),
};

// ── Singleton state ──

let nativeModule: NativeToolModule | null = null;
let bridgeConfig: RustBridgeConfig = { ...DEFAULT_CONFIG };
let loadAttempted = false;

/**
 * Try to load the native module. Returns true if successful.
 * Safe to call multiple times; will only attempt loading once.
 */
export function tryLoadNativeModule(): boolean {
  if (loadAttempted) {
    return nativeModule !== null;
  }
  loadAttempted = true;

  try {
    // The .node binary is placed next to the JS bundle by the build process.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../native/node-bridge.node") as NativeToolModule;
    if (typeof mod.ping === "function" && mod.ping() === "pong") {
      nativeModule = mod;
      return true;
    }
    return false;
  } catch {
    // Native module not available — this is expected in dev/CI without Rust.
    return false;
  }
}

/**
 * Reconfigure the bridge at runtime.
 */
export function configureRustBridge(config: Partial<RustBridgeConfig>): void {
  if (config.enabled !== undefined) {
    bridgeConfig.enabled = config.enabled;
  }
  if (config.enabledTools !== undefined) {
    bridgeConfig.enabledTools = config.enabledTools;
  }
}

/**
 * Returns true when the given tool name should be dispatched to Rust.
 */
export function shouldUseRust(toolName: string): boolean {
  return bridgeConfig.enabled && nativeModule !== null && bridgeConfig.enabledTools.has(toolName);
}

/**
 * Execute a tool via the Rust native backend.
 * Caller must check `shouldUseRust()` first.
 */
export async function executeViaNative(
  toolName: string,
  args: JsonObject,
  workspaceRoot: string
): Promise<ToolExecutionResult> {
  if (!nativeModule) {
    return { ok: false, error: "Native module not loaded." };
  }

  const request = JSON.stringify({
    tool: toolName,
    args,
    workspace_root: workspaceRoot,
  });

  try {
    const responseJson = await nativeModule.executeTool(request);
    const response = JSON.parse(responseJson) as ToolExecutionResult;
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Native execution error: ${message}` };
  }
}

/**
 * Wrap a TS tool with automatic Rust dispatch.
 *
 * The returned tool has the same definition but its `execute()` method
 * first checks whether Rust should handle it. If yes, the call goes to
 * the native module; otherwise it falls through to the original TS impl.
 *
 * This is the key integration point — `createDefaultTools()` wraps each
 * eligible tool with this helper so the rest of the system is oblivious.
 */
export function wrapWithRustFallback(tsTool: Tool): Tool {
  const toolName = tsTool.definition.name;

  return {
    definition: tsTool.definition,

    async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
      if (shouldUseRust(toolName)) {
        const result = await executeViaNative(toolName, input, context.workspaceRoot);
        // If the native call itself errored out (not a tool-level error, but a
        // bridge/FFI error), fall back to TS.
        if (!result.ok && result.error?.startsWith("Native execution error:")) {
          context.logger?.warn(`Rust bridge error for ${toolName}, falling back to TS: ${result.error}`);
          return tsTool.execute(input, context);
        }
        return result;
      }

      return tsTool.execute(input, context);
    },
  };
}

/**
 * Report bridge diagnostic info (for logging / status UI).
 */
export function getRustBridgeStatus(): {
  nativeLoaded: boolean;
  enabled: boolean;
  enabledTools: string[];
} {
  return {
    nativeLoaded: nativeModule !== null,
    enabled: bridgeConfig.enabled,
    enabledTools: [...bridgeConfig.enabledTools],
  };
}
