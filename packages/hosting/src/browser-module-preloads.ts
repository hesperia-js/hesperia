import { assertCanonicalAssetPath, isRecord } from "./captured-build.ts";

/** Managed record for verified browser module dependencies. @internal */
export const BROWSER_MODULE_PRELOADS_ASSET = "/assets/browser-module-preloads.json";

/** Dependencies of the startup entry and its subsequent required imports. @internal */
export interface BrowserModulePreloads {
  readonly modules: readonly string[];
  readonly imports?: Readonly<Record<string, readonly string[]>>;
}

function readModulePaths(
  source: unknown,
  files: Pick<ReadonlyMap<string, unknown>, "has">,
): readonly string[] {
  if (!Array.isArray(source) || source.length === 0)
    throw new TypeError("Browser module preloads require a nonempty list of JavaScript artifacts");

  const seen = new Set<string>();

  for (const path of source) {
    if (typeof path !== "string" || !/\.m?js$/u.test(path))
      throw new TypeError("Browser module preloads must reference JavaScript artifacts");

    assertCanonicalAssetPath(path, "browser module preload");

    if (!files.has(path) || seen.has(path))
      throw new TypeError("Browser module preload names a missing or repeated artifact");

    seen.add(path);
  }

  return Object.freeze([...seen]);
}

/**
 * Read browser preload paths from the verified inventory of the same capture.
 * @param source - Verified metadata from this capture, if present.
 * @param startupAsset - The capture's already validated startup module key.
 * @param files - Membership in that same verified capture.
 * @returns The startup and required import dependencies in publication order.
 * @throws TypeError through rejection for malformed metadata or uncaptured module references.
 * @internal
 */
export async function readBrowserModulePreloads(
  source: Blob | undefined,
  startupAsset: string,
  files: Pick<ReadonlyMap<string, unknown>, "has">,
): Promise<BrowserModulePreloads> {
  if (!source) return { modules: [] };

  const record: unknown = JSON.parse(await source.text());

  if (!isRecord(record))
    throw new TypeError("Browser module preloads must be supplied as an object");

  const modules = readModulePaths(record.modules, files);

  if (modules[0] !== startupAsset)
    throw new TypeError("Browser module preloads must start with this capture's startup module");

  if (record.version === 1 && Object.keys(record).length === 2) return { modules };

  if (record.version !== 2 || Object.keys(record).length !== 3 || !isRecord(record.imports))
    throw new TypeError("Browser module preload metadata has an unsupported shape");

  const imports: Record<string, readonly string[]> = Object.create(null);

  for (const [key, paths] of Object.entries(record.imports))
    imports[key] = readModulePaths(paths, files);

  return { modules, imports: Object.freeze(imports) };
}
