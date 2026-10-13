import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { normalizeFilename as pathKey } from "./utils.ts";

/** A filesystem input read by the native TypeScript checking snapshot. */
export interface CapturedCheckingInput {
  /** Canonical absolute filename supplied to TypeScript. */
  readonly filename: string;
  /** Exact UTF-8 bytes returned to TypeScript for this snapshot. */
  readonly source: string;
  /** SHA-256 digest of `source`, prefixed with `sha256-`. */
  readonly digest: string;
}

/**
 * Immutable-on-read filesystem state for the native TypeScript API.
 *
 * Virtual compiler files win over disk files. A disk file is captured on its first read,
 * and a missing path is remembered so a later filesystem mutation cannot change this snapshot.
 */
export class CheckingInputSnapshot {
  readonly #files: ReadonlyMap<string, string>;
  readonly #captured = new Map<string, CapturedCheckingInput>();
  readonly #missing = new Set<string>();

  constructor(files: ReadonlyMap<string, string>) {
    this.#files = files;
  }

  /** Add a known disk-backed configuration that was loaded before the API host was created. */
  capture(filename: string, source: string): void {
    const canonical = resolve(filename);
    const key = pathKey(canonical);

    if (this.#captured.has(key) || this.#missing.has(key)) return;

    this.#captured.set(key, Object.freeze({ filename: canonical, source, digest: digest(source) }));
  }

  /** Read one virtual or disk file without allowing a later disk reread. */
  readFile(filename: string): string | null | undefined {
    const canonical = resolve(filename);
    const key = pathKey(canonical);
    const virtual = this.#files.get(key);

    if (virtual !== undefined) return virtual;

    const captured = this.#captured.get(key);

    if (captured) return captured.source;

    if (this.#missing.has(key)) return null;

    let source: string;

    try {
      source = readFileSync(canonical, "utf8");
    } catch {
      if (isCheckingInput(canonical)) {
        this.#missing.add(key);

        return null;
      }

      return undefined;
    }

    this.capture(canonical, source);

    return source;
  }

  /** Check one virtual or disk path while preserving negative observations. */
  fileExists(filename: string): boolean {
    const canonical = resolve(filename);
    const key = pathKey(canonical);

    if (this.#files.has(key) || this.#captured.has(key)) return true;

    if (this.#missing.has(key)) return false;

    if (existsSync(canonical)) return this.readFile(canonical) !== null;

    this.#missing.add(key);

    return false;
  }

  /** Project and dependency inputs in first-read order; pinned TypeScript toolchain files are omitted. */
  get captured(): readonly CapturedCheckingInput[] {
    return Object.freeze(
      [...this.#captured.values()].filter((input) => isCheckingInput(input.filename)),
    );
  }
}

function isCheckingInput(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  return (
    !normalized.includes("/node_modules/typescript/") &&
    !/\/node_modules\/@typescript\/typescript-[^/]+\//u.test(normalized)
  );
}

function digest(source: string): string {
  return `sha256-${createHash("sha256").update(source).digest("hex")}`;
}
