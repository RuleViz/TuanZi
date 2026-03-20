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
    prompt:
      "Recommended first step: use ls to inspect the current directory only (non-recursive). Keep results focused with path/pattern/limit."
  },
  glob: {
    name: "glob",
    prompt: "Use glob for cross-directory file discovery by name/path pattern when ls output is not sufficient."
  },
  grep: {
    name: "grep",
    prompt: "Use grep to locate content and call-sites after narrowing candidate paths."
  },
  read: {
    name: "read",
    prompt:
      "Use read for single-file context. For large files, paginate with offset+limit instead of trying full-file dumps."
  },
  write: {
    name: "write",
    prompt: "Use write for full-file create/overwrite operations when replacing entire content is intentional."
  },
  edit: {
    name: "edit",
    prompt: "Use edit (unified diff) for precise local modifications; this is usually better than broad overwrite."
  },
  delete_file: {
    name: "delete_file",
    prompt: "Use delete_file only when deletion is necessary and clearly intended by the task."
  },
  bash: {
    name: "bash",
    prompt: "Use bash mainly for build/test/diagnostic verification, not as a replacement for ls/glob/grep/read."
  },
  browser_action: {
    name: "browser_action",
    prompt: "Use browser_action for browser-driven verification only when UI evidence is needed."
  },
  spawn_subagent: {
    name: "spawn_subagent",
    prompt:
      "Use spawn_subagent to offload broad repository search or lightweight web research when the result can come back as a short summary."
  },
  wait_subagents: {
    name: "wait_subagents",
    prompt:
      "Use wait_subagents after dispatching one or more subagents. Prefer waiting after creating a small parallel batch."
  },
  list_subagents: {
    name: "list_subagents",
    prompt:
      "Use list_subagents to inspect current child status before deciding whether to wait, continue, or summarize."
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

const ALWAYS_ENABLED_INTERNAL_TOOLS = [
  "skill_load",
  "skill_read_resource",
  "spawn_subagent",
  "wait_subagents",
  "list_subagents"
] as const;

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
