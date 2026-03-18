import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonObject, McpSettings, McpToolCallResult } from "../core/types";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
}

interface ToolsListResult {
  tools?: unknown;
  nextCursor?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export interface McpListedTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private nextId = 1;
  private readBuffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private stderrChunks: string[] = [];

  constructor(private readonly settings: McpSettings) { }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.settings.command.trim()) {
      throw new Error("MCP command is empty. Configure mcp.command in agent.config.json.");
    }

    // On Windows, always use shell so that .cmd/.bat wrappers (npx, uvx, etc.)
    // and PATH resolution work correctly inside Electron's child_process.spawn.
    const useShell = process.platform === "win32";
    this.process = spawn(this.settings.command, this.settings.args, {
      stdio: "pipe",
      shell: useShell,
      env: {
        ...process.env,
        // Force non-interactive mode for npx/npm so they never show
        // "Ok to proceed? (y)" prompts, which would stall the child process
        // indefinitely when spawned without a real terminal (tty).
        // CI=1 is the standard signal understood by npm, npx, and most CLIs.
        CI: "1",
        NPM_CONFIG_YES: "true",
        // Allow user-defined env overrides to take effect on top.
        ...this.settings.env
      },
      // Prevent the child window from appearing on Windows
      windowsHide: true
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      // Capture stderr for diagnostics.
      const text = chunk.toString("utf8");
      this.stderrChunks.push(text);
      // Cap to 50 chunks to avoid unbounded memory growth.
      if (this.stderrChunks.length > 50) {
        this.stderrChunks.shift();
      }
    });
    this.process.on("error", (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      this.started = false;
      this.process = null;
    });
    this.process.on("exit", () => {
      const error = new Error("MCP process exited.");
      this.rejectAllPending(error);
      this.started = false;
      this.process = null;
    });

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "tuanzi",
          version: "0.2.0"
        }
      },
      this.settings.startupTimeoutMs
    );

    this.notify("notifications/initialized", {});
    this.started = true;
  }

  async callTool(toolName: string, args: JsonObject, options?: { signal?: AbortSignal }): Promise<McpToolCallResult> {
    if (!this.started) {
      await this.start();
    }

    const result = await this.request(
      "tools/call",
      {
        name: toolName,
        arguments: args
      },
      this.settings.requestTimeoutMs,
      options
    );

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("MCP tools/call response is invalid.");
    }
    return result as McpToolCallResult;
  }

  async listTools(): Promise<McpListedTool[]> {
    if (!this.started) {
      await this.start();
    }

    const output: McpListedTool[] = [];
    let cursor: string | undefined;
    while (true) {
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        this.settings.requestTimeoutMs
      )) as ToolsListResult;

      if (!result || typeof result !== "object" || Array.isArray(result)) {
        break;
      }
      const tools = normalizeTools((result as ToolsListResult).tools);
      output.push(...tools);

      const nextCursorRaw = (result as ToolsListResult).nextCursor;
      const nextCursor = typeof nextCursorRaw === "string" ? nextCursorRaw.trim() : "";
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return output;
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      return;
    }
    this.process = null;
    this.started = false;
    this.rejectAllPending(new Error("MCP client stopped."));

    // Close stdin to signal the child process to exit.
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
    } catch { /* ignore */ }

    // Remove data listeners to prevent further processing after stop.
    proc.stdout.removeAllListeners("data");
    proc.stderr.removeAllListeners("data");

    const exitPromise = new Promise<void>((resolve) => {
      const onExit = (): void => {
        proc.removeListener("exit", onExit);
        proc.removeListener("error", onExit);
        resolve();
      };
      proc.on("exit", onExit);
      proc.on("error", onExit);
    });

    // Fire and forget the kill signals. No more awaiting for OS exit events.
    if (process.platform === "win32" && proc.pid) {
      const { exec } = require("node:child_process") as typeof import("node:child_process");
      // Execute taskkill without waiting for its callback.
      exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true });
    } else {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }

    // Resolve immediately. We've done our part by signaling the OS.
    return Promise.resolve();
  }

  private onStdoutData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    while (true) {
      const framedPayload = this.tryReadFramedPayload();
      if (framedPayload === undefined) {
        return;
      }
      if (framedPayload !== null) {
        this.handleRpcPayload(framedPayload);
        continue;
      }

      const linePayload = this.tryReadLinePayload();
      if (linePayload === undefined) {
        return;
      }
      if (linePayload === null) {
        continue;
      }
      this.handleRpcPayload(linePayload);
    }
  }

  private tryReadFramedPayload(): JsonRpcResponse | null | undefined {
    const header = readFrameHeader(this.readBuffer);
    if (!header) {
      return looksLikeFrameHeaderPrefix(this.readBuffer) ? undefined : null;
    }
    if (this.readBuffer.length < header.bodyStart + header.contentLength) {
      return undefined;
    }

    const bodyBytes = this.readBuffer.slice(header.bodyStart, header.bodyStart + header.contentLength);
    this.readBuffer = this.readBuffer.slice(header.bodyStart + header.contentLength);
    const bodyText = bodyBytes.toString("utf8").trim();
    if (!bodyText) {
      return null;
    }
    try {
      return JSON.parse(bodyText) as JsonRpcResponse;
    } catch {
      return null;
    }
  }

  private tryReadLinePayload(): JsonRpcResponse | null | undefined {
    const newlineIdx = this.readBuffer.indexOf("\n");
    if (newlineIdx < 0) {
      return undefined;
    }

    const lineBytes = this.readBuffer.slice(0, newlineIdx);
    this.readBuffer = this.readBuffer.slice(newlineIdx + 1);

    const line = lineBytes.toString("utf8").trim();
    if (!line) {
      return null;
    }

    try {
      return JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Skip non-JSON lines (e.g. startup banner written by some servers).
      return null;
    }
  }

  private handleRpcPayload(payload: JsonRpcResponse): void {
    if (typeof payload.id !== "number") {
      return;
    }
    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }
    this.pending.delete(payload.id);

    if (payload.error) {
      pending.reject(new Error(`MCP error ${payload.error.code}: ${payload.error.message}`));
      return;
    }
    pending.resolve(payload.result);
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    options?: { signal?: AbortSignal }
  ): Promise<unknown> {
    if (!this.process) {
      throw new Error("MCP process is not running.");
    }

    if (options?.signal?.aborted) {
      throw new Error(`MCP request aborted by user: ${method}`);
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0" as const,
      id,
      method,
      params
    };

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(id);
        cleanup();
        reject(new Error(`MCP request aborted by user: ${method}`));
      };

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(id);
        cleanup();
        const stderrTail = this.stderrChunks.slice(-5).join("").trim();
        const hint = stderrTail
          ? ` | stderr: ${stderrTail.slice(0, 500)}`
          : "";
        reject(new Error(`MCP request timed out: ${method} (waited ${timeoutMs}ms)${hint}`));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      if (options?.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (value) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        },
        cleanup
      });

      try {
        this.writeFrame(payload);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const payload = {
      jsonrpc: "2.0" as const,
      method,
      params
    };
    this.writeFrame(payload);
  }

  private writeFrame(message: unknown): void {
    if (!this.process) {
      throw new Error("MCP process is not running.");
    }
    const body = JSON.stringify(message);
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    this.process.stdin.write(frame, "utf8");
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }
}

