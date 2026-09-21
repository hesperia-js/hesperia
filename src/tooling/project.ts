import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import remapping, { type SourceMapInput } from "@jridgewell/remapping";
import { analyzeBrowserCapabilities, type CompilerDiagnostic } from "../compiler/index.ts";
import { analyzeModule, emitAnalysis } from "../compiler/compilation.ts";
import type { VirtualModule } from "../compiler/checking.ts";
import { ModuleResolver } from "../compiler/module-resolution.ts";
import { compileProjectModules, type ProjectCompilation } from "../compiler/project-compilation.ts";
import { runtimeKeyRegistry } from "../compiler/runtime-keys.ts";
import { readConfiguration, type ProjectConfiguration } from "./configuration.ts";
import { scanRouteFiles } from "../routing/scanner.ts";
import { buildRouteGuards, routeFilesFromManifest } from "./route-build.ts";
import { createRouteTable } from "./route-table.ts";
import { writeProjectTypes } from "./page-types.ts";
import { browserStartupHtml, browserStartupSource, startupModules } from "./startup.ts";

/** A diagnostic retains its authored file when several modules are checked together. */
export interface ProjectDiagnostic extends CompilerDiagnostic {
  readonly filename: string;
}

/** Browser artifacts are prepared in memory before a successful build is published. */
export interface BrowserBuild {
  /** URL-keyed assets captured before publishing a successful build. */
  readonly files: ReadonlyMap<string, Blob>;
  /** Authored sources and native TypeScript checking inputs used for development watching. */
  readonly sources: readonly string[];
  /** Authored diagnostics retained after successful checking and emission. */
  readonly diagnostics: readonly ProjectDiagnostic[];
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
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        throw error;
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
export function checkSources(
  files: ReadonlyMap<string, string>,
  root = process.cwd(),
  configuration: ProjectConfiguration = {
    allowUnsafeHTML: false,
    resolutionOverrides: { browser: {} },
  },
  resolution?: ModuleResolver,
): readonly ProjectDiagnostic[] {
  return projectCompilation(files, root, configuration, resolution).checking.modules.flatMap(
    (module) => module.diagnostics.map((item) => ({ ...item, filename: module.filename })),
  );
}

/** Compile and bundle a browser application without writing partial output on failure. */
export async function prepareBuild(root: string, development = false): Promise<BrowserBuild> {
  root = resolve(root);
  const configuration = await readConfiguration(root);
  const sources = await readProject(root);
  const resolution = new ModuleResolver(
    root,
    sources,
    development ? "development" : "production",
    configuration.resolutionOverrides.browser,
  );
  const projectRuntimeModule = `hesperia:compiler-runtime:project:${new Bun.CryptoHasher("sha256")
    .update(root)
    .digest("hex")
    .slice(0, 16)}`;
  const runtimeFilename = Bun.resolveSync("hesperia/runtime", import.meta.dir);
  const runtimeEntry = resolution.captureCompilerEntry(runtimeFilename);
  const runtimeDiagnostics = analyzeBrowserCapabilities(
    [...[...sources].map(([filename, source]) => ({ filename, source })), runtimeEntry],
    root,
    resolution,
    [runtimeEntry.filename],
  );
  const compilation = projectCompilation(
    sources,
    root,
    configuration,
    resolution,
    projectRuntimeModule,
  );
  const diagnostics = [
    ...runtimeDiagnostics,
    ...compilation.checking.modules.flatMap((module) =>
      module.diagnostics.map((item) => ({ ...item, filename: module.filename })),
    ),
  ];
  if (!diagnostics.some((item) => item.code === "HES-ROUTE-SCAN"))
    await writeProjectTypes(root, sources);
  if (diagnostics.some((item) => item.severity === "error"))
    throw new ProjectError("Hesperia checking failed", diagnostics);
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
  const routeTable = createRouteTable({ manifest, root, guardUrls: routeGuardUrls });
  const shellEntrypoint = join(root, "app.tsx");
  if (!sources.has(shellEntrypoint))
    throw new ProjectError("The browser application requires a root app.tsx shell");
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
  const generatedSources = new Map<string, GeneratedBrowserSource>();
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
    generatedSpecifiers.set(
      guard.outputUrl,
      captureGenerated(
        join(generatedRoot, "guards", `${sourceToken(guard.outputUrl)}.js`),
        guard.code,
        "route-guard",
        emitGeneratedModule(guard.code, guard.routeFilename, projectRuntimeModule).semanticHash,
        guard.routeFilename,
        digestJson(guard.map),
      ),
    );
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
      const generated = generatedSources.get(sourceKey(from));
      if (generated && specifier === projectRuntimeModule)
        return resolution.resolveCompilerEntry(from, specifier, runtimeEntry.filename);
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
  const result = await Bun.build({
    entrypoints: [mainEntrypoint, routeTableEntrypoint],
    root,
    target: "browser",
    format: "esm",
    conditions: [...resolution.activeConditions],
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
  for (const guard of routeBuild.guards) {
    files.set(guard.outputUrl, new Blob([guard.code], { type: "text/javascript; charset=utf-8" }));
    files.set(
      `${guard.outputUrl}.map`,
      new Blob([JSON.stringify(guard.map)], { type: "application/json" }),
    );
  }
  for (const artifact of result.outputs) files.set(outputPath(artifact.path), artifact);
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
  const record = {
    version: 1,
    target: "browser",
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
    checkingInputs: compilation.checking.checkingInputs.map((item) => ({
      filename: recordFilename(root, item.filename),
      digest: item.digest,
    })),
    configuration,
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
  files.set(
    "/index.html",
    new Blob([browserStartupHtml(outputPath(entry.path))], {
      type: "text/html; charset=utf-8",
    }),
  );
  return {
    files,
    sources: Object.freeze([
      ...sources.keys(),
      ...compilation.checking.checkingInputs.map((item) => item.filename),
    ]),
    diagnostics,
  };
}

function outputPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/assets/");
  if (index >= 0) return normalized.slice(index);
  if (normalized.startsWith("assets/")) return `/${normalized}`;
  throw new ProjectError(`Unexpected browser artifact path: ${path}`);
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
  return absolute.toLowerCase();
}

function samePath(first: string, second: string, root?: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  const left = normalize(first);
  const right = normalize(second);
  if (left === right || left.endsWith(`:${right}`) || left.endsWith(`/${right}`)) return true;
  if (left.startsWith("/") || /^[a-z]:\//u.test(left)) return false;
  for (const base of [root, process.cwd()].filter(
    (value): value is string => value !== undefined,
  )) {
    const absolute = normalize(resolve(base, first));
    if (absolute === right || absolute.endsWith(`:${right}`) || absolute.endsWith(`/${right}`))
      return true;
  }
  return false;
}

function sourceKey(filename: string): string {
  return resolve(filename).replaceAll("\\", "/").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Publish successful artifacts; write the HTML entry last and keep previous hashed assets usable. */
export async function writeBuild(root: string, build: BrowserBuild): Promise<string> {
  const output = resolve(root, ".hesperia/build");
  for (const [path, blob] of build.files) {
    const destination = join(output, path.slice(1));
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, new Uint8Array(await blob.arrayBuffer()));
  }
  return output;
}

function projectCompilation(
  files: ReadonlyMap<string, string>,
  root: string,
  configuration: ProjectConfiguration,
  resolution?: ModuleResolver,
  runtimeModule?: string,
): ProjectCompilation {
  const modules: VirtualModule[] = [...files].map(([filename, source]) => ({ filename, source }));
  return compileProjectModules(modules, {
    root,
    ...configuration,
    documentShell: true,
    browserTarget: true,
    resolution,
    resolutionOverrides: configuration.resolutionOverrides,
    runtimeModule,
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
          dependencies: { hesperia: "0.0.0", aeolia: "0.0.0" },
          devDependencies: { typescript: "7.0.2", "@types/bun": "1.4.2" },
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
      "# Hesperia application\n\nInstall dependencies with `bun install`, then start the browser application with `bun run dev`. Edit `app.tsx` for the HTML shell and `src/routes/+page.tsx` for the page. The shell places routed content through `props.children()`. Configure inactive page retention in `app.config.ts`; the default is five pages and zero disables caching. Development changes reload the page.\n\nRun `bun run check` to check authored modules, `bun run build` to create browser assets, and `bun run preview` to serve the build.\n",
  };
  for (const [path, source] of Object.entries(files)) {
    const filename = join(destination, path);
    await mkdir(resolve(filename, ".."), { recursive: true });
    await writeFile(filename, source, { flag: "wx" });
  }
  await writeProjectTypes(destination, await readProject(destination));
}
