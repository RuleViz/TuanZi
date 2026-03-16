import { promises as fs } from "node:fs";
import path from "node:path";

export async function atomicWriteTextFile(absoluteFilePath: string, content: string): Promise<void> {
  const directory = path.dirname(absoluteFilePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(absoluteFilePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempPath, content, "utf8");

  try {
    await fs.rm(absoluteFilePath, { force: true });
  } catch {
    // ignore
  }

  await fs.rename(tempPath, absoluteFilePath);
}

export function globToRegExp(globPattern: string): RegExp {
  const normalized = globPattern.replace(/\\/g, "/");
  const hasWildcard = /[*?]/.test(normalized);
  const wrappedPattern = hasWildcard ? normalized : `*${normalized}*`;

  const marker = "__DOUBLE_STAR__";
  const withMarker = wrappedPattern.replace(/\*\*/g, marker);
  const escaped = withMarker.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const singleStar = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  const finalPattern = singleStar.replace(new RegExp(marker, "g"), ".*");

  return new RegExp(`^${finalPattern}$`, "i");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function looksLikeTextFile(fileName: string): boolean {
  const lowercase = fileName.toLowerCase();
  const binaryExt = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".mp3",
    ".mp4",
    ".mov",
    ".exe",
    ".dll",
    ".so",
    ".class",
    ".jar",
    ".woff",
    ".woff2"
  ];
  return !binaryExt.some((ext) => lowercase.endsWith(ext));
}
