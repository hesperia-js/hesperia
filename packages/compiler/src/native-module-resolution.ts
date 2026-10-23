import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  ModuleResolver,
  isHostImport,
  type BrowserBuildMode,
  type CapturedModuleSource,
  type CapturedPackageManifest,
  type ModuleResolution,
  type ModuleResolutionEdge,
  type ModuleResolutionFailure,
} from "./module-resolution.ts";
import { absolutePathKey as pathKey } from "./utils.ts";

interface NativeBinding<Runtime extends string, Profile extends string, Identity extends string> {
  /** Binding format version. */
  readonly version: 1;
  /** Explicit runtime/profile declaration recorded by the target owner. */
  readonly declaration: {
    /** Declaration format version. */
    readonly version: 1;
    /** Declared runtime, independent of the build process. */
    readonly runtime: Runtime;
    /** Owned deployment contract within that runtime. */
    readonly profile: Profile;
  };
  /** Descriptor associated with this exact runtime/profile pair. */
  readonly descriptorIdentity: Identity;
  /** Required descriptor revision. */
  readonly descriptorRevision: 1;
}

interface NativePolicyData {
  /** Policy format version, independent of build records. */
  readonly version: 1;
  /** Explicit native runtime cohort; the build process does not select it. */
  readonly runtimeVersion: string;
  /** Complete supplied native condition set, without inferred additions. */
  readonly conditions: readonly string[];
  /** Exact import spellings admitted without a captured source file. */
  readonly externalModules: readonly string[];
  /** Source provenance supplied by the owner of the native policy. */
  readonly provenance: string;
}

/** Descriptor-correlated native source-selection data; its caller supplies the owned policy. */
export type NativeResolutionPolicy = NativePolicyData & (
  | {
      /** Correlated explicit Node/fetch declaration and descriptor. */
      readonly binding: NativeBinding<"node", "fetch", "hesperia.target/node-fetch/1">;
      /** Captured module contract associated with this descriptor. */
      readonly moduleABI: "node-captured-esm-v1";
    }
  | {
      /** Correlated explicit Bun/Elysia declaration and descriptor. */
      readonly binding: NativeBinding<"bun", "elysia", "hesperia.target/bun-elysia/1">;
      /** Captured module contract associated with this descriptor. */
      readonly moduleABI: "bun-captured-esm-v1";
    }
  | {
      /** Correlated explicit Bun/Hono declaration and descriptor. */
      readonly binding: NativeBinding<"bun", "hono", "hesperia.target/bun-hono/1">;
      /** Captured module contract associated with this descriptor. */
      readonly moduleABI: "bun-captured-esm-v1";
    }
);

/** An exact native-policy decision, without fabricated source or filesystem identity. */
export interface NativeExternalModule {
  /** The policy admits this spelling as a native external. */
  readonly kind: "external";
  /** Original requested spelling, matched exactly against the policy. */
  readonly specifier: string;
  /** SHA-256 digest of the complete copied native policy. */
  readonly policyDigest: string;
  /** Actual explicit declaration and descriptor selected by the policy. */
  readonly binding: NativeResolutionPolicy["binding"];
  /** Actual module contract selected by that descriptor. */
  readonly moduleABI: NativeResolutionPolicy["moduleABI"];
  /** Native runtime version supplied by the policy. */
  readonly runtimeVersion: string;
  /** Complete supplied native condition set. */
  readonly conditions: readonly string[];
  /** Source provenance of the external decision. */
  readonly provenance: string;
}

/** A captured module, structured refusal, or exact native external decision. */
export type NativeModuleResolution = ModuleResolution | NativeExternalModule;

/** One external request retained alongside ordinary captured-module edges. */
export interface NativeExternalModuleEdge {
  /** Canonical path of an actually captured importer. */
  readonly from: string;
  /** Original import spelling. */
  readonly specifier: string;
  /** The request selected an explicit native external rather than a source file. */
  readonly outcome: "external";
  /** Digest of the complete policy that admitted this exact spelling. */
  readonly policyDigest: string;
}