function readFrameHeader(buffer: Buffer): { bodyStart: number; contentLength: number } | null {
  const delimiter = findHeaderDelimiter(buffer);
  if (!delimiter) {
    return null;
  }

  const headerText = buffer.slice(0, delimiter.end).toString("utf8");
  const match = headerText.match(/content-length\s*:\s*(\d+)/i);
  if (!match) {
    return null;
  }
  const contentLength = Number.parseInt(match[1], 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return null;
  }
  return {
    bodyStart: delimiter.bodyStart,
    contentLength
  };
}

function findHeaderDelimiter(buffer: Buffer): { end: number; bodyStart: number } | null {
  const crlfCrlf = buffer.indexOf("\r\n\r\n");
  if (crlfCrlf >= 0) {
    return { end: crlfCrlf, bodyStart: crlfCrlf + 4 };
  }
  const lfLf = buffer.indexOf("\n\n");
  if (lfLf >= 0) {
    return { end: lfLf, bodyStart: lfLf + 2 };
  }
  return null;
}

function looksLikeFrameHeaderPrefix(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  const sample = buffer.slice(0, Math.min(buffer.length, 64)).toString("utf8").toLowerCase();
  return sample.startsWith("content-length") || sample.startsWith("content-type");
}

function normalizeTools(input: unknown): McpListedTool[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const tools: McpListedTool[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      continue;
    }
    const description = typeof record.description === "string" ? record.description : "";
    const inputSchema = toJsonObject(record.inputSchema);
    tools.push({
      name,
      description,
      inputSchema
    });
  }
  return tools;
}

function toJsonObject(input: unknown): JsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true
    };
  }
  return input as JsonObject;
}
