import { resolve as resolvePath, dirname, extname, join } from "node:path";
import { parseSync } from "oxc-parser";
import { transformSync } from "oxc-transform";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { canonicalize } from "./canonical.ts";
import { collectFiniteImportConstants, enumerateFiniteImportSpecifiers } from "./finite-imports.ts";
import { canonicalDebugSidecar, isCanonicalChild, type CanonicalDebugSidecar } from "./ir.ts";
import type { ModuleResolutionFailure, ModuleResolver } from "./module-resolution.ts";
import type {
  CanonicalArgument,
  CanonicalChild,
  CanonicalExpression,
  CanonicalImportSpecifier,
  CanonicalModule,
  CanonicalPattern,
  CanonicalStatement,
  CanonicalStatementBlock,
  CompilerDiagnostic,
  SourceSpan,
} from "./ir.ts";

/** One immutable authored source available to route dependency analysis. */
export interface RouteSourceModule {
  /** Stable project-relative or absolute source identity used for import resolution and diagnostics. */
  readonly filename: string;
  /** Authored text from the immutable build snapshot. It is parsed but never evaluated. */
  readonly source: string;
}

/** Inputs for route guard extraction. The module set is the build's immutable source snapshot. */
export interface RouteAnalysisOptions {
  /** Route file identity; defaults to `+route.ts` for isolated analysis. */
  readonly filename?: string;
  /** Complete source snapshot used to resolve relative imports. Unlisted modules fail closed. */
  readonly modules?: readonly RouteSourceModule[];
  /** Optional immutable package resolver used by tooling when loading guard modules. */
  readonly resolution?: ModuleResolver;
}

/** A selected canonical module with request-time route declarations removed. */
export interface RouteGuardModule {
  /** Source identity retained for generated module paths and per-file diagnostics. */
  readonly filename: string;
  /** Canonical declarations selected by the guard's transitive binding closure. */
  readonly module: CanonicalModule;
  /** Authored source spans for canonical nodes; spans are debug metadata, not semantic identity. */
  readonly debug: CanonicalDebugSidecar;
  /** Normalized emission source and map consumed by generateModule; these are not canonical meaning. */
  readonly source: string;
  readonly map: unknown;
}

/** The browser artifact's entry binding and its transitive canonical declaration closure. */
export interface RouteGuardArtifact {
  /** The route module and resolved guard binding used as the generated artifact entry. */
  readonly entry: { readonly filename: string; readonly bindingId: string; readonly name: string };
  /** Generator-ready closure modules; route-time loaders, headers, and unrelated statements are absent. */
  readonly modules: readonly RouteGuardModule[];
}

/** Route analysis result shared by manifest/build integration and diagnostics consumers. */
export interface RouteAnalysisResult {
  /** Route source identity used for the result and the scanner's route node. */
  readonly filename: string;
  /** Resolved canonical route module, including source-only declarations omitted from the artifact. */
  readonly ir: CanonicalModule;
  /** Authored debug spans for the complete route module. */
  readonly debug: CanonicalDebugSidecar;
  /** Build errors and refusal diagnostics. A route without a guard has no artifact and no error. */
  readonly diagnostics: readonly RouteDiagnostic[];
  /** Present only when route shape and the complete guard closure pass fail-closed analysis. */
  readonly artifact?: RouteGuardArtifact;
}

/** A route diagnostic retains the authored module that owns the reported span. */
export interface RouteDiagnostic extends CompilerDiagnostic {
  /** Authored module owning the diagnostic span, including transitive helper modules. */
  readonly filename: string;
}

interface ModuleSnapshot {
  readonly filename: string;
  readonly source: string;
  readonly module: CanonicalModule;
  readonly debug: CanonicalDebugSidecar;
  readonly mapOffset: (offset: number) => number;
  readonly normalizedSource: string;
  readonly normalizedMap: unknown;
}

interface BindingEntry {
  readonly module: ModuleSnapshot;
  readonly statement: CanonicalStatement;
  readonly specifier?: CanonicalImportSpecifier;
  readonly declaration?: {
    readonly pattern: CanonicalPattern;
    readonly initializer: CanonicalExpression | CanonicalChild | null;
    readonly span: SourceSpan;
  };
}

interface ModuleInfo extends ModuleSnapshot {
  readonly bindings: ReadonlyMap<string, BindingEntry>;
  readonly imports: ReadonlyMap<string, CanonicalImportSpecifier>;
  readonly exports: ReadonlyMap<string, string>;
  readonly constants: ReadonlyMap<string, CanonicalExpression>;
}

interface Reference {
  readonly id?: string;
  readonly name: string;
  readonly span: SourceSpan;
  readonly importSource?: CanonicalExpression;
}

interface PendingBinding {
  readonly filename: string;
  readonly bindingId: string;
}

const SAFE_ROUTING_IMPORTS = new Set(["redirect"]);
const SERVER_BUILTINS = new Set([
  "assert",
  "child_process",
  "crypto",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "stream",
  "url",
  "util",
  "worker_threads",
]);

/**
 * Inspect a +route.ts source without evaluating it. Only the referenced guard binding and the
 * declarations it reaches are returned; the route object, loaders, headers, and unrelated module
 * side effects never enter the artifact. A route declaration without `guard` is valid and returns no
 * artifact; an unproven or forbidden guard dependency returns an error diagnostic instead. Route
 * shape diagnostics use the authored Oxc AST directly, while canonical dependency diagnostics use
 * the normalized-source map. The selected module body is executable closure data; its retained
 * source/map sidecar is kept separately for later generated-module map composition.
 */
