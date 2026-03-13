import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidSkillName, parseSkillMarkdown, SkillParseError } from "../core/skill-parser";

test("parseSkillMarkdown should parse required fields and allowed-tools metadata", () => {
  const raw = [
    "---",
    "name: pdf-processing",
    "description: Extract text and tables from PDF files.",
    "allowed-tools:",
    "  - run_command",
    "  - view_file",
    "tags: [pdf, extraction]",
    "---",
    "",
    "1. Use script A first.",
    "2. Validate output."
  ].join("\n");

  const parsed = parseSkillMarkdown(raw, { directoryName: "pdf-processing" });
  assert.equal(parsed.frontmatter.name, "pdf-processing");
  assert.equal(parsed.frontmatter.description, "Extract text and tables from PDF files.");
  assert.deepEqual(parsed.frontmatter.allowedTools, ["run_command", "view_file"]);
  assert.deepEqual(parsed.frontmatter.tags, ["pdf", "extraction"]);
  assert.match(parsed.body, /Use script A first/);
});

test("parseSkillMarkdown should reject directory/name mismatches", () => {
  const raw = [
    "---",
    "name: valid-name",
    "description: demo",
    "---",
    "Body"
  ].join("\n");
  assert.throws(() => parseSkillMarkdown(raw, { directoryName: "other-name" }), SkillParseError);
});

test("isValidSkillName should enforce lowercase alnum and hyphen", () => {
  assert.equal(isValidSkillName("my-skill-2"), true);
  assert.equal(isValidSkillName("MySkill"), false);
  assert.equal(isValidSkillName("my_skill"), false);
});
