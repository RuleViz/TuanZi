export function createLineDiffPreview(previousContent: string, nextContent: string, maxChangedLines = 80): string {
  const previousLines = previousContent.split(/\r?\n/);
  const nextLines = nextContent.split(/\r?\n/);
  const maxLength = Math.max(previousLines.length, nextLines.length);

  const output: string[] = [];
  let changedCount = 0;

  for (let index = 0; index < maxLength; index += 1) {
    const before = previousLines[index];
    const after = nextLines[index];

    if (before === after) {
      continue;
    }

    const lineNumber = index + 1;
    output.push(`@@ line ${lineNumber} @@`);
    if (before !== undefined) {
      output.push(`- ${before}`);
    }
    if (after !== undefined) {
      output.push(`+ ${after}`);
    }
    changedCount += 1;

    if (changedCount >= maxChangedLines) {
      output.push("... diff preview truncated ...");
      break;
    }
  }

  if (output.length === 0) {
    return "No content change detected.";
  }
  return output.join("\n");
}
