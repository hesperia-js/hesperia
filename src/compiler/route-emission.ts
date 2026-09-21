import { dirname, extname, join, resolve as resolvePath } from "node:path";
import remapping from "@jridgewell/remapping";
import type { SourceMapInput } from "@jridgewell/trace-mapping";
import { generateModule } from "./generate.ts";
import type { RouteGuardArtifact, RouteGuardModule } from "./route-analysis.ts";

interface SourceMap {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
  readonly sourcesContent?: readonly (string | null)[];
}

/** An emitted import edge retained so tooling can write the selected closure graph. */
export interface RouteEmittedImport {
  /** The import text authored in the selected module. */
  readonly source: string;
  /** The selected module reached by a relative import, when one exists in the artifact. */
  readonly resolvedFilename?: string;
}

/** One generated route-guard module and its authored source map. */
export interface RouteEmittedModule {
  /** The stable output filename corresponding to the analyzed source module. */
  readonly filename: string;
  /** Fresh generated JavaScript containing only the selected guard closure. */
  readonly code: string;
  /** A generated-to-authored map with sourcesContent intentionally omitted. */
  readonly map?: SourceMap;
  /** Relative and external import edges retained by the generated module. */
  readonly imports: readonly RouteEmittedImport[];
}

/** Internal emitted graph consumed by route build integration. */
export interface RouteEmissionResult {
  /** The output filename that exports the guard entry as its default export. */
  readonly entryFilename: string;
  /** All selected closure modules, including the entry module. */
  readonly modules: readonly RouteEmittedModule[];
}

/** Options for generating an analyzed route guard closure. */
export interface RouteEmissionOptions {
  /** Runtime module passed to the normal compiler generator. */
  readonly runtimeModule: string;
  /** Private per-artifact specifier used only for the generator's injected runtime import. */
  readonly generatedRuntimeModule?: string;
}

/**
 * Generate the selected guard closure from canonical modules and compose each map back to its
 * authored module. The generated code and maps contain only selected declarations; normalized
 * source sidecars are used during composition and then removed from the published maps so route
 * loaders, headers, and unrelated server source cannot leak through sourcesContent.
 */
export function emitRouteGuardArtifact(
  artifact: RouteGuardArtifact,
  options: RouteEmissionOptions,
): RouteEmissionResult {
  const filenames = new Map(
    artifact.modules.map((item) => [moduleKey(item.filename), item.filename]),
  );
  const modules = artifact.modules.map((item) => emitModule(item, filenames, options));
  return { entryFilename: artifact.entry.filename, modules };
}

function emitModule(
  item: RouteGuardModule,
  filenames: ReadonlyMap<string, string>,
  options: RouteEmissionOptions,
): RouteEmittedModule {
  const generated = generateModule(item.module, {
    filename: item.filename,
    runtimeModule: options.generatedRuntimeModule ?? options.runtimeModule,
    source: item.source,
    clientBindings: new Map(),
    browserTarget: true,
  });
  const imports = item.module.body.flatMap((statement) =>
    statement.kind === "import"
      ? statement.specifiers.length === 0
        ? [{ source: statement.source }]
        : [
            {
              source: statement.source,
              resolvedFilename: resolveGraphImport(item.filename, statement.source, filenames),
            },
          ]
      : [],
  );
  const map = composeMap(generated.map, item.map);
  return { filename: item.filename, code: generated.code, ...(map ? { map } : {}), imports };
}

function composeMap(generated: unknown, normalized: unknown): SourceMap | undefined {
  if (!generated || typeof generated !== "object") return undefined;
  const map = normalized
    ? remapping([generated as SourceMapInput, normalized as SourceMapInput], () => null)
    : generated;
  if (!map || typeof map !== "object") return undefined;
  const published = { ...(map as SourceMap), sourcesContent: undefined };
  delete (published as { sourcesContent?: readonly (string | null)[] }).sourcesContent;
  return published;
}

function resolveGraphImport(
  from: string,
  source: string,
  filenames: ReadonlyMap<string, string>,
): string | undefined {
  if (!source.startsWith(".")) return undefined;
  const base = resolvePath(dirname(from), source);
  const candidates = [base, ...extensions(base), ...extensions(join(base, "index"))];
  for (const candidate of candidates) {
    const resolved = filenames.get(moduleKey(candidate));
    if (resolved) return resolved;
  }
  return undefined;
}

function extensions(base: string): string[] {
  if (extname(base)) return [];
  return [".ts", ".tsx", ".mts", ".js"].map((suffix) => `${base}${suffix}`);
}

function moduleKey(filename: string): string {
  return resolvePath(filename).replaceAll("\\", "/").toLowerCase();
}