/** One unique actual request and its immutable result, in first-observation order. */
export interface NativeModuleResolutionRecord {
  /** Observed request, including the selected package path or refusal class. */
  readonly observed: ModuleResolutionEdge | NativeExternalModuleEdge;
  /** Captured source, refusal, or native policy decision for this request. */
  readonly result: NativeModuleResolution;
}

/** Source-selection evidence to be bound to an actual server build by its producer. */
export interface NativeModuleResolutionSnapshot {
  /** Native resolver snapshot format. */
  readonly version: 1;
  /** This snapshot describes the server source graph only. */
  readonly target: "server";
  /** Captured build mode, independent of the native condition set. */
  readonly mode: BrowserBuildMode;
  /** Complete validated policy, including its correlated declaration and descriptor. */
  readonly policy: NativeResolutionPolicy;
  /** Exact supplied conditions; no browser or mode key is added. */
  readonly conditions: readonly string[];
  /** Native source selection applies no browser project overrides. */
  readonly overrides: Readonly<Record<string, never>>;
  /** Full first-captured source bytes and their content digests. */
  readonly sources: readonly CapturedModuleSource[];
  /** Full first-captured package manifest bytes, including invalid manifests. */
  readonly manifests: readonly CapturedPackageManifest[];
  /** Every unique actual request, including native decisions and failures. */
  readonly edges: readonly NativeModuleResolutionRecord[];
}

/**
 * Resolve a native captured graph while retaining the ordinary resolver's package decisions.
 * Policy conditions and exact externals are source-selection facts, not host availability.
 */
export class NativeModuleResolver {
  readonly #root: string;
  readonly #policy: NativeResolutionPolicy;
  readonly #policyDigest: string;
  readonly #externals: ReadonlySet<string>;
  readonly #generatedImports: ReadonlyMap<string, string>;
  readonly #paths = new Map<string, string>();
  readonly #importers = new Map<string, string>();
  readonly #requests = new Map<string, NativeModuleResolutionRecord>();
  readonly #missingImporterRequests = new Set<string>();
  readonly #entryTargets = new Map<string, { readonly filename: string; readonly generated: boolean }>();
  #resolver: ModuleResolver;
  #conflict: Error | undefined;

  /**
   * Capture primary sources and the caller's native policy without reading policy getters.
   * The producer must supply its owned hosting policy; shape validation grants no authority.
   * Proxy reflection traps retain their native synchronous behavior.
   * @param root - Root for relative source and generated-entry paths.
   * @param sources - Actual primary module bytes, keyed by source path.
   * @param mode - Captured development or production mode; it adds no condition.
   * @param policy - Closed native descriptor, ABI, conditions and external policy.
   * @param generatedImports - Exact compiler-generated aliases and their selected files.
   * @throws TypeError for malformed policy, host-shaped aliases or external/generated collisions.
   * @throws Error for conflicting source bytes under one canonical identity.
   */
  constructor(
    root: string,
    sources: ReadonlyMap<string, string>,
    mode: BrowserBuildMode,
    policy: NativeResolutionPolicy,
    generatedImports: ReadonlyMap<string, string> = new Map(),
  ) {
    if (mode !== "development" && mode !== "production")
      throw new TypeError("Native module resolution requires development or production mode");

    this.#root = resolve(root);
    this.#policy = snapshotPolicy(policy);
    this.#policyDigest = `sha256-${createHash("sha256").update(JSON.stringify(this.#policy)).digest("hex")}`;
    this.#externals = new Set(this.#policy.externalModules);
    this.#generatedImports = this.generatedImports(generatedImports);
    this.#resolver = new ModuleResolver(
      this.#root,
      this.sources(sources),
      mode,
      {},
      this.#generatedImports,
      this.#policy.conditions,
    );

    for (const source of this.#resolver.capturedSources) this.remember(source);
  }

