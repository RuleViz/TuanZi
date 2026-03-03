import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import figlet from "figlet";
import gradient from "gradient-string";
import type {
  ConversationMemoryTurn,
  OrchestrationResult,
  OrchestratorPhase
} from "../agents/orchestrator";
import { loadRuntimeConfig } from "../config";
import type { ApprovalMode } from "../core/approval-gate";
import {
  findCustomModelConfig,
  getCustomModelStorePath,
  loadCustomModelStore,
  saveCustomModelStore,
  type CustomModelConfig
} from "../core/custom-model-store";
import { assertInsideWorkspace, relativeFromWorkspace } from "../core/path-utils";
import type { Logger, ToolCallRecord, ToolExecutionResult } from "../core/types";
import { createOrchestrator, createToolRuntime } from "../runtime";
import { parseSlashCommand, type SlashCommand } from "./slash-commands";
import { ChatSessionStore } from "./session-store";

function getCharWidth(codePoint: number): number {
  if (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x2000 && codePoint <= 0x206f) ||
    codePoint > 0xffff
  ) {
    return 2;
  }
  return 1;
}

function getStringVisibleWidth(str: string): number {
  let w = 0;
  for (const char of str) {
    const cp = char.codePointAt(0);
    w += cp ? getCharWidth(cp) : 1;
  }
  return w;
}

const PROJECT_CONTEXT_FILE = "TUANZI.md";
const PROJECT_CONTEXT_MAX_CHARS = 12_000;
const RUN_COMMAND_OUTPUT_PREVIEW_CHARS = 1_200;
const WELCOME_BANNER_TEXT = "TUANZI";
const WELCOME_BANNER_FONT = "ANSI Shadow";
const WELCOME_BANNER_COLORS = ["#555555", "#ffffff", "#aaaaaa"] as const;

export interface InteractiveChatOptions {
  workspaceRoot: string;
  approvalMode: ApprovalMode;
  modelOverride?: string | null;
}

interface SessionTurn {
  id: string;
  userMessage: string;
  assistantMessage: string;
  toolCalls: ToolCallRecord[];
  createdAt: string;
}

interface UsageStats {
  inputChars: number;
  outputChars: number;
  toolCalls: number;
}

interface RuntimePair {
  runtimeConfig: ReturnType<typeof loadRuntimeConfig>;
  runtime: ReturnType<typeof createToolRuntime>;
}

export async function startInteractiveChat(options: InteractiveChatOptions): Promise<number> {
  if (!input.isTTY || !output.isTTY) {
    console.error("交互模式需要 TTY 终端。");
    return 1;
  }

  const session = new InteractiveChatSession(options);
  return session.run();
}

class InteractiveChatSession {
  private readonly workspaceRoot: string;
  private readonly approvalMode: ApprovalMode;
  private modelOverride: string | null;
  private readonly history: SessionTurn[] = [];
  private readonly usage: UsageStats = {
    inputChars: 0,
    outputChars: 0,
    toolCalls: 0
  };
  private runningTask = false;
  private exitRequested = false;
  private lastSigintAt = 0;
  private activePromptAbort: (() => void) | null = null;
  private readonly promptHistory: string[] = [];
  private projectContextMissingNotified = false;
  private projectContextErrorNotified = false;
  private readonly sessionStore: ChatSessionStore;

  constructor(options: InteractiveChatOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.approvalMode = options.approvalMode;
    this.modelOverride = normalizeModelName(options.modelOverride ?? null);
    this.sessionStore = new ChatSessionStore(this.workspaceRoot);
  }

  async run(): Promise<number> {
    this.attachSigintHandler();
    try {
      await this.printWelcome();

      while (!this.exitRequested) {
        const line = await this.promptMultiline("你 > ");
        if (this.exitRequested) {
          break;
        }
        const userInput = line.trim();
        if (!userInput) {
          continue;
        }

        const slash = parseSlashCommand(userInput);
        if (slash) {
          const shouldExit = await this.handleSlashCommand(slash);
          if (shouldExit) {
            break;
          }
          continue;
        }

        if (userInput.startsWith("!")) {
          await this.handleBangCommand(userInput.slice(1));
          continue;
        }

        await this.handleUserTask(userInput);
      }
    } finally {
      process.off("SIGINT", this.onSigint);
      this.activePromptAbort?.();
      this.activePromptAbort = null;
    }

    console.log("已退出交互模式。");
    return 0;
  }

  private attachSigintHandler(): void {
    process.on("SIGINT", this.onSigint);
  }

  private readonly onSigint = (): void => {
    const now = Date.now();
    const isDoublePress = now - this.lastSigintAt < 1500;
    this.lastSigintAt = now;

    if (this.runningTask) {
      if (isDoublePress) {
        this.exitRequested = true;
        console.log("\n将在当前任务结束后退出。");
      } else {
        console.log("\n当前任务执行中。再次按 Ctrl+C 将在任务结束后退出。");
      }
      return;
    }

    if (isDoublePress) {
      this.exitRequested = true;
      this.activePromptAbort?.();
      this.activePromptAbort = null;
      return;
    }

    console.log("\n再按一次 Ctrl+C 退出。");
  };

  private async printWelcome(): Promise<void> {
    const { runtimeConfig, runtime } = this.createRuntime();
    const contextInfo = await this.detectProjectContextMeta();
    const modelDisplay = this.currentModelDisplay(runtimeConfig);

    printWelcomeBanner();

    const dim = "\x1b[38;2;120;120;120m";
    const reset = "\x1b[0m";

    console.log(`${dim}工作区: ${runtimeConfig.workspaceRoot}`);
    console.log(`模型: ${modelDisplay}`);
    console.log(`上下文: ${contextInfo ? `${PROJECT_CONTEXT_FILE} (${formatSize(contextInfo.size)})` : `未找到 ${PROJECT_CONTEXT_FILE}`}`);
    console.log(`提示: 输入 /help 获取帮助，行尾添加 \\ 多行输入${reset}\n`);
  }