export function analyzeRouteModule(
  source: string,
  options: RouteAnalysisOptions = {},
): RouteAnalysisResult {
  const filename = options.filename ?? "+route.ts";
  const sources = new SourceTable(source, filename, options.modules, options.resolution);
  const root = sources.load(filename);
  if (!root)
    return failedRouteResult(filename, [
      {
        code: "HES-ROUTE-SOURCE",
        severity: "error",
        message: "Route source is not present in the immutable module snapshot.",
        span: { start: 0, end: source.length },
        filename,
      },
    ]);

  const diagnostics: RouteDiagnostic[] =
    root.module.body.length === 0
      ? root.module.diagnostics.map((item) =>
          toRouteDiagnostic(root.filename, mapDiagnostic(item, root.mapOffset)),
        )
      : [];
  const routeImportIds = new Set<string>();
  for (const statement of root.module.body) {
    if (statement.kind !== "import" || statement.source !== "hesperia/routing") continue;
    for (const specifier of statement.specifiers)
      if (specifier.kind === "named" && specifier.imported === "route" && specifier.bindingId)
        routeImportIds.add(specifier.bindingId);
  }

  const routeExpression = defaultExpression(root.module);
  const routeCall = routeExpression && isCall(routeExpression) ? routeExpression : null;
  if (!routeCall || !isIdentifier(routeCall.callee) || !routeCall.callee.referenceId) {
    diagnostics.push(
      routeDiagnostic(
        "HES-ROUTE-SHAPE",
        "A route file must default-export route(...).",
        authoredRouteSpan(root, "route") ??
          authoredSpan(root, routeExpression?.span ?? moduleSpan(root.module)),
        root.filename,
      ),
    );
    return resultWithDiagnostics(root, diagnostics);
  }
  if (!routeImportIds.has(routeCall.callee.referenceId)) {
    diagnostics.push(
      routeDiagnostic(
        "HES-ROUTE-FACTORY",
        "The default route declaration must call the route factory imported from hesperia/routing.",
        authoredRouteSpan(root, "callee") ?? authoredSpan(root, routeCall.callee.span),
        root.filename,
      ),
    );
    return resultWithDiagnostics(root, diagnostics);
  }
  const configuration = routeCall.arguments[0];
  if (
    !configuration ||
    configuration.kind === "spread" ||
    configuration.kind !== "object" ||
    routeCall.arguments.length !== 1
  ) {
    diagnostics.push(
      routeDiagnostic(
        "HES-ROUTE-SHAPE",
        "route(...) requires one object configuration argument.",
        authoredRouteSpan(root, "route") ?? authoredSpan(root, routeCall.span),
        root.filename,
      ),
    );
    return resultWithDiagnostics(root, diagnostics);
  }
  if (
    configuration.properties.some((property) => property.kind === "spread" || property.computed)
  ) {
    diagnostics.push(
      routeDiagnostic(
        "HES-ROUTE-SHAPE",
        "The route configuration must use statically inspectable literal property names; spreads and computed properties are not allowed.",
        authoredRouteSpan(root, "config") ?? authoredSpan(root, configuration.span),
        root.filename,
      ),
    );
    return resultWithDiagnostics(root, diagnostics);
  }
  const guardProperty = configuration.properties.find(
    (property) => property.kind === "property" && !property.computed && property.key === "guard",
  );
  if (!guardProperty || guardProperty.kind !== "property")
    return resultWithDiagnostics(root, diagnostics);
  if (!isIdentifier(guardProperty.value)) {
    diagnostics.push(
      routeDiagnostic(
        "HES-ROUTE-GUARD",
        "The route guard must be a binding referenced by identifier; inline functions are not allowed.",
        authoredRouteSpan(root, "guard") ?? authoredSpan(root, guardProperty.value.span),
        root.filename,
      ),
    );
    return resultWithDiagnostics(root, diagnostics);
  }
  const guardId = guardProperty.value.referenceId;
  if (!guardId) {
    diagnostics.push(
      routeDiagnostic(
        "HES-ROUTE-GUARD",
        "The route guard reference could not be resolved.",
        authoredRouteSpan(root, "guard") ?? authoredSpan(root, guardProperty.value.span),
        root.filename,
      ),
    );
    return resultWithDiagnostics(root, diagnostics);
  }

  const analysis = new ClosureAnalysis(sources, diagnostics);
  const entry = analysis.add(root, guardId, guardProperty.value.name);
  diagnostics.push(...analysis.relevantDiagnostics());
  if (!entry || diagnostics.some((item) => item.severity === "error"))
    return resultWithDiagnostics(root, diagnostics);
  const artifact = analysis.artifact(entry);
  return {
    ...resultWithDiagnostics(root, diagnostics),
    artifact,
  };
}

class SourceTable {
  readonly #sources = new Map<string, RouteSourceModule>();
  readonly #snapshots = new Map<string, ModuleInfo>();
  readonly #resolution?: ModuleResolver;

  constructor(
    source: string,
    filename: string,
    modules: readonly RouteSourceModule[] | undefined,
    resolution: ModuleResolver | undefined,
  ) {
    this.#resolution = resolution;
    this.add({ filename, source });
    for (const item of modules ?? []) this.add(item);
  }

  add(item: RouteSourceModule): void {
    this.#sources.set(key(item.filename), item);
    this.#sources.set(key(resolvePath(item.filename)), item);
  }

