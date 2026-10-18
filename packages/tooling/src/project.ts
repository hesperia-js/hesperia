import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import remapping, { type SourceMapInput } from "@jridgewell/remapping";
import { parseSync } from "oxc-parser";
import type { NodeHandle } from "typescript/unstable/async";
import {
  generatedPositionFor,
  originalPositionFor,
  sourceContentFor,
  TraceMap,
} from "@jridgewell/trace-mapping";
import {
  analyzeBrowserCapabilities,
  analyzeModule,
  checkProjectModules,
  emitCheckingSession,
  emitAnalysis,
  ModuleResolver,
  openCheckingProject,
  compileProjectModules,
  runtimeKeyRegistry,
  scanRouteFiles,
  type CompilerDiagnostic,
  type VirtualModule,
  type ProjectCompilation,
  type CheckingSession,
} from "@hesperia/compiler/tooling";
import { createHost, type HostingRecordV1 } from "@hesperia/hosting";
import { canonicalizeMountURL } from "@hesperia/hosting/internal";
import { readConfiguration, type ProjectConfiguration } from "./configuration.ts";
import { buildRouteGuards, routeFilesFromManifest } from "./route-build.ts";
import { createRouteTable } from "./route-table.ts";
import { escapeRegExp, isMissingFile, sourceKey } from "./utils.ts";
import { writeProjectTypes } from "./page-types.ts";
import { browserStartupSource, startupModules } from "./startup.ts";
import {
  PluginPipeline,
  generatedStyleFilename,
  hasBuiltinAssetImports,
  type PluginImportProjection,
  type PreparedMarkupStyleImport,
  type PreparedMarkupNativeStyle,
  type PreparedStyleImport,
  type PreparedPluginProjectBody,
  type TransformedPluginSource,
} from "./plugin-pipeline.ts";
import type {
  CapturedProjectSource,
  PluginCheckingSource,
  PluginProjectInput,
  PluginStyleArtifact,
  PluginWatch,
  ProjectTypeQueries,
} from "./plugins.ts";
import { encodePublicValue, projectPublicValues, type PublicWireValue } from "./public-values.ts";
import {
  bundleCssRoots,
  CssBundleError,
  nativeCssResponseType,
  type BundledCss,
} from "./css-bundling.ts";
import { buildStyleTopology, type StyleTopology } from "./style-topology.ts";
import {
  stylePlanSource,
  styleRevisionPlan,
  type StyleLinkMetadata,
  type StyleRevisionPlan,
} from "./style-plan.ts";
import { buildRouteStyleMetadata } from "./route-style-topology.ts";

/** A diagnostic retains its authored file when several modules are checked together. */
export interface ProjectDiagnostic extends CompilerDiagnostic {
  readonly filename: string;
}

/** Browser artifacts are prepared in memory before a successful build is published. */
export interface BrowserBuild {
  /** URL-keyed assets captured before publishing a successful build. */
  readonly files: ReadonlyMap<string, Blob>;
  /** Validated-host input metadata published with the completed build. */
  readonly hosting: HostingRecordV1;
  /** Authored sources and native TypeScript checking inputs used for development watching. */
  readonly sources: readonly string[];
  /** Authored diagnostics retained after successful checking and emission. */
  readonly diagnostics: readonly ProjectDiagnostic[];
  /** Generated styles retain ownership and provenance for the private CSS plan. */
  readonly styles?: readonly PluginStyleArtifact[];
  /** Plugin-owned file and directory inputs for development invalidation. */
  readonly watch?: readonly PluginWatch[];
  /** Private development update boundary; absent unless a complete compiled CSS plan exists. */
  readonly styleRevision?: { readonly semanticKey: string; readonly plan: StyleRevisionPlan };
  /** Private development source ownership used to invalidate removed dependencies. */
  readonly developmentDependencies?: {
    readonly shared: readonly string[];
    readonly routes: readonly { readonly routeId: string; readonly sources: readonly string[] }[];
    readonly assets: Readonly<Record<string, readonly string[]>>;
  };
}

interface GeneratedBrowserSource {
  readonly filename: string;
  readonly source: string;
  readonly semantic: string;
  readonly semanticHash: string;
  readonly authoredFilename?: string;
  readonly sourceMapDigest?: string;
}

/** Refuse a project operation while preserving each compiler diagnostic for display. */
export class ProjectError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly ProjectDiagnostic[] = [],
  ) {
    super(message);

    this.name = "ProjectError";
  }
}

/** Read the root app shell and source modules once for a shared checking/build snapshot. */
export async function readProject(root: string): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();

  for (const name of ["app.tsx", "app.config.ts"]) {
    const filename = resolve(root, name);

    try {
      files.set(filename, await readFile(filename, "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filename = join(directory, entry.name);

      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && /\.(?:ts|tsx|mts)$/.test(entry.name))
        files.set(filename, await readFile(filename, "utf8"));
    }
  }

  await visit(resolve(root, "src"));

  const imports = new Bun.Transpiler({ loader: "tsx" });

  for (const [filename, source] of files) {
    let requests: ReturnType<Bun.Transpiler["scanImports"]>;

    try {
      requests = imports.scanImports(source);
    } catch {
      // The compiler reports syntax errors against the authored source below.
      continue;
    }

    for (const request of requests) {
      if (!request.path.startsWith(".")) continue;

      let dependency: string;

      try {
        dependency = Bun.resolveSync(request.path, dirname(filename));
      } catch {
        // Keep unresolved-import diagnostics in the shared checking pass.
        continue;
      }

      if (!/\.(?:ts|tsx|mts)$/.test(dependency) || files.has(dependency)) continue;

      files.set(dependency, await readFile(dependency, "utf8"));
    }
  }

  return files;
}

/** Check every authored module, including modules not reachable from the browser entry. */
export async function checkSources(
  files: ReadonlyMap<string, string>,
  root = process.cwd(),
  configuration: ProjectConfiguration = {
    allowUnsafeHTML: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
  },
  resolution?: ModuleResolver,
): Promise<readonly ProjectDiagnostic[]> {
  if (
    !configuration.plugins?.length &&
    configuration.public === undefined &&
    !hasBuiltinAssetImports(files)
  )
    return (
      await projectCompilation(files, root, configuration, resolution)
    ).checking.modules.flatMap((module) =>
      module.diagnostics.map((item) => ({ ...item, filename: module.filename })),
    );

  const prepared = await configuredCompilation(files, root, configuration);
  return prepared.diagnostics;
}

/** Check a complete project in its own Bun process when it has executable configuration. */
export async function checkProject(root: string): Promise<readonly ProjectDiagnostic[]> {
  root = resolve(root);

  if (existsSync(join(root, "hesperia.config.ts"))) {
    const { checkInProjectProcess } = await import("./project-worker-client.ts");
    return checkInProjectProcess(root);
  }

  return checkProjectLocal(root);
}

/** Project-root worker entry for a complete check and generated declarations. */
export async function checkProjectLocal(root: string): Promise<readonly ProjectDiagnostic[]> {
  root = resolve(root);
  const sources = await readProject(root);
  const configuration = await readConfiguration(root);
  const diagnostics = await checkSources(sources, root, configuration);

  if (!diagnostics.some((item) => item.code === "HES-ROUTE-SCAN"))
    await writeProjectTypes(root, sources, configuration);

  return diagnostics;
}

/** Checked plugin projections and offset translation for the language server's current revision. */
export interface PreparedPluginEditor {
  /** Sources after import interpretation and ordered transforms. */
  readonly modules: readonly VirtualModule[];
  /** Custom-import declarations supplied to the native checker. */
  readonly additionalFiles: readonly VirtualModule[];
  /** Server-only TypeScript roots retained in this editor revision. */
  readonly checkingRoots: readonly VirtualModule[];
  /** Captured browser resolution shared with command checking. */
  readonly resolution: ModuleResolver;
  /** Authored diagnostics from original TS, transformed checking, and plugins. */
  readonly diagnostics: readonly ProjectDiagnostic[];
  /** Inputs whose changes require a fresh editor revision. */
  readonly watch: readonly PluginWatch[];

  /** Translate an authored cursor offset into the transformed checking source. */
  generatedOffset(filename: string, offset: number): number;

  /** Translate a transformed diagnostic or definition offset to authored text. */
  authoredOffset(filename: string, offset: number): number;

  /** Original import location behind a virtual custom-import declaration. */
  declarationOrigin(filename: string): import("./plugins.ts").PluginOrigin | undefined;

  /** Authored location for a mapped plugin declaration, when its generated span is mapped. */
  declarationLocation(
    filename: string,
    start: number,
    end: number,
  ): { readonly filename: string; readonly start: number; readonly end: number } | undefined;
}

/** Plain data transferred from a project-root worker for one editor revision. */
export interface PreparedPluginEditorWire {
  readonly root: string;
  readonly configuration: Omit<ProjectConfiguration, "plugins" | "public">;
  readonly publicData?: PublicWireValue;
  readonly modules: readonly VirtualModule[];
  readonly additionalFiles: readonly VirtualModule[];
  readonly checkingRoots: readonly VirtualModule[];
  readonly browserSources: readonly VirtualModule[];
  readonly generatedImports: readonly (readonly [string, string])[];
  readonly resolutionOverrides: ProjectConfiguration["resolutionOverrides"];
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly watch: readonly PluginWatch[];
  readonly transformed: readonly TransformedPluginSource[];
  readonly declarationOrigins: readonly (readonly [string, import("./plugins.ts").PluginOrigin])[];
  readonly declarationMaps: readonly (readonly [string, import("./plugins.ts").PluginSourceMap])[];
}

/** Create serializable editor inputs inside the project-root Bun process. */
export async function preparePluginEditorWire(
  files: ReadonlyMap<string, string>,
  root: string,
  configuration: ProjectConfiguration,
): Promise<PreparedPluginEditorWire> {
  const result = await configuredCompilation(files, root, configuration, true);
  return {
    root,
    configuration: {
      allowUnsafeHTML: configuration.allowUnsafeHTML,
      allowUnsafeEmbed: configuration.allowUnsafeEmbed ?? false,
      mountURL: configuration.mountURL,
      resolutionOverrides: configuration.resolutionOverrides,
    },
    ...(configuration.public ? { publicData: encodePublicValue(configuration.public) } : {}),
    modules: [...result.sources].map(([filename, source]) => ({ filename, source })),
    additionalFiles: result.additionalFiles,
    checkingRoots: result.checkingRoots,
    browserSources: result.resolution.capturedSources,
    generatedImports: [...result.generatedImports],
    resolutionOverrides: configuration.resolutionOverrides,
    diagnostics: result.diagnostics,
    watch: [
      ...result.pipeline.watch,
      ...result.pipeline.capturedFiles.map(
        (item) => ({ kind: "file", file: item.filename }) as const,
      ),
    ],
    transformed: [...result.transformed.values()],
    declarationOrigins: result.projections.map(
      (projection) =>
        [sourceKey(projection.declarationFilename), projection.result.declaration.origin] as const,
    ),
    declarationMaps: result.projections.flatMap((projection) =>
      projection.result.declaration.map
        ? [[sourceKey(projection.declarationFilename), projection.result.declaration.map] as const]
        : [],
    ),
  };
}

