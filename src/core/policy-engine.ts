import type { JsonObject, PolicyDecision, PolicyEngine as PolicyEngineContract, PolicyEvaluation, PolicySettings } from "./types";

export class ConfigPolicyEngine implements PolicyEngineContract {
  constructor(private readonly settings: PolicySettings) {}

  evaluateTool(toolName: string, args: JsonObject): PolicyEvaluation {
    const normalizedTool = toolName.trim();
    const configured = this.settings.tools[normalizedTool];
    const fallbackDecision = isPolicyDecision(configured) ? configured : this.settings.default;

    if (normalizedTool === "run_command") {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (command) {
        if (matchesAnyRule(command, this.settings.commandRules.deny)) {
          return {
            decision: "deny",
            reason: "Matched deny command rule."
          };
        }
        if (matchesAnyRule(command, this.settings.commandRules.allow)) {
          return {
            decision: "allow",
            reason: "Matched allow command rule."
          };
        }
      }
    }

    return {
      decision: fallbackDecision,
      reason: "Matched tool policy."
    };
  }
}

function matchesAnyRule(command: string, rules: string[]): boolean {
  const normalized = command.toLowerCase();
  return rules.some((rule) => {
    const trimmed = rule.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed.startsWith("/") && trimmed.endsWith("/") && trimmed.length > 2) {
      try {
        const regex = new RegExp(trimmed.slice(1, -1), "i");
        return regex.test(command);
      } catch {
        return normalized.includes(trimmed.toLowerCase());
      }
    }
    return normalized.includes(trimmed.toLowerCase());
  });
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  return value === "allow" || value === "ask" || value === "deny";
}

