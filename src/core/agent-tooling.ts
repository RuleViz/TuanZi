export interface SystemToolProfile {
  name: string;
  prompt: string;
}

export interface ActiveToolSelection {
  activeToolNames: string[];
  activeTools: SystemToolProfile[];
}

const SYSTEM_TOOL_REGISTRY: Record<string, SystemToolProfile> = {
  ls: {
    name: "ls",
    prompt: "Use ls first to inspect current directory only (non-recursive). Keep results focused with path/pattern/limit."
  },
  glob: {
    name: "glob",
    prompt: "Use glob for cross-directory file discovery by name/path pattern when ls is not enough."
  },
  grep: {
    name: "grep",
    prompt: "Use grep to locate content and call-sites in files after narrowing candidate paths."
  },
  read: {
    name: "read",
    prompt: "Use read for single-file context. Paginate large files with offset+limit; do not attempt full-file dumps."
  },
  write: {
    name: "write",
    prompt: "Use write only for full-file create/overwrite operations when replacing entire content is intended."
  },
  edit: {
    name: "edit",
    prompt: "Use edit (unified diff) for precise local modifications; prefer this over broad overwrite."
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
  bash: {
    name: "bash",
    prompt: "Use bash for build/test/diagnostic verification. Do not use bash to replace ls/glob/grep/read."
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
