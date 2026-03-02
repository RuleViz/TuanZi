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
    const regex = parseRegexLiteral(trimmed);
    if (regex) {
      return regex.test(command);
    }
    return normalized.includes(trimmed.toLowerCase());
  });
}

function parseRegexLiteral(input: string): RegExp | null {
  if (!input.startsWith("/") || input.length < 2) {
    return null;
  }
  const lastSlash = input.lastIndexOf("/");
  if (lastSlash <= 0) {
    return null;
  }
  const pattern = input.slice(1, lastSlash);
  const rawFlags = input.slice(lastSlash + 1);
  if (!pattern) {
    return null;
  }
  const flags = rawFlags || "i";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  return value === "allow" || value === "ask" || value === "deny";
}
