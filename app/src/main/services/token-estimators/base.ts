import type {
  ProviderModelProtocolType,
  ProviderModelTokenEstimatorType
} from "../../../shared/domain-types";

export interface TokenEstimateToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface TokenEstimateToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: string };
}

export interface TokenEstimateImageInput {
  mimeType: string;
  dataUrl: string;
}

export interface TokenEstimateInput {
  systemPrompt: string;
  conversationContext: string;
  currentUserMessage: string;
  tools: TokenEstimateToolDefinition[];
  toolCalls: TokenEstimateToolCall[];
  images: TokenEstimateImageInput[];
  maxOutputTokens: number | null;
  contextWindowTokens: number | null;
  tokenEstimatorType: ProviderModelTokenEstimatorType;
}

export interface TokenEstimateResult {
  estimatedInputTokens: number;
  estimatedOutputTokens: number | null;
  estimatorType: ProviderModelTokenEstimatorType;
  protocolType: ProviderModelProtocolType;
  details?: Record<string, number>;
}

export interface TokenEstimatorAdapter {
  protocolType: ProviderModelProtocolType;
  estimate(input: TokenEstimateInput): Promise<TokenEstimateResult>;
}

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}
