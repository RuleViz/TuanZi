export interface SkillCatalogItem {
  name: string;
  description: string;
  rootDir: string;
  skillDir: string;
  skillFile: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  author?: string;
  version?: string;
  license?: string;
  tags?: string[];
  dependencies?: string[];
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}

export interface SkillDocument {
  frontmatter: SkillFrontmatter;
  body: string;
  raw: string;
}

export interface SkillResource {
  path: string;
  content: string;
}

export interface SkillRuntime {
  refreshCatalog(): void;
  listCatalog(): SkillCatalogItem[];
  loadSkill(name: string): SkillDocument;
  readSkillResource(name: string, relativePath: string): SkillResource;
}
