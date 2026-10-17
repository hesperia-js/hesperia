import { dirname, relative, resolve as resolvePath } from "node:path";
import remapping, { type SourceMapInput } from "@jridgewell/remapping";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import {
  analyzeBrowserCapabilities,
  type CapabilityDiagnostic,
  ModuleResolver,
  analyzeRouteModule,
  emitRouteGuardArtifact,
  type RouteDiagnostic,
  type RouteSourceModule,
} from "@hesperia/compiler/tooling";
import type { RouteManifest } from "hesperia/routing";
import { escapeRegExp, sourceKey } from "./utils.ts";

interface PublishedSourceMap {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
  readonly sourcesContent?: readonly (string | null)[];
}

/** Immutable source snapshot and scanner-selected route files for one browser build. */
export interface RouteBuildInput {
  /** Authored project modules from one immutable read snapshot. */
  readonly modules: readonly RouteSourceModule[];
  /** Absolute or snapshot-relative +route.ts paths selected by the route scanner. */
  readonly routeFiles: readonly string[];
}

/** Options for internal route guard bundling. */
export interface RouteBuildOptions {
  /** Project root used by Bun when resolving external package imports. */
  readonly root: string;
  /** Runtime import preserved in generated guard modules. */
  readonly runtimeModule?: string;
  /** Shared browser resolver for package conditions and immutable captured source bytes. */
  readonly resolution?: ModuleResolver;
}

/** One published browser guard bundle and its authored source map. */
export interface PublishedRouteGuard {
  /** Conventional source route represented by this browser guard. */
  readonly routeFilename: string;
  /** URL path assigned to the final bundled guard module. */
  readonly outputUrl: string;
  /** Bundled browser JavaScript. */
  readonly code: string;
  /** Final bundle-to-authored source map without sourcesContent. */
  readonly map: PublishedSourceMap;
}

/** Route guard build output; diagnostics preserve the route/helper owning each span. */
export interface RouteBuildResult {
  readonly guards: readonly PublishedRouteGuard[];
  readonly diagnostics: readonly RouteDiagnostic[];
}

class RouteCapabilityError extends Error {
  readonly diagnostics: readonly RouteDiagnostic[];