  private async detectProjectContextMeta(): Promise<{ size: number } | null> {
    const filePath = path.join(this.workspaceRoot, PROJECT_CONTEXT_FILE);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return null;
      }
      return { size: stat.size };
    } catch {
      return null;
    }
  }

  private currentModelDisplay(runtimeConfig: ReturnType<typeof loadRuntimeConfig>): string {
    const planner = runtimeConfig.model.plannerModel ?? "<unset>";
    const search = runtimeConfig.model.searchModel ?? "<unset>";
    const coder = runtimeConfig.model.coderModel ?? "<unset>";
    if (planner === search && search === coder) {
      return planner;
    }
    return `planner=${planner} search=${search} coder=${coder}`;
  }

  private async promptMultiline(question: string): Promise<string> {
    const lines: string[] = [];

    const borderStyle = "\x1b[38;2;85;95;110m";
    const reset = "\x1b[0m";

    let promptLabel = `> `;
    let initialValue = "";

    const erasePreviousLine = (prevLine: string) => {
      const cols = (output as NodeJS.WriteStream).columns || 80;
      const textWidth = Math.max(1, cols - 3);
      const chars = prevLine.length + 1;
      const prevChunks = Math.max(1, Math.ceil(chars / textWidth));
      output.write(`\x1b[${prevChunks}A\r\x1b[J`);
    };

    while (true) {
      if (lines.length === 0) {
        const boxWidth = (output as NodeJS.WriteStream).columns || 80;
        output.write(`${borderStyle}${'─'.repeat(boxWidth)}${reset}\n`);
      }

      const lineResult = await this.promptLine(promptLabel, {
        allowBack: lines.length > 0,
        initialValue: initialValue
      });
      initialValue = "";

      if (this.exitRequested) {
        const boxWidth = (output as NodeJS.WriteStream).columns || 80;
        output.write(`${borderStyle}${'─'.repeat(boxWidth)}${reset}\n`);
        return "";
      }

      if (lineResult.back) {
        const prevLine = lines.pop() ?? "";

        erasePreviousLine(prevLine);

        initialValue = prevLine + "\\";

        if (lines.length === 0) {
          output.write(`\x1b[1A\r\x1b[J`);
          promptLabel = `> `;
        } else {
          promptLabel = `  `;
        }
        continue;
      }

      const line = lineResult.value;

      if (isContinuationLine(line)) {
        lines.push(stripContinuationMarker(line));
        promptLabel = `  `;
        continue;
      }
      lines.push(line);
      break;
    }

    const boxWidth = (output as NodeJS.WriteStream).columns || 80;
    output.write(`${borderStyle}${'─'.repeat(boxWidth)}${reset}\n`);

    const merged = lines.join("\n");
    this.rememberPromptHistory(merged);
    return merged;
  }

  private rememberPromptHistory(entry: string): void {
    const trimmed = entry.trim();
    if (!trimmed) {
      return;
    }
    // 将多输入的换行替换为空格，避免多行历史调出时破坏终端原始的 redraw 单行渲染逻辑
    const singleLine = trimmed.replace(/\r?\n/g, "  ");
    if (this.promptHistory[this.promptHistory.length - 1] === singleLine) {
      return;
    }
    this.promptHistory.push(singleLine);
    if (this.promptHistory.length > 50) {
      this.promptHistory.splice(0, this.promptHistory.length - 50);
    }
  }

  private async promptLine(
    question: string,
    options?: { allowBack?: boolean; initialValue?: string }
  ): Promise<{ value: string; back?: boolean }> {
    if (!input.isTTY || !output.isTTY) {
      return { value: "" };
    }

    const ttyInput = input as NodeJS.ReadStream;
    const supportsRaw = typeof ttyInput.setRawMode === "function";
    const previousRawMode = supportsRaw ? ttyInput.isRaw : false;
    readline.emitKeypressEvents(ttyInput);
    if (supportsRaw && !previousRawMode) {
      ttyInput.setRawMode(true);
    }

    let line = options?.initialValue ?? "";
    let cursor = line.length;
    let historyIndex = this.promptHistory.length;
    let finished = false;
    let lastCursorRow = 0;

    return await new Promise<{ value: string; back?: boolean }>((resolve) => {
      const restoreInputMode = (): void => {
        if (supportsRaw && !previousRawMode) {
          ttyInput.setRawMode(false);
        }
        ttyInput.pause();
      };

      ttyInput.resume();

      const cleanup = (): void => {
        ttyInput.off("keypress", onKeypress);
        this.activePromptAbort = null;
        restoreInputMode();
      };

      const finalize = (result: { value: string; back?: boolean }): void => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();

        if (lastCursorRow > 0) {
          output.write(`\x1b[${lastCursorRow}A`);
        }
        output.write("\r\x1b[J");

        if (!result.back) {
          const cols = (output as NodeJS.WriteStream).columns || 80;
          const questionLen = getStringVisibleWidth(question.replace(/\x1b\[[0-9;]*m/g, ""));
          const textWidth = Math.max(1, cols - questionLen - 1);

          const chunks: string[] = [];
          let currentChunk = "";
          let currentWidth = 0;

          for (const char of line) {
            const cp = char.codePointAt(0) || 0;
            const w = getCharWidth(cp);

            if (currentWidth + w > textWidth) {
              chunks.push(currentChunk);
              currentChunk = char;
              currentWidth = w;
            } else {
              currentChunk += char;
              currentWidth += w;
            }
          }
          if (currentChunk.length > 0) {
            chunks.push(currentChunk);
          }
          if (chunks.length === 0) chunks.push("");

          output.write(question + chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            output.write("\n" + " ".repeat(questionLen) + chunks[i]);
          }
          output.write("\n");
        }
        resolve(result);
      };

      const redraw = (): void => {
        const cols = (output as NodeJS.WriteStream).columns || 80;
        const boxWidth = cols;
        const borderStyle = "\x1b[38;2;85;95;110m";
        const reset = "\x1b[0m";

        const questionLen = getStringVisibleWidth(question.replace(/\x1b\[[0-9;]*m/g, ""));
        const textWidth = Math.max(1, cols - questionLen - 1);

        const chunks: string[] = [];
        let currentChunk = "";
        let currentWidth = 0;
        let cursorChunk = 0;
        let cursorColInChunk = 0;

        let charIdx = 0;
        let foundCursor = false;

        for (const char of line) {
          if (!foundCursor && charIdx >= cursor) {
            cursorChunk = chunks.length;
            cursorColInChunk = currentWidth;
            foundCursor = true;
          }

          const cp = char.codePointAt(0) || 0;
          const w = getCharWidth(cp);

          if (currentWidth + w > textWidth) {
            chunks.push(currentChunk);
            currentChunk = char;
            currentWidth = w;
          } else {
            currentChunk += char;
            currentWidth += w;
          }
          charIdx += char.length;
        }

        if (!foundCursor) {
          cursorChunk = chunks.length;
          cursorColInChunk = currentWidth;
        }

        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }
        if (chunks.length === 0) chunks.push("");

        while (chunks.length <= cursorChunk) {
          chunks.push("");
        }

        if (lastCursorRow > 0) {
          output.write(`\x1b[${lastCursorRow}A`);
        }
        output.write("\r\x1b[J");

        output.write(question + chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          output.write("\n" + " ".repeat(questionLen) + chunks[i]);
        }

        const bottomBorder = `${borderStyle}${'─'.repeat(boxWidth)}${reset}`;
        output.write(`\n${bottomBorder}`);

        const moveUp = chunks.length - cursorChunk;
        if (moveUp > 0) {
          output.write(`\x1b[${moveUp}A`);
        }
        output.write("\r");

        const targetCol = questionLen + cursorColInChunk;
        if (targetCol > 0) {
          output.write(`\x1b[${targetCol}C`);
        }

        lastCursorRow = cursorChunk;
      };

      const setFromHistory = (value: string): void => {
        line = value;
        cursor = line.length;
        redraw();
      };

      this.activePromptAbort = () => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        output.write("\n");
        resolve({ value: "" });
      };

      const onKeypress = (chunk: string, key: readline.Key): void => {
        if (finished) {
          return;
        }
        const name = key?.name ?? "";
        if (name === "return" || name === "enter") {
          finalize({ value: line });
          return;
        }

        if (key?.ctrl && name === "c") {
          this.onSigint();
          if (this.exitRequested) {
            finalize({ value: "" });
            return;
          }
          redraw();
          return;
        }

        if (key?.ctrl && name === "l") {
          console.clear();
          redraw();
          return;
        }

        if (name === "escape") {
          line = "";
          cursor = 0;
          historyIndex = this.promptHistory.length;
          redraw();
          return;
        }

        if (name === "backspace") {
          if (cursor <= 0) {
            if (options?.allowBack && line.length === 0) {
              finalize({ value: "", back: true });
            }
            return;
          }
          let step = 1;
          if (cursor >= 2 && line.codePointAt(cursor - 2)! > 0xffff) step = 2;
          line = `${line.slice(0, cursor - step)}${line.slice(cursor)}`;
          cursor -= step;
          redraw();
          return;
        }

        if (name === "delete") {
          if (cursor >= line.length) {
            return;
          }
          const cp = line.codePointAt(cursor);
          const step = (cp && cp > 0xffff) ? 2 : 1;
          line = `${line.slice(0, cursor)}${line.slice(cursor + step)}`;
          redraw();
          return;
        }

        if (name === "left") {
          if (cursor > 0) {
            // Find previous character length (1 or 2 code units)
            let step = 1;
            if (cursor >= 2 && line.codePointAt(cursor - 2)! > 0xffff) step = 2;
            cursor = Math.max(0, cursor - step);
            redraw();
          }
          return;
        }

        if (name === "right") {
          if (cursor < line.length) {
            const cp = line.codePointAt(cursor);
            const step = (cp && cp > 0xffff) ? 2 : 1;
            cursor = Math.min(line.length, cursor + step);
            redraw();
          }
          return;
        }

        if (name === "home") {
          if (cursor > 0) {
            cursor = 0;
            redraw();
          }
          return;
        }

        if (name === "end") {
          if (cursor < line.length) {
            cursor = line.length;
            redraw();
          }
          return;
        }

        if (name === "up") {
          if (this.promptHistory.length === 0) {
            return;
          }
          historyIndex = Math.max(0, historyIndex - 1);
          setFromHistory(this.promptHistory[historyIndex] ?? "");
          return;
        }

        if (name === "down") {
          if (this.promptHistory.length === 0) {
            return;
          }
          historyIndex = Math.min(this.promptHistory.length, historyIndex + 1);
          if (historyIndex >= this.promptHistory.length) {
            setFromHistory("");
          } else {
            setFromHistory(this.promptHistory[historyIndex] ?? "");
          }
          return;
        }

        if (!chunk || key?.ctrl || key?.meta) {
          return;
        }

        line = `${line.slice(0, cursor)}${chunk}${line.slice(cursor)}`;
        cursor += chunk.length;
        redraw();
      };

      redraw();
      ttyInput.on("keypress", onKeypress);
    });
  }

  private async handleSlashCommand(command: SlashCommand): Promise<boolean> {
    switch (command.name) {
      case "help":
        this.printSlashHelp();
        return false;
      case "clear":
        this.history.length = 0;
        console.clear();
        console.log("已清空对话历史。");
        return false;
      case "compact":
        this.compactHistory();
        return false;
      case "model":
        await this.handleModelCommand(command.args);
        return false;
      case "tools":
        this.handleToolsCommand();
        return false;
      case "config":
        this.handleConfigCommand();
        return false;
      case "cost":
        this.handleCostCommand();
        return false;
      case "checkpoint":
        await this.handleCheckpointCommand(command.args);
        return false;
      case "exit":
      case "quit":
        return true;
      default:
        console.log(`未知命令: /${command.name}，输入 /help 查看帮助。`);
        return false;
    }
  }

  private printSlashHelp(): void {
    console.log(
      [
        "可用命令:",
        "  /help                         显示帮助",
        "  /clear                        清空对话历史",
        "  /compact                      压缩历史（仅保留最近 4 轮）",
        "  /model                        查看当前模型与模型仓库状态",
        "  /model list                   列出已保存模型别名",
        "  /model add [name baseUrl modelId apiKey]  添加或更新模型",
        "  /model use <name>             设为全局默认并立即应用到当前会话",
        "  /model rm <name>              删除模型别名",
        "  /checkpoint save [name]       保存会话检查点",
        "  /checkpoint load <name>       加载会话检查点",
        "  /checkpoint list              列出会话检查点",
        "  /checkpoint drop <name>       删除会话检查点",
        "  /checkpoint git <action>      执行 git checkpoint 工具(create/list/diff/restore/drop)",
        "  /tools                        列出可用工具",
        "  /config                       显示当前配置",
        "  /cost                         显示会话用量估算",
        "  /exit                         退出交互模式",
        "  !<command>                    直接执行终端命令",
        "  @<path>                       在输入中引用工作区文件",
        "  行尾 \\                        继续输入下一行（多行输入）",
        "  Esc                           清空当前输入草稿",
        "  Ctrl+L                        清屏并保留当前输入"
      ].join("\n")
    );
  }

  private compactHistory(): void {
    const keep = 4;
    if (this.history.length <= keep) {
      console.log("历史较短，无需压缩。");
      return;
    }
    this.history.splice(0, this.history.length - keep);
    console.log(`已压缩历史，保留最近 ${keep} 轮对话。`);
  }

  private async handleModelCommand(args: string[]): Promise<void> {
    try {
      if (args.length === 0) {
        this.printModelSummary();
        return;
      }

      const action = (args[0] ?? "").toLowerCase();
      if (action === "list") {
        this.printCustomModelList();
        return;
      }
      if (action === "add") {
        await this.handleModelAddCommand(args.slice(1));
        return;
      }
      if (action === "use") {
        await this.handleModelUseCommand(args[1]);
        return;
      }
      if (action === "rm" || action === "remove" || action === "delete") {
        await this.handleModelRemoveCommand(args[1]);
        return;
      }

      if (args.length === 1) {
        // Backward-compatible shortcut.
        await this.handleModelUseCommand(args[0]);
        return;
      }

      console.log("用法: /model [list|add|use|rm]");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`model 操作失败: ${message}`);
    }
  }

  private printModelSummary(): void {
    const { runtimeConfig } = this.createRuntime();
    const store = loadCustomModelStore();
    const activeAlias = this.modelOverride ?? store.defaultModel;
    const activeModel = findCustomModelConfig(store, activeAlias);
    console.log(`当前模型: ${this.currentModelDisplay(runtimeConfig)}`);
    console.log(`模型仓库: ${getCustomModelStorePath()}`);
    console.log(`全局默认别名: ${store.defaultModel || "<unset>"}`);
    console.log(`会话覆盖别名: ${this.modelOverride || "<none>"}`);
    if (activeModel) {
      console.log(`当前别名配置: ${activeModel.name} (${activeModel.baseUrl}) -> ${activeModel.modelId}`);
    }
  }

  private printCustomModelList(): void {
    const store = loadCustomModelStore();
    const activeAlias = this.modelOverride ?? store.defaultModel;
    if (store.models.length === 0) {
      console.log("模型库为空。可用 /model add 添加。");
      return;
    }
    console.log("TuanZi 模型库:");
    for (const model of store.models) {
      const marker = activeAlias && model.name.toLowerCase() === activeAlias.toLowerCase() ? "*" : " ";
      console.log(`${marker} - ${model.name} (${model.baseUrl}) -> ${model.modelId}`);
    }
  }

  private async handleModelAddCommand(args: string[]): Promise<void> {
    let rawName = args[0] ?? "";
    let rawBaseUrl = args[1] ?? "";
    let rawModelId = args[2] ?? "";
    let rawApiKey = args[3] ?? "";

    if (args.length === 0) {
      const prompted = await this.promptCustomModelConfig();
      if (!prompted) {
        return;
      }
      rawName = prompted.name;
      rawBaseUrl = prompted.baseUrl;
      rawModelId = prompted.modelId;
      rawApiKey = prompted.apiKey;
    } else if (args.length < 4) {
      console.log("用法: /model add <name> <baseUrl> <modelId> <apiKey>");
      return;
    }

    const normalized = normalizeCustomModelInput({
      name: rawName,
      baseUrl: rawBaseUrl,
      modelId: rawModelId,
      apiKey: rawApiKey
    });
    if (!normalized.ok) {
      console.log(normalized.error);
      return;
    }

    const store = loadCustomModelStore();
    const next = normalized.model;
    const foundIndex = store.models.findIndex((item) => item.name.toLowerCase() === next.name.toLowerCase());
    if (foundIndex >= 0) {
      store.models[foundIndex] = next;
    } else {
      store.models.push(next);
    }
    if (!store.defaultModel) {
      store.defaultModel = next.name;
    }

    await saveCustomModelStore(store);
    if (foundIndex >= 0) {
      console.log(`已更新模型 [${next.name}]。`);
    } else {
      console.log(`已添加并保存新模型 [${next.name}]。`);
    }
  }

  private async promptCustomModelConfig(): Promise<CustomModelConfig | null> {
    const nameResult = await this.promptLine("model name > ");
    if (this.exitRequested) {
      return null;
    }
    const baseUrlResult = await this.promptLine("base url > ");
    if (this.exitRequested) {
      return null;
    }
    const modelIdResult = await this.promptLine("model id > ");
    if (this.exitRequested) {
      return null;
    }
    const apiKeyResult = await this.promptLine("api key (or none) > ");
    if (this.exitRequested) {
      return null;
    }

    const normalized = normalizeCustomModelInput({
      name: nameResult.value,
      baseUrl: baseUrlResult.value,
      modelId: modelIdResult.value,
      apiKey: apiKeyResult.value
    });
    if (!normalized.ok) {
      console.log(normalized.error);
      return null;
    }
    return normalized.model;
  }

  private async handleModelUseCommand(nameArg: string | undefined): Promise<void> {
    const name = normalizeModelName(nameArg ?? null);
    if (!name) {
      console.log("用法: /model use <name>");
      return;
    }

    const store = loadCustomModelStore();
    const target = findCustomModelConfig(store, name);
    if (!target) {
      console.log(`模型别名不存在: ${name}`);
      return;
    }
    store.defaultModel = target.name;
    await saveCustomModelStore(store);

    this.modelOverride = target.name;
    console.log(`已切换默认模型为: ${target.name}`);
  }

  private async handleModelRemoveCommand(nameArg: string | undefined): Promise<void> {
    const name = normalizeModelName(nameArg ?? null);
    if (!name) {
      console.log("用法: /model rm <name>");
      return;
    }

    const store = loadCustomModelStore();
    const index = store.models.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
    if (index < 0) {
      console.log(`模型别名不存在: ${name}`);
      return;
    }

    const removed = store.models.splice(index, 1)[0];
    if (store.defaultModel && store.defaultModel.toLowerCase() === removed.name.toLowerCase()) {
      store.defaultModel = store.models[0]?.name ?? "";
    }
    await saveCustomModelStore(store);

    if (this.modelOverride && this.modelOverride.toLowerCase() === removed.name.toLowerCase()) {
      this.modelOverride = null;
    }
    console.log(`已删除模型 [${removed.name}]。`);
  }

  private handleToolsCommand(): void {
    const { runtime } = this.createRuntime();
    const names = runtime.registry.getToolNames();
    console.log(`可用工具 (${names.length}):`);
    for (const name of names) {
      console.log(`  - ${name}`);
    }
  }

  private handleConfigCommand(): void {
    const { runtimeConfig } = this.createRuntime();
    console.log(JSON.stringify(runtimeConfig, null, 2));
  }

  private handleCostCommand(): void {
    const inputTokens = estimateTokens(this.usage.inputChars);
    const outputTokens = estimateTokens(this.usage.outputChars);
    const totalTokens = inputTokens + outputTokens;

    console.log("本会话统计:");
    console.log(`  输入 Tokens(估算): ${inputTokens}`);
    console.log(`  输出 Tokens(估算): ${outputTokens}`);
    console.log(`  总 Tokens(估算): ${totalTokens}`);
    console.log(`  工具调用: ${this.usage.toolCalls}`);
    console.log("  费用估算: 未配置单价，暂不显示金额。");
  }

  private async handleCheckpointCommand(args: string[]): Promise<void> {
    try {
      const action = (args[0] ?? "list").toLowerCase();
      if (action === "git") {
        await this.handleGitCheckpointCommand(args.slice(1));
        return;
      }

      if (action === "save") {
        const name = args[1];
        const saved = await this.sessionStore.save(
          {
            workspaceRoot: this.workspaceRoot,
            modelOverride: this.modelOverride,
            history: this.history,
            usage: this.usage
          },
          name
        );
        console.log(`已保存会话检查点: ${saved.name}`);
        return;
      }

      if (action === "load") {
        const name = (args[1] ?? "").trim();
        if (!name) {
          console.log("用法: /checkpoint load <name>");
          return;
        }
        const loaded = await this.sessionStore.load(name);
        this.history.length = 0;
        this.history.push(...loaded.history);
        this.usage.inputChars = loaded.usage.inputChars;
        this.usage.outputChars = loaded.usage.outputChars;
        this.usage.toolCalls = loaded.usage.toolCalls;
        this.modelOverride = normalizeModelName(loaded.modelOverride);
        console.log(`已加载会话检查点: ${loaded.name} (${loaded.history.length} 轮)`);
        return;
      }

      if (action === "list") {
        const list = await this.sessionStore.list();
        if (list.length === 0) {
          console.log("暂无会话检查点。");
          return;
        }
        console.log("会话检查点:");
        for (const item of list) {
          console.log(`  - ${item.name} (${item.createdAt})`);
        }
        return;
      }

      if (action === "drop") {
        const name = (args[1] ?? "").trim();
        if (!name) {
          console.log("用法: /checkpoint drop <name>");
          return;
        }
        await this.sessionStore.drop(name);
        console.log(`已删除会话检查点: ${name}`);
        return;
      }

      if (action === "create" || action === "restore" || action === "diff") {
        console.log("提示: 这些动作现在属于 git checkpoint，请使用 `/checkpoint git ...`。");
        await this.handleGitCheckpointCommand(args);
        return;
      }

      console.log("用法: /checkpoint save|load|list|drop 或 /checkpoint git <action>");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`checkpoint 操作失败: ${message}`);
    }
  }

  private async handleGitCheckpointCommand(args: string[]): Promise<void> {
    const action = (args[0] ?? "list").toLowerCase();
    let toolInput: Record<string, unknown>;
    if (action === "create" || action === "save") {
      toolInput = {
        action: "create",
        label: args.slice(1).join(" ").trim() || `chat-${Date.now()}`
      };
    } else if (action === "restore" || action === "load") {
      toolInput = {
        action: "restore",
        index: parseCheckpointIndex(args[1])
      };
    } else if (action === "list") {
      toolInput = { action: "list" };
    } else if (action === "diff") {
      toolInput = {
        action: "diff",
        index: parseCheckpointIndex(args[1])
      };
    } else if (action === "drop") {
      toolInput = {
        action: "drop",
        index: parseCheckpointIndex(args[1])
      };
    } else {
      console.log("用法: /checkpoint git create|restore|list|diff|drop [index|label]");
      return;
    }
    const { runtime } = this.createRuntime();
    const result = await runtime.registry.execute("checkpoint", toolInput, runtime.toolContext);
    renderToolCard({
      toolName: "checkpoint",
      args: toolInput,
      result,
      timestamp: new Date().toISOString()
    });
  }

  private async handleBangCommand(command: string): Promise<void> {
    const trimmed = command.trim();
    if (!trimmed) {
      console.log("用法: !<command>");
      return;
    }
    try {
      const { runtime } = this.createRuntime();
      const result = await runtime.registry.execute(
        "run_command",
        {
          command: trimmed,
          cwd: this.workspaceRoot,
          max_output_chars: 4000
        },
        runtime.toolContext
      );
      renderToolCard({
        toolName: "run_command",
        args: { command: trimmed, cwd: this.workspaceRoot },
        result,
        timestamp: new Date().toISOString()
      });
      printRunCommandOutput(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`命令执行失败: ${message}`);
    }
  }

  private async handleUserTask(userMessage: string): Promise<void> {
    this.runningTask = true;
    this.usage.inputChars += userMessage.length;

    const { runtimeConfig, runtime } = this.createRuntime();
    const preparedTask = await this.attachReferencedFiles(userMessage);
    const taskWithProjectContext = await this.injectProjectContext(preparedTask);
    const orchestrator = createOrchestrator(runtimeConfig, runtime);
    const memoryTurns = this.buildMemoryTurns();
    let streamStarted = false;
    let streamedResponse = "";

    try {
      const result = await orchestrator.run(
        {
          task: taskWithProjectContext,
          memoryTurns
        },
        {
          onPhaseChange: (phase) => {
            this.renderPhase(phase);
          },
          onAssistantTextDelta: (delta) => {
            if (!delta) {
              return;
            }
            if (!streamStarted) {
              streamStarted = true;
              output.write("\nTuanZi:\n");
            }
            streamedResponse += delta;
            output.write(delta);
          }
        }
      );

      renderToolCalls(result.toolCalls);
      if (streamStarted) {
        if (!streamedResponse.endsWith("\n")) {
          output.write("\n");
        }
        output.write("\n");
      } else {
        await this.renderAssistantSummary(result);
      }
      this.recordHistory(userMessage, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`执行失败: ${message}`);
    } finally {
      this.runningTask = false;
    }
  }

  private renderPhase(phase: OrchestratorPhase): void {
    // 保持界面极简，移除了执行进度提示词
  }

  private async renderAssistantSummary(result: OrchestrationResult): Promise<void> {
    const rendered = renderMarkdown(result.summary);
    console.log("\nTuanZi:");
    const lines = rendered.split(/\r?\n/);
    const shouldDelay = lines.length <= 40;
    for (const line of lines) {
      console.log(line);
      if (shouldDelay) {
        await sleep(8);
      }
    }
    console.log("");
  }

  private recordHistory(userMessage: string, result: OrchestrationResult): void {
    this.usage.outputChars += result.summary.length;
    this.usage.toolCalls += result.toolCalls.length;
    this.history.push({
      id: String(this.history.length + 1),
      userMessage,
      assistantMessage: result.summary,
      toolCalls: result.toolCalls,
      createdAt: new Date().toISOString()
    });
    if (this.history.length > 30) {
      this.history.splice(0, this.history.length - 30);
    }
  }

  private buildMemoryTurns(): ConversationMemoryTurn[] {
    return this.history.slice(-10).map((turn) => ({
      user: turn.userMessage,
      assistant: turn.assistantMessage,
      toolCalls: turn.toolCalls
    }));
  }

  private createRuntime(): RuntimePair {
    const runtimeConfig = loadRuntimeConfig({
      workspaceRoot: this.workspaceRoot,
      approvalMode: this.approvalMode,
      modelOverride: this.modelOverride
    });

    const logger = new InteractiveLogger();
    const runtime = createToolRuntime(runtimeConfig, { logger });
    return { runtimeConfig, runtime };
  }

  private async injectProjectContext(task: string): Promise<string> {
    const contextBlock = await this.readProjectContextBlock();
    if (!contextBlock) {
      return task;
    }
    return [task, "", contextBlock].join("\n");
  }

  private async readProjectContextBlock(): Promise<string> {
    const contextPath = path.join(this.workspaceRoot, PROJECT_CONTEXT_FILE);
    try {
      const stat = await fs.stat(contextPath);
      if (!stat.isFile()) {
        this.notifyMissingProjectContextOnce();
        return "";
      }
      const content = await fs.readFile(contextPath, "utf8");
      const truncated = content.length > PROJECT_CONTEXT_MAX_CHARS;
      const body = truncated ? `${content.slice(0, PROJECT_CONTEXT_MAX_CHARS)}\n...(truncated)` : content;
      return [
        `Project context from ${PROJECT_CONTEXT_FILE} (guidelines only, lower priority than current task):`,
        "```markdown",
        body,
        "```"
      ].join("\n");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        this.notifyMissingProjectContextOnce();
      } else if (!this.projectContextErrorNotified) {
        this.projectContextErrorNotified = true;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`读取 ${PROJECT_CONTEXT_FILE} 失败，已跳过注入: ${message}`);
      }
      return "";
    }
  }

  private notifyMissingProjectContextOnce(): void {
    if (this.projectContextMissingNotified) {
      return;
    }
    this.projectContextMissingNotified = true;
  }

  private async attachReferencedFiles(userMessage: string): Promise<string> {
    const referenced = extractFileReferences(userMessage);
    if (referenced.length === 0) {
      return userMessage;
    }

    const uniqueRefs = [...new Set(referenced)].slice(0, 5);
    const blocks: string[] = [];
    for (const ref of uniqueRefs) {
      const resolved = path.resolve(this.workspaceRoot, ref);
      try {
        assertInsideWorkspace(resolved, this.workspaceRoot);
      } catch {
        console.log(`@文件超出工作区，已忽略: ${ref}`);
        continue;
      }

      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile()) {
        console.log(`@文件不存在，已忽略: ${ref}`);
        continue;
      }
      try {
        const content = await fs.readFile(resolved, "utf8");
        const relativePath = relativeFromWorkspace(resolved, this.workspaceRoot);
        const trimmed = content.length > 8000 ? `${content.slice(0, 8000)}\n...(truncated)` : content;
        blocks.push(`File: ${relativePath}\n\`\`\`\n${trimmed}\n\`\`\``);
        console.log(`已挂载文件: ${relativePath}`);
      } catch {
        console.log(`@文件读取失败，已忽略: ${ref}`);
      }
    }

    if (blocks.length === 0) {
      return userMessage;
    }

    return [
      userMessage,
      "",
      "Attached file references from user input:",
      blocks.join("\n\n")
    ].join("\n");
  }
}

