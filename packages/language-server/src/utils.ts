import { resolve } from "node:path";

export function normalizeFilename(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeAbsolutePath(filename: string): string {
  return normalizeFilename(resolve(filename));
}
