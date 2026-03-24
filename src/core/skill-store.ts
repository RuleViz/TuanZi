import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAgentHomePath } from "./agent-store";
import { looksLikeTextFile } from "./file-utils";
import { parseSkillMarkdown, SKILL_FILE_NAME } from "./skill-parser";
import type { SkillCatalogItem, SkillDocument, SkillResource, SkillRuntime } from "./skill-types";
import type { Logger } from "./types";

const SKILLS_DIR_NAME = "skills";
const WORKSPACE_SKILLS_DIR = path.join(".tuanzi", "skills");
const MAX_RESOURCE_BYTES = 200 * 1024;
const RESOURCE_PREFIXES = ["scripts", "references", "assets"];

const NOOP_LOGGER: Logger = {
  info() {
    return;
  },
  warn() {
    return;
  },
  error() {
    return;
  }
};

export class FileSystemSkillRuntime implements SkillRuntime {
  private catalog: Map<string, SkillCatalogItem> | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger = NOOP_LOGGER
  ) {}

  listCatalog(): SkillCatalogItem[] {
    this.ensureCatalogLoaded();
    return [...this.catalog!.values()].map((item) => ({ ...item }));
  }

  refreshCatalog(): void {
    this.catalog = null;
    this.ensureCatalogLoaded();
  }

  loadSkill(name: string): SkillDocument {
    const catalogItem = this.getCatalogItem(name);
    const raw = readFileSync(catalogItem.skillFile, "utf8");
    return parseSkillMarkdown(raw, {
      filePath: catalogItem.skillFile,
      directoryName: path.basename(catalogItem.skillDir)
    });
  }

  readSkillResource(name: string, relativePath: string): SkillResource {
    const catalogItem = this.getCatalogItem(name);
    const safeRelativePath = normalizeResourcePath(relativePath);
    if (!isAllowedResourcePath(safeRelativePath)) {
      throw new Error("relativePath must be under scripts/, references/, or assets/.");
    }

    const absolutePath = path.resolve(catalogItem.skillDir, safeRelativePath);
    assertInsideDirectory(absolutePath, catalogItem.skillDir);
    const stat = statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      throw new Error(`Resource not found: ${safeRelativePath}`);
    }
    if (stat.size > MAX_RESOURCE_BYTES) {
      throw new Error(`Resource too large (${stat.size} bytes). Max allowed is ${MAX_RESOURCE_BYTES} bytes.`);
    }
    if (!looksLikeTextFile(absolutePath)) {
      throw new Error("Binary resources are not supported for skill_read_resource.");
    }

    const rawBuffer = readFileSync(absolutePath);
    if (rawBuffer.includes(0)) {
      throw new Error("Binary resources are not supported for skill_read_resource.");
    }
    return {
      path: absolutePath,
      content: rawBuffer.toString("utf8")
    };
  }

  private getCatalogItem(name: string): SkillCatalogItem {
    this.ensureCatalogLoaded();
    const normalized = normalizeLookupName(name);
    const item = this.catalog!.get(normalized);
    if (!item) {
      throw new Error(`Skill not found: ${name}`);
    }
    return item;
  }

  private ensureCatalogLoaded(): void {
    if (this.catalog) {
      return;
    }

    const catalog = new Map<string, SkillCatalogItem>();
    for (const rootDir of resolveSkillRoots(this.workspaceRoot)) {
      if (!isDirectory(rootDir)) {
        continue;
      }

      const entries = readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const skillDir = path.join(rootDir, entry.name);
        const skillFile = path.join(skillDir, SKILL_FILE_NAME);
        if (!existsSync(skillFile)) {
          this.logger.warn(`[skill] skipped ${entry.name}: missing ${SKILL_FILE_NAME}`);
          continue;
        }

        let doc: SkillDocument;
        try {
          const raw = readFileSync(skillFile, "utf8");
          doc = parseSkillMarkdown(raw, { filePath: skillFile, directoryName: entry.name });
        } catch (error) {
          this.logger.warn(`[skill] skipped ${entry.name}: ${errorMessage(error)}`);
          continue;
        }

        const key = normalizeLookupName(doc.frontmatter.name);
        const existing = catalog.get(key);
        if (existing) {
          this.logger.warn(
            `[skill] duplicate name "${doc.frontmatter.name}" ignored: ${skillDir} (kept ${existing.skillDir})`
          );
          continue;
        }

        catalog.set(key, {
          name: doc.frontmatter.name,
          description: doc.frontmatter.description,
          rootDir,
          skillDir,
          skillFile
        });
      }
    }

    this.catalog = catalog;
  }
}

export function createSkillRuntime(workspaceRoot: string, logger?: Logger): SkillRuntime {
  return new FileSystemSkillRuntime(workspaceRoot, logger ?? NOOP_LOGGER);
}

function resolveSkillRoots(workspaceRoot: string): string[] {
  const candidates = [path.join(getAgentHomePath(), SKILLS_DIR_NAME), path.join(workspaceRoot, WORKSPACE_SKILLS_DIR)];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function isDirectory(targetPath: string): boolean {
  const stat = statSync(targetPath, { throwIfNoEntry: false });
  return Boolean(stat && stat.isDirectory());
}

function normalizeLookupName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Skill name must be a non-empty string.");
  }
  return trimmed.toLowerCase();
}

function normalizeResourcePath(input: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("relativePath must be a non-empty string.");
  }
  if (path.isAbsolute(input)) {
    throw new Error("relativePath must be relative.");
  }

  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").trim();
  if (!normalized) {
    throw new Error("relativePath must be a non-empty relative path.");
  }
  return normalized;
}

function isAllowedResourcePath(relativePath: string): boolean {
  return RESOURCE_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function assertInsideDirectory(absolutePath: string, rootDir: string): void {
  const normalizedRoot = stripTrailingSeparator(path.resolve(rootDir));
  const normalizedTarget = stripTrailingSeparator(path.resolve(absolutePath));
  const rootLower = normalizedRoot.toLowerCase();
  const targetLower = normalizedTarget.toLowerCase();
  const inside = targetLower === rootLower || targetLower.startsWith(`${rootLower}${path.sep}`);
  if (!inside) {
    throw new Error(`Access denied: path is outside skill directory (${rootDir}).`);
  }
}

function stripTrailingSeparator(input: string): string {
  return input.replace(/[\\/]+$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