  /** Captured build mode; package conditions come only from the native policy. */
  get mode(): BrowserBuildMode {
    return this.#resolver.mode;
  }

  /** Exact supplied condition order, copied and frozen during policy capture. */
  get activeConditions(): readonly string[] {
    return this.#policy.conditions;
  }

  /** Complete copied and deeply frozen native source-selection policy. */
  get policy(): NativeResolutionPolicy {
    return this.#policy;
  }

  /** Copied first-captured module bytes; callers cannot mutate the underlying capture. */
  get capturedSources(): readonly CapturedModuleSource[] {
    return freezeCopy(this.#resolver.capturedSources);
  }

  /** Copied first-captured manifest bytes, including malformed package JSON. */
  get capturedManifests(): readonly CapturedPackageManifest[] {
    return freezeCopy(this.#resolver.capturedManifests);
  }

  /**
   * Resolve one request only after its importer has actually been captured.
   * @param from - Authored, generated or compiler-captured importer path.
   * @param specifier - Original exact import spelling.
   * @returns The immutable first decision; missing importers produce retained failures.
   */
  resolve(from: string, specifier: string): NativeModuleResolution {
    const importer = this.canonicalPath(from);
    const key = requestKey(importer, specifier);
    const previous = this.#requests.get(key);

    if (previous) return previous.result;

    if (!this.#importers.has(pathKey(importer))) {
      this.#missingImporterRequests.add(key);

      return this.retain(importer, specifier, missingImporter(importer, specifier));
    }

    if (this.#externals.has(specifier))
      return this.retain(importer, specifier, {
        kind: "external",
        specifier,
        policyDigest: this.#policyDigest,
        binding: this.#policy.binding,
        moduleABI: this.#policy.moduleABI,
        runtimeVersion: this.#policy.runtimeVersion,
        conditions: this.#policy.conditions,
        provenance: this.#policy.provenance,
      });

    return this.retain(importer, specifier, this.#resolver.resolve(importer, specifier));
  }

  /**
   * Capture a real compiler-selected file through the underlying immutable capture.
   * @param filename - Actual selected module file, resolved against this root when relative.
   * @returns Copied captured bytes and digest.
   * @throws Error when the selected module is missing or unsupported.
   */
  captureCompilerEntry(filename: string): CapturedModuleSource {
    const captured = this.#resolver.captureCompilerEntry(this.canonicalPath(filename));

    this.remember(captured);

    return freezeCopy(captured);
  }

  /**
   * Capture actual compiler output without reading a generated file from disk.
   * @param filename - Generated module identity within this capture.
   * @param source - Exact compiler output bytes.
   * @returns Copied immutable source record.
   * @throws Error for changed captured bytes or an unsupported module identity.
   */
  captureGeneratedSource(filename: string, source: string): CapturedModuleSource {
    if (typeof source !== "string") throw new TypeError("Captured module source must be a string");

    const canonical = this.canonicalPath(filename);
    const previous = this.#resolver.capturedSources.find((entry) => pathKey(entry.filename) === pathKey(canonical));

    if (previous && previous.source !== source) {
      const message = `Generated module identity changed after capture: ${canonical}`;

      this.#conflict ??= new Error(message);

      throw new Error(message);
    }

    const captured = this.#resolver.captureGeneratedSource(canonical, source);

    this.remember(captured);

    return freezeCopy(captured);
  }

  /**
   * Retain an actual compiler-selected entry and its original request spelling.
   * @param from - Already captured importer.
   * @param specifier - Exact generated import spelling.
   * @param filename - Actual compiler-selected module file.
   * @returns Captured source or structured refusal; conflicts invalidate snapshot export.
   */
  resolveCompilerEntry(from: string, specifier: string, filename: string): NativeModuleResolution {
    return this.resolveEntry(from, specifier, filename, false);
  }

  /**
   * Resolve a previously captured generated module without filesystem fallback.
   * @param from - Already captured importer.
   * @param specifier - Exact generated import spelling.
   * @param filename - Previously captured generated module identity.
   * @returns Captured source or structured refusal; conflicts invalidate snapshot export.
   */
  resolveGeneratedEntry(from: string, specifier: string, filename: string): NativeModuleResolution {
    return this.resolveEntry(from, specifier, filename, true);
  }

  /**
   * Fork pinned captures with actual generated bytes and exact new aliases.
   * @param sources - Additional actual generated module bytes.
   * @param generatedImports - Generated aliases to resolve in the fork.
   * @returns An independent resolver preserving policy and unaffected request decisions.
   * @throws Error if the parent is conflicted or a captured identity is changed.
   * @throws TypeError for a host-shaped alias or collision with an admitted external.
   */
  forkWithGeneratedSources(
    sources: ReadonlyMap<string, string>,
    generatedImports: ReadonlyMap<string, string>,
  ): NativeModuleResolver {
    this.assertConsistent();

    const paths = new Map(this.#paths);
    const additions = this.generatedImports(generatedImports, paths);
    const imports = new Map(this.#generatedImports);

    for (const [specifier, filename] of additions) {
      const previous = imports.get(specifier);

      if (previous !== undefined && pathKey(previous) !== pathKey(filename))
        throw new Error(`Generated import identity conflicts for ${specifier}.`);

      imports.set(specifier, filename);
    }

    const generated = this.sources(sources, paths);

    for (const captured of this.#resolver.capturedSources) {
      const source = generated.get(captured.filename);

      if (source !== undefined && source !== captured.source)
        throw new Error(`Generated module identity changed after capture: ${captured.filename}`);
    }

    const fork = new NativeModuleResolver(this.#root, new Map(), this.mode, this.#policy, imports);
    fork.#resolver = this.#resolver.forkWithGeneratedSources(generated, additions);

    for (const [key, filename] of paths) fork.#paths.set(key, filename);

    for (const source of fork.#resolver.capturedSources) fork.remember(source);

    for (const [key, request] of this.#requests) {
      const missingImporter = this.#missingImporterRequests.has(key);

      if (missingImporter
        ? fork.#importers.has(pathKey(request.observed.from))
        : additions.has(request.observed.specifier)) continue;

      fork.#requests.set(key, request);

      if (missingImporter) fork.#missingImporterRequests.add(key);

      const entry = this.#entryTargets.get(key);

      if (entry) fork.#entryTargets.set(key, entry);
    }

    return fork;
  }

  /**
   * Copy complete source-selection evidence without claiming build or renderer admission.
   * @returns Fresh deeply frozen plain data, retaining all unique requests and failures.
   * @throws Error after any conflicting request or changed generated-source capture.
   */
  snapshot(): NativeModuleResolutionSnapshot {
    this.assertConsistent();

    const snapshot: NativeModuleResolutionSnapshot = {
      version: 1,
      target: "server",
      mode: this.mode,
      policy: this.#policy,
      conditions: this.#policy.conditions,
      overrides: {},
      sources: this.#resolver.capturedSources,
      manifests: this.#resolver.capturedManifests,
      edges: [...this.#requests.values()],
    };

    return freezeCopy(snapshot);
  }

  private resolveEntry(from: string, specifier: string, filename: string, generated: boolean): NativeModuleResolution {
    const importer = this.canonicalPath(from);
    const canonical = this.canonicalPath(filename);
    const key = requestKey(importer, specifier);
    const previous = this.#requests.get(key);

    if (previous) {
      const entry = this.#entryTargets.get(key);

      if (entry && pathKey(entry.filename) === pathKey(canonical) && entry.generated === generated)
        return previous.result;

      if (previous.result.kind === "resolved" && pathKey(previous.result.filename) === pathKey(canonical))
        return previous.result;

      return this.conflict(importer, specifier, `Selected entry ${specifier} conflicts with its previously captured resolution.`);
    }

    this.#entryTargets.set(key, { filename: canonical, generated });

    if (!this.#importers.has(pathKey(importer))) {
      this.#missingImporterRequests.add(key);

      return this.retain(importer, specifier, missingImporter(importer, specifier));
    }

    const alias = this.#generatedImports.get(specifier);

    if (this.#externals.has(specifier) || (alias !== undefined && pathKey(alias) !== pathKey(canonical)))
      return this.conflict(importer, specifier, `Selected entry ${specifier} conflicts with the captured native policy or generated alias.`);

    if (isHostImport(specifier) || specifier === "hesperia/env")
      return this.retain(importer, specifier, this.#resolver.resolve(importer, specifier));

    const result = generated
      ? this.#resolver.resolveGeneratedEntry(importer, specifier, canonical)
      : this.#resolver.resolveCompilerEntry(importer, specifier, canonical);

    return this.retain(importer, specifier, result);
  }

  private retain(from: string, specifier: string, result: NativeModuleResolution): NativeModuleResolution {
    const key = requestKey(from, specifier);

    if (this.#requests.has(key))
      return this.conflict(from, specifier, `Request ${specifier} already has a captured resolution.`);

    if (result.kind === "resolved") this.remember(result);

    const observed: ModuleResolutionEdge | NativeExternalModuleEdge = result.kind === "external"
      ? { from, specifier, outcome: "external", policyDigest: result.policyDigest }
      : result.kind === "resolved"
        ? { from, specifier, outcome: "resolved", resolvedFilename: result.filename, conditionPath: result.provenance.conditionPath }
        : { from, specifier, outcome: "failed", failureCode: result.code };
    const request = freezeCopy({ observed, result });

    this.#requests.set(key, request);

    return request.result;
  }

  private conflict(from: string, specifier: string, message: string): ModuleResolutionFailure {
    this.#conflict ??= new Error(message);

    return Object.freeze({ kind: "failure", code: "MODULE_NOT_FOUND", from, specifier, message });
  }

  private assertConsistent(): void {
    if (this.#conflict)
      throw new Error("Native module resolution contains conflicting capture decisions", { cause: this.#conflict });
  }

  private remember(source: CapturedModuleSource): void {
    this.#importers.set(pathKey(source.filename), source.filename);
    this.#paths.set(pathKey(source.filename), source.filename);
  }

  private canonicalPath(filename: string, paths = this.#paths): string {
    const absolute = resolve(this.#root, filename);
    const key = pathKey(absolute);
    const previous = paths.get(key);

    if (previous !== undefined) return previous;

    let canonical = absolute;

    try {
      canonical = realpathSync(absolute);
    } catch {
      // Generated and unsaved sources retain their actual virtual identity.
    }

    paths.set(key, canonical);

    return canonical;
  }

  private sources(sources: ReadonlyMap<string, string>, paths = this.#paths): ReadonlyMap<string, string> {
    const captured = new Map<string, string>();
    const keys = new Map<string, string>();

    for (const [filename, source] of sources) {
      nonemptyString(filename, "Source filename");

      if (typeof source !== "string") throw new TypeError("Captured module source must be a string");

      const canonical = this.canonicalPath(filename, paths);
      const previous = keys.get(pathKey(canonical));

      if (previous !== undefined && captured.get(previous) !== source)
        throw new Error(`Module identity has conflicting source bytes: ${canonical}`);

      keys.set(pathKey(canonical), canonical);
      captured.set(canonical, source);
    }

    return captured;
  }

  private generatedImports(imports: ReadonlyMap<string, string>, paths = this.#paths): ReadonlyMap<string, string> {
    const captured = new Map<string, string>();

    for (const [specifier, filename] of imports) {
      nonemptyString(specifier, "Generated import specifier");
      nonemptyString(filename, "Generated import filename");

      if (this.#externals.has(specifier))
        throw new TypeError(`Generated import ${specifier} collides with a native external`);

      if (isHostImport(specifier) || specifier === "hesperia/env")
        throw new TypeError(`Generated import ${specifier} cannot replace a host capability`);

      const canonical = this.canonicalPath(filename, paths);
      const previous = captured.get(specifier);

      if (previous !== undefined && pathKey(previous) !== pathKey(canonical))
        throw new Error(`Generated import identity conflicts for ${specifier}.`);

      captured.set(specifier, canonical);
    }

    return captured;
  }
}

function requestKey(from: string, specifier: string): string {
  return JSON.stringify([pathKey(from), specifier]);
}

function missingImporter(from: string, specifier: string): ModuleResolutionFailure {
  return {
    kind: "failure",
    code: "MODULE_NOT_FOUND",
    from,
    specifier,
    message: `Native import ${specifier} has no captured importer: ${from}`,
  };
}

function snapshotPolicy(value: unknown): NativeResolutionPolicy {
  const fields = dataFields(value, ["version", "binding", "moduleABI", "runtimeVersion", "conditions", "externalModules", "provenance"], "Native resolution policy");
  const binding = dataFields(fields.get("binding"), ["version", "declaration", "descriptorIdentity", "descriptorRevision"], "Native target binding");
  const declaration = dataFields(binding.get("declaration"), ["version", "runtime", "profile"], "Native target declaration");

  if (fields.get("version") !== 1 || binding.get("version") !== 1 ||
      binding.get("descriptorRevision") !== 1 || declaration.get("version") !== 1)
    throw new TypeError("Unsupported native policy, binding, declaration or descriptor version");

  const runtime = declaration.get("runtime");
  const profile = declaration.get("profile");
  const identity = binding.get("descriptorIdentity");
  const abi = fields.get("moduleABI");
  const node = runtime === "node" && profile === "fetch" &&
    identity === "hesperia.target/node-fetch/1" && abi === "node-captured-esm-v1";
  const bun = runtime === "bun" && abi === "bun-captured-esm-v1" && (
    (profile === "elysia" && identity === "hesperia.target/bun-elysia/1") ||
    (profile === "hono" && identity === "hesperia.target/bun-hono/1")
  );

  if (!node && !bun) throw new TypeError("Native declaration, descriptor and module ABI do not match");

  return freezeCopy({
    version: 1,
    binding: { version: 1, declaration: { version: 1, runtime, profile }, descriptorIdentity: identity, descriptorRevision: 1 },
    moduleABI: abi,
    runtimeVersion: nonemptyString(fields.get("runtimeVersion"), "Native runtime version"),
    conditions: stringArray(fields.get("conditions"), "Native conditions", true),
    externalModules: stringArray(fields.get("externalModules"), "Native externals", false),
    provenance: nonemptyString(fields.get("provenance"), "Native policy provenance"),
  }) as NativeResolutionPolicy;
}

function dataFields(value: unknown, expected: readonly string[], label: string): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);

  const keys = Reflect.ownKeys(value);

  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key)))
    throw new TypeError(`${label} has unexpected or missing fields`);

  const fields = new Map<string, unknown>();

  for (const key of expected) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor))
      throw new TypeError(`${label}.${key} must be an own data property`);

    fields.set(key, descriptor.value);
  }

  return fields;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${label} must be a nonempty string`);

  return value;
}

function stringArray(value: unknown, label: string, required: boolean): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);

  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const length = descriptors.length?.value as unknown;

  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
      (required && length === 0) ||
      Reflect.ownKeys(descriptors).length !== length + 1)
    throw new TypeError(`${label} must be a dense array of unique strings`);

  const result: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];

    if (!descriptor || !("value" in descriptor))
      throw new TypeError(`${label} must contain only own data entries`);

    const entry = nonemptyString(descriptor.value, `${label}[${index}]`);

    if (seen.has(entry)) throw new TypeError(`${label} must contain unique strings`);

    seen.add(entry);
    result.push(entry);
  }

  return Object.freeze(result);
}

function freezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeCopy(entry))) as unknown as T;

  if (value !== null && typeof value === "object")
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, freezeCopy(entry)]),
    )) as unknown as T;

  return value;
}
