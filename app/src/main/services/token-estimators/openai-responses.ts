import {
  type TokenEstimateInput,
  type TokenEstimateResult,
  type TokenEstimatorAdapter
} from "./base";
import { CustomFallbackTokenEstimator } from "./custom-fallback";

export class OpenAIResponsesTokenEstimator implements TokenEstimatorAdapter {
  readonly protocolType = "openai_responses" as const;
  private readonly fallback = new CustomFallbackTokenEstimator(this.protocolType);

  estimate(input: TokenEstimateInput): Promise<TokenEstimateResult> {
    return this.fallback.estimate(input);
  }
}