  load(filename: string): ModuleInfo | undefined {
    const source = this.#sources.get(key(filename));
    if (!source) return undefined;
    const sourceKey = key(source.filename);
    const existing = this.#snapshots.get(sourceKey);
    if (existing) return existing;
    const parsed = parseModule(source.source, source.filename);
    const snapshot: ModuleSnapshot = {
      filename: source.filename,
      source: source.source,
      module: parsed.module,
      debug: parsed.debug,
      mapOffset: parsed.mapOffset,
      normalizedSource: parsed.normalizedSource,
      normalizedMap: parsed.normalizedMap,
    };
    const bindings = new Map<string, BindingEntry>();
    const imports = new Map<string, CanonicalImportSpecifier>();
    const exports = new Map<string, string>();
    for (const statement of parsed.module.body)
      indexStatement(statement, snapshot, bindings, imports, exports);
    const info: ModuleInfo = {
      ...snapshot,
      bindings,
      imports,
      exports,
      constants: collectFiniteImportConstants(parsed.module),
    };
    this.#snapshots.set(sourceKey, info);
    return info;
  }

  get usesResolution(): boolean {
    return this.#resolution !== undefined;
  }

  resolveImport(
    from: string,
    specifier: string,
  ): { readonly module?: ModuleInfo; readonly failure?: ModuleResolutionFailure } {
    if (this.#resolution) {
      const result = this.#resolution.resolve(from, specifier);
      if (result.kind === "failure") return { failure: result };
      const existing = this.#sources.get(key(result.filename));
      if (existing) return { module: this.load(existing.filename) };
      this.add({ filename: result.filename, source: result.source });
      return { module: this.load(result.filename) };
    }
    if (!specifier.startsWith(".")) return {};
    const base = resolvePath(dirname(from), specifier);
    const candidates = [base, ...extensions(base), ...extensions(join(base, "index"))];
    for (const candidate of candidates) {
      const loaded = this.load(candidate);
      if (loaded) return { module: loaded };
    }
    return {};
  }
}

class ClosureAnalysis {
  readonly #sources: SourceTable;
  readonly #diagnostics: RouteDiagnostic[];
  readonly #selected = new Map<string, Set<string>>();
  readonly #entries = new Map<string, BindingEntry>();
  readonly #queued = new Set<string>();
  readonly #queue: PendingBinding[] = [];
  readonly #reported = new Set<string>();
  readonly #completeModules = new Map<string, ModuleInfo>();

  constructor(sources: SourceTable, diagnostics: RouteDiagnostic[]) {
    this.#sources = sources;
    this.#diagnostics = diagnostics;
  }

