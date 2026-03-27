import type { ChatMessage } from "./model-types";

export interface ToolOutputPruningConfig {
  protectRecentTokens: number;
  pruneMinimumTokens: number;
  pruneStrategy: "truncate" | "summarize";
}

export interface ToolOutputPruneResult {
  prunedMessageCount: number;
  prunedTokenCount: number;
}

export const DEFAULT_TOOL_OUTPUT_PRUNING_CONFIG: ToolOutputPruningConfig = {
  protectRecentTokens: 40000,
  pruneMinimumTokens: 20000,
  pruneStrategy: "truncate"
};

const PRUNED_PREFIX = "[Tool output pruned - ";
const PRUNED_SUFFIX = " tokens removed]";

interface PrunableToolMessage {
  index: number;
  tokenCount: number;
}

export function pruneToolOutputs(
  messages: ChatMessage[],
  config: ToolOutputPruningConfig
): ToolOutputPruneResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      prunedMessageCount: 0,
      prunedTokenCount: 0
    };
  }

  const toolMessages: PrunableToolMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "tool" || typeof message.content !== "string") {
      continue;
    }
    toolMessages.push({
      index,
      tokenCount: estimateTextTokens(message.content)
    });
  }

  if (toolMessages.length === 0) {
    return {
      prunedMessageCount: 0,
      prunedTokenCount: 0
    };
  }

  const protectRecentTokens = normalizePositiveInt(config.protectRecentTokens, DEFAULT_TOOL_OUTPUT_PRUNING_CONFIG.protectRecentTokens);
  const pruneMinimumTokens = normalizePositiveInt(config.pruneMinimumTokens, DEFAULT_TOOL_OUTPUT_PRUNING_CONFIG.pruneMinimumTokens);
  const pruneStrategy = config.pruneStrategy === "summarize" ? "summarize" : "truncate";

  let protectedTokenCount = 0;
  const toPrune: PrunableToolMessage[] = [];
  for (let cursor = toolMessages.length - 1; cursor >= 0; cursor -= 1) {
    const current = toolMessages[cursor];
    if (protectedTokenCount < protectRecentTokens) {
      protectedTokenCount += current.tokenCount;
      continue;
    }
    toPrune.push(current);
  }

  const removableTokens = toPrune.reduce((total, item) => total + item.tokenCount, 0);
  if (removableTokens < pruneMinimumTokens || toPrune.length === 0) {
    return {
      prunedMessageCount: 0,
      prunedTokenCount: 0
    };
  }

  let prunedMessageCount = 0;
  let prunedTokenCount = 0;
  for (const target of toPrune) {
    const message = messages[target.index];
    if (!message || message.role !== "tool" || typeof message.content !== "string") {
      continue;
    }
    if (isPrunedPlaceholder(message.content)) {
      continue;
    }
    message.content = buildPrunedPlaceholder(target.tokenCount, pruneStrategy);
    prunedMessageCount += 1;
    prunedTokenCount += target.tokenCount;
  }

  return {
    prunedMessageCount,
    prunedTokenCount
  };
}

function buildPrunedPlaceholder(removedTokens: number, _strategy: "truncate" | "summarize"): string {
  return `${PRUNED_PREFIX}${removedTokens}${PRUNED_SUFFIX}`;
}

function isPrunedPlaceholder(content: string): boolean {
  return content.startsWith(PRUNED_PREFIX) && content.endsWith(PRUNED_SUFFIX);
}

function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
