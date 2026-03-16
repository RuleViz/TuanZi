export interface SystemToolProfile {
  name: string;
  prompt: string;
}

export interface ActiveToolSelection {
  activeToolNames: string[];
  activeTools: SystemToolProfile[];
}

const SYSTEM_TOOL_REGISTRY: Record<string, SystemToolProfile> = {
  list_dir: {
    name: "list_dir",
    prompt: "Use list_dir to inspect folder structure before deep file operations."
  },
  find_by_name: {
    name: "find_by_name",
    prompt: "Use find_by_name to locate files quickly by filename patterns."
  },
  grep_search: {
    name: "grep_search",
    prompt: "Use grep_search to locate text patterns and call-sites before editing."
  },
  view_file: {
    name: "view_file",
    prompt: "Use view_file to read exact source content before making assumptions."
  },
  write_to_file: {
    name: "write_to_file",
    prompt: "Use write_to_file for controlled file rewrites and report modified paths truthfully."
  },
  diff_apply: {
    name: "diff_apply",
    prompt: "Use diff_apply for precise patch-style edits instead of broad overwrites."
  },
  delete_file: {
    name: "delete_file",
    prompt: "Use delete_file only when deletion is necessary and clearly intended by the task."
  },
  codebase_search: {
    name: "codebase_search",
    prompt: "Use codebase_search to find symbols and semantic references across the repository."
  },
  checkpoint: {
    name: "checkpoint",
    prompt: "Use checkpoint before risky refactors and for rollback/review when verification fails."
  },
  run_command: {
    name: "run_command",
    prompt: "Use run_command for build/test/diagnostic commands and always respect command failures."
  },
  browser_action: {
    name: "browser_action",
    prompt: "Use browser_action for browser-driven verification only when UI evidence is needed."
  },
  skill_load: {
    name: "skill_load",
    prompt:
      "Use skill_load to retrieve full SKILL.md instructions when a skill from <skill_catalog> looks relevant."
  },
  skill_read_resource: {
    name: "skill_read_resource",
    prompt:
      "Use skill_read_resource to read scripts/references/assets files only after SKILL.md indicates the resource is needed."
  }
};

const ALWAYS_ENABLED_INTERNAL_TOOLS = ["skill_load", "skill_read_resource"] as const;

export function getSystemToolProfile(name: string): SystemToolProfile | null {
  return SYSTEM_TOOL_REGISTRY[name] ?? null;
}

export function resolveActiveTools(agentTools: string[], availableToolNames: string[]): ActiveToolSelection {
  const available = new Set(availableToolNames);
  const requestedTools = [...agentTools, ...ALWAYS_ENABLED_INTERNAL_TOOLS];
  const seen = new Set<string>();
  const activeToolNames: string[] = [];
  const activeTools: SystemToolProfile[] = [];

  for (const toolName of requestedTools) {
    const normalizedName = toolName.trim();
    if (!normalizedName || seen.has(normalizedName)) {
      continue;
    }
    seen.add(normalizedName);

    if (!available.has(normalizedName)) {
      continue;
    }

    activeToolNames.push(normalizedName);
    const profile = SYSTEM_TOOL_REGISTRY[normalizedName];
    if (profile) {
      activeTools.push(profile);
    }
  }

  return {
    activeToolNames,
    activeTools
  };
}
