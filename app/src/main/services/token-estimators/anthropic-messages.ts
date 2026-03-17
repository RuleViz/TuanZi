import {
  type TokenEstimateInput,
  type TokenEstimateResult,
  type TokenEstimatorAdapter
} from "./base";
import { CustomFallbackTokenEstimator } from "./custom-fallback";

export class AnthropicMessagesTokenEstimator implements TokenEstimatorAdapter {
  readonly protocolType = "anthropic_messages" as const;
  private readonly fallback = new CustomFallbackTokenEstimator(this.protocolType);

  estimate(input: TokenEstimateInput): Promise<TokenEstimateResult> {
    return this.fallback.estimate(input);
  }
}