class InteractiveLogger implements Logger {
  info(message: string): void {
    if (message.startsWith("[tool]")) {
      const line = message
        .replace("[tool] start ", "🔧 ")
        .replace("[tool] done ", "✅ ")
        .replace(" ok=true", " 完成")
        .replace(" ok=false", " 失败");
      console.log(line);
      return;
    }
    if (message.startsWith("[agent]")) {
      return;
    }
    console.log(`[INFO] ${message}`);
  }

  warn(message: string): void {
    console.log(`[WARN] ${message}`);
  }

  error(message: string): void {
    console.log(`[ERROR] ${message}`);
  }
}

function parseCheckpointIndex(inputValue: string | undefined): number {
  if (!inputValue) {
    return 0;
  }
  const numeric = Number.parseInt(inputValue, 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return numeric;
}

function extractFileReferences(text: string): string[] {
  const results: string[] = [];
  const pattern = /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const cleaned = raw.trim();
    if (!cleaned) {
      continue;
    }
    if (cleaned.includes("://")) {
      continue;
    }
    results.push(cleaned);
  }
  return results;
}

function isContinuationLine(line: string): boolean {
  return /(^|[^\\])\\$/.test(line);
}

function stripContinuationMarker(line: string): string {
  if (!isContinuationLine(line)) {
    return line;
  }
  return line.slice(0, -1);
}

