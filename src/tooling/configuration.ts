import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  BrowserResolutionOverrides,
  ProjectResolutionOverrides,
} from "../compiler/module-resolution.ts";

/** Resolved project inputs used by checking, generation, and the build record. */
export interface ProjectConfiguration {
  /** Permit the explicit unsafe HTML primitive; browser enforcement and warnings still apply. */
  readonly allowUnsafeHTML: boolean;
  /** Exact browser import names mapped to packages or project-config-relative modules. */
  readonly resolutionOverrides: ProjectResolutionOverrides;
}

/** Read the optional project file; an absent file keeps raw HTML disabled. */
export async function readConfiguration(root: string): Promise<ProjectConfiguration> {
  let source: string;
  try {
    source = await readFile(resolve(root, "hesperia.config.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return Object.freeze({ allowUnsafeHTML: false, resolutionOverrides: { browser: {} } });
    throw error;
  }
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("hesperia.config.json must contain an object");
  const entries = Object.entries(value);
  for (const [name, setting] of entries) {
    if (name !== "allowUnsafeHTML" && name !== "resolutionOverrides")
      throw new TypeError(`Unknown Hesperia configuration option: ${name}`);
    if (name === "allowUnsafeHTML") {
      if (typeof setting !== "boolean") throw new TypeError("allowUnsafeHTML must be a boolean");
      continue;
    }
    validateResolutionOverrides(setting);
  }
  const overrides =
    typeof (value as { resolutionOverrides?: unknown }).resolutionOverrides === "object" &&
    (value as { resolutionOverrides?: unknown }).resolutionOverrides !== null &&
    !Array.isArray((value as { resolutionOverrides?: unknown }).resolutionOverrides)
      ? ((value as { resolutionOverrides?: { browser?: BrowserResolutionOverrides } })
          .resolutionOverrides?.browser ?? {})
      : {};
  return Object.freeze({
    allowUnsafeHTML: (value as { allowUnsafeHTML?: boolean }).allowUnsafeHTML ?? false,
    resolutionOverrides: { browser: Object.freeze({ ...overrides }) },
  });
}

function validateResolutionOverrides(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("resolutionOverrides must contain an object");
  const browser = (value as { browser?: unknown }).browser;
  if (browser === undefined) throw new TypeError("resolutionOverrides.browser is required");
  if (browser === null || typeof browser !== "object" || Array.isArray(browser))
    throw new TypeError("resolutionOverrides.browser must contain an object");
  for (const [specifier, target] of Object.entries(browser)) {
    if (
      !specifier ||
      specifier.startsWith("/") ||
      specifier.includes("\\") ||
      specifier.includes("*")
    )
      throw new TypeError(`Invalid browser resolution override import name: ${specifier}`);
    if (
      typeof target !== "string" ||
      !target ||
      target.includes("\\") ||
      (target.startsWith(".") && !target.startsWith("./") && !target.startsWith("../")) ||
      target.startsWith("/")
    )
      throw new TypeError(
        `Browser resolution override target for ${specifier} must name a module specifier`,
      );
    if (target.startsWith("./") || target.startsWith("../")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        throw new TypeError(`Invalid browser resolution override target for ${specifier}`);
      }
      if (/%2f|%5c/iu.test(target) || decoded.includes("\\"))
        throw new TypeError(`Invalid browser resolution override target for ${specifier}`);
    }
  }
}
