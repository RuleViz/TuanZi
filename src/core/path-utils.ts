import path from "node:path";

export function ensureAbsolutePath(inputPath: string, fieldName = "path"): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (!path.isAbsolute(inputPath)) {
    throw new Error(`${fieldName} must be an absolute path.`);
  }
  return path.resolve(inputPath);
}

export function resolveSafePath(inputPath: string, workspaceRoot: string, fieldName = "path"): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw new Error("workspaceRoot must be a non-empty string.");
  }

  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }

  return path.resolve(workspaceRoot, inputPath);
}

export function assertInsideWorkspace(absolutePath: string, workspaceRoot: string): void {
  const normalizedRoot = stripTrailingSeparator(path.resolve(workspaceRoot));
  const normalizedTarget = stripTrailingSeparator(path.resolve(absolutePath));

  const rootLower = normalizedRoot.toLowerCase();
  const targetLower = normalizedTarget.toLowerCase();
  const startsWithRoot = targetLower === rootLower || targetLower.startsWith(`${rootLower}${path.sep}`);

  if (!startsWithRoot) {
    throw new Error(
      `Access denied: path [${absolutePath}] is outside workspace root [${workspaceRoot}]. ` +
        "Use a relative path like '.' or './src', or an absolute path within the current workspace."
    );
  }
}

export function toUnixPath(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

export function relativeFromWorkspace(absolutePath: string, workspaceRoot: string): string {
  return toUnixPath(path.relative(workspaceRoot, absolutePath));
}

function stripTrailingSeparator(inputPath: string): string {
  return inputPath.replace(/[\\/]+$/, "");
}
