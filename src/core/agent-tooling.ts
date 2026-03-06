import type { GlobalSkillCategory, GlobalSkillsConfig } from "./agent-store";

export interface SystemToolProfile {
  name: string;
  category: GlobalSkillCategory;
  prompt: string;
}

export interface ActiveToolSelection {
  activeToolNames: string[];
  activeTools: SystemToolProfile[];
}

const SYSTEM_TOOL_REGISTRY: Record<string, SystemToolProfile> = {
  list_dir: {
    name: "list_dir",
    category: "file_system",
    prompt: "Use list_dir to inspect folder structure before deep file operations."
  },
  find_by_name: {
    name: "find_by_name",
    category: "file_system",
    prompt: "Use find_by_name to locate files quickly by filename patterns."
  },
  grep_search: {
    name: "grep_search",
    category: "file_system",
    prompt: "Use grep_search to locate text patterns and call-sites before editing."
  },
  view_file: {
    name: "view_file",
    category: "file_system",
    prompt: "Use view_file to read exact source content before making assumptions."
  },
  write_to_file: {
    name: "write_to_file",
    category: "file_system",
    prompt: "Use write_to_file for controlled file rewrites and report modified paths truthfully."
  },
  diff_apply: {
    name: "diff_apply",
    category: "file_system",
    prompt: "Use diff_apply for precise patch-style edits instead of broad overwrites."
  },
  delete_file: {
    name: "delete_file",
    category: "file_system",
    prompt: "Use delete_file only when deletion is necessary and clearly intended by the task."
  },
  codebase_search: {
    name: "codebase_search",
    category: "file_system",
    prompt: "Use codebase_search to find symbols and semantic references across the repository."
  },
  checkpoint: {
    name: "checkpoint",
    category: "file_system",
    prompt: "Use checkpoint before risky refactors and for rollback/review when verification fails."
  },
  run_command: {
    name: "run_command",
    category: "execute_command",
    prompt: "Use run_command for build/test/diagnostic commands and always respect command failures."
  },
  browser_action: {
    name: "browser_action",
    category: "execute_command",
    prompt: "Use browser_action for browser-driven verification only when UI evidence is needed."
  },
  search_web: {
    name: "search_web",
    category: "web_search",
    prompt: "Use search_web for latest external facts, versions, and official references."
  },
  fetch_url: {
    name: "fetch_url",
    category: "web_search",
    prompt: "Use fetch_url to retrieve full page content from trustworthy sources after search."
  }
};

export function getSystemToolProfile(name: string): SystemToolProfile | null {
  return SYSTEM_TOOL_REGISTRY[name] ?? null;
}

export function resolveActiveTools(
  agentTools: string[],
  globalSkills: GlobalSkillsConfig,
  availableToolNames: string[]
): ActiveToolSelection {
  const available = new Set(availableToolNames);
  const seen = new Set<string>();
  const activeToolNames: string[] = [];
  const activeTools: SystemToolProfile[] = [];

  for (const toolName of agentTools) {
    const normalizedName = toolName.trim();
    if (!normalizedName || seen.has(normalizedName)) {
      continue;
    }
    seen.add(normalizedName);

    const profile = SYSTEM_TOOL_REGISTRY[normalizedName];
    if (!profile) {
      continue;
    }
    if (!available.has(normalizedName)) {
      continue;
    }
    if (globalSkills[profile.category] !== true) {
      continue;
    }

    activeToolNames.push(normalizedName);
    activeTools.push(profile);
  }

  return {
    activeToolNames,
    activeTools
  };
}