function normalizeModelName(inputModel: string | null): string | null {
  if (!inputModel) {
    return null;
  }
  const trimmed = inputModel.trim();
  return trimmed ? trimmed : null;
}

function normalizeCustomModelInput(inputModel: {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}): { ok: true; model: CustomModelConfig } | { ok: false; error: string } {
  const name = normalizeModelName(inputModel.name);
  if (!name) {
    return {
      ok: false,
      error: "模型别名不能为空。"
    };
  }
  if (/\s/.test(name)) {
    return {
      ok: false,
      error: "模型别名不能包含空白字符。"
    };
  }

  const baseUrlText = (inputModel.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrlText) {
    return {
      ok: false,
      error: "baseUrl 不能为空。"
    };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrlText);
  } catch {
    return {
      ok: false,
      error: "baseUrl 格式不合法。示例: http://127.0.0.1:11434/v1"
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      error: "baseUrl 仅支持 http 或 https。"
    };
  }

  const modelId = (inputModel.modelId ?? "").trim();
  if (!modelId) {
    return {
      ok: false,
      error: "modelId 不能为空。"
    };
  }

  const apiKey = normalizeApiKeyText(inputModel.apiKey ?? "");
  if (!apiKey) {
    return {
      ok: false,
      error: "apiKey 不能为空，可填 none。"
    };
  }

  return {
    ok: true,
    model: {
      name,
      baseUrl: baseUrlText,
      modelId,
      apiKey
    }
  };
}

