import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { absolutePathKey as pathKey } from "./utils.ts";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The two browser build modes whose package conditions are part of resolution. */
export type BrowserBuildMode = "development" | "production";

/** Exact import names mapped to packages or project-config-relative replacement modules. */
export type BrowserResolutionOverrides = Readonly<Record<string, string>>;

/** Per-target project resolution settings shared by checking and tooling. */
export interface ProjectResolutionOverrides {
  /** Browser replacements apply once to exact import names; package conditions still apply. */
  readonly browser: BrowserResolutionOverrides;
}

/** Failure classes returned by the resolver before a compiler diagnostic is attached. */
export type ModuleResolutionFailureCode =
  | "HOST_IMPORT"
  | "PACKAGE_IMPORT_UNSUPPORTED"
  | "MODULE_NOT_FOUND"
  | "PACKAGE_NOT_FOUND"
  | "INVALID_PACKAGE"
  | "INVALID_PACKAGE_TARGET"
  | "EXPORTS_NO_MATCH"
  | "EXPORTS_BLOCKED";

/** A source captured by this resolution snapshot, including its stable content digest. */
export interface CapturedModuleSource {
  /** Canonical absolute path whose first captured bytes are used for this build. */
  readonly filename: string;
  /** Exact UTF-8 source captured for this path; later filesystem changes are ignored. */
  readonly source: string;
  /** Full SHA-256 digest of `source`, prefixed with `sha256-` for build records. */
  readonly digest: string;
}

/** A package manifest captured while resolving a dependency. */
export interface CapturedPackageManifest {
  /** Canonical absolute package.json path observed while resolving a dependency. */
  readonly filename: string;
  /** Exact manifest bytes observed for this path, including malformed JSON when present. */
  readonly source: string;
  /** Full SHA-256 digest of `source`, prefixed with `sha256-`. */
  readonly digest: string;
  /** Authored package name when the manifest contains a string `name` field. */
  readonly packageName?: string;
  /** Whether the captured JSON object explicitly owns an `exports` field. */
  readonly exportsPresent: boolean;
}

/** The package decision that led to one resolved module. */
export interface ModuleResolutionProvenance {
  /** Resolver condition set used for this request, including browser, import, mode, and default. */
  readonly conditions: readonly string[];
  /** Ordered package-map keys selected while descending through exports conditions/subpaths. */
  readonly conditionPath: readonly string[];
  /** Package owning the selected target, when this was a package request. */
  readonly packageName?: string;
  /** Requested package subpath, such as `.` or `./feature`, when applicable. */
  readonly packageSubpath?: string;
  /** Captured manifest that supplied the selected exports map. */
  readonly packageManifest?: string;
}

/** A successfully resolved source module. */
export interface ResolvedModule {
  /** This result contains a captured source rather than a live filesystem path. */
  readonly kind: "resolved";
  /** Canonical absolute source path selected by the resolver. */
  readonly filename: string;
  /** Exact captured source bytes for `filename`. */
  readonly source: string;
  /** Digest matching `source` and the resolver snapshot record. */
  readonly digest: string;
  /** Conditions and package-map decisions that selected this source. */
  readonly provenance: ModuleResolutionProvenance;
}

/** A structured resolution failure. */
export interface ModuleResolutionFailure {
  /** This request was rejected and must not be delegated to another resolver. */
  readonly kind: "failure";
  /** Stable failure class suitable for compiler diagnostics and build records. */
  readonly code: ModuleResolutionFailureCode;
  /** Canonical importer path used for the request. */
  readonly from: string;
  /** Authored import text that failed resolution. */
  readonly specifier: string;
  /** Human-readable explanation retaining the selected failure cause. */
  readonly message: string;
}

/** A result from one cached module request. */
export type ModuleResolution = ResolvedModule | ModuleResolutionFailure;

/** One dependency request observed by the immutable resolver snapshot. */
export interface ModuleResolutionEdge {
  /** Canonical importer path, ordered by first observation in the snapshot. */
  readonly from: string;
  /** Authored import text requested by `from`. */
  readonly specifier: string;
  /** Whether the request selected a captured source or a structured failure. */
  readonly outcome: "resolved" | "failed";
  /** Canonical selected source path for a successful request. */
  readonly resolvedFilename?: string;
  /** Ordered selected package condition keys for a successful package request. */
  readonly conditionPath?: readonly string[];
  /** Stable failure class for a rejected request. */
  readonly failureCode?: ModuleResolutionFailureCode;
}