  add(
    module: ModuleInfo,
    bindingId: string,
    name: string,
  ): { module: ModuleInfo; bindingId: string; name: string } | undefined {
    this.enqueue(module, bindingId);
    while (this.#queue.length) {
      const pending = this.#queue.shift()!;
      const current = this.#sources.load(pending.filename);
      if (!current) {
        this.error(
          module,
          "HES-ROUTE-RESOLVE",
          "A route guard dependency is not present in the immutable module snapshot.",
          { start: 0, end: 0 },
        );
        continue;
      }
      const entry = current.bindings.get(pending.bindingId);
      if (!entry) {
        this.error(
          current,
          "HES-ROUTE-RESOLVE",
          `Could not resolve guard binding ${pending.bindingId}.`,
          { start: 0, end: 0 },
        );
        continue;
      }
      this.#entries.set(bindingKey(current, pending.bindingId), entry);
      if (entry.specifier) {
        this.resolveImport(current, entry.specifier);
        continue;
      }
      const references: Reference[] = [];
      if (entry.declaration) {
        collectPatternReferences(entry.declaration.pattern, references);
        if (entry.declaration.initializer) collectValue(entry.declaration.initializer, references);
      } else collectStatementReferences(entry.statement, references);
      for (const reference of references) this.resolveReference(current, reference);
    }
    if (this.#diagnostics.some((item) => item.severity === "error")) return undefined;
    return { module, bindingId, name };
  }

  relevantDiagnostics(): readonly RouteDiagnostic[] {
    const diagnostics: RouteDiagnostic[] = [];
    for (const module of this.#completeModules.values())
      for (const diagnostic of module.module.diagnostics)
        diagnostics.push(
          toRouteDiagnostic(module.filename, mapDiagnostic(diagnostic, module.mapOffset)),
        );
    for (const entry of this.#entries.values()) {
      const selectedSpan = entry.declaration?.span ?? entry.statement.span;
      for (const item of entry.module.module.diagnostics) {
        if (!item.span || overlaps(item.span, selectedSpan))
          diagnostics.push(
            toRouteDiagnostic(
              entry.module.filename,
              item.span ? { ...item, span: authoredSpan(entry.module, item.span) } : item,
            ),
          );
      }
    }
    return diagnostics;
  }

  artifact(entry: { module: ModuleInfo; bindingId: string; name: string }): RouteGuardArtifact {
    const modules: RouteGuardModule[] = [];
    const infos = new Map<string, ModuleInfo>(this.#completeModules);
    for (const pending of this.#entries.keys()) {
      const filename = pending.slice(0, pending.lastIndexOf("#"));
      const info = this.#sources.load(filename);
      if (info) infos.set(key(info.filename), info);
    }
    for (const info of infos.values()) {
      const selected = this.#selected.get(key(info.filename)) ?? new Set<string>();
      const body = this.#completeModules.has(key(info.filename))
        ? [...info.module.body]
        : info.module.body.flatMap((statement) => projectStatement(statement, selected));
      if (key(info.filename) === key(entry.module.filename))
        body.push({
          kind: "export",
          exportKind: "default",
          declaration: {
            kind: "expression",
            expression: {
              kind: "identifier",
              name: entry.name,
              referenceId: entry.bindingId,
              span: moduleSpan(info.module),
            },
            span: moduleSpan(info.module),
          },
          span: moduleSpan(info.module),
        });
      modules.push({
        filename: info.filename,
        module: { ...info.module, body, diagnostics: [] },
        debug: info.debug,
        source: info.normalizedSource,
        map: info.normalizedMap,
      });
    }
    modules.sort((a, b) => a.filename.localeCompare(b.filename));
    return {
      entry: { filename: entry.module.filename, bindingId: entry.bindingId, name: entry.name },
      modules,
    };
  }

  private enqueue(module: ModuleInfo, bindingId: string): void {
    const item = `${key(module.filename)}#${bindingId}`;
    if (this.#queued.has(item)) return;
    this.#queued.add(item);
    this.#selected.set(
      key(module.filename),
      new Set(this.#selected.get(key(module.filename)) ?? []).add(bindingId),
    );
    this.#queue.push({ filename: module.filename, bindingId });
  }

  private resolveReference(module: ModuleInfo, reference: Reference): void {
    if (reference.importSource) {
      const targets = enumerateFiniteImportSpecifiers(reference.importSource, module.constants);
      if (!targets) {
        this.error(
          module,
          "HES-CAPABILITY-DYNAMIC",
          "A route guard dynamic import must have a complete, statically enumerable target set.",
          reference.span,
        );
        return;
      }
      for (const target of targets) this.includeCompleteDependency(module, target, reference.span);
      return;
    }
    if (!reference.id || reference.id.startsWith("unresolved/")) {
      if (reference.name === "process" || reference.name === "Bun" || reference.name === "Deno")
        this.error(
          module,
          "HES-ROUTE-CAPABILITY",
          `Route guard references server capability ${reference.name}.`,
          reference.span,
        );
      else
        this.error(
          module,
          "HES-ROUTE-UNRESOLVED",
          `Route guard reference ${reference.name} cannot be proven client-eligible.`,
          reference.span,
        );
      return;
    }
    if (!isModuleBinding(reference.id)) return;
    this.enqueue(module, reference.id);
  }

  private includeCompleteDependency(module: ModuleInfo, source: string, span: SourceSpan): void {
    const resolved = this.#sources.resolveImport(module.filename, source);
    if (resolved.failure || !resolved.module) {
      this.error(
        module,
        resolved.failure?.code === "HOST_IMPORT" ? "HES-ROUTE-CAPABILITY" : "HES-ROUTE-RESOLVE",
        resolved.failure?.message ??
          `Route guard dependency ${source} is missing from the immutable module snapshot.`,
        span,
      );
      return;
    }
    const dependency = resolved.module;
    if (/(?:^|[\\/])\+route\.ts$/u.test(dependency.filename)) {
      this.error(
        module,
        "HES-ROUTE-SERVER",
        "Route declarations cannot be imported into a browser guard; only the extracted guard is browser code.",
        span,
      );
      return;
    }
    if (this.#completeModules.has(key(dependency.filename))) return;
    this.#completeModules.set(key(dependency.filename), dependency);
    for (const statement of dependency.module.body) {
      if (
        statement.kind === "import" ||
        statement.kind === "export-all" ||
        (statement.kind === "export-list" && statement.source !== null)
      )
        this.includeCompleteDependency(dependency, statement.source!, statement.span);
      const references: Reference[] = [];
      collectStatementReferences(statement, references);
      for (const reference of references) {
        if (!reference.importSource) continue;
        const targets = enumerateFiniteImportSpecifiers(
          reference.importSource,
          dependency.constants,
        );
        // Reachable unknown targets are rejected by capability checking of the emitted closure.
        for (const target of targets ?? [])
          this.includeCompleteDependency(dependency, target, reference.span);
      }
    }
  }

  private resolveImport(module: ModuleInfo, specifier: CanonicalImportSpecifier): void {
    const importStatement = module.bindings.get(specifier.bindingId ?? "")?.statement;
    if (!importStatement || importStatement.kind !== "import") return;
    const source = importStatement.source;
    if (
      source === "hesperia/routing" &&
      specifier.kind === "named" &&
      SAFE_ROUTING_IMPORTS.has(specifier.imported)
    )
      return;
    if (isServerImport(source)) {
      this.error(
        module,
        "HES-ROUTE-CAPABILITY",
        `Route guard imports server capability ${source}.`,
        importStatement.span,
      );
      return;
    }
    if (!source.startsWith(".") && !this.#sources.usesResolution) {
      this.error(
        module,
        "HES-ROUTE-UNRESOLVED",
        `Route guard dependency ${source} is not a proven client module.`,
        importStatement.span,
      );
      return;
    }
    if (specifier.kind === "namespace") {
      this.error(
        module,
        "HES-ROUTE-UNRESOLVED",
        "Namespace imports in route guards cannot be resolved at binding granularity.",
        importStatement.span,
      );
      return;
    }
    const resolved = this.#sources.resolveImport(module.filename, source);
    if (resolved.failure) {
      this.error(
        module,
        resolved.failure.code === "HOST_IMPORT" ? "HES-ROUTE-CAPABILITY" : "HES-ROUTE-RESOLVE",
        resolved.failure.message,
        importStatement.span,
      );
      return;
    }
    const dependency = resolved.module;
    if (!dependency) {
      this.error(
        module,
        "HES-ROUTE-RESOLVE",
        `Route guard dependency ${source} is missing from the immutable module snapshot.`,
        importStatement.span,
      );
      return;
    }
    const exported = dependency.exports.get(
      specifier.kind === "default" ? "default" : specifier.imported,
    );
    if (!exported) {
      this.error(
        module,
        "HES-ROUTE-RESOLVE",
        `Module ${source} does not export ${specifier.kind === "default" ? "default" : specifier.imported}.`,
        importStatement.span,
      );
      return;
    }
    this.enqueue(dependency, exported);
  }

  private error(module: ModuleInfo, code: string, message: string, span: SourceSpan): void {
    const mapped = authoredSpan(module, span);
    const key = `${code}:${module.filename}:${mapped.start}:${mapped.end}:${message}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#diagnostics.push({
      code,
      severity: "error",
      message,
      span: mapped,
      filename: module.filename,
    });
  }
}

function parseModule(
  source: string,
  filename: string,
): {
  module: CanonicalModule;
  debug: CanonicalDebugSidecar;
  mapOffset: (offset: number) => number;
  normalizedSource: string;
  normalizedMap: unknown;
} {
  const normalized = transformSync(filename, source, {
    lang: filename.endsWith(".tsx") ? "tsx" : "ts",
    jsx: "preserve",
    target: "esnext",
    sourcemap: true,
  });
  const mapper = authoredOffset(normalized.code, source, normalized.map);
  const diagnostics = oxcDiagnostics(normalized.errors);
  if (diagnostics.some((item) => item.severity === "error"))
    return emptyModule(filename, diagnostics, mapper, normalized.code, normalized.map);
  const parsed = parseSync(filename, normalized.code, {
    lang: "jsx",
    astType: "js",
    range: true,
    sourceType: "module",
  });
  diagnostics.push(...oxcDiagnostics(parsed.errors));
  if (diagnostics.some((item) => item.severity === "error"))
    return emptyModule(filename, diagnostics, mapper, normalized.code, normalized.map);
  const normalizedModule = canonicalize(parsed.program, filename);
  return {
    module: { ...normalizedModule, diagnostics: [...diagnostics, ...normalizedModule.diagnostics] },
    debug: mapDebug(canonicalDebugSidecar(normalizedModule), mapper),
    mapOffset: mapper,
    normalizedSource: normalized.code,
    normalizedMap: normalized.map,
  };
}

function emptyModule(
  filename: string,
  diagnostics: readonly CompilerDiagnostic[],
  mapOffset: (offset: number) => number,
  normalizedSource: string,
  normalizedMap: unknown,
): {
  module: CanonicalModule;
  debug: CanonicalDebugSidecar;
  mapOffset: (offset: number) => number;
  normalizedSource: string;
  normalizedMap: unknown;
} {
  const module: CanonicalModule = { version: 1, filename, body: [], diagnostics };
  return {
    module,
    debug: canonicalDebugSidecar(module),
    mapOffset,
    normalizedSource,
    normalizedMap,
  };
}

function defaultExpression(module: CanonicalModule): CanonicalExpression | null {
  for (const statement of module.body)
    if (
      statement.kind === "export" &&
      statement.exportKind === "default" &&
      statement.declaration.kind === "expression"
    )
      return statement.declaration.expression;
  return null;
}

function indexStatement(
  statement: CanonicalStatement,
  module: ModuleSnapshot,
  bindings: Map<string, BindingEntry>,
  imports: Map<string, CanonicalImportSpecifier>,
  exports: Map<string, string>,
): void {
  if (statement.kind === "import") {
    for (const specifier of statement.specifiers)
      if (specifier.bindingId) {
        bindings.set(specifier.bindingId, { module, statement, specifier });
        imports.set(specifier.bindingId, specifier);
      }
    return;
  }
  if (statement.kind === "export") {
    indexStatement(statement.declaration, module, bindings, imports, exports);
    if (
      statement.exportKind === "default" &&
      statement.declaration.kind === "expression" &&
      statement.declaration.expression.kind === "identifier" &&
      statement.declaration.expression.referenceId
    )
      exports.set("default", statement.declaration.expression.referenceId);
    for (const item of statement.exportedBindings ?? [])
      exports.set(item.exported, item.referenceId);
    return;
  }
  if (statement.kind === "function") {
    if (statement.bindingId) bindings.set(statement.bindingId, { module, statement });
    return;
  }
  if (statement.kind === "class") {
    if (statement.bindingId) bindings.set(statement.bindingId, { module, statement });
    return;
  }
  if (statement.kind === "variable") {
    for (const declaration of statement.declarations)
      for (const bindingId of patternBindingIds(declaration.pattern))
        bindings.set(bindingId, {
          module,
          statement,
          declaration: {
            pattern: declaration.pattern,
            initializer: declaration.initializer,
            span: declaration.span,
          },
        });
  }
}

function projectStatement(
  statement: CanonicalStatement,
  selected: ReadonlySet<string>,
): CanonicalStatement[] {
  if (statement.kind === "import") {
    const specifiers = statement.specifiers.filter(
      (item) => item.bindingId && selected.has(item.bindingId),
    );
    return specifiers.length ? [{ ...statement, specifiers }] : [];
  }
  if (statement.kind === "export") {
    if (
      statement.exportKind === "default" &&
      statement.declaration.kind === "expression" &&
      statement.declaration.expression.kind === "identifier" &&
      statement.declaration.expression.referenceId &&
      selected.has(statement.declaration.expression.referenceId)
    )
      return [statement];
    const projected = projectStatement(statement.declaration, selected);
    return projected.map((declaration) => ({
      kind: "export",
      exportKind: statement.exportKind,
      declaration,
      exportedBindings: statement.exportedBindings,
      span: statement.span,
    }));
  }
  if (statement.kind === "function")
    return statement.bindingId && selected.has(statement.bindingId) ? [statement] : [];
  if (statement.kind === "class")
    return statement.bindingId && selected.has(statement.bindingId) ? [statement] : [];
  if (statement.kind === "variable") {
    const declarations = statement.declarations.filter((item) =>
      patternBindingIds(item.pattern).some((id) => selected.has(id)),
    );
    return declarations.length ? [{ ...statement, declarations }] : [];
  }
  return [];
}

function collectStatementReferences(statement: CanonicalStatement, references: Reference[]): void {
  switch (statement.kind) {
    case "variable":
      for (const declaration of statement.declarations) {
        collectPatternReferences(declaration.pattern, references);
        if (declaration.initializer) collectValue(declaration.initializer, references);
      }
      return;
    case "function":
      for (const parameter of statement.parameters) collectPatternReferences(parameter, references);
      collectBlock(statement.body, references);
      return;
    case "class":
      collectClassReferences(statement.superClass, statement.elements, references);
      return;
    case "return":
      if (statement.argument) collectValue(statement.argument, references);
      return;
    case "expression":
      collectExpression(statement.expression, references);
      return;
    case "if":
      collectExpression(statement.test, references);
      collectStatementReferences(statement.consequent, references);
      if (statement.alternate) collectStatementReferences(statement.alternate, references);
      return;
    case "switch":
      collectExpression(statement.discriminant, references);
      for (const item of statement.cases) {
        if (item.test) collectExpression(item.test, references);
        for (const entry of item.consequent) collectStatementReferences(entry, references);
      }
      return;
    case "for":
      if (statement.init) {
        if (statement.init.kind === "variable") {
          for (const declaration of statement.init.declarations) {
            collectPatternReferences(declaration.pattern, references);
            if (declaration.initializer) collectValue(declaration.initializer, references);
          }
        } else collectExpression(statement.init, references);
      }
      if (statement.test) collectExpression(statement.test, references);
      if (statement.update) collectExpression(statement.update, references);
      collectStatementReferences(statement.body, references);
      return;
    case "for-of":
    case "for-in":
      if (statement.left.kind === "declaration")
        collectPatternReferences(statement.left.pattern, references);
      else collectExpression(statement.left.target, references);
      collectExpression(statement.right, references);
      collectStatementReferences(statement.body, references);
      return;
    case "while":
      collectExpression(statement.test, references);
      collectStatementReferences(statement.body, references);
      return;
    case "do-while":
      collectStatementReferences(statement.body, references);
      collectExpression(statement.test, references);
      return;
    case "try":
      collectBlock(statement.body, references);
      if (statement.handler) {
        if (statement.handler.param) collectPatternReferences(statement.handler.param, references);
        collectBlock(statement.handler.body, references);
      }
      if (statement.finalizer) collectBlock(statement.finalizer, references);
      return;
    case "labeled":
      collectStatementReferences(statement.body, references);
      return;
    case "break":
    case "continue":
      return;
    case "throw":
      collectExpression(statement.argument, references);
      return;
    case "block":
      collectBlock(statement, references);
      return;
    case "export":
      collectStatementReferences(statement.declaration, references);
      return;
    case "import":
      return;
  }
}

function collectValue(value: CanonicalExpression | CanonicalChild, references: Reference[]): void {
  if (isCanonicalChild(value)) {
    collectChild(value, references);
    return;
  }
  collectExpression(value, references);
}

function collectExpression(expression: CanonicalExpression, references: Reference[]): void {
  switch (expression.kind) {
    case "identifier":
      references.push({ id: expression.referenceId, name: expression.name, span: expression.span });
      return;
    case "literal":
    case "regexp":
    case "bigint":
    case "undefined":
    case "this":
    case "super":
    case "new-target":
    case "private":
      return;
    case "template":
      for (const item of expression.expressions) collectExpression(item, references);
      return;
    case "await":
      collectExpression(expression.expression, references);
      return;
    case "yield":
      if (expression.expression) collectExpression(expression.expression, references);
      return;
    case "import-expression":
      references.push({ name: "import", span: expression.span, importSource: expression.source });
      collectExpression(expression.source, references);
      if (expression.options) collectExpression(expression.options, references);
      return;
    case "member":
      collectExpression(expression.object, references);
      if (expression.computed) collectExpression(expression.property, references);
      return;
    case "call":
      collectExpression(expression.callee, references);
      for (const item of expression.arguments) collectArgument(item, references);
      return;
    case "new":
      collectExpression(expression.callee, references);
      for (const item of expression.arguments) collectArgument(item, references);
      return;
    case "assignment":
      collectExpression(expression.left, references);
      collectExpression(expression.right, references);
      return;
    case "binary":
      collectExpression(expression.left, references);
      collectExpression(expression.right, references);
      return;
    case "unary":
      collectExpression(expression.argument, references);
      return;
    case "conditional":
      collectExpression(expression.test, references);
      collectExpression(expression.consequent, references);
      collectExpression(expression.alternate, references);
      return;
    case "arrow":
      for (const parameter of expression.parameters)
        collectPatternReferences(parameter, references);
      if (isChildLike(expression.body)) collectChild(expression.body, references);
      else if (expression.body.kind === "block") collectBlock(expression.body, references);
      else collectExpression(expression.body, references);
      return;
    case "function-expression":
      for (const parameter of expression.parameters)
        collectPatternReferences(parameter, references);
      collectBlock(expression.body, references);
      return;
    case "class":
      collectClassReferences(expression.superClass, expression.elements, references);
      return;
    case "object":
      for (const property of expression.properties) {
        if (property.kind === "spread") collectExpression(property.argument, references);
        else {
          if (property.computed && typeof property.key !== "string")
            collectExpression(property.key, references);
          collectExpression(property.value, references);
        }
      }
      return;
    case "array":
      for (const item of expression.elements)
        if (item) collectExpression(item.kind === "spread" ? item.argument : item, references);
      return;
  }
}

function collectClassReferences(
  superClass: CanonicalExpression | null,
  elements: readonly import("./ir.ts").CanonicalClassElement[],
  references: Reference[],
): void {
  if (superClass) collectExpression(superClass, references);
  for (const element of elements) {
    if (element.kind === "static-block") collectBlock(element.body, references);
    else {
      if (typeof element.key === "object") collectExpression(element.key, references);
      if (element.kind === "field") {
        if (element.initializer) collectExpression(element.initializer, references);
      } else {
        for (const parameter of element.parameters) collectPatternReferences(parameter, references);
        collectBlock(element.body, references);
      }
    }
  }
}

function collectArgument(argument: CanonicalArgument, references: Reference[]): void {
  collectExpression(argument.kind === "spread" ? argument.argument : argument, references);
}

function collectBlock(block: CanonicalStatementBlock, references: Reference[]): void {
  for (const statement of block.body) collectStatementReferences(statement, references);
}

function collectPatternReferences(pattern: CanonicalPattern, references: Reference[]): void {
  if (pattern.kind === "rest") {
    collectPatternReferences(pattern.argument, references);
    return;
  }
  if (pattern.kind === "default") {
    collectPatternReferences(pattern.left, references);
    collectExpression(pattern.right, references);
    return;
  }
  if (pattern.kind === "array") {
    for (const item of pattern.elements) if (item) collectPatternReferences(item, references);
    return;
  }
  if (pattern.kind === "object")
    for (const item of pattern.properties) collectPatternReferences(item.value, references);
  if (pattern.kind === "object" && pattern.rest) collectPatternReferences(pattern.rest, references);
}

function collectChild(child: CanonicalChild, references: Reference[]): void {
  switch (child.kind) {
    case "element":
      for (const attribute of child.attributes)
        if (attribute.kind !== "static") collectExpression(attribute.expression, references);
      for (const item of child.children) collectChild(item, references);
      return;
    case "fragment":
      for (const item of child.children) collectChild(item, references);
      return;
    case "text":
      return;
    case "dynamic-child":
      collectExpression(child.expression, references);
      return;
    case "component":
    case "await-child":
      collectExpression(child.reference, references);
      for (const prop of child.props) {
        if (prop.kind === "value") collectExpression(prop.expression, references);
        else if (prop.kind === "children")
          for (const item of prop.children) collectChild(item, references);
        else collectChild(prop.child, references);
      }
      return;
    case "raw-html":
      if (child.host) collectChild(child.host, references);
      collectExpression(child.html, references);
      return;
    case "conditional":
      collectExpression(child.test, references);
      if (child.consequent) collectChild(child.consequent, references);
      if (child.alternate) collectChild(child.alternate, references);
      return;
    case "list":
      collectExpression(child.collection, references);
      collectExpression(child.key, references);
      collectPatternReferences(child.parameter, references);
      collectChild(child.body, references);
      return;
  }
}

function patternBindingIds(pattern: CanonicalPattern): string[] {
  if (pattern.kind === "identifier") return pattern.bindingId ? [pattern.bindingId] : [];
  if (pattern.kind === "rest") return patternBindingIds(pattern.argument);
  if (pattern.kind === "default") return patternBindingIds(pattern.left);
  if (pattern.kind === "array")
    return pattern.elements.flatMap((item) => (item ? patternBindingIds(item) : []));
  return pattern.properties
    .flatMap((item) => patternBindingIds(item.value))
    .concat(pattern.rest ? patternBindingIds(pattern.rest) : []);
}

function isCall(
  expression: CanonicalExpression,
): expression is Extract<CanonicalExpression, { kind: "call" }> {
  return expression.kind === "call";
}

function isIdentifier(
  expression: CanonicalExpression,
): expression is Extract<CanonicalExpression, { kind: "identifier" }> {
  return expression.kind === "identifier";
}

function isChildLike(
  value: CanonicalExpression | CanonicalChild | CanonicalStatementBlock,
): value is CanonicalChild {
  return isCanonicalChild(value);
}

function isModuleBinding(bindingId: string): boolean {
  return /^m\/b\d+$/u.test(bindingId);
}

function bindingKey(module: ModuleInfo, bindingId: string): string {
  return `${module.filename}#${bindingId}`;
}

function isServerImport(source: string): boolean {
  return source.startsWith("node:") || source.startsWith("bun:") || SERVER_BUILTINS.has(source);
}

function extensions(base: string): string[] {
  if (extname(base)) return [];
  return [".ts", ".tsx", ".mts", ".js"].map((suffix) => `${base}${suffix}`);
}

function key(filename: string): string {
  return resolvePath(filename).replaceAll("\\", "/").toLowerCase();
}

function moduleSpan(module: CanonicalModule): SourceSpan {
  const first = module.body[0];
  return first?.span ?? { start: 0, end: 0 };
}

type RouteSpanPart = "route" | "callee" | "config" | "guard";
type RawNode = { readonly type: string; readonly [key: string]: unknown };

function authoredRouteSpan(module: ModuleSnapshot, part: RouteSpanPart): SourceSpan | undefined {
  const parsed = parseSync(module.filename, module.source, {
    lang: module.filename.endsWith(".tsx") ? "tsx" : "ts",
    astType: "js",
    range: true,
    sourceType: "module",
  });
  for (const raw of rawList((parsed.program as unknown as RawNode).body)) {
    const statement = rawNode(raw);
    if (statement?.type !== "ExportDefaultDeclaration") continue;
    const declaration = unwrapRawExpression(statement.declaration);
    if (declaration?.type !== "CallExpression") continue;
    const configuration = unwrapRawExpression(rawList(declaration.arguments)[0]);
    const guard =
      configuration?.type === "ObjectExpression"
        ? rawList(configuration.properties)
            .map(rawNode)
            .find((property) => {
              if (!property || property.type !== "Property") return false;
              const key = rawNode(property.key);
              return key?.name === "guard" || key?.value === "guard";
            })
        : undefined;
    const selected =
      part === "route"
        ? declaration
        : part === "callee"
          ? rawNode(declaration.callee)
          : part === "config"
            ? configuration
            : rawNode(guard?.value);
    return selected && typeof selected.start === "number" && typeof selected.end === "number"
      ? { start: selected.start, end: selected.end }
      : undefined;
  }
  return undefined;
}

function rawNode(value: unknown): RawNode | null {
  return typeof value === "object" && value !== null && "type" in value ? (value as RawNode) : null;
}

function unwrapRawExpression(value: unknown): RawNode | null {
  let current = rawNode(value);
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression")
  )
    current = rawNode(current.expression);
  return current;
}

function rawList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function routeDiagnostic(
  code: string,
  message: string,
  span: SourceSpan,
  filename = "",
): RouteDiagnostic {
  return { code, severity: "error", message, span, filename };
}

function authoredSpan(module: ModuleSnapshot, span: SourceSpan): SourceSpan {
  const start = module.mapOffset(span.start);
  const mappedEnd = module.mapOffset(span.end);
  return {
    start,
    end: mappedEnd > start ? mappedEnd : start + Math.max(0, span.end - span.start),
  };
}

function overlaps(a: SourceSpan, b: SourceSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function resultWithDiagnostics(
  root: ModuleInfo,
  diagnostics: readonly RouteDiagnostic[],
): RouteAnalysisResult {
  return { filename: root.filename, ir: root.module, debug: root.debug, diagnostics };
}

function failedRouteResult(
  filename: string,
  diagnostics: readonly RouteDiagnostic[],
): RouteAnalysisResult {
  const module: CanonicalModule = { version: 1, filename, body: [], diagnostics };
  return { filename, ir: module, debug: canonicalDebugSidecar(module), diagnostics };
}

function toRouteDiagnostic(filename: string, diagnostic: CompilerDiagnostic): RouteDiagnostic {
  return { ...diagnostic, filename };
}

function oxcDiagnostics(
  errors: readonly {
    readonly severity: string;
    readonly message: string;
    readonly labels: readonly { readonly start: number; readonly end: number }[];
  }[],
): CompilerDiagnostic[] {
  return errors.map((error) => ({
    code: "HES-OXC",
    severity: error.severity === "Warning" ? "warning" : "error",
    message: error.message,
    ...(error.labels[0]
      ? { span: { start: error.labels[0].start, end: error.labels[0].end } }
      : {}),
  }));
}

function mapDiagnostic(
  item: CompilerDiagnostic,
  mapper: (offset: number) => number,
): CompilerDiagnostic {
  return item.span
    ? { ...item, span: { start: mapper(item.span.start), end: mapper(item.span.end) } }
    : item;
}

function authoredOffset(
  generated: string,
  source: string,
  map: unknown,
): (offset: number) => number {
  if (!map) return (offset) => offset;
  const trace = new TraceMap(map as SourceMapInput);
  const generatedLines = lineStarts(generated);
  const sourceLines = lineStarts(source);
  return (offset) => {
    let low = 0;
    let high = generatedLines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (generatedLines[middle]! <= offset) low = middle;
      else high = middle;
    }
    const original = originalPositionFor(trace, {
      line: low + 1,
      column: offset - generatedLines[low]!,
    });
    return original.line === null || original.column === null
      ? 0
      : (sourceLines[original.line - 1] ?? source.length) + original.column;
  };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

function mapDebug(
  debug: CanonicalDebugSidecar,
  mapper: (offset: number) => number,
): CanonicalDebugSidecar {
  return {
    ...debug,
    spans: Object.fromEntries(
      Object.entries(debug.spans).map(([id, span]) => [
        id,
        { start: mapper(span.start), end: mapper(span.end) },
      ]),
    ),
  };
}