/** Recreate native checker resolution and offset translation from a worker result. */
export function hydratePluginEditor(wire: PreparedPluginEditorWire): PreparedPluginEditor {
  const transformed = new Map(wire.transformed.map((item) => [item.filename, item]));
  const resolution = new ModuleResolver(
    wire.root,
    new Map([...wire.modules, ...wire.browserSources].map((item) => [item.filename, item.source])),
    "development",
    wire.resolutionOverrides.browser,
    new Map(wire.generatedImports),
  );
  const origins = new Map(wire.declarationOrigins);
  const declarationMaps = new Map(wire.declarationMaps);
  const declarationSources = new Map(
    wire.additionalFiles.map(({ filename, source }) => [sourceKey(filename), source] as const),
  );
  return {
    modules: wire.modules,
    additionalFiles: wire.additionalFiles,
    checkingRoots: wire.checkingRoots,
    resolution,
    diagnostics: wire.diagnostics,
    watch: wire.watch,

    generatedOffset(filename, offset) {
      const source = transformed.get(filename) ?? mappedPluginSource(transformed, filename);
      return source ? pluginGeneratedOffset(source, offset) : offset;
    },

    authoredOffset(filename, offset) {
      const source = transformed.get(filename) ?? mappedPluginSource(transformed, filename);
      return source ? pluginOriginalOffset(source, offset) : offset;
    },

    declarationOrigin(filename) {
      return origins.get(sourceKey(filename));
    },

    declarationLocation(filename, start, end) {
      const key = sourceKey(filename);
      const map = declarationMaps.get(key);
      const source = declarationSources.get(key);
      return map && source
        ? mapPluginDeclarationLocation(map, source, filename, start, end)
        : undefined;
    },
  };
}

function mappedPluginSource(
  transformed: ReadonlyMap<string, TransformedPluginSource>,
  filename: string,
): TransformedPluginSource | undefined {
  for (const source of transformed.values()) {
    if (samePluginSource(source.filename, filename)) return source;
  }

  return undefined;
}

/** Prepare configured editor inputs using the same captured plugin stages as commands. */
export async function preparePluginEditor(
  files: ReadonlyMap<string, string>,
  root: string,
  configuration: ProjectConfiguration,
): Promise<PreparedPluginEditor> {
  return hydratePluginEditor(await preparePluginEditorWire(files, root, configuration));
}

/** Compile and bundle a browser application without writing partial output on failure. */
export async function prepareBuild(root: string, development = false): Promise<BrowserBuild> {
  root = resolve(root);

  if (existsSync(join(root, "hesperia.config.ts"))) {
    const { buildInProjectProcess } = await import("./project-worker-client.ts");
    return buildInProjectProcess(root, development);
  }

  return prepareBuildLocal(root, development);
}