function normalizeApiKeyText(rawApiKey: string): string {
  const trimmed = rawApiKey.trim();
  if (!trimmed) {
    return "";
  }
  const withoutInvisible = trimmed.replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (
    (withoutInvisible.startsWith("\"") && withoutInvisible.endsWith("\"")) ||
    (withoutInvisible.startsWith("'") && withoutInvisible.endsWith("'"))
  ) {
    return withoutInvisible.slice(1, -1).trim();
  }
  return withoutInvisible;
}

function renderToolCalls(toolCalls: ToolCallRecord[]): void {
  if (toolCalls.length === 0) {
    return;
  }
  console.log("\n工具调用:");
  for (const call of toolCalls) {
    renderToolCard(call);
  }
}

function renderToolCard(call: ToolCallRecord): void {
  const statusIcon = call.result.ok ? "✅" : "❌";
  const argsText = oneLineJson(call.args, 180);
  const summary = summarizeToolResult(call.toolName, call.result);
  const statusText = call.result.ok ? "completed" : classifyFailure(call.result.error);

  console.log(`  ├─ 🔧 ${call.toolName}`);
  console.log(`  │  args: ${argsText}`);
  console.log(`  │  status: ${statusIcon} ${statusText}`);
  console.log(`  │  result: ${summary}`);
}

