import type { SkillDocument, SkillFrontmatter } from "./skill-types";

export const SKILL_FILE_NAME = "SKILL.md";

const REQUIRED_FIELDS = ["name", "description"] as const;
const RESERVED_FIELDS = new Set([
  "name",
  "description",
  "author",
  "version",
  "license",
  "tags",
  "dependencies",
  "allowed-tools",
  "allowed_tools",
  "allowedTools"
]);

export class SkillParseError extends Error {
  constructor(message: string, readonly filePath?: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

export function parseSkillMarkdown(
  rawContent: string,
  options?: { filePath?: string; directoryName?: string }
): SkillDocument {
  const normalized = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const { frontmatter, body } = splitFrontmatter(normalized);
  if (!frontmatter) {
    throw skillError("SKILL.md must include YAML frontmatter wrapped by --- markers.", options?.filePath);
  }

  const parsed = parseFrontmatter(frontmatter);
  for (const field of REQUIRED_FIELDS) {
    if (!normalizeOptionalString(parsed[field])) {
      throw skillError(`Missing required frontmatter field: ${field}`, options?.filePath);
    }
  }

  const name = normalizeOptionalString(parsed.name)!;
  const description = normalizeOptionalString(parsed.description)!;
  if (!isValidSkillName(name)) {
    throw skillError(
      `Invalid skill name "${name}". Use lowercase alphanumeric characters and hyphens only.`,
      options?.filePath
    );
  }
  if (options?.directoryName && name !== options.directoryName) {
    throw skillError(
      `Skill directory name "${options.directoryName}" must exactly match frontmatter name "${name}".`,
      options.filePath
    );
  }

  const tags = normalizeStringArray(parsed.tags);
  const dependencies = normalizeStringArray(parsed.dependencies);
  const allowedTools = normalizeStringArray(parsed["allowed-tools"] ?? parsed.allowed_tools ?? parsed.allowedTools);

  const frontmatterData: SkillFrontmatter = {
    name,
    description
  };
  const author = normalizeOptionalString(parsed.author);
  if (author) {
    frontmatterData.author = author;
  }
  const version = normalizeOptionalString(parsed.version);
  if (version) {
    frontmatterData.version = version;
  }
  const license = normalizeOptionalString(parsed.license);
  if (license) {
    frontmatterData.license = license;
  }
  if (tags.length > 0) {
    frontmatterData.tags = tags;
  }
  if (dependencies.length > 0) {
    frontmatterData.dependencies = dependencies;
  }
  if (allowedTools.length > 0) {
    frontmatterData.allowedTools = allowedTools;
  }

  const metadata = collectMetadata(parsed);
  if (Object.keys(metadata).length > 0) {
    frontmatterData.metadata = metadata;
  }

  return {
    frontmatter: frontmatterData,
    body: body.trim(),
    raw: normalized
  };
}

export function isValidSkillName(input: string): boolean {
  const value = input.trim();
  if (!value) {
    return false;
  }
  for (const char of value) {
    if (char === "-") {
      continue;
    }
    if (/^\p{Nd}$/u.test(char)) {
      continue;
    }
    if (char.toLowerCase() === char && char.toUpperCase() !== char) {
      continue;
    }
    return false;
  }
  return true;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith("---\n")) {
    return { frontmatter: "", body: content };
  }

  const lines = content.split("\n");
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      endIndex = index;
      break;
    }
  }

  if (endIndex < 0) {
    return { frontmatter: "", body: content };
  }

  return {
    frontmatter: lines.slice(1, endIndex).join("\n"),
    body: lines.slice(endIndex + 1).join("\n")
  };
}

function parseFrontmatter(input: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const lines = input.split("\n");
  let index = 0;

  while (index < lines.length) {
    const current = lines[index];
    const trimmed = current.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }

    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyMatch) {
      index += 1;
      continue;
    }

    const key = keyMatch[1];
    const inlineValue = keyMatch[2].trim();
    if (inlineValue) {
      output[key] = parseYamlValue(inlineValue);
      index += 1;
      continue;
    }

    index += 1;
    const blockLines: string[] = [];
    while (index < lines.length) {
      const next = lines[index];
      if (isTopLevelKey(next)) {
        break;
      }
      blockLines.push(next);
      index += 1;
    }
    output[key] = parseYamlBlock(blockLines);
  }

  return output;
}

function isTopLevelKey(line: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(line.trim());
}

function parseYamlBlock(lines: string[]): unknown {
  const normalized = trimBlock(lines);
  if (normalized.length === 0) {
    return "";
  }

  const listItems = normalized
    .map((line) => line.match(/^\s*-\s*(.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (listItems.length === normalized.length) {
    return listItems.map((match) => parseYamlScalar(match[1])).filter((item) => item.length > 0);
  }

  return normalized.map((line) => line.trim()).join("\n").trim();
}

function trimBlock(lines: string[]): string[] {
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && !lines[start].trim()) {
    start += 1;
  }
  while (end >= start && !lines[end].trim()) {
    end -= 1;
  }
  return start > end ? [] : lines.slice(start, end + 1);
}

function parseYamlValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseInlineArray(trimmed);
  }
  return parseYamlScalar(trimmed);
}

function parseInlineArray(input: string): string[] {
  const inner = input.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const values: string[] = [];
  let buffer = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of inner) {
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (quote === "\"") {
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        quote = null;
        continue;
      }
      buffer += char;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = null;
        continue;
      }
      buffer += char;
      continue;
    }

    if (char === "\"") {
      quote = "\"";
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === ",") {
      const parsed = parseYamlScalar(buffer);
      if (parsed) {
        values.push(parsed);
      }
      buffer = "";
      continue;
    }
    buffer += char;
  }
  const last = parseYamlScalar(buffer);
  if (last) {
    values.push(last);
  }
  return values;
}

function parseYamlScalar(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function normalizeOptionalString(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed || null;
}

function normalizeStringArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof input === "string" && input.trim()) {
    return [input.trim()];
  }
  return [];
}

function collectMetadata(parsed: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (RESERVED_FIELDS.has(key)) {
      continue;
    }
    metadata[key] = value;
  }
  return metadata;
}

function skillError(message: string, filePath?: string): SkillParseError {
  if (!filePath) {
    return new SkillParseError(message);
  }
  return new SkillParseError(`${message} (file: ${filePath})`, filePath);
}
