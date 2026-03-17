import {
  estimateJsonTokens,
  estimateTextTokens,
  type TokenEstimateInput,
  type TokenEstimateResult,
  type TokenEstimatorAdapter
} from "./base";

const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 6;

export class OpenAIChatCompletionsTokenEstimator implements TokenEstimatorAdapter {
  readonly protocolType = "openai_chat_completions" as const;

  async estimate(input: TokenEstimateInput): Promise<TokenEstimateResult> {
    const systemTokens = estimateTextTokens(input.systemPrompt) + MESSAGE_OVERHEAD_TOKENS;
    const contextTokens = estimateTextTokens(input.conversationContext) + MESSAGE_OVERHEAD_TOKENS;
    const userTokens = estimateTextTokens(input.currentUserMessage) + MESSAGE_OVERHEAD_TOKENS;
    const toolsTokens = estimateJsonTokens(input.tools) + input.tools.length * MESSAGE_OVERHEAD_TOKENS;
    const toolCallsTokens =
      estimateJsonTokens(input.toolCalls) + input.toolCalls.length * TOOL_CALL_OVERHEAD_TOKENS;
    const imageTokens = estimateImageTokens(input.images);

    const estimatedInputTokens =
      systemTokens + contextTokens + userTokens + toolsTokens + toolCallsTokens + imageTokens;

    return {
      estimatedInputTokens,
      estimatedOutputTokens: input.maxOutputTokens,
      estimatorType: input.tokenEstimatorType,
      protocolType: this.protocolType,
      details: {
        systemTokens,
        contextTokens,
        userTokens,
        toolsTokens,
        toolCallsTokens,
        imageTokens
      }
    };
  }
}

function estimateImageTokens(images: TokenEstimateInput["images"]): number {
  if (images.length === 0) {
    return 0;
  }
  let total = 0;
  for (const image of images) {
    const bytes = estimateDataUrlByteSize(image.dataUrl);
    if (bytes <= 0) {
      total += 600;
      continue;
    }
    // Rule of thumb for vision requests: fixed framing cost + size-dependent cost.
    total += 340 + Math.ceil(bytes / 2048);
  }
  return total;
}

function estimateDataUrlByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return 0;
  }
  const base64 = dataUrl.slice(commaIndex + 1).trim();
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    return 0;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