/** Project-root worker entry; plugin closures never cross this boundary. */
export async function prepareBuildLocal(root: string, development = false): Promise<BrowserBuild> {
  root = resolve(root);

  if (!development) await cleanUnpublishedCaptures(root);

  const configuration = await readConfiguration(root);
  const authored = await readProject(root);
  const projectRuntimeModule = `hesperia:compiler-runtime:project:${new Bun.CryptoHasher("sha256")
    .update(root)
    .digest("hex")
    .slice(0, 16)}`;
  const configured = await configuredCompilation(
    authored,
    root,
    configuration,
    development,
    projectRuntimeModule,
  );
  const sources = configured?.sources ?? authored;
  const resolution =
    configured?.resolution ??
    new ModuleResolver(
      root,
      sources,
      development ? "development" : "production",
      configuration.resolutionOverrides.browser,
    );
  const runtimeFilename = Bun.resolveSync("hesperia/runtime", root);
  const runtimeEntry = resolution.captureCompilerEntry(runtimeFilename);
  const runtimeDiagnostics = analyzeBrowserCapabilities(
    [...[...sources].map(([filename, source]) => ({ filename, source })), runtimeEntry],
    root,
    resolution,
    [runtimeEntry.filename],
  );
  const compilation =
    configured?.compilation ??
    (await projectCompilation(sources, root, configuration, resolution, projectRuntimeModule));
  const diagnostics = [
    ...runtimeDiagnostics,
    ...(configured?.diagnostics ?? []),
    ...compilation.checking.modules.flatMap((module) =>
      module.diagnostics.map((item) => ({
        ...item,
        filename: diagnosticFilename(item, module.filename),
      })),
    ),
  ];
  const styles = configured?.styles ?? [];

  if (diagnostics.some((item) => item.severity === "error"))
    throw new ProjectError("Hesperia checking failed", diagnostics);

  if (!diagnostics.some((item) => item.code === "HES-ROUTE-SCAN"))
    await writeProjectTypes(root, sources, configuration);

  const routeRoot = resolve(root, "src/routes");
  const manifest = scanRouteFiles(
    routeRoot,
    [...sources.keys()].filter((path) => path.startsWith(`${routeRoot}${sep}`)),
  );
  const routeDeclarations = new Set<string>();
  const pendingRoutes = [manifest.root];

  for (const node of pendingRoutes) {
    if (node.files.route) routeDeclarations.add(node.files.route);

    pendingRoutes.push(...node.children);
  }

  const routeBuild = await buildRouteGuards(
    {
      modules: [...sources].map(([filename, source]) => ({ filename, source })),
      routeFiles: routeFilesFromManifest(manifest),
    },
    { root, resolution },
  );

  diagnostics.push(...routeBuild.diagnostics);

  if (diagnostics.some((item) => item.severity === "error"))
    throw new ProjectError("Hesperia route guard build failed", diagnostics);

  const routeGuardUrls = new Map(
    routeBuild.guards.map((guard) => [sourceKey(guard.routeFilename), guard.outputUrl]),
  );
  const guardAssetUrls = new Set(routeBuild.guards.map((guard) => guard.outputUrl));
  const shellEntrypoint = join(root, "app.tsx");

  if (!sources.has(shellEntrypoint))
    throw new ProjectError("The browser application requires a root app.tsx shell");

  const routeStyleMetadata = configured?.styleTopology
    ? buildRouteStyleMetadata(root, manifest, configured.styleTopology)
    : undefined;
  const routeTable = createRouteTable({
    manifest,
    root,
    guardUrls: routeGuardUrls,
    ...(routeStyleMetadata ? { styleMetadata: routeStyleMetadata } : {}),
  });
  const configurationEntrypoint = join(root, "app.config.ts");
  const mainEntrypoint = join(root, ".hesperia", "main.ts");
  const routeTableEntrypoint = join(root, ".hesperia", "route-table.ts");
  const generatedRoot = join(root, ".hesperia", "generated");
  const startupEmission = emitGeneratedModule(
    browserStartupSource(sources.has(configurationEntrypoint), projectRuntimeModule),
    join(generatedRoot, "startup.js"),
    projectRuntimeModule,
  );
  const routeTableEmission = emitGeneratedModule(
    routeTable.code,
    join(generatedRoot, "route-table.js"),
    projectRuntimeModule,
  );
  const startup = startupEmission.code;
  const compiledMaps = new Map<string, SourceMapInput>();

  for (const projection of configured?.projections ?? []) {
    if (projection.result.browser.map)
      recordCompiledMap(
        projection.browserFilename,
        projection.result.browser.map as SourceMapInput,
        compiledMaps,
      );
  }

  const generatedSources = new Map<string, GeneratedBrowserSource>();
  const preparedMarkupProjectionSources = new Set(
    (configured?.projections ?? [])
      .filter((projection) => projection.markup !== undefined)
      .map((projection) => sourceKey(projection.browserFilename)),
  );
  const authoredGeneratedPaths = new Map<string, string>();
  const generatedSourceOrigins = new Map<string, string>();
  const generatedSpecifiers = new Map<string, string>();
  const compiledGeneratedPaths = new Map<string, string>();

  const captureGenerated = (
    filename: string,
    source: string,
    semantic: string,
    semanticHash: string,
    authoredFilename?: string,
    sourceMapDigest?: string,
  ): string => {
    const captured = resolution.captureGeneratedSource(filename, source);
    const item: GeneratedBrowserSource = {
      filename: captured.filename,
      source: captured.source,
      semantic,
      semanticHash,
      ...(authoredFilename ? { authoredFilename } : {}),
      ...(sourceMapDigest ? { sourceMapDigest } : {}),
    };

    generatedSources.set(sourceKey(captured.filename), item);

    if (authoredFilename) {
      authoredGeneratedPaths.set(sourceKey(authoredFilename), captured.filename);

      generatedSourceOrigins.set(sourceKey(captured.filename), authoredFilename);
    }

    return captured.filename;
  };

  const sourceToken = (value: string): string =>
    new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);

  const generatedStartupFilename = captureGenerated(
    join(generatedRoot, "startup.js"),
    startup,
    "startup",
    startupEmission.semanticHash,
  );
  const generatedRouteTableFilename = captureGenerated(
    join(generatedRoot, "route-table.js"),
    routeTableEmission.code,
    "route-table",
    routeTableEmission.semanticHash,
  );

  if (configured?.styleRuntimeModule && configured.bundledCss && configured.styleTopology) {
    const source = stylePlanSource(
      configured.bundledCss,
      configured.styleTopology,
      projectRuntimeModule,
      development,
      routeStyleMetadata?.compositions,
      new Map(configured.markupStyleMetadata.map(({ styleId, link }) => [styleId, link])),
    );

    generatedSpecifiers.set(
      configured.styleRuntimeModule,
      captureGenerated(
        join(generatedRoot, "style-plan.js"),
        source,
        "style-plan",
        sourceToken(source),
      ),
    );
  }

  generatedSpecifiers.set(startupModules.shell, captureCompiledGenerated(shellEntrypoint));

  if (sources.has(configurationEntrypoint))
    generatedSpecifiers.set(
      startupModules.configuration,
      captureCompiledGenerated(configurationEntrypoint),
    );

  generatedSpecifiers.set(startupModules.routes, generatedRouteTableFilename);

  for (const [specifier, filename] of routeTable.modules)
    generatedSpecifiers.set(specifier, captureCompiledGenerated(filename));

  for (const guard of routeBuild.guards)
    (() => {
      const captured = captureGenerated(
        join(generatedRoot, "guards", `${sourceToken(guard.outputUrl)}.js`),
        guard.code,
        "route-guard",
        emitGeneratedModule(guard.code, guard.routeFilename, projectRuntimeModule).semanticHash,
        guard.routeFilename,
        digestJson(guard.map),
      );

      generatedSpecifiers.set(guard.outputUrl, captured);

      generatedSpecifiers.set(`./routes/${basename(guard.outputUrl)}`, captured);
    })();

  for (const body of configured?.projectBodies ?? []) {
    const captured = resolution.captureGeneratedSource(body.filename, body.source);
    const semanticHash = sourceToken(body.source);

    generatedSources.set(sourceKey(captured.filename), {
      filename: captured.filename,
      source: captured.source,
      semantic: "plugin-project",
      semanticHash,
      authoredFilename: body.origin.filename,
      ...(body.map ? { sourceMapDigest: digestJson(body.map) } : {}),
    });

    generatedSpecifiers.set(body.id, captured.filename);

    if (body.map) recordCompiledMap(body.filename, body.map as SourceMapInput, compiledMaps);
  }

  function captureCompiledGenerated(filename: string): string {
    const existing = compiledGeneratedPaths.get(sourceKey(filename));

    if (existing) return existing;

    const compiled = compilation.modules.get(filename);

    if (!compiled)
      throw new ProjectError(
        `Compilation was not emitted for checked module: ${filename}`,
        diagnostics,
      );

    if (compiled.map) recordCompiledMap(filename, compiled.map as SourceMapInput, compiledMaps);

    const generated = captureGenerated(
      join(generatedRoot, "modules", `${sourceToken(filename)}.js`),
      compiled.code,
      "compiled-module",
      compiled.semanticHash,
      filename,
      compiled.map ? digestJson(compiled.map) : undefined,
    );

    compiledGeneratedPaths.set(sourceKey(filename), generated);

    return generated;
  }

  for (const filename of compilation.modules.keys()) captureCompiledGenerated(filename);

  const generatedResolution = {
    resolve(from: string, specifier: string) {
      if (configured?.publicFilename && specifier === "hesperia/config/public")
        return resolution.resolveGeneratedEntry(from, specifier, configured.publicFilename);

      const generated = generatedSources.get(sourceKey(from));

      if (generated && specifier === projectRuntimeModule)
        return resolution.resolveCompilerEntry(from, specifier, runtimeEntry.filename);

      if (generated && specifier === configured?.styleRuntimeModule) {
        const target = generatedSpecifiers.get(specifier);

        if (target) return resolution.resolveGeneratedEntry(from, specifier, target);
      }

      if (generated?.semantic === "plugin-project") {
        const target = generatedSpecifiers.get(specifier);

        if (target) return resolution.resolveGeneratedEntry(from, specifier, target);
      }

      if (generated && (generated.semantic === "startup" || generated.semantic === "route-table")) {
        const target = generatedSpecifiers.get(specifier);

        if (target) return resolution.resolveGeneratedEntry(from, specifier, target);
      }

      if (generated?.authoredFilename) {
        const resolved = resolution.resolve(generated.authoredFilename, specifier);

        if (resolved.kind === "resolved") {
          const generatedTarget = authoredGeneratedPaths.get(sourceKey(resolved.filename));

          if (generatedTarget)
            return resolution.resolveGeneratedEntry(from, specifier, generatedTarget);
        }

        return resolved;
      }

      return resolution.resolve(from, specifier);
    },
  };
  const generatedDiagnostics = analyzeBrowserCapabilities(
    [...generatedSources.values()].map((item) => ({
      filename: item.filename,
      source: item.source,
    })),
    root,
    generatedResolution,
    [generatedStartupFilename],
  );

  diagnostics.push(...generatedDiagnostics.map((item) => ({ ...item, filename: item.filename })));

  if (generatedDiagnostics.some((item) => item.severity === "error")) {
    throw new ProjectError("Generated browser module checking failed", diagnostics);
  }

  const markupResources = new Map<string, string>();

  for (const projection of configured?.projections ?? []) {
    const token = basename(projection.browserFilename, ".js");

    for (let index = 0; index < (projection.markup?.resources.length ?? 0); index++)
      markupResources.set(
        `hesperia:markup-resource:${token}:${index}`,
        projection.markup!.resources[index]!,
      );
  }

  const result = await Bun.build({
    entrypoints: [mainEntrypoint, routeTableEntrypoint],
    root,
    target: "browser",
    format: "esm",
    conditions: [...resolution.activeConditions],
    publicPath: "",
    define: { __HESPERIA_DEV__: String(development) },
    naming: {
      entry: "assets/[name]-[hash].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    splitting: true,
    sourcemap: "linked",
    metafile: true,
    plugins: [
      {
        name: "hesperia",

        setup(builder) {
          builder.onResolve({ filter: /^hesperia:markup-resource:/u }, ({ path }) => {
            const filename = markupResources.get(path);
            return filename ? { path: filename, namespace: "hesperia-markup-resource" } : undefined;
          });

          builder.onLoad(
            { filter: /.*/u, namespace: "hesperia-markup-resource" },
            async ({ path }) => {
              const file = configured?.pipeline.capturedFiles.find(
                (item) => sourceKey(item.filename) === sourceKey(path),
              );

              if (!file)
                throw new ProjectError(`Markup resource was not captured: ${path}`, diagnostics);

              return {
                contents: new Uint8Array(await file.blob.arrayBuffer()),
                loader: "file",
                resolveDir: dirname(path),
              };
            },
          );

          if (configured?.publicFilename)
            builder.onResolve({ filter: /^hesperia\/config\/public$/u }, () => ({
              path: configured.publicFilename!,
              namespace: "hesperia-resolved",
            }));

          // Generated modules share the runtime shipped with this compiler, including
          // when project checking runs before the application's dependency install.
          builder.onResolve(
            { filter: new RegExp(`^${escapeRegExp(projectRuntimeModule)}$`, "u") },
            ({ importer }) =>
              importer && generatedSources.has(sourceKey(importer))
                ? {
                    path: runtimeEntry.filename,
                    namespace: "hesperia-resolved",
                  }
                : undefined,
          );

          if (configured?.styleRuntimeModule)
            builder.onResolve(
              { filter: new RegExp(`^${escapeRegExp(configured.styleRuntimeModule)}$`, "u") },
              ({ importer }) => {
                const importerKey = importer ? sourceKey(importer) : undefined;

                if (
                  !importerKey ||
                  (!generatedSources.has(importerKey) &&
                    !preparedMarkupProjectionSources.has(importerKey))
                )
                  throw new ProjectError(
                    "The private style plan may only be imported by generated Hesperia modules.",
                    diagnostics,
                  );

                const target = generatedSpecifiers.get(configured.styleRuntimeModule!);

                if (!target)
                  throw new ProjectError(
                    "The generated browser style plan is unavailable.",
                    diagnostics,
                  );

                return { path: target, namespace: "hesperia-generated" };
              },
            );

          builder.onResolve({ filter: /main\.ts$/u }, ({ path }) => {
            if (sourceKey(path) !== sourceKey(mainEntrypoint)) return undefined;

            return { path: generatedStartupFilename, namespace: "hesperia-generated" };
          });

          builder.onResolve({ filter: /^hesperia-app-/u }, ({ path, importer }) => {
            const generatedImporter = importer
              ? generatedSources.get(sourceKey(importer))
              : undefined;

            if (generatedImporter?.semantic !== "startup") return undefined;

            const target = generatedSpecifiers.get(path);
            return target ? { path: target, namespace: "hesperia-generated" } : undefined;
          });

          builder.onResolve({ filter: /route-table\.ts$/u }, ({ path }) => {
            if (sourceKey(path) !== sourceKey(routeTableEntrypoint)) return undefined;

            return { path: generatedRouteTableFilename, namespace: "hesperia-generated" };
          });

          builder.onResolve({ filter: /^hesperia-route-module:/u }, ({ path, importer }) => {
            const generatedImporter = importer
              ? generatedSources.get(sourceKey(importer))
              : undefined;

            if (generatedImporter?.semantic !== "route-table") return undefined;

            const target = generatedSpecifiers.get(path);
            return target ? { path: target, namespace: "hesperia-generated" } : undefined;
          });

          builder.onResolve({ filter: /^\.\//u }, ({ path, importer }) => {
            const generatedImporter = importer
              ? generatedSources.get(sourceKey(importer))
              : undefined;
            return generatedImporter?.semantic === "route-table" && generatedSpecifiers.has(path)
              ? { path, external: true }
              : undefined;
          });

          builder.onResolve({ filter: /^\/assets\/routes\//u }, ({ path }) =>
            guardAssetUrls.has(path) ? { path, external: true } : undefined,
          );

          builder.onResolve({ filter: /.*/u }, ({ path, importer }) => {
            if (!importer) return undefined;

            const generated = generatedSources.get(sourceKey(importer));
            const from = generated?.authoredFilename ?? importer;
            const resolved = resolution.resolve(from, path);

            if (resolved.kind === "failure") throw new ProjectError(resolved.message, diagnostics);

            const generatedTarget = authoredGeneratedPaths.get(sourceKey(resolved.filename));
            return generatedTarget
              ? { path: generatedTarget, namespace: "hesperia-generated" }
              : { path: resolved.filename, namespace: "hesperia-resolved" };
          });

          builder.onLoad({ filter: /.*/u, namespace: "hesperia-generated" }, ({ path }) => {
            const generated = generatedSources.get(sourceKey(path));

            if (!generated)
              throw new ProjectError(
                `Generated browser module was not captured: ${path}`,
                diagnostics,
              );

            return { contents: generated.source, loader: "js", resolveDir: root };
          });

          builder.onLoad({ filter: /.*/u, namespace: "hesperia-resolved" }, ({ path }) => {
            if (routeDeclarations.has(path)) {
              diagnostics.push({
                code: "HES-ROUTE-SERVER",
                severity: "error",
                filename: path,
                message:
                  "Route declarations are server-only; browser code must not import +route.ts. Only the separately extracted guard may enter the browser.",
              });

              throw new ProjectError(`Server-only route import: ${path}`, diagnostics);
            }

            return loadResolvedSource(
              path,
              sources,
              compilation,
              compiledMaps,
              resolution,
              diagnostics,
            );
          });

          builder.onLoad({ filter: /\.(?:ts|tsx|mts)$/ }, async ({ path }) => {
            const source = sources.get(path);

            if (source === undefined) return undefined;

            if (routeDeclarations.has(path)) {
              diagnostics.push({
                code: "HES-ROUTE-SERVER",
                severity: "error",
                filename: path,
                message:
                  "Route declarations are server-only; browser code must not import +route.ts. Only the separately extracted guard may enter the browser.",
              });

              throw new ProjectError(`Server-only route import: ${path}`, diagnostics);
            }

            return loadCompiledSource(path, compilation, compiledMaps, diagnostics);
          });
        },
      },
    ],
  }).catch((error: unknown) => {
    if (diagnostics.some((item) => item.severity === "error"))
      throw new ProjectError("Hesperia browser compilation failed", diagnostics);

    throw error;
  });

  if (!result.success)
    throw new ProjectError(result.logs.map((item) => item.message).join("\n"), diagnostics);

  const entry = entryArtifact(result, root, generatedStartupFilename);
  const routeTableEntry = entryArtifact(result, root, generatedRouteTableFilename);
  const files = new Map<string, Blob>();

  for (const [path, artifact] of configured?.bundledCss?.files ?? [])
    files.set(path, new Blob([await artifact.arrayBuffer()], { type: artifact.type }));

  for (const style of styles) {
    const name = new Bun.CryptoHasher("sha256")
      .update(`${style.id}\0${style.css}`)
      .digest("hex")
      .slice(0, 20);
    const path = `/assets/plugin-${name}.css`;

    files.set(
      path,
      new Blob(
        [style.css, ...(style.map ? [`\n/*# sourceMappingURL=plugin-${name}.css.map */\n`] : [])],
        { type: "text/css; charset=utf-8" },
      ),
    );

    if (style.map)
      files.set(`${path}.map`, new Blob([JSON.stringify(style.map)], { type: "application/json" }));
  }

  for (const guard of routeBuild.guards) {
    files.set(guard.outputUrl, new Blob([guard.code], { type: "text/javascript; charset=utf-8" }));

    files.set(
      `${guard.outputUrl}.map`,
      new Blob([JSON.stringify(guard.map)], { type: "application/json" }),
    );
  }

  for (const artifact of result.outputs)
    files.set(
      outputPath(artifact.path),
      new Blob([await artifact.arrayBuffer()], { type: artifact.type }),
    );

  for (const artifact of result.outputs) {
    if (artifact.kind !== "sourcemap") continue;

    const map = JSON.parse(await artifact.text()) as SourceMapInput;
    const composed = remapping(
      map,
      (source, context) => {
        if (context.depth !== 1) return null;

        const filename = source.startsWith("hesperia-resolved:")
          ? source.slice("hesperia-resolved:".length)
          : source.startsWith("hesperia-generated:")
            ? source.slice("hesperia-generated:".length)
            : source;
        const origin = generatedSourceOrigins.get(sourceKey(filename));

        if (origin)
          return compiledMaps.get(origin) ?? compiledMaps.get(origin.replaceAll("/", "\\"));

        const candidate = resolve(filename);
        return compiledMaps.get(candidate) ?? compiledMaps.get(candidate.replaceAll("/", "\\"));
      },
      { excludeContent: false },
    );

    files.set(
      outputPath(artifact.path),
      new Blob([JSON.stringify(composed)], { type: "application/json" }),
    );
  }

  const hosting: HostingRecordV1 = Object.freeze({
    version: 1,
    mode: development ? "development" : "production",
    standaloneMountURL: configuration.mountURL,
    startupAsset: outputPath(entry.path),
    assets: Object.freeze(
      await Promise.all(
        [...files]
          .filter(([path]) => path.startsWith("/assets/"))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(async ([path, blob]) => ({
            path,
            sha256: new Bun.CryptoHasher("sha256")
              .update(new Uint8Array(await blob.arrayBuffer()))
              .digest("hex"),
            contentType:
              (configured?.bundledCss
                ? nativeCssResponseType(configured.bundledCss.files, path)
                : undefined) ?? assetContentType(path, blob.type),
          })),
      ),
    ),
  });
  const checkingInputs = [...compilation.checking.checkingInputs].sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );
  const record = {
    version: 1,
    target: "browser",
    hosting,
    resolution: {
      mode: resolution.mode,
      activeConditions: resolution.activeConditions,
      overrides: resolution.resolutionOverrides,
      runtimeKeyRegistry,
      capturedSources: resolution.capturedSources.map((item) => ({
        filename: recordFilename(root, item.filename),
        digest: item.digest,
      })),
      capturedManifests: resolution.capturedManifests.map((item) => ({
        filename: recordFilename(root, item.filename),
        digest: item.digest,
      })),
      edges: resolution.capturedEdges.map((item) => ({
        from: recordFilename(root, item.from),
        specifier: item.specifier,
        outcome: item.outcome,
        ...(item.resolvedFilename
          ? { resolvedFilename: recordFilename(root, item.resolvedFilename) }
          : {}),
        ...(item.conditionPath ? { conditionPath: item.conditionPath } : {}),
        ...(item.failureCode ? { failureCode: item.failureCode } : {}),
      })),
      generatedSources: [...generatedSources.values()].map((item) => ({
        filename: recordFilename(root, item.filename),
        semantic: item.semantic,
        semanticHash: item.semanticHash,
        ...(item.authoredFilename
          ? { authoredFilename: recordFilename(root, item.authoredFilename) }
          : {}),
        digest: resolution.capturedSources.find(
          (captured) => sourceKey(captured.filename) === sourceKey(item.filename),
        )?.digest,
        ...(item.sourceMapDigest ? { sourceMapDigest: item.sourceMapDigest } : {}),
      })),
    },
    checkingInputs: checkingInputs.map((item) => ({
      filename: recordFilename(root, item.filename),
      digest: item.digest,
    })),
    configuration: configuration.plugins
      ? {
          allowUnsafeHTML: configuration.allowUnsafeHTML,
          allowUnsafeEmbed: configuration.allowUnsafeEmbed ?? false,
          mountURL: configuration.mountURL,
          resolutionOverrides: configuration.resolutionOverrides,
          plugins: configuration.plugins.map((plugin) => plugin.name),
        }
      : configuration,
    modules: [...sources].map(([filename, source]) => ({
      filename: relative(root, filename).replaceAll("\\", "/"),
      digest: `sha256-${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`,
    })),
    routeGuards: Object.fromEntries(
      routeBuild.guards.map((guard) => [
        relative(root, guard.routeFilename).replaceAll("\\", "/"),
        guard.outputUrl,
      ]),
    ),
    routeTable: outputPath(routeTableEntry.path),
  };

  files.set(
    "/hesperia-build.json",
    new Blob([JSON.stringify(record, null, 2) + "\n"], { type: "application/json" }),
  );

  const styleRevision =
    development &&
    configured?.styleRuntimeModule &&
    configured.bundledCss &&
    configured.styleTopology
      ? {
          semanticKey: styleSemanticKey(
            root,
            configuration,
            sources,
            resolution,
            generatedSources,
            configured,
          ),
          plan: styleRevisionPlan(
            configured.bundledCss,
            configured.styleTopology,
            routeStyleMetadata?.compositions,
            new Map(configured.markupStyleMetadata.map(({ styleId, link }) => [styleId, link])),
          ),
        }
      : undefined;
  let developmentDependencies: BrowserBuild["developmentDependencies"];

  if (development) {
    const aliases = new Map<string, string>();

    for (const generated of generatedSources.values())
      if (generated.authoredFilename)
        aliases.set(sourceKey(generated.filename), sourceKey(generated.authoredFilename));

    for (const projection of configured?.projections ?? []) {
      aliases.set(sourceKey(projection.browserFilename), sourceKey(projection.filename));

      aliases.set(sourceKey(projection.declarationFilename), sourceKey(projection.filename));
    }

    const original = (filename: string): string => {
      const path = filename.replace(/^hesperia-(?:generated|resolved|markup-resource):/u, "");
      return aliases.get(sourceKey(path)) ?? sourceKey(path);
    };

    const dependencies = new Map<string, Set<string>>();

    const add = (from: string, to: string): void => {
      const source = original(from);
      const targets = dependencies.get(source) ?? new Set<string>();

      targets.add(original(to));

      dependencies.set(source, targets);
    };

    for (const edge of resolution.capturedEdges)
      if (edge.resolvedFilename) add(edge.from, edge.resolvedFilename);

    for (const projection of configured?.projections ?? []) {
      add(projection.importer, projection.filename);

      for (const resource of projection.markup?.resources ?? []) add(projection.filename, resource);

      for (const watch of projection.result.watch ?? [])
        if (watch.kind === "file") add(projection.filename, watch.file);
    }

    for (const imported of configured?.styleImports ?? [])
      add(imported.importer, imported.filename);

    for (const ownership of configured?.pipeline.watchOwnership.sources ?? [])
      for (const filename of ownership.files) add(ownership.source, filename);

    for (const css of configured?.bundledCss?.roots ?? []) {
      for (const dependency of css.dependencies) add(css.source, dependency);

      const generated = styles.find((style) => `generated:${style.id}` === css.id);

      if (generated) {
        const owner =
          generated.owner.kind === "application"
            ? shellEntrypoint
            : generated.owner.id.slice(0, generated.owner.id.lastIndexOf("#"));

        add(owner, css.source);

        add(owner, generated.origin.filename);
      }
    }

    const closure = (seeds: readonly string[]): readonly string[] => {
      const pending = seeds.map(original);
      const found = new Set<string>();

      while (pending.length) {
        const filename = pending.pop()!;

        if (found.has(filename)) continue;

        found.add(filename);

        pending.push(...(dependencies.get(filename) ?? []));
      }

      return [...found];
    };

    const shared = closure([
      shellEntrypoint,
      ...(sources.has(configurationEntrypoint) ? [configurationEntrypoint] : []),
      ...(configured?.pipeline.watchOwnership.project ?? []),
    ]);
    const routes: { routeId: string; sources: readonly string[] }[] = [];

    const visit = (
      node: typeof manifest.root,
      ancestors: readonly (typeof manifest.root)[],
    ): void => {
      const chain = [...ancestors, node];

      routes.push({
        routeId: node.id,
        sources: closure(
          chain.flatMap((item) =>
            Object.values(item.files).filter((value): value is string => typeof value === "string"),
          ),
        ),
      });

      for (const child of node.children) visit(child, chain);
    };

    visit(manifest.root, []);

    const assets: Record<string, readonly string[]> = {};

    for (const [path, output] of Object.entries(result.metafile?.outputs ?? {}))
      assets[outputPath(path)] = closure(Object.keys(output.inputs));

    for (const css of configured?.bundledCss?.roots ?? [])
      for (const path of css.outputs) assets[path] = closure([css.source]);

    developmentDependencies = { shared, routes, assets };
  }

  return {
    files,
    hosting,
    sources: Object.freeze([
      ...sources.keys(),
      ...checkingInputs.map((item) => item.filename),
      ...(configured?.pipeline.capturedFiles.map((item) => item.filename) ?? []),
      ...(configured?.pipeline.watch
        .filter((item) => item.kind === "file")
        .map((item) => item.file) ?? []),
    ]),
    diagnostics,
    ...(styleRevision ? { styleRevision } : {}),
    ...(developmentDependencies ? { developmentDependencies } : {}),
    ...(configured ? { styles, watch: configured.pipeline.watch } : {}),
  };
}