function printRunCommandOutput(result: ToolExecutionResult): void {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return;
  }
  const data = result.data as Record<string, unknown>;
  const command = typeof data.command === "string" ? data.command : "";
  const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
  const timedOut = data.timedOut === true;
  const durationMs = typeof data.durationMs === "number" ? data.durationMs : null;
  const stdout = typeof data.stdout === "string" ? data.stdout.trim() : "";
  const stderr = typeof data.stderr === "string" ? data.stderr.trim() : "";

  if (command) {
    console.log(`command: ${command}`);
  }
  console.log(`exitCode: ${exitCode === null ? "null" : String(exitCode)}${timedOut ? " (timeout)" : ""}`);
  if (durationMs !== null) {
    console.log(`duration: ${durationMs}ms`);
  }

  if (stdout) {
    const preview = truncateMiddle(stdout, RUN_COMMAND_OUTPUT_PREVIEW_CHARS);
    const truncated = preview.length < stdout.length;
    console.log(`stdout${truncated ? " (truncated)" : ""}:`);
    console.log(preview);
  } else {
    console.log("stdout: [empty]");
  }
  if (stderr) {
    const preview = truncateMiddle(stderr, RUN_COMMAND_OUTPUT_PREVIEW_CHARS);
    const truncated = preview.length < stderr.length;
    console.log(`stderr${truncated ? " (truncated)" : ""}:`);
    console.log(preview);
  } else {
    console.log("stderr: [empty]");
  }
}

