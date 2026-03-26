import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../core/types";

export const MISSING_PROJECT_CONTEXT_PLACEHOLDER = "TUANZI.md not found in workspace root.";
const FALLBACK_PROMPT_BUDGET_TOTAL = 120000;

export interface PromptTokenBudgetSnapshot {
  total: number;
  used: number;
  remaining: number;
}

export function loadProjectContextFromWorkspace(workspaceRoot: string, logger?: Logger): string {
  const contextFilePath = path.join(workspaceRoot, "TUANZI.md");
  if (!existsSync(contextFilePath)) {
    return MISSING_PROJECT_CONTEXT_PLACEHOLDER;
  }

  try {
    const content = readFileSync(contextFilePath, "utf8").replace(/^\uFEFF/, "").trim();
    return content.length > 0 ? content : MISSING_PROJECT_CONTEXT_PLACEHOLDER;
  } catch (error) {
    logger?.warn(
      `[context] failed to read TUANZI.md from workspace root: ${error instanceof Error ? error.message : String(error)}`
    );
    return MISSING_PROJECT_CONTEXT_PLACEHOLDER;
  }
}

export function buildInitialPromptTokenBudget(input?: {
  total: number;
  reserve: number;
  limit: number;
}): PromptTokenBudgetSnapshot {
  const total = normalizePositiveInt(input?.limit) ?? FALLBACK_PROMPT_BUDGET_TOTAL;
  return {
    total,
    used: 0,
    remaining: total
  };
}

function normalizePositiveInt(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}