function styleSemanticKey(
  root: string,
  configuration: ProjectConfiguration,
  sources: ReadonlyMap<string, string>,
  resolution: ModuleResolver,
  generatedSources: ReadonlyMap<string, GeneratedBrowserSource>,
  configured: ConfiguredCompilation,
): string {
  const sorted = <T extends { readonly filename: string }>(items: readonly T[]): readonly T[] =>
    [...items].sort((a, b) => a.filename.localeCompare(b.filename));

  const generatedPaths = new Set(generatedSources.keys());
  const cssRootPaths = new Set(configured.styleImports.map((item) => sourceKey(item.filename)));
  const cssAssetPaths = new Set(
    configured.styles.flatMap((style) =>
      (style.assetReferences ?? []).map((reference) => sourceKey(reference.filename)),
    ),
  );
  const payload = {
    root,
    configSource: ["hesperia.config.ts", "hesperia.config.json"]
      .map((name) => join(root, name))
      .filter((filename) => existsSync(filename))
      .map((filename) => ({ filename, source: readFileSync(filename, "utf8") })),
    configuration: {
      allowUnsafeHTML: configuration.allowUnsafeHTML,
      allowUnsafeEmbed: configuration.allowUnsafeEmbed,
      mountURL: configuration.mountURL,
      resolutionOverrides: configuration.resolutionOverrides,
      plugins: configuration.plugins?.map((plugin) => plugin.name),
      public: configuration.public,
    },
    authored: sorted([...sources].map(([filename, source]) => ({ filename, source }))),
    generated: sorted(
      [...generatedSources.values()]
        .filter((item) => item.semantic !== "style-plan")
        .map((item) => ({ filename: item.filename, source: item.source })),
    ),
    resolved: sorted(
      resolution.capturedSources
        .filter((item) => !generatedPaths.has(sourceKey(item.filename)))
        .map((item) => ({ filename: item.filename, digest: item.digest })),
    ),
    manifests: sorted(
      resolution.capturedManifests.map((item) => ({
        filename: item.filename,
        digest: item.digest,
      })),
    ),
    checkingInputs: sorted(
      configured.compilation.checking.checkingInputs.map((item) => ({
        filename: item.filename,
        digest: item.digest,
      })),
    ),
    projections: configured.projections.map((item) => ({
      filename: item.browserFilename,
      browser: item.result.browser.code,
      declaration: item.result.declaration.code,
    })),
    capturedNonCss: sorted(
      configured.pipeline.capturedFiles
        .filter(
          (item) =>
            !item.filename.toLowerCase().endsWith(".css") &&
            !cssRootPaths.has(sourceKey(item.filename)) &&
            !cssAssetPaths.has(sourceKey(item.filename)),
        )
        .map((item) => ({ filename: item.filename, digest: item.digest })),
    ),
    topology: configured.styleTopology,
  };
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex");
}

function outputPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/assets/");

  if (index >= 0) return canonicalizeMountURL(normalized.slice(index));

  if (normalized.startsWith("assets/")) return canonicalizeMountURL(`/${normalized}`);

  throw new ProjectError(`Unexpected browser artifact path: ${path}`);
}

function assetContentType(path: string, type: string): string {
  if (type) return type;

  const extension = path.split(".").at(-1)?.toLowerCase();

  if (extension === "css") return "text/css; charset=utf-8";

  if (extension === "js" || extension === "mjs") return "text/javascript; charset=utf-8";

  if (extension === "map" || extension === "json") return "application/json";

  if (extension === "svg") return "image/svg+xml";

  return "application/octet-stream";
}

function entryArtifact(
  result: Bun.BuildOutput,
  root: string,
  entrypoint: string,
): Bun.BuildArtifact {
  const metadata = result.metafile?.outputs ?? {};
  const output = Object.entries(metadata).find(
    ([, item]) => item.entryPoint && samePath(item.entryPoint, entrypoint, root),
  )?.[0];

  if (!output)
    throw new ProjectError(`The browser build produced no entry point for ${entrypoint}`);

  const artifact = result.outputs.find(
    (item) =>
      samePath(item.path, output) ||
      outputPathFromRoot(item.path, root) === outputPathFromRoot(output, root),
  );

  if (!artifact) throw new ProjectError(`The browser build omitted entry output for ${entrypoint}`);

  return artifact;
}

