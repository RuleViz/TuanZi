import type { ProviderModelProtocolType } from "../../../shared/domain-types";
import {
  estimateJsonTokens,
  estimateTextTokens,
  type TokenEstimateInput,
  type TokenEstimateResult,
  type TokenEstimatorAdapter
} from "./base";

export class CustomFallbackTokenEstimator implements TokenEstimatorAdapter {
  constructor(readonly protocolType: ProviderModelProtocolType = "custom") {}

  async estimate(input: TokenEstimateInput): Promise<TokenEstimateResult> {
    const systemTokens = estimateTextTokens(input.systemPrompt);
    const contextTokens = estimateTextTokens(input.conversationContext);
    const userTokens = estimateTextTokens(input.currentUserMessage);
    const toolsTokens = estimateJsonTokens(input.tools);
    const toolCallsTokens = estimateJsonTokens(input.toolCalls);
    const imageTokens = input.images.length * 512;
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
