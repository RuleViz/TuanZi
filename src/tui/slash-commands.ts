export interface SlashCommand {
  raw: string;
  name: string;
  args: string[];
}

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1).trim();
  if (!body) {
    return null;
  }

  const parts = splitShellLike(body);
  const name = (parts[0] ?? "").toLowerCase();
  if (!name) {
    return null;
  }

  return {
    raw: trimmed,
    name,
    args: parts.slice(1)
  };
}

function splitShellLike(text: string): string[] {
  const tokens: string[] = [];
  let buffer = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        buffer += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (buffer) {
        tokens.push(buffer);
        buffer = "";
      }
      continue;
    }

    buffer += char;
  }

  if (escaped) {
    buffer += "\\";
  }
  if (buffer) {
    tokens.push(buffer);
  }

  return tokens;
}