function outputPathFromRoot(path: string, root: string): string {
  const normalized = path.replaceAll("\\", "/");
  const absolute =
    normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)
      ? normalized
      : resolve(root, normalized).replaceAll("\\", "/");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function samePath(first: string, second: string, root?: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  const left = normalize(first);
  const right = normalize(second);

  if (left === right || left.endsWith(`:${right}`) || left.endsWith(`/${right}`)) return true;

  if (left.startsWith("/") || /^[a-z]:\//iu.test(left)) return false;

  for (const base of [root, process.cwd()].filter(
    (value): value is string => value !== undefined,
  )) {
    const absolute = normalize(resolve(base, first));

    if (absolute === right || absolute.endsWith(`:${right}`) || absolute.endsWith(`/${right}`))
      return true;
  }

  return false;
}

/**
 * Publish an immutable asset capture first, then atomically expose its complete record.
 * Each capture starts empty. The prior published capture remains usable on failure
 * and is retired only after its replacement record has been published.
 */
export async function writeBuild(root: string, build: BrowserBuild): Promise<string> {
  const output = resolve(root, ".hesperia/build");
  const record = build.files.get("/hesperia-build.json");

  if (!record) throw new ProjectError("Browser build has no completed hosting record");

  await cleanUnpublishedCaptures(root);

  await mkdir(output, { recursive: true });

  for (const directory of [dirname(output), output]) {
    const stats = await lstat(directory);

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new ProjectError("The build output path must be a real directory");
  }

  const capturesDirectory = join(output, ".captures");

  await mkdir(capturesDirectory, { recursive: true });

  const capturesStat = await lstat(capturesDirectory);

  if (!capturesStat.isDirectory() || capturesStat.isSymbolicLink())
    throw new ProjectError("The build captures path must be a real directory");

  const captureId = randomUUID();
  const captureDirectory = join(capturesDirectory, captureId);
  const assetRoot = join(captureDirectory, "assets");
  const assetDirectory = `.captures/${captureId}/assets`;
  const destination = join(output, "hesperia-build.json");
  const temporary = join(output, `.hesperia-build.${randomUUID()}.tmp`);
  const previousDirectory = await publishedAssetDirectory(output);

  try {
    const metadata = JSON.parse(await record.text()) as Record<string, unknown>;
    const hosting = metadata.hosting as HostingRecordV1;
    const assets = new Map([...build.files].filter(([path]) => path.startsWith("/assets/")));

    await createHost({ hosting, files: assets });

    await mkdir(assetRoot, { recursive: true });

    for (const { path } of hosting.assets) {
      const blob = assets.get(path);

      if (!blob) throw new ProjectError(`Browser build omitted ${path}`);

      const target = join(assetRoot, path.slice("/assets/".length));

      await mkdir(dirname(target), { recursive: true });

      await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
    }

    const publishedRecord = new Blob(
      [JSON.stringify({ ...metadata, assetDirectory }, null, 2) + "\n"],
      { type: record.type || "application/json" },
    );

    await writeFile(temporary, new Uint8Array(await publishedRecord.arrayBuffer()), {
      flag: "wx",
    });

    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });

    await rm(captureDirectory, { recursive: true, force: true });

    throw error;
  }

  if (previousDirectory) {
    const previousCapture =
      previousDirectory === "assets"
        ? join(output, "assets")
        : join(output, ".captures", previousDirectory.split("/")[1]!);
    const absolute = resolve(previousCapture);

    if (!absolute.startsWith(`${output}${sep}`))
      throw new ProjectError("The previous build capture is outside the output directory");

    await rm(absolute, { recursive: true, force: true });
  }

  await rm(join(output, "index.html"), { force: true });

  return output;
}

