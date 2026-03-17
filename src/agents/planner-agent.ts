import { randomUUID } from "node:crypto";
import type { ExecutionPlan, PlanStep } from "../core/types";
import { parseJsonObject } from "../core/json-utils";
import type { ChatCompletionClient, ChatMessageContent } from "./model-types";
import { plannerSystemPrompt } from "./prompts";

export class PlannerAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly workspaceRoot: string
  ) {}

  async buildPlan(task: string, conversationContext = "", signal?: AbortSignal): Promise<ExecutionPlan> {
    throwIfAborted(signal);
    if (!this.client || !this.model) {
      return fallbackPlan(task);
    }

    const messages: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: plannerSystemPrompt({ workspaceRoot: this.workspaceRoot }) }
    ];
    if (conversationContext) {
      messages.push({
        role: "user",
        content: [
          "Conversation memory from previous turns (context only, lower priority than current task):",
          conversationContext
        ].join("\n")
      });
    }
    messages.push({ role: "user", content: `User task: ${task}` });

    const completion = await this.client.complete({
      model: this.model,
      temperature: 0.2,
      messages
    }, {
      signal
    });

    throwIfAborted(signal);
    const parsed = parseJsonObject(messageContentToText(completion.message.content));
    if (!parsed) {
      return fallbackPlan(task);
    }

    const goal = typeof parsed.goal === "string" ? parsed.goal : task;
    const suggestedTestCommand = typeof parsed.suggestedTestCommand === "string" ? parsed.suggestedTestCommand : undefined;
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps = rawSteps
      .map((step) => toStep(step))
      .filter((step): step is PlanStep => step !== null);

    if (steps.length === 0) {
      return fallbackPlan(task);
    }

    return {
      goal,
      steps,
      suggestedTestCommand
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

function messageContentToText(content: ChatMessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const part of content) {
    if (part.type === "text") {
      text += part.text;
    }
  }
  return text;
}

function toStep(value: unknown): PlanStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;

  const id = typeof record.id === "string" && record.id.trim() ? record.id : randomUUID().slice(0, 8);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const owner = record.owner === "search" || record.owner === "code" ? record.owner : "code";
  const acceptance = typeof record.acceptance === "string" ? record.acceptance.trim() : "";

  if (!title || !acceptance) {
    return null;
  }

  return { id, title, owner, acceptance };
}

function fallbackPlan(task: string): ExecutionPlan {
  return {
    goal: task,
    steps: [
      {
        id: "S1",
        title: "定位与任务相关的文件和关键代码位置",
        owner: "search",
        acceptance: "产出一组可执行修改的文件路径列表。"
      },
      {
        id: "S2",
        title: "阅读关键代码并设计最小改动方案",
        owner: "code",
        acceptance: "形成低风险、可验证的修改策略。"
      },
      {
        id: "S3",
        title: "执行代码修改并保存",
        owner: "code",
        acceptance: "完成目标变更，且无明显语法问题。"
      },
      {
        id: "S4",
        title: "运行校验命令并总结结果",
        owner: "code",
        acceptance: "至少执行一次验证命令并反馈结果。"
      }
    ],
    suggestedTestCommand: "npm test"
  };
}
