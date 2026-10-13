import { extname, resolve } from "node:path";

export function normalizeFilename(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function absolutePathKey(filename: string): string {
  const normalized = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function routeImportCandidates(base: string): string[] {
  if (extname(base)) return [];

  return [".ts", ".tsx", ".mts", ".js"].map((suffix) => `${base}${suffix}`);
}

export function lfLineStarts(source: string): number[] {
  const starts = [0];

  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") starts.push(index + 1);

  return starts;
}