  constructor(diagnostics: readonly RouteDiagnostic[]) {
    super("The emitted route guard failed browser capability analysis.");

    this.name = "RouteCapabilityError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Bundle scanner-selected route guards from one immutable source snapshot. Each route is built in
 * its own Bun virtual graph, so shared helper files can retain different selected declarations.
 */
export async function buildRouteGuards(
  input: RouteBuildInput,
  options: RouteBuildOptions,
): Promise<RouteBuildResult> {
  const resolution =
    options.resolution ??
    new ModuleResolver(
      options.root,
      new Map(input.modules.map((module) => [module.filename, module.source])),
      "production",
    );
  let runtimeEntry: ReturnType<ModuleResolver["captureCompilerEntry"]> | undefined;

  try {
    const runtimeFilename = Bun.resolveSync(
      options.runtimeModule ?? "hesperia/runtime",
      import.meta.dir,
    );
    runtimeEntry = resolution.captureCompilerEntry(runtimeFilename);
  } catch {
    // Preserve the existing per-route build diagnostic when an explicitly selected runtime is invalid.
  }

  try {
    resolution.captureCompilerEntry(Bun.resolveSync("hesperia/routing", import.meta.dir));
  } catch {
    // The route bundle reports a compiler routing entry failure against its route filename.
  }

  const runtimeDiagnostics = runtimeEntry
    ? analyzeBrowserCapabilities([...input.modules, runtimeEntry], options.root, resolution, [
        runtimeEntry.filename,
      ])
    : [];
  const buildOptions = { ...options, resolution };
  const sourceByKey = new Map(input.modules.map((item) => [sourceKey(item.filename), item]));
  const diagnostics: RouteDiagnostic[] = [...runtimeDiagnostics];
  const guards: PublishedRouteGuard[] = [];

  if (runtimeDiagnostics.some((item) => item.severity === "error"))
    return { guards: [], diagnostics };

  for (const filename of input.routeFiles) {
    const source = sourceByKey.get(sourceKey(filename));

    if (!source) {
      diagnostics.push({
        code: "HES-ROUTE-SOURCE",
        severity: "error",
        message: "Route source is not present in the immutable module snapshot.",
        span: { start: 0, end: 0 },
        filename,
      });

      continue;
    }

    const analysis = analyzeRouteModule(source.source, {
      filename: source.filename,
      modules: input.modules,
      resolution,
    });

    diagnostics.push(...analysis.diagnostics);

    if (!analysis.artifact || analysis.diagnostics.some((item) => item.severity === "error"))
      continue;

    try {
      guards.push(await bundleGuard(analysis.artifact, source.filename, buildOptions));
    } catch (error) {
      if (error instanceof RouteCapabilityError) {
        diagnostics.push(...error.diagnostics);

        continue;
      }

      diagnostics.push({
        code: "HES-ROUTE-BUILD",
        severity: "error",
        message: `Could not bundle route guard: ${errorMessage(error)}`,
        filename: source.filename,
      });
    }
  }

  return {
    guards: diagnostics.some((item) => item.severity === "error") ? [] : guards,
    diagnostics,
  };
}

/** Flatten scanner-selected route files without evaluating route modules. */
export function routeFilesFromManifest(manifest: RouteManifest): readonly string[] {
  const files: string[] = [];
  const pending = [manifest.root];

  while (pending.length) {
    const node = pending.shift()!;

    if (node.files.route) files.push(node.files.route);

    pending.push(...node.children);
  }

  return files;
}

async function bundleGuard(
  artifact: NonNullable<ReturnType<typeof analyzeRouteModule>["artifact"]>,
  routeFilename: string,
  options: RouteBuildOptions,
): Promise<PublishedRouteGuard> {
  const runtimeModule = options.runtimeModule ?? "hesperia/runtime";
  const routeIdentity = relative(resolvePath(options.root), resolvePath(routeFilename)).replaceAll(
    "\\",
    "/",
  );
  const token = digest(routeIdentity);
  const generatedRuntimeModule = `hesperia:compiler-runtime:${token}`;
  const emitted = emitRouteGuardArtifact(artifact, { runtimeModule, generatedRuntimeModule });
  const runtimeEntry = options.resolution?.captureCompilerEntry(
    Bun.resolveSync(runtimeModule, import.meta.dir),
  );

  if (!options.resolution || !runtimeEntry) throw new Error("Compiler runtime was not captured.");

  const emittedModule = (filename: string) =>
    emitted.modules.find((module) => sourceKey(module.filename) === sourceKey(filename));

  const projectionResolution = {
    resolve(from: string, specifier: string) {
      if (specifier === generatedRuntimeModule && emittedModule(from) !== undefined)
        return options.resolution!.resolveCompilerEntry(from, specifier, runtimeEntry!.filename);

      return options.resolution!.resolve(from, specifier);
    },
  };
  const projectionDiagnostics = analyzeBrowserCapabilities(
    emitted.modules.map((module) => ({ filename: module.filename, source: module.code })),
    options.root,
    projectionResolution,
    [emitted.entryFilename],
  );
  const capabilityErrors = projectionDiagnostics.filter((item) => item.severity === "error");

  if (capabilityErrors.length > 0)
    throw new RouteCapabilityError(
      capabilityErrors.map((item) => mapCapabilityDiagnostic(item, emitted.modules, options)),
    );

  const moduleIds = new Map(
    emitted.modules.map((item, index) => [
      item.filename,
      `hesperia-route-module:${token}:${index}`,
    ]),
  );
  const moduleById = new Map(emitted.modules.map((item) => [moduleIds.get(item.filename)!, item]));

  const compilerOrigin = (importer: string): boolean => {
    const module =
      moduleById.get(importer) ??
      emitted.modules.find((item) => sourceKey(item.filename) === sourceKey(importer));
    return module !== undefined;
  };

  const entryPoint = `hesperia-route-entry:${token}`;
  const entryId = moduleIds.get(emitted.entryFilename);

  if (!entryId) throw new Error(`Route guard entry ${emitted.entryFilename} was not emitted.`);

  const result = await Bun.build({
    entrypoints: [entryPoint],
    root: resolvePath(options.root),
    target: "browser",
    format: "esm",
    conditions: options.resolution ? [...options.resolution.activeConditions] : undefined,
    splitting: false,
    sourcemap: "external",
    naming: { entry: "assets/routes/guard-[hash].[ext]" },
    plugins: [
      {
        name: "hesperia-route-guard",

        setup(builder) {
          builder.onResolve(
            { filter: new RegExp(`^${escapeRegExp(generatedRuntimeModule)}$`, "u") },
            (args) => {
              if (!compilerOrigin(args.importer)) return undefined;

              if (!runtimeEntry) throw new Error("Compiler runtime was not captured.");

              return { path: runtimeEntry.filename, namespace: "hesperia-resolved" };
            },
          );

          builder.onResolve({ filter: /^hesperia-route-entry:/ }, () => ({
            path: entryId,
            namespace: "hesperia-route",
          }));

          // Bun reports imports from plugin-loaded modules with the file namespace during
          // resolution, even though the containing module was loaded in our namespace.
          builder.onResolve({ filter: /^\.{1,2}\// }, (args) => {
            const importer = moduleById.get(args.importer);
            const resolved = importer?.imports.find(
              (item) => item.source === args.path,
            )?.resolvedFilename;
            const path = resolved ? moduleIds.get(resolved) : undefined;
            return path ? { path, namespace: "hesperia-route" } : undefined;
          });

          builder.onResolve({ filter: /.*/u }, (args) => {
            const resolver = options.resolution;

            if (!resolver || !args.importer) return undefined;

            const importerModule = moduleById.get(args.importer);
            const importer = importerModule?.filename ?? args.importer;

            if (
              args.path === generatedRuntimeModule &&
              runtimeEntry &&
              compilerOrigin(args.importer)
            )
              return { path: runtimeEntry.filename, namespace: "hesperia-resolved" };

            const projected = importerModule?.imports.find((item) => item.source === args.path);
            const projectedId = projected?.resolvedFilename
              ? moduleIds.get(projected.resolvedFilename)
              : undefined;

            if (projectedId) return { path: projectedId, namespace: "hesperia-route" };

            const resolved = resolver.resolve(importer, args.path);

            if (resolved.kind === "failure") throw new Error(resolved.message);

            const artifactId = moduleIds.get(resolved.filename);

            if (artifactId) return { path: artifactId, namespace: "hesperia-route" };

            return { path: resolved.filename, namespace: "hesperia-resolved" };
          });

          builder.onLoad({ filter: /.*/u, namespace: "hesperia-resolved" }, ({ path }) => {
            const captured = options.resolution?.capturedSources.find(
              (item) => sourceKey(item.filename) === sourceKey(path),
            );

            if (!captured) throw new Error(`Resolver did not capture module source: ${path}`);

            const extension = path.slice(path.lastIndexOf(".")).toLowerCase();

            if (extension === ".ts" || extension === ".tsx" || extension === ".mts")
              throw new Error(`Captured route dependency has no emitted browser artifact: ${path}`);

            return { contents: captured.source, loader: "js" as const };
          });

          builder.onLoad(
            { filter: /^hesperia-route-module:/, namespace: "hesperia-route" },
            (args) => {
              const module = moduleById.get(args.path);
              return module ? { contents: module.code, loader: "js" } : undefined;
            },
          );
        },
      },
    ],
  });

  if (!result.success) throw new Error(result.logs.map((item) => item.message).join("\n"));

  const output = result.outputs.find((item) => item.kind === "entry-point");
  const sourceMapOutput = result.outputs.find((item) => item.kind === "sourcemap");

  if (!output || !sourceMapOutput)
    throw new Error("Route guard bundle did not produce code and map outputs.");

  const bundleMap = JSON.parse(await sourceMapOutput.text()) as SourceMapInput;
  const moduleMaps = new Map(
    emitted.modules.map((item) => [moduleIds.get(item.filename)!, item.map]),
  );
  const map = stripSourcesContent(
    remapping(
      bundleMap,
      (source) => {
        const moduleId = source.startsWith("hesperia-route:")
          ? source.slice("hesperia-route:".length)
          : source;
        return (moduleMaps.get(moduleId) as SourceMapInput | undefined) ?? null;
      },
      {
        excludeContent: true,
      },
    ),
  );
  const outputPathname = outputUrl(output.path);
  return {
    routeFilename,
    outputUrl: outputPathname,
    code: `${await output.text()}\n//# sourceMappingURL=${outputPathname.slice(outputPathname.lastIndexOf("/") + 1)}.map\n`,
    map,
  };
}

function mapCapabilityDiagnostic(
  diagnostic: CapabilityDiagnostic,
  emitted: readonly { filename: string; code: string; map?: unknown }[],
  options: RouteBuildOptions,
): RouteDiagnostic {
  const module = emitted.find(
    (item) => sourceKey(item.filename) === sourceKey(diagnostic.filename),
  );
  const span = diagnostic.span;

  if (!module?.map || !span) return diagnostic;

  const trace = new TraceMap(module.map as SourceMapInput);
  const start = originalPositionFor(trace, offsetPosition(module.code, span.start));
  const end = originalPositionFor(trace, offsetPosition(module.code, span.end));

  if (!start.source || start.line == null || start.column == null) return diagnostic;

  const sourceFilename = resolvePath(dirname(module.filename), start.source);
  const source = options.resolution?.capturedSources.find(
    (item) => sourceKey(item.filename) === sourceKey(sourceFilename),
  )?.source;
  const mappedStart = source ? positionOffset(source, start.line, start.column) : span.start;
  const mappedEnd =
    source && end.source === start.source && end.line != null && end.column != null
      ? positionOffset(source, end.line, end.column)
      : mappedStart;
  return {
    ...diagnostic,
    filename: sourceFilename,
    span: { start: mappedStart, end: Math.max(mappedStart, mappedEnd) },
  };
}

function offsetPosition(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = prefix.split(/\r?\n/u);
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function positionOffset(source: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 1;

  while (currentLine < line) {
    const newline = source.indexOf("\n", offset);

    if (newline < 0) return source.length;

    offset = newline + 1;
    currentLine += 1;
  }

  const lineEnd = source.indexOf("\n", offset);
  const limit = lineEnd < 0 ? source.length : lineEnd;
  return Math.min(limit, offset + Math.max(0, column));
}

function stripSourcesContent(value: unknown): PublishedSourceMap {
  if (!value || typeof value !== "object")
    throw new Error("Route guard bundle produced an invalid source map.");

  const map = { ...(value as PublishedSourceMap), sourcesContent: undefined };
  delete (map as { sourcesContent?: readonly (string | null)[] }).sourcesContent;
  return map;
}

function outputUrl(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const marker = normalized.indexOf("assets/");
  return `/${marker >= 0 ? normalized.slice(marker) : normalized.replace(/^\.\//u, "")}`;
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