function summarizeToolResult(toolName: string, result: ToolExecutionResult): string {
  if (!result.ok) {
    return result.error ? truncateMiddle(result.error.replace(/\s+/g, " ").trim(), 180) : "Unknown error";
  }
  if (result.data === undefined) {
    return "ok";
  }
  if (typeof result.data === "string") {
    return truncateMiddle(result.data.replace(/\s+/g, " ").trim(), 180);
  }
  if (typeof result.data !== "object" || result.data === null) {
    return String(result.data);
  }

  const record = result.data as Record<string, unknown>;
  if (toolName === "write_to_file") {
    const target = typeof record.path === "string" ? record.path : "unknown";
    const bytes = typeof record.bytesWritten === "number" ? record.bytesWritten : null;
    const backup = typeof record.backupPath === "string" ? " with backup" : "";
    return bytes === null ? `wrote ${target}${backup}` : `wrote ${target} (${bytes} bytes)${backup}`;
  }
  if (toolName === "diff_apply") {
    const target = typeof record.path === "string" ? record.path : "unknown";
    const hunks = typeof record.hunksApplied === "number" ? record.hunksApplied : null;
    const linesChanged = typeof record.linesChanged === "number" ? record.linesChanged : null;
    if (hunks !== null || linesChanged !== null) {
      return `patched ${target} (hunks=${hunks ?? "?"}, lines=${linesChanged ?? "?"})`;
    }
    return `patched ${target}`;
  }
  if (Array.isArray(record.matches)) {
    return `${record.matches.length} matches`;
  }
  if (Array.isArray(record.items)) {
    return `${record.items.length} items`;
  }
  if (Array.isArray(record.checkpoints)) {
    return `${record.checkpoints.length} checkpoints`;
  }
  if (typeof record.exitCode === "number") {
    const timedOut = record.timedOut === true ? " timeout" : "";
    return `command exit=${record.exitCode}${timedOut}`;
  }

  return oneLineJson(record, 180);
}

