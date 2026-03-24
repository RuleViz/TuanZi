import type {
  ProviderModelProtocolType,
  ProviderModelTokenEstimatorType
} from "../../shared/domain-types";

export interface ConversationModelSnapshot {
  providerId: string | null;
  providerType: string | null;
  modelId: string | null;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  protocolType: ProviderModelProtocolType;
  tokenEstimatorType: ProviderModelTokenEstimatorType;
  capturedAt: string;
}

export interface TokenEstimateRecord {
  protocolType: ProviderModelProtocolType;
  estimatorType: ProviderModelTokenEstimatorType;
  estimatedInputTokens: number;
  estimatedOutputTokens: number | null;
  contextWindowTokens: number | null;
  thresholdTokens: number | null;
  createdAt: string;
}

export interface ConversationTurnToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: string };
  timestamp: string;
}

export interface ConversationTurnRecord {
  version: 1;
  workspace: string;
  workspaceHash: string;
  sessionId: string;
  seq: number;
  turnId: string;
  taskId: string;
  turnIndex: number;
  user: string;
  assistant: string;
  thinkingSummary: string;
  toolCalls: ConversationTurnToolCallRecord[];
  checkpointId: string | null;
  interrupted: boolean;
  error?: string | null;
  createdAt: string;
  tokenEstimate?: TokenEstimateRecord | null;
}

export interface ConversationSummaryRecord {
  version: 1;
  workspace: string;
  workspaceHash: string;
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  title: string;
  summary: string;
  keyPoints: string[];
  openQuestions: string[];
  updatedAt: string;
  source: "model" | "fallback";
}

export interface ConversationSessionState {
  version: 1;
  workspace: string;
  workspaceHash: string;
  sessionId: string;
  nextSeq: number;
  lastCompactedSeq: number;
  modelSnapshot: ConversationModelSnapshot | null;
  createdAt: string;
  updatedAt: string;
}
