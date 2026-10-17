import { resolve } from "node:path";

export function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMissingFile(error: unknown): error is { readonly code: "ENOENT" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function sourceKey(filename: string): string {
  const normalized = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