interface PackageManifest {
  readonly filename: string;
  readonly packageRoot: string;
  readonly source: string;
  readonly packageName?: string;
  readonly exports?: unknown;
}

interface TargetSelection {
  readonly kind: "target";
  readonly target: string;
  readonly conditionPath: readonly string[];
}

type TargetResult =
  | TargetSelection
  | { readonly kind: "no-match" }
  | { readonly kind: "blocked" }
  | { readonly kind: "invalid-package" }
  | { readonly kind: "invalid" };

type ManifestLookup =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly failure: ModuleResolutionFailure }
  | { readonly kind: "manifest"; readonly value: PackageManifest };

const HOST_BUILTINS = new Set([
  "assert",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"] as const;

/**
 * Resolve browser dependencies against one build-local capture set. Each observed path is immutable
 * after its first read; distinct dependency paths and manifests are discovered lazily.
 *
 * The active conditions are a set for package matching; package object order remains authoritative.
 * Returned source, manifest, request, and edge collections preserve those first observations and
 * never reread an already captured path.
 * Existing files use their physical paths, so linked packages share one module instance with
 * compiler-selected entries. Unsaved and generated modules retain their virtual paths.
 */
export class ModuleResolver {
  readonly #root: string;
  readonly #mode: BrowserBuildMode;
  readonly #conditions: ReadonlySet<string>;
  readonly #sources = new Map<string, CapturedModuleSource>();
  readonly #missingSources = new Set<string>();
  readonly #manifests = new Map<string, CapturedPackageManifest>();
  readonly #manifestLookups = new Map<string, ManifestLookup>();
  readonly #requests = new Map<string, ModuleResolution>();
  readonly #edges = new Map<string, ModuleResolutionEdge>();
  readonly #pathIdentities = new Map<string, string>();

  readonly #overrides: BrowserResolutionOverrides;
  readonly #generatedImports: ReadonlyMap<string, string>;

  constructor(
    root: string,
    sources: ReadonlyMap<string, string>,
    mode: BrowserBuildMode,
    overrides: BrowserResolutionOverrides = {},
    generatedImports: ReadonlyMap<string, string> = new Map(),
  ) {
    this.#root = resolve(root);
    this.#mode = mode;
    this.#overrides = Object.freeze({ ...overrides });
    this.#generatedImports = new Map(generatedImports);
    this.#conditions = new Set(["browser", "import", mode, "default"]);

    for (const [filename, source] of sources)
      this.captureSource(resolve(this.#root, filename), source);
  }

  /** Build mode used by this snapshot. */
  get mode(): BrowserBuildMode {
    return this.#mode;
  }

  /** Canonically sorted active conditions for reproducibility records. */
  get activeConditions(): readonly string[] {
    return Object.freeze([...this.#conditions].sort());
  }

  /** Exact browser import replacements captured by this resolver snapshot. */
  get resolutionOverrides(): BrowserResolutionOverrides {
    return this.#overrides;
  }

  /** Resolve a project override target once, without applying another override to that target. */
  resolveProjectTarget(target: string): ModuleResolution {
    const importer = target.startsWith(".")
      ? join(this.#root, "override.ts")
      : join(this.#root, ".hesperia", "override.ts");
    return this.resolveUncached(importer, target, false);
  }

  /** Resolve the public TypeScript declaration selected by a project package target. */
  resolveProjectTypesTarget(target: string): ModuleResolution {
    const runtime = this.resolveProjectTarget(target);

    if (runtime.kind === "failure") return runtime;

    const manifestPath = runtime.provenance.packageManifest;

    if (!manifestPath) return runtime;

    const manifest = this.#manifests.get(pathKey(manifestPath));

    if (!manifest) return runtime;

    let value: { readonly exports?: unknown; readonly types?: unknown; readonly typings?: unknown };

    try {
      value = JSON.parse(manifest.source) as typeof value;
    } catch {
      return runtime;
    }

    const conditions = new Set(["types", ...this.#conditions]);
    const selected =
      value.exports === undefined
        ? undefined
        : selectExport(value.exports, runtime.provenance.packageSubpath ?? ".", conditions);
    const selectedTarget =
      selected?.kind === "target" && selected.conditionPath.includes("types")
        ? selected.target
        : undefined;
    const typeTarget =
      selectedTarget ??
      (typeof value.types === "string"
        ? value.types
        : typeof value.typings === "string"
          ? value.typings
          : undefined);

    if (!typeTarget) return runtime;

    const filename = validatePackageTarget(dirname(manifest.filename), typeTarget);

    if (!filename) return runtime;

    const source = this.captureSourceFromDisk(filename);

    if (!source) return runtime;

    return {
      kind: "resolved",
      filename: source.filename,
      source: source.source,
      digest: source.digest,
      provenance: {
        ...runtime.provenance,
        conditionPath: ["types", ...(selected?.kind === "target" ? selected.conditionPath : [])],
      },
    };
  }

  /** Captured module contents, including authored and lazily discovered dependencies. */
  get capturedSources(): readonly CapturedModuleSource[] {
    return Object.freeze([...this.#sources.values()]);
  }

  /** Captured package manifests, including their original bytes and content digests. */
  get capturedManifests(): readonly CapturedPackageManifest[] {
    return Object.freeze([...this.#manifests.values()]);
  }

  /** Dependency requests resolved or rejected by this snapshot. */
  get capturedEdges(): readonly ModuleResolutionEdge[] {
    return Object.freeze([...this.#edges.values()]);
  }

  /**
   * Create a resolver over this snapshot plus generated sources and virtual import identities.
   * Captured bytes, manifests, missing paths, and prior non-generated edges remain pinned; request
   * caches are copied so declared virtual IDs that were intentionally deferred can resolve now.
   */
  forkWithGeneratedSources(
    sources: ReadonlyMap<string, string>,
    generatedImports: ReadonlyMap<string, string>,
  ): ModuleResolver {
    const imports = new Map(this.#generatedImports);

    for (const [specifier, filename] of generatedImports) {
      const existing = imports.get(specifier);

      if (existing !== undefined && pathKey(existing) !== pathKey(filename))
        throw new Error(`Generated import identity conflicts for ${specifier}.`);

      imports.set(specifier, filename);
    }

    const fork = new ModuleResolver(this.#root, new Map(), this.#mode, this.#overrides, imports);

    copyMap(this.#sources, fork.#sources);

    copySet(this.#missingSources, fork.#missingSources);

    copyMap(this.#manifests, fork.#manifests);

    copyMap(this.#manifestLookups, fork.#manifestLookups);

    const deferredSpecifiers = [...generatedImports.keys()];

    const copyUnaffectedRequests = <T>(source: ReadonlyMap<string, T>, target: Map<string, T>) => {
      for (const [cacheKey, value] of source) {
        if (deferredSpecifiers.some((specifier) => cacheKey.endsWith(`\0${specifier}`))) continue;

        target.set(cacheKey, value);
      }
    };

    copyUnaffectedRequests(this.#requests, fork.#requests);

    copyUnaffectedRequests(this.#edges, fork.#edges);

    copyMap(this.#pathIdentities, fork.#pathIdentities);

    for (const [filename, source] of sources) fork.captureSource(filename, source);

    return fork;
  }

  /** Capture a compiler-selected module entry without inventing a project package override. */
  captureCompilerEntry(filename: string): CapturedModuleSource {
    const canonical = this.pathIdentity(filename);
    const key = pathKey(canonical);
    const existing = this.#sources.get(key);

    if (existing) return existing;

    if (!isSupportedModule(canonical))
      throw new Error(`Compiler entry is not a supported module: ${canonical}`);

    if (this.#missingSources.has(key))
      throw new Error(`Compiler entry could not be captured: ${canonical}`);

    let source: string;

    try {
      source = readFileSync(canonical, "utf8");
    } catch (error) {
      this.#missingSources.add(key);

      throw new Error(`Compiler entry could not be captured: ${canonical}`, { cause: error });
    }

    return this.captureSource(canonical, source);
  }

  /** Capture immutable in-memory compiler output under a generated module identity. */
  captureGeneratedSource(filename: string, source: string): CapturedModuleSource {
    const canonical = resolve(this.#root, filename);

    if (!isSupportedModule(canonical))
      throw new Error(`Generated module is not a supported module: ${canonical}`);

    const existing = this.#sources.get(pathKey(canonical));

    if (existing && existing.source !== source)
      throw new Error(`Generated module identity changed after capture: ${canonical}`);

    return existing ?? this.captureSource(canonical, source);
  }

  /**
   * Resolve a generated import to one compiler-selected entry and record that exact edge.
   * Generated runtime imports do not have a project package spelling to resolve, so this seam
   * binds the same captured bytes used by the Bun plugin without exposing an author override.
   * Reusing a request with a different selected filename fails closed.
   */
  resolveCompilerEntry(from: string, specifier: string, filename: string): ModuleResolution {
    const importer = this.pathIdentity(resolve(this.#root, from));
    const canonical = this.pathIdentity(filename);
    const cacheKey = `${pathKey(importer)}\0${specifier}`;
    const existing = this.#requests.get(cacheKey);

    if (existing) {
      if (existing.kind === "resolved" && pathKey(existing.filename) === pathKey(canonical))
        return existing;

      const conflict = failure(
        "MODULE_NOT_FOUND",
        importer,
        specifier,
        `Compiler-selected entry ${specifier} conflicts with the previously captured resolution.`,
      );
      return conflict;
    }

    let captured: CapturedModuleSource;

    try {
      captured = this.captureCompilerEntry(canonical);
    } catch (error) {
      const missing = failure(
        "MODULE_NOT_FOUND",
        importer,
        specifier,
        error instanceof Error
          ? error.message
          : `Compiler entry could not be captured: ${canonical}`,
      );

      this.#requests.set(cacheKey, missing);

      this.#edges.set(cacheKey, edge(importer, specifier, missing));

      return missing;
    }

    const selected: ResolvedModule = {
      kind: "resolved",
      filename: captured.filename,
      source: captured.source,
      digest: captured.digest,
      provenance: {
        conditions: this.activeConditions,
        conditionPath: ["compiler-entry", specifier],
      },
    };

    this.#requests.set(cacheKey, selected);

    this.#edges.set(cacheKey, edge(importer, specifier, selected));

    return selected;
  }

  /** Resolve one previously captured virtual module without consulting the filesystem. */
  resolveGeneratedEntry(from: string, specifier: string, filename: string): ModuleResolution {
    const importer = resolve(this.#root, from);
    const canonical = resolve(this.#root, filename);
    const cacheKey = `${pathKey(importer)}\0${specifier}`;
    const existing = this.#requests.get(cacheKey);

    if (existing) {
      if (existing.kind === "resolved" && pathKey(existing.filename) === pathKey(canonical))
        return existing;

      return failure(
        "MODULE_NOT_FOUND",
        importer,
        specifier,
        `Generated entry ${specifier} conflicts with the previously captured resolution.`,
      );
    }

    const captured = this.#sources.get(pathKey(canonical));

    if (!captured) {
      const missing = failure(
        "MODULE_NOT_FOUND",
        importer,
        specifier,
        `Generated entry was not captured: ${canonical}`,
      );

      this.#requests.set(cacheKey, missing);

      this.#edges.set(cacheKey, edge(importer, specifier, missing));

      return missing;
    }

    const selected: ResolvedModule = {
      kind: "resolved",
      filename: captured.filename,
      source: captured.source,
      digest: captured.digest,
      provenance: {
        conditions: this.activeConditions,
        conditionPath: ["generated-entry", specifier],
      },
    };

    this.#requests.set(cacheKey, selected);

    this.#edges.set(cacheKey, edge(importer, specifier, selected));

    return selected;
  }

  /** Resolve and cache one import request from an authored or captured module. */
  resolve(from: string, specifier: string): ModuleResolution {
    const generated = this.#generatedImports.get(specifier);

    if (generated) return this.resolveGeneratedEntry(from, specifier, generated);

    const importer = this.pathIdentity(resolve(this.#root, from));
    const cacheKey = `${pathKey(importer)}\0${specifier}`;
    const existing = this.#requests.get(cacheKey);

    if (existing) return existing;

    let result = this.resolveUncached(importer, specifier);

    if (
      specifier.startsWith("hesperia:plugin/") &&
      result.kind === "failure" &&
      (result.code === "PACKAGE_NOT_FOUND" || result.code === "MODULE_NOT_FOUND")
    )
      result = {
        ...result,
        message: `${result.message} Plugin-provided module ${specifier} is unavailable. Configure the plugin that provides it in hesperia.config.ts. If it is already configured, verify the module ID and returned browser module.`,
      };

    this.#requests.set(cacheKey, result);

    this.#edges.set(cacheKey, edge(importer, specifier, result));

    return result;
  }

  private resolveUncached(from: string, specifier: string, applyOverride = true): ModuleResolution {
    if (specifier === "hesperia/env")
      return failure(
        "HOST_IMPORT",
        from,
        specifier,
        `Host capability import ${specifier} is not browser-eligible.`,
      );

    const override =
      applyOverride && Object.prototype.hasOwnProperty.call(this.#overrides, specifier)
        ? this.#overrides[specifier]
        : undefined;

    if (override !== undefined) return this.resolveOverride(from, specifier, override);

    if (isHostImport(specifier))
      return failure(
        "HOST_IMPORT",
        from,
        specifier,
        `Host capability import ${specifier} is not browser-eligible.`,
      );

    if (specifier.startsWith("#"))
      return failure(
        "PACKAGE_IMPORT_UNSUPPORTED",
        from,
        specifier,
        `Package import ${specifier} requires a declared package-import resolver.`,
      );

    if (specifier.startsWith(".")) return this.resolveRelative(from, specifier);

    return this.resolvePackage(from, specifier);
  }

  private resolveOverride(from: string, specifier: string, target: string): ModuleResolution {
    const selected = this.resolveProjectTarget(target);

    if (selected.kind === "failure")
      return failure(
        selected.code,
        from,
        specifier,
        `Browser resolution override for ${specifier} could not resolve ${target}: ${selected.message}`,
      );

    const resolved: ResolvedModule = {
      kind: "resolved",
      filename: selected.filename,
      source: selected.source,
      digest: selected.digest,
      provenance: {
        ...selected.provenance,
        conditionPath: ["override", specifier, target, ...selected.provenance.conditionPath],
      },
    };
    return resolved;
  }

  private resolveRelative(from: string, specifier: string): ModuleResolution {
    const base = resolve(dirname(from), specifier);
    const candidates = extname(base)
      ? [base]
      : [
          base,
          ...MODULE_EXTENSIONS.map((suffix) => `${base}${suffix}`),
          ...MODULE_EXTENSIONS.map((suffix) => `${join(base, "index")}${suffix}`),
        ];

    for (const candidate of candidates) {
      const source = this.captureSourceFromDisk(candidate);

      if (source)
        return {
          kind: "resolved",
          filename: source.filename,
          source: source.source,
          digest: source.digest,
          provenance: {
            conditions: this.activeConditions,
            conditionPath: [],
          },
        };
    }

    return failure(
      "MODULE_NOT_FOUND",
      from,
      specifier,
      `Cannot resolve relative module ${specifier} from ${from}.`,
    );
  }

  private resolvePackage(from: string, specifier: string): ModuleResolution {
    const parsed = parsePackageSpecifier(specifier);

    if (!parsed)
      return failure(
        "PACKAGE_NOT_FOUND",
        from,
        specifier,
        `Invalid package specifier ${specifier}.`,
      );

    const scope = this.findPackageScope(from);

    if (scope.kind === "invalid") return scope.failure;

    if (
      scope.kind === "manifest" &&
      scope.value.packageName === parsed.packageName &&
      scope.value.exports !== undefined
    )
      return this.resolvePackageRoot(scope.value, parsed.subpath, from, specifier);

    let directory = dirname(from);

    while (true) {
      const packageRoot = join(directory, "node_modules", parsed.packageName);
      const manifest = this.readManifest(packageRoot);

      if (manifest.kind === "invalid") return manifest.failure;

      if (manifest.kind === "manifest")
        return this.resolvePackageRoot(manifest.value, parsed.subpath, from, specifier);

      const parent = dirname(directory);

      if (parent === directory) break;

      directory = parent;
    }

    return failure(
      "PACKAGE_NOT_FOUND",
      from,
      specifier,
      `Cannot resolve package ${parsed.packageName} from ${from}.`,
    );
  }

  private resolvePackageRoot(
    manifest: PackageManifest,
    subpath: string,
    from: string,
    specifier: string,
  ): ModuleResolution {
    if (manifest.exports === undefined)
      return failure(
        "EXPORTS_NO_MATCH",
        from,
        specifier,
        `Package ${manifest.packageName ?? manifest.packageRoot} has no exports entry for ${subpath}.`,
      );

    const selected = selectExport(manifest.exports, subpath, this.#conditions);

    if (selected.kind === "blocked")
      return failure(
        "EXPORTS_BLOCKED",
        from,
        specifier,
        `Package ${manifest.packageName ?? manifest.packageRoot} blocks export ${subpath}.`,
      );

    if (selected.kind === "no-match")
      return failure(
        "EXPORTS_NO_MATCH",
        from,
        specifier,
        `Package ${manifest.packageName ?? manifest.packageRoot} has no matching export for ${subpath}.`,
      );

    if (selected.kind === "invalid-package")
      return failure(
        "INVALID_PACKAGE",
        from,
        specifier,
        `Package ${manifest.packageName ?? manifest.packageRoot} has invalid exports configuration.`,
      );

    if (selected.kind === "invalid")
      return failure(
        "INVALID_PACKAGE_TARGET",
        from,
        specifier,
        `Package ${manifest.packageName ?? manifest.packageRoot} has an invalid export target for ${subpath}.`,
      );

    const target = validatePackageTarget(manifest.packageRoot, selected.target);

    if (!target)
      return failure(
        "INVALID_PACKAGE_TARGET",
        from,
        specifier,
        `Package ${manifest.packageName ?? manifest.packageRoot} has an escaping export target for ${subpath}.`,
      );

    const source = this.captureSourceFromDisk(target);

    if (!source)
      return failure(
        "MODULE_NOT_FOUND",
        from,
        specifier,
        `Package ${manifest.packageName ?? manifest.packageRoot} export ${subpath} resolves to a missing module.`,
      );

    return {
      kind: "resolved",
      filename: source.filename,
      source: source.source,
      digest: source.digest,
      provenance: {
        conditions: this.activeConditions,
        conditionPath: selected.conditionPath,
        packageName: manifest.packageName,
        packageSubpath: subpath,
        packageManifest: manifest.filename,
      },
    };
  }

  private findPackageScope(filename: string): ManifestLookup {
    let directory = dirname(filename);

    while (true) {
      if (basename(directory) === "node_modules") return { kind: "missing" };

      const manifest = this.readManifest(directory);

      if (manifest.kind !== "missing") return manifest;

      const parent = dirname(directory);

      if (parent === directory) return { kind: "missing" };

      directory = parent;
    }
  }

  private readManifest(packageRoot: string): ManifestLookup {
    const manifestPath = this.pathIdentity(join(packageRoot, "package.json"));
    const manifestKey = pathKey(manifestPath);
    const existing = this.#manifestLookups.get(manifestKey);

    if (existing) return existing;

    const captured = this.captureManifestFromDisk(manifestPath);

    if (!captured) {
      const missing = { kind: "missing" } as const;

      this.#manifestLookups.set(manifestKey, missing);

      return missing;
    }

    let value: unknown;

    try {
      value = JSON.parse(captured.source);
    } catch {
      const invalid = {
        kind: "invalid",
        failure: failure(
          "INVALID_PACKAGE",
          this.#root,
          captured.filename,
          `Package manifest ${captured.filename} is not valid JSON.`,
        ),
      } as const;

      this.#manifestLookups.set(manifestKey, invalid);

      return invalid;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const invalid = {
        kind: "invalid",
        failure: failure(
          "INVALID_PACKAGE",
          this.#root,
          captured.filename,
          `Package manifest ${captured.filename} must contain a JSON object.`,
        ),
      } as const;

      this.#manifestLookups.set(manifestKey, invalid);

      return invalid;
    }

    const fields = value as { name?: unknown; exports?: unknown };
    const manifest: PackageManifest = {
      filename: captured.filename,
      packageRoot: dirname(captured.filename),
      source: captured.source,
      ...(typeof fields.name === "string" ? { packageName: fields.name } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, "exports")
        ? { exports: fields.exports }
        : {}),
    };
    const result = { kind: "manifest", value: manifest } as const;

    this.#manifestLookups.set(manifestKey, result);

    return result;
  }

  private captureSourceFromDisk(filename: string): CapturedModuleSource | undefined {
    const canonical = this.pathIdentity(filename);

    if (!isSupportedModule(canonical)) return undefined;

    const key = pathKey(canonical);
    const existing = this.#sources.get(key);

    if (existing) return existing;

    if (this.#missingSources.has(key)) return undefined;

    if (!existsSync(canonical)) {
      this.#missingSources.add(key);

      return undefined;
    }

    let source: string;

    try {
      source = readFileSync(canonical, "utf8");
    } catch {
      this.#missingSources.add(key);

      return undefined;
    }

    return this.captureSource(canonical, source);
  }

  private captureManifestFromDisk(filename: string): CapturedPackageManifest | undefined {
    const existing = this.#manifests.get(pathKey(filename));

    if (existing) return existing;

    if (!existsSync(filename)) return undefined;

    let source: string;

    try {
      source = readFileSync(filename, "utf8");
    } catch {
      return undefined;
    }

    let value: { name?: unknown; exports?: unknown };

    try {
      value = JSON.parse(source) as typeof value;
    } catch {
      value = {};
    }

    const captured: CapturedPackageManifest = Object.freeze({
      filename: resolve(filename),
      source,
      digest: digest(source),
      ...(typeof value.name === "string" ? { packageName: value.name } : {}),
      exportsPresent: Object.prototype.hasOwnProperty.call(value, "exports"),
    });

    this.#manifests.set(pathKey(filename), captured);

    return captured;
  }

  private captureSource(filename: string, source: string): CapturedModuleSource {
    filename = this.pathIdentity(filename);
    const existing = this.#sources.get(pathKey(filename));

    if (existing) return existing;

    const captured: CapturedModuleSource = Object.freeze({
      filename: resolve(filename),
      source,
      digest: digest(source),
    });

    this.#sources.set(pathKey(filename), captured);

    return captured;
  }

  private pathIdentity(filename: string): string {
    const absolute = resolve(filename);
    const key = pathKey(absolute);
    const existing = this.#pathIdentities.get(key);

    if (existing !== undefined) return existing;

    let canonical = absolute;

    try {
      canonical = realpathSync(absolute);
    } catch {
      // Unsaved and generated modules have no filesystem entry.
    }

    this.#pathIdentities.set(key, canonical);

    return canonical;
  }
}

function copyMap<K, V>(source: ReadonlyMap<K, V>, target: Map<K, V>): void {
  for (const [key, value] of source) target.set(key, value);
}

function copySet<T>(source: ReadonlySet<T>, target: Set<T>): void {
  for (const value of source) target.add(value);
}

function selectExport(
  exports: unknown,
  subpath: string,
  conditions: ReadonlySet<string>,
): TargetResult {
  if (typeof exports === "string" || exports === null || Array.isArray(exports))
    return subpath === "." ? selectTarget(exports, conditions, []) : { kind: "no-match" };

  if (!exports || typeof exports !== "object") return { kind: "invalid-package" };

  const entries = Object.entries(exports);
  const subpaths = entries.filter(([key]) => key.startsWith("."));

  if (subpaths.length) {
    if (subpaths.length !== entries.length) return { kind: "invalid-package" };

    const exact = subpaths.find(([key]) => key === subpath);

    if (exact) return selectTarget(exact[1], conditions, [exact[0]]);

    const patterns = subpaths
      .filter(([key]) => key.includes("*"))
      .map(([key, value], index) => ({
        key,
        value,
        index,
        prefix: key.slice(0, key.indexOf("*")),
        suffix: key.slice(key.indexOf("*") + 1),
      }))
      .filter((item) => subpath.startsWith(item.prefix) && subpath.endsWith(item.suffix))
      .sort(
        (left, right) =>
          right.prefix.length - left.prefix.length ||
          right.key.length - left.key.length ||
          left.index - right.index,
      );
    const pattern = patterns[0];

    if (!pattern) return { kind: "no-match" };

    const match = subpath.slice(pattern.prefix.length, subpath.length - pattern.suffix.length);
    return selectTarget(pattern.value, conditions, [pattern.key], match);
  }

  return subpath === "." ? selectTarget(exports, conditions, []) : { kind: "no-match" };
}

function selectTarget(
  value: unknown,
  conditions: ReadonlySet<string>,
  conditionPath: readonly string[],
  patternMatch?: string,
): TargetResult {
  if (value === null) return { kind: "blocked" };

  if (typeof value === "string") {
    const target = patternMatch === undefined ? value : value.replaceAll("*", patternMatch);

    if (!isSyntacticallyValidTarget(target)) return { kind: "invalid" };

    return {
      kind: "target",
      target,
      conditionPath,
    };
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const selected = selectTarget(item, conditions, conditionPath, patternMatch);

      if (selected.kind === "target") return selected;

      if (selected.kind === "blocked") continue;

      if (selected.kind === "invalid-package") return selected;

      if (selected.kind === "no-match" || selected.kind === "invalid") continue;
    }

    return { kind: "no-match" };
  }

  if (!value || typeof value !== "object") return { kind: "invalid" };

  if (Object.keys(value).some(isArrayIndexKey)) return { kind: "invalid-package" };

  for (const [condition, target] of Object.entries(value)) {
    if (!conditions.has(condition)) continue;

    const selected = selectTarget(target, conditions, [...conditionPath, condition], patternMatch);

    if (selected.kind === "target") return selected;

    if (selected.kind === "blocked") return selected;

    if (selected.kind === "invalid-package") return selected;

    if (selected.kind === "invalid") return selected;
  }

  return { kind: "no-match" };
}

function isSyntacticallyValidTarget(target: string): boolean {
  if (!target.startsWith("./") || target.includes("\\")) return false;

  if (/%2f|%5c/iu.test(target)) return false;

  let decoded: string;

  try {
    decoded = decodeURIComponent(target);
  } catch {
    return false;
  }

  if (decoded.includes("\\")) return false;

  return !decoded
    .slice(2)
    .split("/")
    .some((segment) => segment === "." || segment === ".." || segment === "node_modules");
}

function validatePackageTarget(packageRoot: string, target: string): string | undefined {
  if (!isSyntacticallyValidTarget(target)) return undefined;

  let resolved: string;

  try {
    resolved = fileURLToPath(
      new URL(
        target,
        pathToFileURL(`${resolve(packageRoot)}${process.platform === "win32" ? "\\" : "/"}`),
      ),
    );
  } catch {
    return undefined;
  }

  const displacement = relative(resolve(packageRoot), resolved);

  if (!displacement || isAbsolute(displacement) || displacement.startsWith("..")) return undefined;

  return resolved;
}

function isArrayIndexKey(key: string): boolean {
  if (!/^\d+$/u.test(key)) return false;

  const value = Number(key);
  return value < 4_294_967_295 && String(value) === key;
}

function parsePackageSpecifier(
  specifier: string,
): { readonly packageName: string; readonly subpath: string } | undefined {
  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

  if (!packageName || (specifier.startsWith("@") && parts.length < 2)) return undefined;

  return {
    packageName,
    subpath: specifier.slice(packageName.length).replace(/^\//u, "")
      ? `./${specifier.slice(packageName.length).replace(/^\//u, "")}`
      : ".",
  };
}

function isHostImport(specifier: string): boolean {
  return (
    specifier.startsWith("node:") || specifier.startsWith("bun:") || HOST_BUILTINS.has(specifier)
  );
}

function isSupportedModule(filename: string): boolean {
  return MODULE_EXTENSIONS.some((suffix) => filename.endsWith(suffix));
}

function failure(
  code: ModuleResolutionFailureCode,
  from: string,
  specifier: string,
  message: string,
): ModuleResolutionFailure {
  return Object.freeze({ kind: "failure", code, from, specifier, message });
}

function edge(from: string, specifier: string, result: ModuleResolution): ModuleResolutionEdge {
  return Object.freeze(
    result.kind === "resolved"
      ? {
          from,
          specifier,
          outcome: "resolved",
          resolvedFilename: result.filename,
          conditionPath: result.provenance.conditionPath,
        }
      : { from, specifier, outcome: "failed", failureCode: result.code },
  );
}

function digest(source: string): string {
  return `sha256-${createHash("sha256").update(source).digest("hex")}`;
}