async function publishedAssetDirectory(output: string): Promise<string | undefined> {
  let source: string;

  try {
    source = await readFile(join(output, "hesperia-build.json"), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;

    throw error;
  }

  const record = JSON.parse(source) as { assetDirectory?: unknown };
  const directory = record.assetDirectory ?? "assets";

  if (
    typeof directory !== "string" ||
    !/^(?:assets|\.captures\/[0-9a-f-]{36}\/assets)$/u.test(directory)
  )
    throw new ProjectError("The published build asset directory is invalid");

  return directory;
}

async function cleanUnpublishedCaptures(root: string): Promise<void> {
  const output = resolve(root, ".hesperia/build");

  if (!existsSync(output)) return;

  for (const directory of [dirname(output), output]) {
    const stats = await lstat(directory);

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new ProjectError("The build output path must be a real directory");
  }

  const published = await publishedAssetDirectory(output);
  const captures = join(output, ".captures");

  if (!existsSync(captures)) return;

  const stats = await lstat(captures);

  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new ProjectError("The build captures path must be a real directory");

  for (const entry of await readdir(captures, { withFileTypes: true })) {
    if (!/^[0-9a-f-]{36}$/u.test(entry.name) || `.captures/${entry.name}/assets` === published)
      continue;

    const capture = resolve(captures, entry.name);

    if (!capture.startsWith(`${captures}${sep}`))
      throw new ProjectError("The unpublished capture is outside the capture directory");

    await rm(capture, { recursive: true, force: true });
  }
}

interface ConfiguredCompilation {
  readonly pipeline: PluginPipeline;
  readonly transformed: ReadonlyMap<string, TransformedPluginSource>;
  readonly sources: ReadonlyMap<string, string>;
  readonly resolution: ModuleResolver;
  readonly additionalFiles: readonly VirtualModule[];
  readonly checkingRoots: readonly VirtualModule[];
  readonly generatedImports: ReadonlyMap<string, string>;
  readonly projectBodies: readonly PreparedPluginProjectBody[];
  readonly compilation: ProjectCompilation;
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly styles: readonly PluginStyleArtifact[];
  readonly styleImports: readonly PreparedStyleImport[];
  readonly markupStyleImports: readonly PreparedMarkupStyleImport[];
  readonly markupStyleMetadata: readonly {
    readonly styleId: string;
    readonly link: StyleLinkMetadata;
  }[];
  readonly markupNativeStyles: readonly PreparedMarkupNativeStyle[];
  readonly bundledCss?: BundledCss;
  readonly styleTopology?: StyleTopology;
  readonly styleRuntimeModule?: string;
  readonly projections: readonly PluginImportProjection[];
  readonly publicFilename?: string;
}

async function configuredCompilation(
  authored: ReadonlyMap<string, string>,
  root: string,
  configuration: ProjectConfiguration,
  development = false,
  runtimeModule?: string,
): Promise<ConfiguredCompilation> {
  const pipeline = new PluginPipeline(configuration.plugins, {
    allowUnsafeHTML: configuration.allowUnsafeHTML,
  });
  const authoredSnapshots: CapturedProjectSource[] = [];

  for (const [filename, source] of authored)
    authoredSnapshots.push(await pipeline.pinSource(filename, source));

  const projectSourceSnapshots = await pipeline.captureProjectSources(root);
  const checkingRoots = projectSourceSnapshots.map(({ filename, source }) => ({
    filename,
    source,
  }));
  const projectSourceKeys = new Set(projectSourceSnapshots.map((item) => sourceKey(item.filename)));
  const browserAuthored = new Map(
    [...authored].filter(
      ([filename]) =>
        /\.(?:ts|tsx|mts)$/iu.test(filename) && !projectSourceKeys.has(sourceKey(filename)),
    ),
  );
  const declarations = pipeline.collectProjectDeclarations(root);
  const prepared = await pipeline.prepareImports(browserAuthored, root);
  const transformed = await pipeline.transformSources(prepared.sources, root);
  const sources = new Map([...transformed].map(([filename, source]) => [filename, source.current]));
  const additionalFiles: VirtualModule[] = prepared.projections.map((projection) => ({
    filename: projection.declarationFilename,
    source: projection.result.declaration.code,
  }));

  additionalFiles.push(
    ...declarations.map(({ filename, declaration }) => ({
      filename,
      source: declaration.code,
    })),
  );

  const publicProjection =
    configuration.public === undefined ? undefined : projectPublicValues(configuration.public);
  const publicFilename = publicProjection ? join(root, ".hesperia", "public.js") : undefined;

  if (publicProjection)
    additionalFiles.push({
      filename: join(root, ".hesperia", "public.d.ts"),
      source: publicProjection.declaration,
    });

  const browserModules = prepared.projections.map(
    (projection) => [projection.browserFilename, projection.result.browser.code] as const,
  );

  if (publicProjection && publicFilename)
    browserModules.push([publicFilename, publicProjection.browser]);

  let resolution = new ModuleResolver(
    root,
    new Map([...sources, ...browserModules]),
    development ? "development" : "production",
    configuration.resolutionOverrides.browser,
    publicFilename ? new Map([["hesperia/config/public", publicFilename]]) : undefined,
  );
  const originalChecking = await checkProjectModules(
    [...prepared.sources].map(([filename, source]) => ({ filename, source: source.current })),
    {
      root,
      ...configuration,
      documentShell: true,
      browserTarget: false,
      resolution,
      resolutionOverrides: configuration.resolutionOverrides,
      additionalFiles,
      checkingRoots,
    },
  );
  const originalTypeDiagnostics = originalChecking.modules.flatMap((module) =>
    module.diagnostics
      .filter((item) => /^TS\d+$/u.test(item.code))
      .map((item) => {
        const mapped = mapPluginDiagnostic(
          item,
          prepared.sources.get(module.filename),
          prepared.sources,
        );
        return { ...mapped, filename: diagnosticFilename(mapped, module.filename) };
      }),
  );
  const retainedAdditionalFiles = mergeVirtualFiles(
    additionalFiles,
    originalChecking.checkingInputs,
  );
  resolution = resolution.forkWithGeneratedSources(
    new Map(originalChecking.checkingInputs.map((item) => [item.filename, item.source])),
    new Map(),
  );
  const declaredIds = new Set(declarations.map((item) => item.declaration.id));

  pinBrowserResolution(sources, root, resolution, declaredIds);

  const session = await openCheckingProject(
    [...sources].map(([filename, source]) => ({ filename, source })),
    {
      root,
      ...configuration,
      documentShell: true,
      browserTarget: false,
      resolution,
      resolutionOverrides: configuration.resolutionOverrides,
      additionalFiles: retainedAdditionalFiles,
      checkingRoots,
    },
  );

  try {
    const checkingSources = projectCheckingSources(transformed, projectSourceSnapshots);
    const projectBodies = await pipeline.analyzeProject(
      () =>
        createProjectHookLease(root, session, checkingSources, () =>
          projectCapturedSources(
            authoredSnapshots,
            projectSourceSnapshots,
            originalChecking.checkingInputs,
            session,
          ),
        ),
      declarations,
      root,
    );

    for (const body of projectBodies) {
      try {
        const parsed = parseSync(body.filename, body.source, {
          lang: "jsx",
          astType: "js",
          range: true,
          sourceType: "module",
        });

        for (const error of parsed.errors)
          pipeline.reportProjectError(
            body.origin,
            `Plugin ${body.pluginName} browser module ${body.id} has invalid JavaScript: ${error.message}`,
          );
      } catch (error) {
        pipeline.reportProjectError(
          body.origin,
          `Plugin ${body.pluginName} browser module ${body.id} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const generatedImports = new Map<string, string>();

    if (publicFilename) generatedImports.set("hesperia/config/public", publicFilename);

    for (const body of projectBodies) generatedImports.set(body.id, body.filename);

    const bodySources = new Map(projectBodies.map((body) => [body.filename, body.source]));

    for (const projection of prepared.projections) {
      if (!projection.markup) continue;

      const token = basename(projection.browserFilename, ".js");

      for (let index = 0; index < projection.markup.resources.length; index++) {
        const specifier = `hesperia:markup-resource:${token}:${index}`;
        const filename = join(root, ".hesperia", "markup-resources", `${token}-${index}.js`);

        generatedImports.set(specifier, filename);

        bodySources.set(filename, 'export default "";');
      }
    }

    if (prepared.markupStyles.length) {
      const styleRuntimeModule = `hesperia:style-plan:project:${new Bun.CryptoHasher("sha256")
        .update(root)
        .digest("hex")
        .slice(0, 16)}`;
      const checkingStyleRuntimeFilename = join(
        root,
        ".hesperia",
        "markup-resources",
        "style-runtime.js",
      );

      generatedImports.set(styleRuntimeModule, checkingStyleRuntimeFilename);

      bodySources.set(
        checkingStyleRuntimeFilename,
        "export const styles={bindStyles(){},bindEntry(){},preloadEntry(){return Promise.resolve({});}};",
      );
    }

    const finalResolution = resolution.forkWithGeneratedSources(bodySources, generatedImports);
    const missingProjectIds = new Set<string>();

    for (const id of referencedProjectIds(sources, projectBodies, declaredIds)) {
      if (projectBodies.some((body) => body.id === id)) continue;

      missingProjectIds.add(id);

      const declaration = declarations.find((item) => item.declaration.id === id)!;

      pipeline.reportProjectError(
        declaration.declaration.origin,
        `Plugin ${declaration.pluginName} did not return browser module ${id}, which is referenced by the checked project.`,
      );
    }

    const edgeDiagnostics = validateBrowserResolution(
      sources,
      root,
      finalResolution,
      projectBodies,
      missingProjectIds,
    );
    const entryFilenames = [
      ...[...sources.keys()].filter((filename) => isBrowserProjectEntry(filename, root)),
      ...projectBodies.map((body) => body.filename),
    ];
    const capabilityDiagnostics = analyzeBrowserCapabilities(
      [
        ...[...sources].map(([filename, source]) => ({ filename, source })),
        ...projectBodies.map((body) => ({ filename: body.filename, source: body.source })),
      ],
      root,
      finalResolution,
      entryFilenames,
    );

    for (const diagnostic of capabilityDiagnostics) {
      const body = projectBodies.find(
        (item) => sourceKey(item.filename) === sourceKey(diagnostic.filename),
      );

      if (body) {
        pipeline.reportProjectError(
          body.origin,
          `Plugin ${body.pluginName} browser module ${body.id}: ${diagnostic.message}`,
        );
      }
    }

    const checkingSnapshot = mapPluginCompilation(
      { checking: session.result, modules: new Map() },
      transformed,
    );
    const capabilityProjectDiagnostics = capabilityDiagnostics.flatMap((item) => {
      if (projectBodies.some((body) => sourceKey(body.filename) === sourceKey(item.filename)))
        return [];

      const mapped = mapPluginDiagnostic(item, transformed.get(item.filename), transformed);
      return [{ ...mapped, filename: diagnosticFilename(mapped, item.filename) }];
    });
    const pluginResolutionDiagnostics = edgeDiagnostics.flatMap((item) => {
      const body = projectBodies.find(
        (candidate) => sourceKey(candidate.filename) === sourceKey(item.filename),
      );

      if (body) {
        pipeline.reportProjectError(
          body.origin,
          `Plugin ${body.pluginName} browser module ${body.id}: ${item.message}`,
        );

        return [];
      }

      const mapped = mapPluginDiagnostic(item, transformed.get(item.filename), transformed);
      return [{ ...mapped, filename: diagnosticFilename(mapped, item.filename) }];
    });

    const collectDiagnostics = (compilation: ProjectCompilation): ProjectDiagnostic[] =>
      [
        ...originalTypeDiagnostics,
        ...compilation.checking.modules.flatMap((module) =>
          module.diagnostics.map((item) => ({
            ...item,
            filename: diagnosticFilename(item, module.filename),
          })),
        ),
        ...pluginResolutionDiagnostics,
        ...capabilityProjectDiagnostics,
        ...pipeline.diagnostics.map(pluginProjectDiagnostic),
        ...pipeline.hookFailures.map((item) => {
          const origin = item.origin;
          const span =
            origin && typeof origin.start === "number" && typeof origin.end === "number"
              ? { start: origin.start, end: origin.end }
              : undefined;
          return {
            code: "HES-PLUGIN",
            severity: "error" as const,
            message: item.message,
            filename: origin?.filename ?? root,
            ...(span ? { span } : {}),
          };
        }),
      ].filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.code === item.code &&
              candidate.filename === item.filename &&
              candidate.message === item.message &&
              candidate.span?.start === item.span?.start &&
              candidate.span?.end === item.span?.end,
          ) === index,
      );

    const emissionOptions = {
      root,
      ...configuration,
      styleIdentityRoot: root,
      documentShell: true,
      browserTarget: true,
      resolution: finalResolution,
      resolutionOverrides: configuration.resolutionOverrides,
      runtimeModule,
      additionalFiles: retainedAdditionalFiles,
    };
    let compilation = checkingSnapshot;
    let diagnostics = collectDiagnostics(compilation);

    if (!diagnostics.some((item) => item.severity === "error")) {
      compilation = mapPluginCompilation(
        emitCheckingSession(session, emissionOptions),
        transformed,
      );
      diagnostics = collectDiagnostics(compilation);
    }

    const styles = diagnostics.some((item) => item.severity === "error")
      ? []
      : await pipeline.generateStyles(transformed, compilation, root);
    diagnostics = collectDiagnostics(compilation);
    const markupStyles: PluginStyleArtifact[] = [];
    const nativeMarkupStyleIds = new Set(
      prepared.markupNativeStyles.map((item) => item.styleId.slice("generated:".length)),
    );

    if (!diagnostics.some((item) => item.severity === "error")) {
      for (const style of prepared.markupStyles) {
        if (nativeMarkupStyleIds.has(style.id)) {
          markupStyles.push(style);

          continue;
        }

        const output = await pipeline.transformCss({
          kind: "generated",
          id: style.id,
          filename: generatedStyleFilename(style),
          css: style.css,
          owner: style.owner,
          origin: style.origin,
        });

        markupStyles.push({
          ...style,
          css: output.css,
          ...(output.map ? { map: output.map } : {}),
        });
      }
    }

    const allGeneratedStyles = [...styles, ...markupStyles];
    diagnostics = collectDiagnostics(compilation);
    let bundledCss: BundledCss | undefined;
    let styleTopology: StyleTopology | undefined;
    let styleRuntimeModule: string | undefined;
    const styleDiagnostics: ProjectDiagnostic[] = [];

    if (
      !diagnostics.some((item) => item.severity === "error") &&
      (prepared.styles.length || allGeneratedStyles.length || runtimeModule)
    ) {
      try {
        bundledCss = await bundleCssRoots(
          root,
          prepared.styles,
          allGeneratedStyles,
          pipeline,
          prepared.markupNativeStyles,
        );
        styleTopology = buildStyleTopology(
          root,
          transformed,
          compilation,
          finalResolution,
          prepared.styles,
          allGeneratedStyles,
          bundledCss.roots,
          (filename, offset) => pluginOriginalOffset(transformed.get(filename)!, offset),
          prepared.markupStyleImports,
        );
        const styledEntryIds = new Set(
          styleTopology.entries
            .filter((item) => item.closure.length)
            .map((item) => resolve(root, item.entryId)),
        );

        if (runtimeModule) {
          styleRuntimeModule = `hesperia:style-plan:project:${new Bun.CryptoHasher("sha256")
            .update(root)
            .digest("hex")
            .slice(0, 16)}`;
          compilation = mapPluginCompilation(
            emitCheckingSession(session, {
              ...emissionOptions,
              styleRuntimeModule,
              styledEntryIds,
              styleShellEntryId: resolve(root, "app.tsx"),
            }),
            transformed,
          );
          diagnostics = collectDiagnostics(compilation);
        }
      } catch (error) {
        const origin =
          error instanceof CssBundleError
            ? (error.origin ??
              prepared.styles.find((item) => sourceKey(item.filename) === sourceKey(error.source))
                ?.origin ??
              allGeneratedStyles.find(
                (item) => sourceKey(item.origin.filename) === sourceKey(error.source),
              )?.origin ??
              allGeneratedStyles[0]?.origin ??
              prepared.styles[0]?.origin)
            : (prepared.styles[0]?.origin ?? allGeneratedStyles[0]?.origin);

        if (!origin) throw error;

        styleDiagnostics.push({
          code: "HES-CSS",
          severity: "error",
          filename: origin.filename,
          span: { start: origin.start, end: origin.end },
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    diagnostics = [...collectDiagnostics(compilation), ...styleDiagnostics];
    return {
      pipeline,
      transformed,
      sources,
      resolution: finalResolution,
      additionalFiles: retainedAdditionalFiles,
      checkingRoots,
      generatedImports,
      projectBodies,
      compilation,
      diagnostics,
      styles,
      styleImports: prepared.styles,
      markupStyleImports: prepared.markupStyleImports,
      markupStyleMetadata: prepared.markupStyleMetadata,
      markupNativeStyles: prepared.markupNativeStyles,
      ...(bundledCss ? { bundledCss } : {}),
      ...(styleTopology ? { styleTopology } : {}),
      ...(styleRuntimeModule ? { styleRuntimeModule } : {}),
      projections: prepared.projections,
      ...(publicFilename ? { publicFilename } : {}),
    };
  } finally {
    await session.dispose();
  }
}

function mergeVirtualFiles(
  files: readonly VirtualModule[],
  captured: readonly { readonly filename: string; readonly source: string }[],
): readonly VirtualModule[] {
  const merged = new Map<string, VirtualModule>();

  for (const file of files) merged.set(sourceKey(file.filename), file);

  for (const file of captured) {
    const key = sourceKey(file.filename);

    if (!merged.has(key)) merged.set(key, { filename: file.filename, source: file.source });
  }

  return Object.freeze([...merged.values()]);
}

function projectCheckingSources(
  transformed: ReadonlyMap<string, TransformedPluginSource>,
  projectSources: readonly CapturedProjectSource[],
): ReadonlyMap<string, PluginCheckingSource> {
  const sources = new Map<string, PluginCheckingSource>();

  for (const item of projectSources)
    sources.set(
      item.filename,
      Object.freeze({
        filename: item.filename,
        authored: item.source,
        checking: item.source,
      }),
    );

  for (const [filename, item] of transformed) {
    const map = item.map ? freezePluginSourceMap(item.map) : undefined;

    sources.set(
      filename,
      Object.freeze({
        filename,
        authored: item.authored,
        checking: item.current,
        ...(map ? { map } : {}),
      }),
    );
  }

  return readonlyMap(sources);
}

function freezePluginSourceMap<T extends import("./plugins.ts").PluginSourceMap>(map: T): T {
  return Object.freeze({
    ...map,
    sources: Object.freeze([...map.sources]),
    names: Object.freeze([...map.names]),
    ...(map.sourcesContent ? { sourcesContent: Object.freeze([...map.sourcesContent]) } : {}),
  }) as T;
}

function projectCapturedSources(
  authored: readonly CapturedProjectSource[],
  projectRoots: readonly CapturedProjectSource[],
  originalInputs: readonly {
    readonly filename: string;
    readonly source: string;
    readonly digest: string;
  }[],
  session: CheckingSession,
): ReadonlyMap<string, CapturedProjectSource> {
  const captured = new Map<string, CapturedProjectSource>();

  const add = (item: CapturedProjectSource): void => {
    const filename = resolve(item.filename);
    const key = sourceKey(filename);
    const value = Object.freeze({ filename, source: item.source, digest: item.digest });
    const previous = captured.get(key);

    if (previous && previous.digest !== value.digest)
      throw new Error(`Project input changed after it was captured: ${filename}`);

    captured.set(key, previous ?? value);
  };

  for (const item of authored) add(item);

  for (const item of projectRoots) add(item);

  for (const item of originalInputs) add(item);

  for (const item of session.result.checkingInputs) add(item);

  return readonlyMap(new Map([...captured.values()].map((item) => [item.filename, item])));
}

function createProjectHookLease(
  root: string,
  session: CheckingSession,
  checkingSources: ReadonlyMap<string, PluginCheckingSource>,
  capturedSources: () => ReadonlyMap<string, CapturedProjectSource>,
): { readonly input: PluginProjectInput; close(): void } {
  const project = session.project;

  if (!project) throw new Error("The native TypeScript project is unavailable for analyzeProject.");

  let active = true;

  const assertActive = (): void => {
    if (!active) throw new Error("The analyzeProject type-query lease has ended.");
  };

  const types: ProjectTypeQueries = Object.freeze({
    get checker() {
      assertActive();

      const checker = project.checker;

      if (!checker) throw new Error("The native TypeScript checker is unavailable.");

      return checker;
    },

    sourceFile(filename: string) {
      assertActive();

      return project.program.getSourceFile(resolve(root, filename));
    },

    resolveDeclaration(handle: NodeHandle) {
      assertActive();

      return handle.resolve();
    },
  });
  const input: PluginProjectInput = Object.freeze({
    root,
    checkingSources,
    capturedSources: capturedSources(),
    types,
  });
  return {
    input,

    close() {
      active = false;
    },
  };
}

function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  let view: ReadonlyMap<K, V>;
  view = Object.freeze({
    get size() {
      return source.size;
    },

    get(key: K) {
      return source.get(key);
    },

    has(key: K) {
      return source.has(key);
    },

    entries() {
      return source.entries();
    },

    keys() {
      return source.keys();
    },

    values() {
      return source.values();
    },

    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      source.forEach((value, key) => callback.call(thisArg, value, key, view));
    },

    [Symbol.iterator]() {
      return source[Symbol.iterator]();
    },
  });
  return view;
}

function referencedProjectIds(
  sources: ReadonlyMap<string, string>,
  bodies: readonly PreparedPluginProjectBody[],
  declarations: ReadonlySet<string>,
): ReadonlySet<string> {
  const referenced = new Set<string>();
  const modules = [...sources, ...bodies.map((body) => [body.filename, body.source] as const)];

  for (const [filename, source] of modules)
    for (const imported of moduleImports(filename, source))
      if (declarations.has(imported.specifier)) referenced.add(imported.specifier);

  return referenced;
}

interface SourceImport {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
  readonly typeOnly: boolean;
}

function moduleImports(filename: string, source: string): readonly SourceImport[] {
  if (/\.d\.\w+$/iu.test(filename)) return [];

  let parsed: ReturnType<typeof parseSync>;

  try {
    const isTypeScript = /\.(?:ts|tsx|mts|cts)$/iu.test(filename);
    parsed = parseSync(filename, source, {
      lang: filename.endsWith(".tsx") ? "tsx" : isTypeScript ? "ts" : "jsx",
      astType: isTypeScript ? "ts" : "js",
      range: true,
      sourceType: "module",
    });
  } catch {
    return [];
  }

  const imports: SourceImport[] = [];

  const add = (node: Record<string, unknown>, specifierNode: unknown, typeOnly: boolean): void => {
    if (!specifierNode || typeof specifierNode !== "object") return;

    const value = specifierNode as { value?: unknown; start?: unknown; end?: unknown };

    if (
      typeof value.value === "string" &&
      typeof value.start === "number" &&
      typeof value.end === "number"
    )
      imports.push({
        specifier: value.value,
        start: Number(node.start ?? value.start),
        end: Number(node.end ?? value.end),
        typeOnly,
      });
  };

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const child of value) visit(child);

      return;
    }

    const node = value as Record<string, unknown>;

    if (node.type === "ImportDeclaration") {
      const specifiers = Array.isArray(node.specifiers)
        ? (node.specifiers as readonly Record<string, unknown>[])
        : [];
      const typeOnly =
        node.importKind === "type" ||
        (specifiers.length > 0 && specifiers.every((specifier) => specifier.importKind === "type"));

      add(node, node.source, typeOnly);
    } else if (node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
      add(node, node.source, node.exportKind === "type");
    } else if (node.type === "ImportExpression") {
      add(node, node.source, false);
    }

    for (const child of Object.values(node)) visit(child);
  };

  visit(parsed.program.body);

  return imports;
}

function pinBrowserResolution(
  sources: ReadonlyMap<string, string>,
  root: string,
  resolution: ModuleResolver,
  deferredIds: ReadonlySet<string>,
): void {
  const queue = [...sources.keys()]
    .filter((filename) => isBrowserProjectEntry(filename, root))
    .map((filename) => ({ filename, source: sources.get(filename)! }));
  const seen = new Set<string>();

  while (queue.length) {
    const module = queue.shift()!;
    const key = sourceKey(module.filename);

    if (seen.has(key)) continue;

    seen.add(key);

    for (const imported of moduleImports(module.filename, module.source)) {
      if (imported.typeOnly || deferredIds.has(imported.specifier)) continue;

      const selected = resolution.resolve(module.filename, imported.specifier);

      if (selected.kind === "resolved")
        queue.push({ filename: selected.filename, source: selected.source });
    }
  }
}

function validateBrowserResolution(
  sources: ReadonlyMap<string, string>,
  root: string,
  resolution: ModuleResolver,
  bodies: readonly PreparedPluginProjectBody[],
  missingProjectIds: ReadonlySet<string>,
): readonly ProjectDiagnostic[] {
  const captured = new Map(
    resolution.capturedSources.map((item) => [sourceKey(item.filename), item]),
  );
  const local = new Map(
    [...sources].map(([filename, source]) => [sourceKey(filename), { filename, source }]),
  );

  for (const body of bodies)
    local.set(sourceKey(body.filename), { filename: body.filename, source: body.source });

  const queue = [
    ...[...sources.keys()].filter((filename) => isBrowserProjectEntry(filename, root)),
    ...bodies.map((body) => body.filename),
  ];
  const seen = new Set<string>();
  const diagnostics: ProjectDiagnostic[] = [];

  while (queue.length) {
    const filename = queue.shift()!;
    const key = sourceKey(filename);

    if (seen.has(key)) continue;

    seen.add(key);

    const module = local.get(key) ?? captured.get(key);

    if (!module) continue;

    for (const imported of moduleImports(module.filename, module.source)) {
      if (imported.typeOnly) continue;

      if (missingProjectIds.has(imported.specifier)) continue;

      const selected = resolution.resolve(module.filename, imported.specifier);

      if (selected.kind === "failure") {
        const body = bodies.find((item) => sourceKey(item.filename) === sourceKey(module.filename));

        diagnostics.push({
          code: selected.code === "HOST_IMPORT" ? "HES-CAPABILITY" : "HES-CAPABILITY-RESOLVE",
          severity: "error",
          filename: module.filename,
          span: { start: imported.start, end: imported.end },
          message: `${body ? `Generated module ${body.id}: ` : ""}${selected.message}`,
        });
      } else {
        queue.push(selected.filename);
      }
    }
  }

  return diagnostics;
}

function isBrowserProjectEntry(filename: string, root: string): boolean {
  const absolute = resolve(filename).replaceAll("\\", "/");
  const rootPath = resolve(root).replaceAll("\\", "/");
  const normalized = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const normalizedRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;

  if (
    normalized === `${normalizedRoot}/app.tsx` ||
    normalized === `${normalizedRoot}/app.config.ts`
  )
    return true;

  const routeRoot = `${normalizedRoot}/src/routes/`;

  if (!normalized.startsWith(routeRoot)) return false;

  return new Set(["+page.tsx", "+layout.tsx", "+loading.tsx", "+error.tsx", "+not-found.tsx"]).has(
    normalized.slice(normalized.lastIndexOf("/") + 1),
  );
}

function mapPluginCompilation(
  compilation: ProjectCompilation,
  transformed: ReadonlyMap<string, TransformedPluginSource>,
): ProjectCompilation {
  const checked = compilation.checking.modules.map((module) => ({
    ...module,
    diagnostics: module.diagnostics.map((item) =>
      mapPluginDiagnostic(item, transformed.get(module.filename), transformed),
    ),
  }));
  const modules = new Map(
    [...compilation.modules].map(([filename, compiled]) => {
      const source = transformed.get(filename);
      return [
        filename,
        {
          ...compiled,
          diagnostics: compiled.diagnostics.map((item) =>
            mapPluginDiagnostic(item, source, transformed),
          ),
          map:
            compiled.map && source?.map
              ? remapping(
                  [compiled.map as SourceMapInput, source.map as SourceMapInput],
                  () => null,
                )
              : compiled.map,
        },
      ] as const;
    }),
  );
  return {
    checking: {
      ...compilation.checking,
      modules: checked,
      diagnostics: checked.flatMap((module) => module.diagnostics),
    },
    modules,
  };
}

interface MappedPluginDiagnostic extends CompilerDiagnostic {
  readonly filename?: string;
}

interface PluginSourcePosition {
  readonly filename: string;
  readonly offset?: number;
}

function mapPluginDiagnostic(
  item: CompilerDiagnostic,
  source: TransformedPluginSource | undefined,
  knownSources?: ReadonlyMap<string, { readonly authored: string }>,
): MappedPluginDiagnostic {
  if (!source || !item.span) return item;

  const unavailable = (): MappedPluginDiagnostic => ({
    ...item,
    message: `${item.message} (Original source location unavailable after plugin transform.)`,
    span: undefined,
  });

  if (
    item.span.start < 0 ||
    item.span.end < item.span.start ||
    item.span.end > source.current.length
  )
    return unavailable();

  if (!source.map) return source.current === source.authored ? item : unavailable();

  const trace = new TraceMap(source.map as SourceMapInput);
  const start = pluginOriginalPosition(source, trace, item.span.start, knownSources);
  const end = pluginOriginalPosition(source, trace, item.span.end, knownSources);

  if (
    !start ||
    !end ||
    !samePluginSource(start.filename, end.filename) ||
    start.offset === undefined ||
    end.offset === undefined ||
    end.offset < start.offset
  )
    return unavailable();

  return {
    ...item,
    filename: start.filename,
    span: { start: start.offset, end: end.offset },
  };
}

function pluginOriginalPosition(
  source: TransformedPluginSource,
  trace: TraceMap,
  offset: number,
  knownSources?: ReadonlyMap<string, { readonly authored: string }>,
): PluginSourcePosition | undefined {
  const before = source.current.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n") - 1;
  const original = originalPositionFor(trace, { line, column });

  if (original.source === null || original.line === null || original.column === null)
    return undefined;

  const filename = pluginMappedFilename(original.source, source.filename);

  if (!filename) return undefined;

  let text: string | undefined;

  if (samePluginSource(filename, source.filename)) text = source.authored;
  else {
    const captured = sourceContentFor(trace, original.source);
    text = captured ?? knownSourceText(filename, knownSources);
  }

  if (text === undefined) return { filename };

  const mappedOffset = sourceOffset(text, original.line, original.column);

  if (mappedOffset === undefined) return { filename };

  return { filename, offset: mappedOffset };
}

function pluginMappedFilename(source: string, currentFilename: string): string | undefined {
  if (source.startsWith("<") && source.endsWith(">")) return undefined;

  if (source.toLowerCase().startsWith("file:")) {
    try {
      return fileURLToPath(source);
    } catch {
      return undefined;
    }
  }

  if (pluginSourceProtocol(source)) return source;

  return isAbsolute(source) || isWindowsDrivePath(source)
    ? source
    : resolve(dirname(currentFilename), source);
}

function pluginSourceProtocol(source: string): string | undefined {
  if (isWindowsDrivePath(source)) return undefined;

  return /^[a-z][a-z\d+.-]*:/iu.exec(source)?.[0].slice(0, -1).toLowerCase();
}

function isWindowsDrivePath(source: string): boolean {
  return process.platform === "win32" && /^[a-z]:[\\/]/iu.test(source);
}

function pluginSourceIdentity(source: string): string | undefined {
  if (source.startsWith("<") && source.endsWith(">")) return undefined;

  if (source.toLowerCase().startsWith("file:")) {
    try {
      return sourceKey(fileURLToPath(source));
    } catch {
      return undefined;
    }
  }

  if (pluginSourceProtocol(source)) return source;

  return sourceKey(source);
}

function samePluginSource(first: string, second: string): boolean {
  const firstIdentity = pluginSourceIdentity(first);
  return firstIdentity !== undefined && firstIdentity === pluginSourceIdentity(second);
}

function knownSourceText(
  filename: string,
  knownSources?: ReadonlyMap<string, { readonly authored: string }>,
): string | undefined {
  if (!knownSources) return undefined;

  for (const [candidate, source] of knownSources) {
    if (samePluginSource(candidate, filename)) return source.authored;
  }

  return undefined;
}

function mapPluginDeclarationLocation(
  map: import("./plugins.ts").PluginSourceMap,
  generated: string,
  generatedFilename: string,
  start: number,
  end: number,
): { readonly filename: string; readonly start: number; readonly end: number } | undefined {
  const position = (offset: number): { line: number; column: number } | undefined => {
    if (!Number.isInteger(offset) || offset < 0 || offset > generated.length) return undefined;

    const before = generated.slice(0, offset);
    return {
      line: before.split("\n").length,
      column: offset - before.lastIndexOf("\n") - 1,
    };
  };

  const generatedStart = position(start);
  const generatedEnd = position(end);

  if (!generatedStart || !generatedEnd) return undefined;

  const trace = new TraceMap(map as SourceMapInput);
  const originalStart = originalPositionFor(trace, generatedStart);
  const originalEnd = originalPositionFor(trace, generatedEnd);

  if (
    originalStart.source === null ||
    originalStart.line === null ||
    originalStart.column === null ||
    originalEnd.source === null ||
    originalEnd.line === null ||
    originalEnd.column === null ||
    !samePluginSource(originalStart.source, originalEnd.source)
  )
    return undefined;

  const filename = pluginMappedFilename(originalStart.source, generatedFilename);
  const source = sourceContentFor(trace, originalStart.source);

  if (!filename || source === null || source === undefined) return undefined;

  const mappedStart = sourceOffset(source, originalStart.line, originalStart.column);
  const mappedEnd = sourceOffset(source, originalEnd.line, originalEnd.column);
  return mappedStart === undefined || mappedEnd === undefined || mappedEnd < mappedStart
    ? undefined
    : { filename, start: mappedStart, end: mappedEnd };
}

function sourceOffset(source: string, line: number, column: number): number | undefined {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 0)
    return undefined;

  let start = 0;

  for (let currentLine = 1; currentLine < line; currentLine++) {
    const newline = source.indexOf("\n", start);

    if (newline < 0) return undefined;

    start = newline + 1;
  }

  const newline = source.indexOf("\n", start);
  let end = newline < 0 ? source.length : newline;

  if (end > start && source[end - 1] === "\r") end--;

  if (column > end - start) return undefined;

  return start + column;
}

function diagnosticFilename(item: CompilerDiagnostic, fallback: string): string {
  const filename = (item as MappedPluginDiagnostic).filename;
  return filename ?? fallback;
}

function pluginOriginalOffset(source: TransformedPluginSource, offset: number): number {
  if (!source.map) return offset;

  const before = source.current.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n") - 1;
  const original = originalPositionFor(new TraceMap(source.map as SourceMapInput), {
    line,
    column,
  });

  if (
    original.source === null ||
    original.line === null ||
    original.column === null ||
    !samePluginSource(original.source, source.filename)
  )
    return offset;

  const lines = source.authored.split("\n");
  return (
    lines.slice(0, original.line - 1).reduce((length, item) => length + item.length + 1, 0) +
    original.column
  );
}

function pluginGeneratedOffset(source: TransformedPluginSource, offset: number): number {
  if (!source.map) return offset;

  const before = source.authored.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n") - 1;
  const trace = new TraceMap(source.map as SourceMapInput);
  const authoredSource = trace.resolvedSources.find((candidate) =>
    samePluginSource(candidate, source.filename),
  );

  if (!authoredSource) return offset;

  const generated = generatedPositionFor(trace, { source: authoredSource, line, column });

  if (generated.line === null || generated.column === null) return offset;

  const lines = source.current.split("\n");
  return (
    lines.slice(0, generated.line - 1).reduce((length, item) => length + item.length + 1, 0) +
    generated.column
  );
}

function pluginProjectDiagnostic(item: import("./plugins.ts").PluginDiagnostic): ProjectDiagnostic {
  const span =
    typeof item.origin.start === "number" && typeof item.origin.end === "number"
      ? { start: item.origin.start, end: item.origin.end }
      : undefined;
  return {
    code: "HES-PLUGIN",
    severity: item.severity,
    message: item.message,
    filename: item.origin.filename,
    ...(span ? { span } : {}),
  };
}

async function projectCompilation(
  files: ReadonlyMap<string, string>,
  root: string,
  configuration: ProjectConfiguration,
  resolution?: ModuleResolver,
  runtimeModule?: string,
  additionalFiles?: readonly VirtualModule[],
  styleRuntimeModule?: string,
  styledEntryIds?: ReadonlySet<string>,
  styleShellEntryId?: string,
): Promise<ProjectCompilation> {
  const modules: VirtualModule[] = [...files].map(([filename, source]) => ({ filename, source }));
  return compileProjectModules(modules, {
    root,
    ...configuration,
    documentShell: true,
    browserTarget: true,
    resolution,
    resolutionOverrides: configuration.resolutionOverrides,
    runtimeModule,
    additionalFiles,
    styleRuntimeModule,
    styledEntryIds,
    styleShellEntryId,
    styleIdentityRoot: root,
  });
}

function loadResolvedSource(
  filename: string,
  sources: ReadonlyMap<string, string>,
  compilation: ProjectCompilation,
  compiledMaps: Map<string, SourceMapInput>,
  resolution: ModuleResolver,
  diagnostics: ProjectDiagnostic[],
): { contents: string; loader: "js" } {
  const captured = resolution.capturedSources.find(
    (item) => sourceKey(item.filename) === sourceKey(filename),
  );

  if (!captured)
    throw new ProjectError(`Resolver did not capture module source: ${filename}`, diagnostics);

  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const authored = [...sources.keys()].some((item) => sourceKey(item) === sourceKey(filename));

  if (authored && (extension === ".ts" || extension === ".tsx" || extension === ".mts"))
    return loadCompiledSource(filename, compilation, compiledMaps, diagnostics);

  if (!authored && (extension === ".ts" || extension === ".tsx" || extension === ".mts"))
    throw new ProjectError(
      `Captured dependency has no checked browser artifact: ${filename}`,
      diagnostics,
    );

  return { contents: captured.source, loader: "js" };
}

function loadCompiledSource(
  filename: string,
  compilation: ProjectCompilation,
  compiledMaps: Map<string, SourceMapInput>,
  diagnostics: ProjectDiagnostic[],
): { contents: string; loader: "js" } {
  const compiled = [...compilation.modules].find(
    ([item]) => sourceKey(item) === sourceKey(filename),
  )?.[1];

  if (!compiled)
    throw new ProjectError(
      `Compilation was not emitted for checked module: ${filename}`,
      diagnostics,
    );

  if (compiled.map) recordCompiledMap(filename, compiled.map as SourceMapInput, compiledMaps);

  return { contents: compiled.code, loader: "js" };
}

function recordCompiledMap(
  filename: string,
  input: SourceMapInput,
  compiledMaps: Map<string, SourceMapInput>,
): void {
  const map = input as unknown as {
    readonly sources?: readonly string[];
    readonly [key: string]: unknown;
  };

  // Bun's plugin loader emits a bundle map for the returned JS but does not consume an inline map
  // in onLoad contents. Keep the compiled map for explicit composition after bundling.
  compiledMaps.set(filename, {
    ...map,
    sources: map.sources?.map((source) => {
      if (!source) return source;

      const absolute = resolve(resolve(filename, ".."), source);
      return absolute.replaceAll("\\", "/");
    }),
  } as SourceMapInput);
}

function digestJson(value: unknown): string {
  return `sha256-${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function emitGeneratedModule(
  source: string,
  filename: string,
  runtimeModule: string,
): { readonly code: string; readonly semanticHash: string } {
  const analysis = analyzeModule(source, { filename, browserTarget: true, runtimeModule });
  const result = emitAnalysis(analysis, { filename, browserTarget: true, runtimeModule });
  const diagnostics = result.diagnostics.filter((item) => item.severity === "error");

  if (diagnostics.length)
    throw new ProjectError(
      `Generated browser module emission failed: ${filename}`,
      diagnostics.map((item) => ({ ...item, filename })),
    );

  return { code: result.code, semanticHash: result.semanticHash };
}

function recordFilename(root: string, filename: string): string {
  const relativeFilename = relative(root, filename).replaceAll("\\", "/");
  return relativeFilename.startsWith("../") || relativeFilename === ".."
    ? filename.replaceAll("\\", "/")
    : relativeFilename;
}

/** Create the starter only in an empty destination; dependency installation is a separate command. */
export async function initProject(destination: string): Promise<void> {
  destination = resolve(destination);

  await mkdir(destination, { recursive: true });

  if ((await readdir(destination)).length !== 0)
    throw new ProjectError("Hesperia init requires an empty destination");

  const packageName =
    basename(destination)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-") || "hesperia-app";
  const files: Record<string, string> = {
    "package.json":
      JSON.stringify(
        {
          name: packageName,
          private: true,
          type: "module",
          scripts: {
            dev: "hesperia dev",
            build: "hesperia build",
            preview: "hesperia preview",
            check: "hesperia check",
          },
          dependencies: { hesperia: "1.0.0-alpha.2", aeolia: "1.0.0-alpha.1" },
          devDependencies: {
            "@hesperia/tooling": "1.0.0-alpha.2",
            typescript: "7.0.2",
            "@types/bun": "1.4.2",
          },
        },
        null,
        2,
      ) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ESNext", "DOM"],
            jsx: "preserve",
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
          },
          include: ["app.tsx", "app.config.ts", "src", "hesperia.d.ts"],
        },
        null,
        2,
      ) + "\n",
    "app.tsx":
      'import type { Component, Rendered } from "hesperia";\n\nexport default function App(props: Component.Props<{ children: Rendered }>) {\n  return <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Hesperia</title></head><body>{props.children()}</body></html>;\n}\n',
    "app.config.ts":
      'import type { AppConfiguration } from "hesperia";\n\nexport default { pageCacheSize: 5 } satisfies AppConfiguration;\n',
    "src/routes/+page.tsx":
      'import * as client from "hesperia/client";\n\nexport default function Page() {\n  const count = client.state(0);\n  return <main><h1>Hesperia</h1><button on:click={() => count.update(value => value + 1)}>Count: {count()}</button></main>;\n}\n',
    ".gitignore": "node_modules/\n.hesperia/\nhesperia.d.ts\n",
    "README.md":
      "# Hesperia application\n\nInstall dependencies with `bun install`, then start the browser application with `bun run dev`. Edit `app.tsx` for the HTML shell and `src/routes/+page.tsx` for the page. The shell places routed content through `props.children()`. Configure inactive page retention in `app.config.ts`; the default is five pages and zero disables caching. CSS-only edits update styles without reloading the page; changes to executable code reload it.\n\nRun `bun run check` to check authored modules, `bun run build` to create browser assets, and `bun run preview` to serve the build.\n",
  };

  for (const [path, source] of Object.entries(files)) {
    const filename = join(destination, path);

    await mkdir(resolve(filename, ".."), { recursive: true });

    await writeFile(filename, source, { flag: "wx" });
  }

  await writeProjectTypes(destination, await readProject(destination));
}