function classifyFailure(errorMessage: string | undefined): string {
  const normalized = (errorMessage ?? "").toLowerCase();
  if (!normalized) {
    return "failed";
  }
  if (normalized.includes("policy denied")) {
    return "failed (policy denied)";
  }
  if (normalized.includes("rejected by user") || normalized.includes("rejected.") || normalized.includes("rejected")) {
    return "failed (approval rejected)";
  }
  if (
    normalized.includes("required") ||
    normalized.includes("must be") ||
    normalized.includes("invalid") ||
    normalized.includes("unexpected")
  ) {
    return "failed (input parse)";
  }
  return "failed";
}

function oneLineJson(value: unknown, maxChars: number): string {
  try {
    return truncateMiddle(JSON.stringify(value), maxChars);
  } catch {
    return "[unserializable]";
  }
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = "...";
  const keep = maxChars - marker.length;
  if (keep <= 0) {
    return text.slice(0, maxChars);
  }
  const left = Math.ceil(keep * 0.65);
  const right = Math.floor(keep * 0.35);
  return `${text.slice(0, left)}${marker}${text.slice(text.length - right)}`;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)}KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(2)}MB`;
}

function renderMarkdown(text: string): string {
  if (!text) {
    return "";
  }

  const lines = text.split(/\r?\n/);
  const outputLines: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      outputLines.push(inCode ? "┌─ code ─────────────────────────" : "└────────────────────────────────");
      continue;
    }

    if (inCode) {
      outputLines.push(`  ${line}`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      outputLines.push(`${headingMatch[1]} ${headingMatch[2].toUpperCase()}`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      outputLines.push(line.replace(/^\s*[-*]\s+/, "• "));
      continue;
    }

    outputLines.push(line.replace(/`([^`]+)`/g, "[$1]"));
  }

  return outputLines.join("\n");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function printWelcomeBanner(): void {
  try {
    const asciiText = figlet.textSync(WELCOME_BANNER_TEXT, { font: WELCOME_BANNER_FONT });
    const bwGradient = gradient([...WELCOME_BANNER_COLORS]);
    console.log(bwGradient.multiline(asciiText));
  } catch {
    // Fallback when terminal does not support ANSI or figlet fails.
    console.log("TUANZI");
  }
}
