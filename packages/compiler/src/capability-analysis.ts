import { join, resolve as resolvePath } from "node:path";
import { absolutePathKey as key } from "./utils.ts";
import { parseSync } from "oxc-parser";
import { analyzeModule } from "./compilation.ts";
import { ModuleResolver } from "./module-resolution.ts";
import { enumerateFiniteImportSpecifiers, enumerateFiniteStrings } from "./finite-imports.ts";
import {
  isCanonicalChild,
  type CanonicalChild,
  type CanonicalClassElement,
  type CanonicalExpression,
  type CanonicalModule,
  type CanonicalPattern,
  type CanonicalStatement,
  type CanonicalStatementBlock,
  type CanonicalImportSpecifier,
  type CompilerDiagnostic,
  type SourceSpan,
} from "./ir.ts";

/** One source module in the immutable browser checking snapshot. */
export interface CapabilitySourceModule {
  /** Authored or captured source identity resolved relative to the analysis root. */
  readonly filename: string;
  /** Captured authored text analyzed for browser capability reachability. */
  readonly source: string;
}

/** A capability diagnostic retains the source module owning the reported span. */
export interface CapabilityDiagnostic extends CompilerDiagnostic {
  /** Source file owning the diagnostic span. */
  readonly filename: string;
}

interface ModuleSnapshot {
  readonly filename: string;
  readonly source: string;
  readonly ir: CanonicalModule;
  readonly mapOffset?: (offset: number) => number;
}

interface BindingEntry {
  readonly module: ModuleInfo;
  readonly statement: CanonicalStatement;
  readonly specifier?: CanonicalImportSpecifier;
  readonly declarations?: readonly {
    readonly pattern: CanonicalPattern;
    readonly initializer: CanonicalExpression | CanonicalChild | null;
    readonly span: SourceSpan;
  }[];
}

interface ModuleInfo extends ModuleSnapshot {
  readonly valid: boolean;
  readonly constants: ReadonlyMap<string, CanonicalExpression>;
  readonly bindings: ReadonlyMap<string, BindingEntry>;
  readonly exports: ReadonlyMap<string, string>;
  readonly reexports: Map<string, ExportReference>;
  readonly starExports: ExportReference[];
}

interface ExportReference {
  readonly source: string;
  /** Null denotes the source module's namespace. */
  readonly imported: string | null;
  readonly span: SourceSpan;
}

interface ResolvedExport {
  readonly module: ModuleInfo;
  /** Absent for a namespace export. */
  readonly bindingId?: string;
  readonly path: readonly string[];
}

interface Reference {
  readonly id?: string;
  readonly name: string;
  readonly span: SourceSpan;
  /** A module assignment contributes a value when its destination binding is retained. */
  readonly assignedValue?: CanonicalExpression;
  readonly importSource?: CanonicalExpression;
}

interface PendingBinding {
  readonly module: ModuleInfo;
  readonly bindingId: string;
  readonly path: readonly string[];
}

const authoredImportScanner = new Bun.Transpiler({ loader: "tsx" });

// These names are the ECMAScript built-in callable values and standard namespace methods
// declared by the installed TypeScript 7.0.2 lib.es2025.* definitions. The table is deliberately
// limited to language built-ins; host APIs and arbitrary reflection remain unresolved.
const INTRINSIC_CALLABLE_GLOBALS = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float32Array",
  "Float64Array",
  "Function",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Map",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "URIError",
  "WeakMap",
  "WeakRef",
  "WeakSet",
]);

const INTRINSIC_CALLABLE_MEMBERS = new Map<string, ReadonlySet<string>>([
  ["Array", new Set(["from", "isArray", "of"])],
  ["ArrayBuffer", new Set(["isView"])],
  [
    "Atomics",
    new Set([
      "add",
      "and",
      "compareExchange",
      "exchange",
      "isLockFree",
      "load",
      "notify",
      "or",
      "store",
      "sub",
      "wait",
      "waitAsync",
      "wake",
      "xor",
    ]),
  ],
  ["Date", new Set(["now", "parse", "UTC"])],
  ["Function", new Set(["apply", "bind", "call", "toString"])],
  ["JSON", new Set(["isRawJSON", "parse", "rawJSON", "stringify"])],
  [
    "Math",
    new Set([
      "abs",
      "acos",
      "acosh",
      "asin",
      "asinh",
      "atan",
      "atan2",
      "atanh",
      "cbrt",
      "ceil",
      "clz32",
      "cos",
      "cosh",
      "exp",
      "expm1",
      "floor",
      "fround",
      "hypot",
      "imul",
      "log",
      "log10",
      "log1p",
      "log2",
      "max",
      "min",
      "pow",
      "random",
      "round",
      "sign",
      "sin",
      "sinh",
      "sqrt",
      "tan",
      "tanh",
      "trunc",
    ]),
  ],
  [
    "Number",
    new Set(["isFinite", "isInteger", "isNaN", "isSafeInteger", "parseFloat", "parseInt"]),
  ],
  [
    "Object",
    new Set([
      "assign",
      "create",
      "defineProperties",
      "defineProperty",
      "entries",
      "freeze",
      "fromEntries",
      "getOwnPropertyDescriptor",
      "getOwnPropertyDescriptors",
      "getOwnPropertyNames",
      "getOwnPropertySymbols",
      "getPrototypeOf",
      "groupBy",
      "hasOwn",
      "is",
      "isExtensible",
      "isFrozen",
      "isSealed",
      "keys",
      "preventExtensions",
      "seal",
      "setPrototypeOf",
      "values",
    ]),
  ],
  [
    "Promise",
    new Set(["all", "allSettled", "any", "race", "reject", "resolve", "try", "withResolvers"]),
  ],
  [
    "Reflect",
    new Set([
      "apply",
      "construct",
      "defineProperty",
      "deleteProperty",
      "get",
      "getOwnPropertyDescriptor",
      "getPrototypeOf",
      "has",
      "isExtensible",
      "ownKeys",
      "preventExtensions",
      "set",
      "setPrototypeOf",
    ]),
  ],
  ["RegExp", new Set(["escape"])],
  ["String", new Set(["fromCodePoint", "raw"])],
]);

const INTRINSIC_GLOBALS = new Set([
  ...INTRINSIC_CALLABLE_GLOBALS,
  ...INTRINSIC_CALLABLE_MEMBERS.keys(),
]);

const INTRINSIC_FUNCTION_PROTOTYPE_MEMBERS = new Set(["apply", "bind", "call", "toString"]);

// Package exports are resolved against the conditions used by browser ESM bundles. A package is
// safe only after its selected source and all of that source's dependencies pass this analysis.

const BROWSER_ROUTE_FILES = new Set([
  "+page.tsx",
  "+layout.tsx",
  "+loading.tsx",
  "+error.tsx",
  "+not-found.tsx",
]);

/**
 * Prove the absence of host capabilities for bindings reachable from browser entries.
 *
 * This is deliberately binding-granular: unused server-only function bindings do not taint a
 * safe export, while a referenced host binding produces a provenance path to its import or global.
 * The resolver supplies the same source snapshot used by bundling. Explicit entry filenames
 * let generated startup and runtime modules undergo the same analysis as authored entries;
 * each must be present in `modules`. Omission selects the root shell, configuration, and pages.
 */
export function analyzeBrowserCapabilities(
  modules: readonly CapabilitySourceModule[],
  root = process.cwd(),
  resolution: Pick<ModuleResolver, "resolve"> = new ModuleResolver(
    root,
    new Map(modules.map((module) => [module.filename, module.source])),
    "production",
  ),
  entryFilenames?: readonly string[],
): readonly CapabilityDiagnostic[] {
  const table = new SourceTable(modules, root, resolution);
  const selected =
    entryFilenames && new Set(entryFilenames.map((filename) => key(resolvePath(root, filename))));
  const entries = modules
    .map((module) => table.load(module.filename))
    .filter((module): module is ModuleInfo => module !== undefined)
    .filter((module) =>
      selected
        ? selected.has(key(resolvePath(root, module.filename)))
        : isBrowserEntry(module.filename, root),
    );
  const diagnostics: CapabilityDiagnostic[] = [];

  for (const filename of entryFilenames ?? []) {
    if (
      modules.some(
        (module) => key(resolvePath(root, module.filename)) === key(resolvePath(root, filename)),
      )
    )
      continue;

    diagnostics.push({
      code: "HES-CAPABILITY-RESOLVE",
      severity: "error",
      message: `Browser entry ${filename} is absent from the captured source snapshot.`,
      filename,
      span: { start: 0, end: 0 },
    });
  }

  const analysis = new ClosureAnalysis(table, diagnostics);

  for (const module of entries) analysis.addModule(module);

  return diagnostics;
}

class SourceTable {
  readonly #sources = new Map<string, CapabilitySourceModule>();
  readonly #authored = new Set<string>();
  readonly #snapshots = new Map<string, ModuleInfo>();

  readonly #root: string;
  readonly #resolution: Pick<ModuleResolver, "resolve">;

  constructor(
    modules: readonly CapabilitySourceModule[],
    root: string,
    resolution: Pick<ModuleResolver, "resolve">,
  ) {
    this.#root = resolvePath(root);
    this.#resolution = resolution;

    for (const module of modules) {
      const identity = key(resolvePath(root, module.filename));

      this.#sources.set(identity, module);

      this.#authored.add(identity);
    }
  }

  load(filename: string): ModuleInfo | undefined {
    const source = this.#sources.get(key(resolvePath(this.#root, filename)));

    if (!source) return undefined;

    const sourceKey = key(resolvePath(this.#root, source.filename));
    const existing = this.#snapshots.get(sourceKey);

    if (existing) return existing;

    const analysis = analyzeModule(source.source, {
      filename: source.filename,
      documentShell: sourceKey === key(join(this.#root, "app.tsx")),
    });
    const snapshot: ModuleSnapshot = {
      filename: source.filename,
      source: source.source,
      ir: analysis.result.ir,
      mapOffset: analysis.mapOffset,
    };
    const valid = !analysis.result.diagnostics.some((item) => item.severity === "error");
    const bindings = new Map<string, BindingEntry>();
    const constants = new Map<string, CanonicalExpression>();
    const exports = new Map<string, string>();
    const info: ModuleInfo = {
      ...snapshot,
      valid,
      bindings,
      constants,
      exports,
      reexports: new Map(),
      starExports: [],
    };

    for (const statement of snapshot.ir.body) indexStatement(statement, info, bindings, exports);

    indexNestedBindings(snapshot.ir, info, bindings, exports, constants);

    this.#snapshots.set(sourceKey, info);

    return info;
  }

  resolveImport(from: string, specifier: string): ModuleInfo | undefined {
    const result = this.resolve(from, specifier);

    if (result.kind === "failure") return undefined;

    if (!this.#sources.has(key(result.filename))) this.#sources.set(key(result.filename), result);

    return this.load(result.filename);
  }

  authoredImport(from: string, specifier: string): ModuleInfo | undefined {
    if (!specifier.startsWith(".")) return undefined;

    const resolution = this.#resolution.resolve(from, specifier);

    if (resolution.kind === "failure" || !this.#authored.has(key(resolution.filename)))
      return undefined;

    return this.load(resolution.filename);
  }

  resolve(from: string, specifier: string) {
    return this.#resolution.resolve(from, specifier);
  }
}

class ClosureAnalysis {
  readonly #sources: SourceTable;
  readonly #diagnostics: CapabilityDiagnostic[];
  readonly #queued = new Set<string>();
  readonly #checkedModules = new Set<string>();
  readonly #checkedNamespaces = new Set<string>();
  readonly #reported = new Set<string>();
  readonly #checkedAuthoredImports = new Set<string>();
  readonly #queue: PendingBinding[] = [];
  readonly #assignedValues = new Map<string, CanonicalExpression[]>();

  constructor(sources: SourceTable, diagnostics: CapabilityDiagnostic[]) {
    this.#sources = sources;
    this.#diagnostics = diagnostics;
  }

  addModule(module: ModuleInfo): void {
    this.checkModuleEvaluation(module, [displayFile(module.filename)]);

    if (module.exports.has("default") || module.reexports.has("default"))
      this.enqueueExport(module, "default", [displayFile(module.filename), "default"]);
    else this.enqueueNamespace(module, [displayFile(module.filename), "export"]);

    this.drain();
  }

  private drain(): void {
    while (this.#queue.length) {
      const pending = this.#queue.shift()!;
      const entry = pending.module.bindings.get(pending.bindingId);

      if (!entry) {
        this.error(
          pending.module,
          "HES-CAPABILITY-RESOLVE",
          `Browser binding ${pending.path.join(" -> ")} cannot be resolved.`,
          { start: 0, end: 0 },
        );

        continue;
      }

      if (entry.specifier) {
        this.resolveImport(pending.module, entry.specifier, pending.path);

        continue;
      }

      const references: Reference[] = [];

      if (entry.declarations) {
        for (const declaration of entry.declarations) {
          visitPatternDefaults(declaration.pattern, (expression) =>
            collectExpression(expression, references, entry.module),
          );

          if (declaration.initializer)
            collectValue(declaration.initializer, references, entry.module);
        }
      } else collectStatementReferences(entry.statement, references, entry.module);

      for (const value of this.#assignedValues.get(
        `${key(entry.module.filename)}#${pending.bindingId}`,
      ) ?? [])
        collectExpression(value, references, entry.module);

      for (const reference of references)
        this.resolveReference(entry.module, reference, pending.path);
    }
  }

  private enqueue(module: ModuleInfo, bindingId: string, path: readonly string[]): void {
    const item = `${key(module.filename)}#${bindingId}`;

    if (this.#queued.has(item)) return;

    this.#queued.add(item);

    this.#queue.push({ module, bindingId, path });
  }

  private checkModuleEvaluation(module: ModuleInfo, path: readonly string[]): void {
    const moduleKey = key(module.filename);

    if (this.#checkedModules.has(moduleKey)) return;

    this.#checkedModules.add(moduleKey);

    if (!module.valid) {
      this.error(
        module,
        "HES-CAPABILITY-UNRESOLVED",
        `Browser binding ${path.join(" -> ")} contains executable syntax whose provenance cannot be classified.`,
        { start: 0, end: 0 },
      );

      return;
    }

    this.checkAuthoredEnvImports(module, path);

    for (const statement of module.ir.body) {
      if (
        statement.kind === "import" ||
        statement.kind === "export-all" ||
        (statement.kind === "export-list" && statement.source !== null)
      ) {
        const dependency = this.dependency(module, statement.source!, path, statement.span);

        if (dependency && statement.kind === "import") {
          for (const specifier of statement.specifiers) {
            if (specifier.kind === "namespace") continue;

            const name = specifier.kind === "default" ? "default" : specifier.imported;

            this.requiredExport(
              dependency,
              name,
              [...path, `${statement.source}.${name}`],
              module,
              statement.span,
            );
          }
        }

        continue;
      }

      collectStatementEvaluation(
        statement,
        (reference) => this.resolveReference(module, reference, path),
        module,
      );
    }

    for (const [name, reference] of module.reexports)
      this.requiredExport(module, name, [...path, name], module, reference.span);
  }

  private checkAuthoredEnvImports(module: ModuleInfo, path: readonly string[]): void {
    const identity = key(module.filename);

    if (this.#checkedAuthoredImports.has(identity)) return;

    this.#checkedAuthoredImports.add(identity);

    for (const span of authoredEnvValueImports(module.filename, module.source))
      this.error(
        module,
        "HES-CAPABILITY",
        `Browser binding ${path.join(" -> ")} reaches host capability hesperia/env.`,
        span,
        true,
      );

    let requests: ReturnType<Bun.Transpiler["scanImports"]>;

    try {
      requests = authoredImportScanner.scanImports(module.source);
    } catch {
      return;
    }

    for (const request of requests) {
      if (request.kind !== "import-statement") continue;

      const dependency = this.#sources.authoredImport(module.filename, request.path);

      if (dependency) this.checkAuthoredEnvImports(dependency, [...path, request.path]);
    }
  }

  private resolveReference(
    module: ModuleInfo,
    reference: Reference,
    path: readonly string[],
  ): void {
    if (reference.importSource) {
      const specifiers = enumerateFiniteImportSpecifiers(reference.importSource, module.constants);

      if (!specifiers) {
        this.error(
          module,
          "HES-CAPABILITY-DYNAMIC",
          `Browser binding ${path.join(" -> ")} contains a dynamic import whose complete target set cannot be determined.`,
          reference.span,
        );

        return;
      }

      for (const source of specifiers) {
        const dependency = this.dependency(module, source, path, reference.span);

        if (dependency) this.enqueueNamespace(dependency, [...path, `import(${source})`]);
      }

      return;
    }

    if (reference.assignedValue && reference.id && module.bindings.has(reference.id)) {
      const bindingKey = `${key(module.filename)}#${reference.id}`;
      const values = this.#assignedValues.get(bindingKey) ?? [];

      values.push(reference.assignedValue);

      this.#assignedValues.set(bindingKey, values);

      if (this.#queued.has(bindingKey))
        for (const item of collectExpression(reference.assignedValue, [], module))
          this.resolveReference(module, item, [...path, reference.name]);

      return;
    }

    if (!reference.id || reference.id.startsWith("unresolved/")) {
      if (reference.name === "eval" || reference.name === "Function")
        this.error(
          module,
          "HES-CAPABILITY-DYNAMIC",
          `Browser binding ${path.join(" -> ")} reaches native ${reference.name}, which can execute code outside the checked module graph.`,
          reference.span,
        );

      if (reference.name === "Reflect.get")
        this.error(
          module,
          "HES-CAPABILITY-DYNAMIC",
          `Browser binding ${path.join(" -> ")} reaches a reflected global property whose execution cannot be classified.`,
          reference.span,
        );

      if (reference.name === "process" || reference.name === "Bun" || reference.name === "Deno")
        this.error(
          module,
          "HES-CAPABILITY",
          `Browser binding ${path.join(" -> ")} reaches host capability ${reference.name}.`,
          reference.span,
        );

      return;
    }

    if (module.bindings.has(reference.id))
      this.enqueue(module, reference.id, [...path, reference.name]);
  }

  private resolveImport(
    module: ModuleInfo,
    specifier: CanonicalImportSpecifier,
    path: readonly string[],
  ): void {
    const statement = module.bindings.get(specifier.bindingId ?? "")?.statement;

    if (!statement || statement.kind !== "import") return;

    const source = statement.source;
    const dependency = this.dependency(module, source, path, statement.span);

    if (!dependency) return;

    if (specifier.kind === "namespace") {
      this.enqueueNamespace(dependency, [...path, source]);

      return;
    }

    const name = specifier.kind === "default" ? "default" : specifier.imported;

    this.enqueueExport(dependency, name, [...path, `${source}.${name}`], module, statement.span);
  }

  private dependency(
    module: ModuleInfo,
    source: string,
    path: readonly string[],
    span: SourceSpan,
  ): ModuleInfo | undefined {
    const resolution = this.#sources.resolve(module.filename, source);
    const dependency = this.#sources.resolveImport(module.filename, source);

    if (!dependency && resolution.kind === "failure" && resolution.code === "HOST_IMPORT") {
      this.error(
        module,
        "HES-CAPABILITY",
        `Browser binding ${path.join(" -> ")} reaches host capability ${source}.`,
        span,
      );

      return;
    }

    if (!dependency) {
      const resolutionDetail =
        resolution.kind === "failure" &&
        source.startsWith("hesperia:plugin/") &&
        (resolution.code === "PACKAGE_NOT_FOUND" || resolution.code === "MODULE_NOT_FOUND")
          ? ` ${resolution.message}`
          : "";

      this.error(
        module,
        "HES-CAPABILITY-RESOLVE",
        `Browser binding ${path.join(" -> ")} imports missing module ${source}.${resolutionDetail}`,
        span,
      );

      return;
    }

    if (/(?:^|[\\/])\+route\.ts$/u.test(dependency.filename)) {
      this.error(
        dependency,
        "HES-ROUTE-SERVER",
        `Browser binding ${path.join(" -> ")} imports a server-only route declaration. Only its separately extracted guard may enter the browser.`,
        { start: 0, end: 0 },
      );

      return;
    }

    this.checkModuleEvaluation(dependency, [...path, source]);

    return dependency.valid ? dependency : undefined;
  }

  private enqueueNamespace(module: ModuleInfo, path: readonly string[]): void {
    const moduleKey = key(module.filename);

    if (this.#checkedNamespaces.has(moduleKey)) return;

    this.#checkedNamespaces.add(moduleKey);

    for (const name of this.exportNames(module, path)) {
      const targets = this.resolveExport(module, name, path, new Set());

      // Ambiguous star exports are absent from a native module namespace.
      if (targets?.length === 1) this.enqueueResolved(targets[0]!);
    }
  }

  private enqueueExport(
    module: ModuleInfo,
    name: string,
    path: readonly string[],
    requester = module,
    span: SourceSpan = { start: 0, end: 0 },
  ): void {
    const target = this.requiredExport(module, name, path, requester, span);

    if (target) this.enqueueResolved(target);
  }

  private requiredExport(
    module: ModuleInfo,
    name: string,
    path: readonly string[],
    requester: ModuleInfo,
    span: SourceSpan,
  ): ResolvedExport | undefined {
    const targets = this.resolveExport(module, name, path, new Set());

    if (!targets) return;

    if (targets.length !== 1) {
      this.error(
        requester,
        "HES-CAPABILITY-RESOLVE",
        `Browser binding ${path.join(" -> ")} imports ${targets.length ? "ambiguous" : "missing"} export ${name} from ${displayFile(module.filename)}.`,
        span,
      );

      return;
    }

    return targets[0];
  }

  private enqueueResolved(target: ResolvedExport): void {
    if (target.bindingId) this.enqueue(target.module, target.bindingId, target.path);
    else this.enqueueNamespace(target.module, target.path);
  }

  private resolveExport(
    module: ModuleInfo,
    name: string,
    path: readonly string[],
    seen: ReadonlySet<string>,
  ): ResolvedExport[] | undefined {
    const token = `${key(module.filename)}#${name}`;

    if (seen.has(token)) return [];

    const visited = new Set(seen).add(token);
    const bindingId = module.exports.get(name);

    if (bindingId) {
      const entry = module.bindings.get(bindingId);

      if (entry?.specifier && entry.statement.kind === "import") {
        const source = entry.statement.source;
        const dependency = this.dependency(module, source, path, entry.statement.span);

        if (!dependency) return undefined;

        const imported =
          entry.specifier.kind === "default"
            ? "default"
            : entry.specifier.kind === "named"
              ? entry.specifier.imported
              : null;
        const nextPath = [...path, `${source}.${imported ?? "*"}`];
        return imported === null
          ? [{ module: dependency, path: nextPath }]
          : this.resolveExport(dependency, imported, nextPath, visited);
      }

      return [{ module, bindingId, path }];
    }

    const indirect = module.reexports.get(name);

    if (indirect) {
      const dependency = this.dependency(module, indirect.source, path, indirect.span);

      if (!dependency) return undefined;

      const nextPath = [...path, `${indirect.source}.${indirect.imported ?? "*"}`];
      return indirect.imported === null
        ? [{ module: dependency, path: nextPath }]
        : this.resolveExport(dependency, indirect.imported, nextPath, visited);
    }

    if (name === "default") return [];

    const found = new Map<string, ResolvedExport>();

    for (const star of module.starExports) {
      const dependency = this.dependency(module, star.source, path, star.span);

      if (!dependency) return undefined;

      const targets = this.resolveExport(
        dependency,
        name,
        [...path, `${star.source}.${name}`],
        visited,
      );

      if (!targets) return undefined;

      for (const target of targets)
        found.set(`${key(target.module.filename)}#${target.bindingId ?? "*"}`, target);
    }

    return [...found.values()];
  }

  private exportNames(
    module: ModuleInfo,
    path: readonly string[],
    seen = new Set<string>(),
  ): Set<string> {
    const moduleKey = key(module.filename);

    if (seen.has(moduleKey)) return new Set();

    seen.add(moduleKey);

    const names = new Set([...module.exports.keys(), ...module.reexports.keys()]);

    for (const star of module.starExports) {
      const dependency = this.dependency(module, star.source, path, star.span);

      if (!dependency) continue;

      for (const name of this.exportNames(dependency, [...path, star.source], seen))
        if (name !== "default") names.add(name);
    }

    return names;
  }

  private error(
    module: ModuleInfo,
    code: string,
    message: string,
    span: SourceSpan,
    alreadyAuthored = false,
  ): void {
    const mapped = alreadyAuthored ? span : authoredSpan(module, span);
    const item =
      code === "HES-CAPABILITY" && message.endsWith("host capability hesperia/env.")
        ? `${code}:${module.filename}:hesperia/env`
        : `${code}:${module.filename}:${mapped.start}:${mapped.end}`;

    if (this.#reported.has(item)) return;

    this.#reported.add(item);

    this.#diagnostics.push({
      code,
      severity: "error",
      message,
      span: mapped,
      filename: module.filename,
    });
  }
}

function authoredEnvValueImports(filename: string, source: string): readonly SourceSpan[] {
  try {
    if (!authoredImportScanner.scanImports(source).some((item) => item.path === "hesperia/env"))
      return [];
  } catch {
    if (!source.includes("hesperia") && !source.includes("\\u")) return [];
  }

  const parsed = parseSync(filename, source, {
    lang: /\.(?:tsx|jsx)$/u.test(filename) ? "tsx" : "ts",
    astType: "ts",
    range: true,
    sourceType: "module",
  });
  const spans: SourceSpan[] = [];

  for (const statement of parsed.program.body) {
    if (
      statement.type !== "ImportDeclaration" &&
      statement.type !== "ExportNamedDeclaration" &&
      statement.type !== "ExportAllDeclaration"
    )
      continue;

    if (statement.source?.value !== "hesperia/env") continue;

    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;

      if (
        statement.specifiers.length > 0 &&
        statement.specifiers.every(
          (specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type",
        )
      )
        continue;
    } else {
      if (statement.exportKind === "type") continue;

      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.specifiers.length > 0 &&
        statement.specifiers.every((specifier) => specifier.exportKind === "type")
      )
        continue;
    }

    spans.push({ start: statement.source.start, end: statement.source.end });
  }

  return spans;
}

function indexStatement(
  statement: CanonicalStatement,
  module: ModuleInfo,
  bindings: Map<string, BindingEntry>,
  exports: Map<string, string>,
): void {
  if (statement.kind === "import") {
    for (const specifier of statement.specifiers)
      if (specifier.bindingId) bindings.set(specifier.bindingId, { module, statement, specifier });

    return;
  }

  if (statement.kind === "export") {
    indexStatement(statement.declaration, module, bindings, exports);

    for (const item of statement.exportedBindings ?? [])
      exports.set(item.exported, item.referenceId);

    if (statement.exportKind === "default" && statement.declaration.kind === "expression") {
      const expression = statement.declaration.expression;

      if (expression.kind === "identifier" && expression.referenceId)
        exports.set("default", expression.referenceId);
      else {
        const bindingId = "export/default";

        bindings.set(bindingId, { module, statement: statement.declaration });

        exports.set("default", bindingId);
      }
    }

    return;
  }

  if (statement.kind === "export-list") {
    for (const item of statement.specifiers) {
      if (statement.source !== null)
        module.reexports.set(item.exported, {
          source: statement.source,
          imported: item.local,
          span: statement.span,
        });
      else if (item.referenceId) exports.set(item.exported, item.referenceId);
    }

    return;
  }

  if (statement.kind === "export-all") {
    const reference = { source: statement.source, imported: null, span: statement.span };

    if (statement.exported !== null) module.reexports.set(statement.exported, reference);
    else module.starExports.push(reference);

    return;
  }

  if (statement.kind === "function" || statement.kind === "class") {
    if (statement.bindingId) bindings.set(statement.bindingId, { module, statement });

    if (statement.kind === "function") {
      for (const child of statement.body.body) indexStatement(child, module, bindings, exports);
    }

    return;
  }

  if (statement.kind === "variable") {
    for (const declaration of statement.declarations) {
      for (const bindingId of patternBindingIds(declaration.pattern))
        bindings.set(bindingId, {
          module,
          statement,
          declarations: [...(bindings.get(bindingId)?.declarations ?? []), declaration],
        });

      for (const bindingId of declaration.hoistedBindingIds ?? [])
        if (!bindings.has(bindingId))
          bindings.set(bindingId, { module, statement, declarations: [] });
    }

    return;
  }

  if (statement.kind === "block") {
    for (const child of statement.body) indexStatement(child, module, bindings, exports);
  } else if (statement.kind === "switch") {
    for (const branch of statement.cases)
      for (const child of branch.consequent) indexStatement(child, module, bindings, exports);
  } else if (statement.kind === "try") {
    indexStatement(statement.body, module, bindings, exports);

    if (statement.handler) {
      const { param, body, span } = statement.handler;

      if (param)
        for (const bindingId of patternBindingIds(param))
          bindings.set(bindingId, {
            module,
            statement,
            declarations: [{ pattern: param, initializer: null, span }],
          });

      indexStatement(body, module, bindings, exports);
    }

    if (statement.finalizer) indexStatement(statement.finalizer, module, bindings, exports);
  } else if (statement.kind === "if") {
    indexStatement(statement.consequent, module, bindings, exports);

    if (statement.alternate) indexStatement(statement.alternate, module, bindings, exports);
  } else if (statement.kind === "for") {
    if (statement.init?.kind === "variable")
      indexStatement(statement.init, module, bindings, exports);

    indexStatement(statement.body, module, bindings, exports);
  } else if (statement.kind === "for-of" || statement.kind === "for-in") {
    if (statement.left.kind === "declaration") {
      for (const bindingId of patternBindingIds(statement.left.pattern))
        bindings.set(bindingId, {
          module,
          statement,
          declarations: [
            ...(bindings.get(bindingId)?.declarations ?? []),
            {
              pattern: statement.left.pattern,
              initializer: statement.right,
              span: statement.left.span,
            },
          ],
        });

      for (const bindingId of statement.left.hoistedBindingIds ?? [])
        if (!bindings.has(bindingId))
          bindings.set(bindingId, { module, statement, declarations: [] });
    }

    indexStatement(statement.body, module, bindings, exports);
  } else if (
    statement.kind === "while" ||
    statement.kind === "do-while" ||
    statement.kind === "labeled"
  ) {
    indexStatement(statement.body, module, bindings, exports);
  }
}

function indexNestedBindings(
  value: unknown,
  module: ModuleInfo,
  bindings: Map<string, BindingEntry>,
  exports: Map<string, string>,
  constants: Map<string, CanonicalExpression>,
): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) indexNestedBindings(item, module, bindings, exports, constants);

    return;
  }

  const record = value as Record<string, unknown>;

  if (record.kind === "arrow" || record.kind === "function-expression") {
    const body = record.body;

    if (
      body &&
      typeof body === "object" &&
      (body as { readonly kind?: unknown }).kind === "block"
    ) {
      for (const statement of (body as CanonicalStatementBlock).body)
        indexStatement(statement, module, bindings, exports);
    }
  }

  if (record.kind === "variable" && record.declarationKind === "const") {
    for (const declaration of (value as Extract<CanonicalStatement, { kind: "variable" }>)
      .declarations)
      if (
        declaration.pattern.kind === "identifier" &&
        declaration.pattern.bindingId &&
        declaration.initializer &&
        !isCanonicalChild(declaration.initializer)
      )
        constants.set(declaration.pattern.bindingId, declaration.initializer);
  }

  if (record.kind === "class") {
    // A static block's values can escape even when the containing class is unused.
    for (const element of (value as ClassContents).elements)
      if (element.kind === "static-block") indexStatement(element.body, module, bindings, exports);
  }

  for (const item of Object.values(record))
    indexNestedBindings(item, module, bindings, exports, constants);
}

function collectStatementReferences(
  statement: CanonicalStatement,
  references: Reference[],
  module?: ModuleInfo,
): void {
  switch (statement.kind) {
    case "switch":
      collectExpression(statement.discriminant, references, module);

      for (const branch of statement.cases) {
        if (branch.test) collectExpression(branch.test, references, module);

        for (const child of branch.consequent)
          collectStatementReferences(child, references, module);
      }

      return;
    case "class":
      collectClassReferences(statement, references, module);

      return;
    case "try":
      collectBlock(statement.body, references, module);

      if (statement.handler) {
        if (statement.handler.param)
          visitPatternDefaults(statement.handler.param, (expression) =>
            collectExpression(expression, references, module),
          );

        collectBlock(statement.handler.body, references, module);
      }

      if (statement.finalizer) collectBlock(statement.finalizer, references, module);

      return;
    case "variable":
      for (const declaration of statement.declarations) {
        visitPatternDefaults(declaration.pattern, (expression) =>
          collectExpression(expression, references, module),
        );

        if (declaration.initializer) collectValue(declaration.initializer, references, module);
      }

      return;
    case "function":
      for (const parameter of statement.parameters)
        visitPatternDefaults(parameter, (expression) =>
          collectExpression(expression, references, module),
        );

      collectBlock(statement.body, references, module);

      return;
    case "return":
      if (statement.argument) collectValue(statement.argument, references, module);

      return;
    case "expression":
      collectExpression(statement.expression, references, module);

      return;
    case "if":
      collectExpression(statement.test, references, module);

      collectStatementReferences(statement.consequent, references, module);

      if (statement.alternate) collectStatementReferences(statement.alternate, references, module);

      return;
    case "throw":
      collectExpression(statement.argument, references, module);

      return;
    case "for":
      if (statement.init?.kind === "variable")
        collectStatementReferences(statement.init, references, module);
      else if (statement.init) collectExpression(statement.init, references, module);

      if (statement.test) collectExpression(statement.test, references, module);

      if (statement.update) collectExpression(statement.update, references, module);

      collectStatementReferences(statement.body, references, module);

      return;
    case "for-of":
    case "for-in":
      collectExpression(statement.right, references, module);

      if (statement.left.kind === "declaration")
        visitPatternDefaults(statement.left.pattern, (expression) =>
          collectExpression(expression, references, module),
        );
      else
        collectAssignmentTarget(
          statement.left.target,
          (reference) => references.push(reference),
          module,
        );

      collectStatementReferences(statement.body, references, module);

      return;
    case "while":
    case "do-while":
      collectExpression(statement.test, references, module);

      collectStatementReferences(statement.body, references, module);

      return;
    case "labeled":
      collectStatementReferences(statement.body, references, module);

      return;
    case "break":
    case "continue":
      return;
    case "block":
      collectBlock(statement, references, module);

      return;
    case "export":
      collectStatementReferences(statement.declaration, references, module);

      return;
    case "import":
    case "export-list":
    case "export-all":
      return;
  }
}

function collectStatementEvaluation(
  statement: CanonicalStatement,
  visit: (reference: Reference) => void,
  module?: ModuleInfo,
): void {
  switch (statement.kind) {
    case "switch":
      collectEvaluationExpression(statement.discriminant, visit, module);

      for (const branch of statement.cases) {
        if (branch.test) collectEvaluationExpression(branch.test, visit, module);

        for (const child of branch.consequent) collectStatementEvaluation(child, visit, module);
      }

      return;
    case "class":
      collectClassEvaluation(statement, visit, module);

      return;
    case "try":
      collectStatementEvaluation(statement.body, visit, module);

      if (statement.handler) {
        if (statement.handler.param)
          visitPatternDefaults(statement.handler.param, (expression) =>
            collectEvaluationExpression(expression, visit, module),
          );

        collectStatementEvaluation(statement.handler.body, visit, module);
      }

      if (statement.finalizer) collectStatementEvaluation(statement.finalizer, visit, module);

      return;
    case "variable":
      for (const declaration of statement.declarations) {
        visitPatternDefaults(declaration.pattern, (expression) =>
          collectEvaluationExpression(expression, visit, module),
        );

        if (declaration.initializer) collectEvaluationValue(declaration.initializer, visit, module);
      }

      return;
    case "expression":
      collectEvaluationExpression(statement.expression, visit, module);

      return;
    case "if":
      collectExpression(statement.test, [], module).forEach(visit);

      collectStatementEvaluation(statement.consequent, visit, module);

      if (statement.alternate) collectStatementEvaluation(statement.alternate, visit, module);

      return;
    case "throw":
      collectExpression(statement.argument, [], module).forEach(visit);

      return;
    case "for":
      if (statement.init?.kind === "variable")
        collectStatementEvaluation(statement.init, visit, module);
      else if (statement.init) collectEvaluationExpression(statement.init, visit, module);

      if (statement.test) collectEvaluationExpression(statement.test, visit, module);

      if (statement.update) collectEvaluationExpression(statement.update, visit, module);

      collectStatementEvaluation(statement.body, visit, module);

      return;
    case "for-of":
    case "for-in":
      collectEvaluationExpression(statement.right, visit, module);

      if (statement.left.kind === "declaration")
        visitPatternDefaults(statement.left.pattern, (expression) =>
          collectEvaluationExpression(expression, visit, module),
        );
      else {
        const target = statement.left.target;

        if (target.kind === "identifier")
          visit({
            id: target.referenceId,
            name: target.name,
            span: target.span,
            assignedValue: statement.right,
          });
        else {
          collectAssignmentTarget(target, visit, module);

          collectExpression(statement.right, [], module).forEach(visit);
        }
      }

      collectStatementEvaluation(statement.body, visit, module);

      return;
    case "while":
    case "do-while":
      collectEvaluationExpression(statement.test, visit, module);

      collectStatementEvaluation(statement.body, visit, module);

      return;
    case "labeled":
      collectStatementEvaluation(statement.body, visit, module);

      return;
    case "break":
    case "continue":
      return;
    case "export":
      collectStatementEvaluation(statement.declaration, visit, module);

      return;
    case "block":
      for (const item of statement.body) collectStatementEvaluation(item, visit, module);

      return;
    case "function":
    case "return":
    case "import":
    case "export-list":
    case "export-all":
      return;
  }
}

function collectEvaluationValue(
  value: CanonicalExpression | CanonicalChild,
  visit: (reference: Reference) => void,
  module?: ModuleInfo,
): void {
  if (isCanonicalChild(value)) {
    const references: Reference[] = [];

    collectChild(value, references, module);

    references.forEach(visit);

    return;
  }

  collectEvaluationExpression(value, visit, module);
}

function collectEvaluationExpression(
  expression: CanonicalExpression,
  visit: (reference: Reference) => void,
  module?: ModuleInfo,
): void {
  if (expression.kind === "import-expression") {
    visit({ name: "import", span: expression.span, importSource: expression.source });

    collectEvaluationExpression(expression.source, visit, module);

    if (expression.options) collectEvaluationExpression(expression.options, visit, module);

    return;
  }

  if (expression.kind === "class") return collectClassEvaluation(expression, visit, module);

  if (expression.kind === "arrow" || expression.kind === "function-expression") return;

  if (expression.kind === "identifier") {
    visit({ id: expression.referenceId, name: expression.name, span: expression.span });

    return;
  }

  if (expression.kind === "template") {
    for (const item of expression.expressions) collectEvaluationExpression(item, visit, module);

    return;
  }

  if (expression.kind === "sequence") {
    for (const item of expression.expressions) collectEvaluationExpression(item, visit, module);

    return;
  }

  if (expression.kind === "await")
    return collectEvaluationExpression(expression.expression, visit, module);

  if (expression.kind === "yield") {
    if (expression.expression) collectEvaluationExpression(expression.expression, visit, module);

    return;
  }

  if (expression.kind === "member") {
    const metadataConstructor = unknownFunctionMetadataConstructor(expression, module);

    if (metadataConstructor) {
      collectSequencePrefixes(expression.object, (prefix) =>
        collectEvaluationExpression(prefix, visit, module),
      );

      collectEvaluationExpression(metadataConstructor.object, visit, module);

      if (metadataConstructor.computed)
        collectEvaluationExpression(metadataConstructor.property, visit, module);

      if (expression.computed) collectEvaluationExpression(expression.property, visit, module);

      return;
    }

    if (isFunctionMetadata(expression, module)) {
      if (!isIntrinsicNativeFunctionValue(expression.object, module))
        collectEvaluationExpression(expression.object, visit, module);
      else
        collectComputedMemberOperands(expression.object, (child) =>
          collectEvaluationExpression(child, visit, module),
        );

      if (expression.computed) collectEvaluationExpression(expression.property, visit, module);

      return;
    }

    if (isNativeFunctionConstructor(expression, module)) {
      collectSequencePrefixes(expression.object, (prefix) =>
        collectEvaluationExpression(prefix, visit, module),
      );

      visit({ name: "Function", span: expression.span });

      if (expression.computed) collectEvaluationExpression(expression.property, visit, module);

      return;
    }

    const unresolvedConstructor = unresolvedConstructorMember(expression, module);

    if (unresolvedConstructor) {
      collectSequencePrefixes(expression.object, (prefix) =>
        collectEvaluationExpression(prefix, visit, module),
      );

      visit(unresolvedConstructor);

      if (expression.computed) collectEvaluationExpression(expression.property, visit, module);

      return;
    }

    const unresolved = unresolvedFunctionMember(expression, module);

    if (unresolved) {
      collectSequencePrefixes(expression.object, (prefix) =>
        collectEvaluationExpression(prefix, visit, module),
      );

      visit(unresolved);

      if (expression.computed) collectEvaluationExpression(expression.property, visit, module);

      return;
    }

    const native = nativeGlobalMember(expression, module);

    if (native) {
      collectSequencePrefixes(expression.object, (prefix) =>
        collectEvaluationExpression(prefix, visit, module),
      );

      visit(native);

      if (expression.computed) collectEvaluationExpression(expression.property, visit, module);

      return;
    }

    collectEvaluationExpression(expression.object, visit, module);

    if (expression.computed) collectEvaluationExpression(expression.property, visit, module);

    return;
  }

  if (expression.kind === "call" || expression.kind === "new") {
    if (expression.kind === "call") {
      const native = reflectedNativeExecution(expression, module);

      if (native) visit(native);
    }

    collectExpression(expression, [], module).forEach(visit);

    return;
  }

  if (expression.kind === "assignment") {
    if (expression.left.kind === "identifier" && expression.left.referenceId) {
      visit({
        id: expression.left.referenceId,
        name: expression.left.name,
        span: expression.left.span,
        assignedValue: expression.right,
      });

      if (expression.operator !== "=") collectEvaluationExpression(expression.left, visit, module);
    } else {
      collectAssignmentTarget(expression.left, (reference) => visit(reference), module);

      collectExpression(expression.right, [], module).forEach(visit);
    }

    collectEvaluationExpression(expression.right, visit, module);

    return;
  }

  if (expression.kind === "binary") {
    collectEvaluationExpression(expression.left, visit, module);

    collectEvaluationExpression(expression.right, visit, module);

    return;
  }

  if (expression.kind === "unary")
    return collectEvaluationExpression(expression.argument, visit, module);

  if (expression.kind === "conditional") {
    collectEvaluationExpression(expression.test, visit, module);

    collectEvaluationExpression(expression.consequent, visit, module);

    collectEvaluationExpression(expression.alternate, visit, module);

    return;
  }

  if (expression.kind === "object") {
    for (const property of expression.properties) {
      if (property.kind === "spread") collectEvaluationExpression(property.argument, visit, module);
      else {
        if (property.computed && typeof property.key !== "string")
          collectEvaluationExpression(property.key, visit, module);

        collectEvaluationValue(property.value, visit, module);
      }
    }

    return;
  }

  if (expression.kind === "array") {
    for (const item of expression.elements)
      if (item)
        collectEvaluationValue(item.kind === "spread" ? item.argument : item, visit, module);
  }
}

function collectValue(
  value: CanonicalExpression | CanonicalChild,
  references: Reference[],
  module?: ModuleInfo,
): void {
  if (isCanonicalChild(value)) collectChild(value, references, module);
  else collectExpression(value, references, module);
}

function collectComputedMemberOperands(
  expression: CanonicalExpression,
  visit: (expression: CanonicalExpression) => void,
): void {
  if (expression.kind === "sequence") {
    for (const item of expression.expressions.slice(0, -1)) visit(item);

    const value = expression.expressions.at(-1);

    if (value) collectComputedMemberOperands(value, visit);

    return;
  }

  if (expression.kind !== "member") {
    if (!(expression.kind === "identifier" && unboundIdentifier(expression) === "Function"))
      visit(expression);

    return;
  }

  if (expression.computed) visit(expression.property);

  collectComputedMemberOperands(expression.object, visit);
}

function collectSequencePrefixes(
  expression: CanonicalExpression,
  collectPrefix: (expression: CanonicalExpression) => void,
): void {
  if (expression.kind === "sequence") {
    for (const item of expression.expressions.slice(0, -1)) collectPrefix(item);

    const final = expression.expressions.at(-1);

    if (final) collectSequencePrefixes(final, collectPrefix);
  } else {
    for (const child of expressionChildren(expression))
      collectSequencePrefixes(child, collectPrefix);
  }
}

function collectAssignmentTarget(
  expression: CanonicalExpression,
  visit: (reference: Reference) => void,
  module?: ModuleInfo,
): void {
  if (expression.kind === "member") {
    collectExpression(expression.object, [], module).forEach(visit);

    if (expression.computed) collectExpression(expression.property, [], module).forEach(visit);

    return;
  }

  collectExpression(expression, [], module).forEach(visit);
}

function collectExpression(
  expression: CanonicalExpression,
  references: Reference[],
  module?: ModuleInfo,
): Reference[] {
  switch (expression.kind) {
    case "import-expression":
      references.push({ name: "import", span: expression.span, importSource: expression.source });

      collectExpression(expression.source, references, module);

      if (expression.options) collectExpression(expression.options, references, module);

      break;
    case "class":
      collectClassReferences(expression, references, module);

      break;
    case "identifier":
      references.push({ id: expression.referenceId, name: expression.name, span: expression.span });

      break;
    case "template":
      for (const item of expression.expressions) collectExpression(item, references, module);

      break;
    case "sequence":
      for (const item of expression.expressions) collectExpression(item, references, module);

      break;
    case "await":
      collectExpression(expression.expression, references, module);

      break;
    case "yield":
      if (expression.expression) collectExpression(expression.expression, references, module);

      break;
    case "member":
      {
        const metadataConstructor = unknownFunctionMetadataConstructor(expression, module);

        if (metadataConstructor) {
          collectSequencePrefixes(expression.object, (prefix) =>
            collectExpression(prefix, references, module),
          );

          collectExpression(metadataConstructor.object, references, module);

          if (metadataConstructor.computed)
            collectExpression(metadataConstructor.property, references, module);

          if (expression.computed) collectExpression(expression.property, references, module);

          break;
        }
      }

      if (isFunctionMetadata(expression, module)) {
        if (!isIntrinsicNativeFunctionValue(expression.object, module))
          collectExpression(expression.object, references, module);
        else
          collectComputedMemberOperands(expression.object, (child) =>
            collectExpression(child, references, module),
          );

        if (expression.computed) collectExpression(expression.property, references, module);

        break;
      }

      if (isNativeFunctionConstructor(expression, module)) {
        collectSequencePrefixes(expression.object, (prefix) =>
          collectExpression(prefix, references, module),
        );

        references.push({ name: "Function", span: expression.span });

        if (expression.computed) collectExpression(expression.property, references, module);

        break;
      }

      {
        const unresolvedConstructor = unresolvedConstructorMember(expression, module);

        if (unresolvedConstructor) {
          collectSequencePrefixes(expression.object, (prefix) =>
            collectExpression(prefix, references, module),
          );

          references.push(unresolvedConstructor);

          if (expression.computed) collectExpression(expression.property, references, module);

          break;
        }
      }
      {
        const unresolved = unresolvedFunctionMember(expression, module);

        if (unresolved) {
          collectSequencePrefixes(expression.object, (prefix) =>
            collectExpression(prefix, references, module),
          );

          references.push(unresolved);

          if (expression.computed) collectExpression(expression.property, references, module);

          break;
        }
      }
      {
        const native = nativeGlobalMember(expression, module);

        if (native) {
          collectSequencePrefixes(expression.object, (prefix) =>
            collectExpression(prefix, references, module),
          );

          references.push(native);

          if (expression.computed) collectExpression(expression.property, references, module);

          break;
        }
      }

      collectExpression(expression.object, references, module);

      if (expression.computed) collectExpression(expression.property, references, module);

      break;
    case "call":
    case "new":
      if (expression.kind === "call") {
        const native = reflectedNativeExecution(expression, module);

        if (native) references.push(native);
      }

      collectExpression(expression.callee, references, module);

      for (const item of expression.arguments)
        collectExpression(item.kind === "spread" ? item.argument : item, references, module);

      break;
    case "binary":
    case "assignment":
      if (expression.kind === "assignment")
        collectAssignmentTarget(expression.left, (reference) => references.push(reference), module);
      else collectExpression(expression.left, references, module);

      collectExpression(expression.right, references, module);

      break;
    case "unary":
      collectExpression(expression.argument, references, module);

      break;
    case "conditional":
      collectExpression(expression.test, references, module);

      collectExpression(expression.consequent, references, module);

      collectExpression(expression.alternate, references, module);

      break;
    case "arrow":
      for (const parameter of expression.parameters)
        visitPatternDefaults(parameter, (expression) =>
          collectExpression(expression, references, module),
        );

      if (isCanonicalChild(expression.body)) collectChild(expression.body, references, module);
      else if (expression.body.kind === "block") collectBlock(expression.body, references, module);
      else collectExpression(expression.body, references, module);

      break;
    case "function-expression":
      for (const parameter of expression.parameters)
        visitPatternDefaults(parameter, (expression) =>
          collectExpression(expression, references, module),
        );

      collectBlock(expression.body, references, module);

      break;
    case "object":
      for (const property of expression.properties) {
        if (property.kind === "spread") collectExpression(property.argument, references, module);
        else {
          if (property.computed && typeof property.key !== "string")
            collectExpression(property.key, references, module);

          collectExpression(property.value, references, module);
        }
      }

      break;
    case "array":
      for (const item of expression.elements)
        if (item) collectValue(item.kind === "spread" ? item.argument : item, references, module);

      break;
    case "literal":
    case "regexp":
    case "bigint":
    case "undefined":
    case "this":
    case "super":
    case "private":
    case "new-target":
    case "import-meta":
      break;
  }

  return references;
}

function unboundIdentifier(expression: CanonicalExpression): string | undefined {
  expression = sequenceValue(expression);

  if (expression.kind !== "identifier") return;

  if (!expression.referenceId || expression.referenceId.startsWith("unresolved/"))
    return expression.name;
}

function memberName(
  expression: Extract<CanonicalExpression, { kind: "member" }>,
): string | undefined {
  if (!expression.computed && expression.property.kind === "identifier")
    return expression.property.name;

  if (
    expression.computed &&
    expression.property.kind === "literal" &&
    typeof expression.property.value === "string"
  )
    return expression.property.value;
}

function nativeGlobalMember(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): Reference | undefined {
  if (expression.kind !== "member") return;

  if (!isGlobalObjectExpression(expression.object, module)) return;

  const names = memberNames(expression, module);

  if (!names) return { name: "Reflect.get", span: expression.span };

  const dangerous = names.find(
    (name) =>
      name === "eval" ||
      name === "Function" ||
      name === "process" ||
      name === "Bun" ||
      name === "Deno",
  );

  if (dangerous) return { name: dangerous, span: expression.span };
}

function isNativeGlobalFunctionValue(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): boolean {
  expression = sequenceValue(expression);
  const names =
    expression.kind === "member" && isGlobalObjectExpression(expression.object, module)
      ? memberNames(expression, module)
      : undefined;
  return names !== undefined && names.length === 1 && names[0] === "Function";
}

function memberNames(
  expression: Extract<CanonicalExpression, { kind: "member" }>,
  module?: ModuleInfo,
): readonly string[] | undefined {
  const direct = memberName(expression);
  return direct === undefined
    ? expression.computed
      ? finiteStringValues(expression.property, module)
      : undefined
    : [direct];
}

function isFunctionMetadata(
  expression: Extract<CanonicalExpression, { kind: "member" }>,
  module?: ModuleInfo,
): boolean {
  const names = memberNames(expression, module);
  return (
    names !== undefined &&
    names.every((name) => name === "prototype" || name === "name" || name === "length") &&
    isNativeFunctionValue(expression.object, module)
  );
}

function intrinsicGlobalName(
  expression: CanonicalExpression,
  module?: ModuleInfo,
  seen = new Set<string>(),
): string | undefined {
  expression = sequenceValue(expression);
  const direct = unboundIdentifier(expression);

  if (direct && INTRINSIC_GLOBALS.has(direct)) return direct;

  if (expression.kind === "member") {
    const names = memberNames(expression, module);

    if (
      names?.length === 1 &&
      isGlobalObjectExpression(expression.object, module) &&
      INTRINSIC_GLOBALS.has(names[0]!)
    )
      return names[0];

    return;
  }

  if (expression.kind !== "identifier" || !module || !expression.referenceId) return;

  if (seen.has(expression.referenceId)) return;

  seen.add(expression.referenceId);

  const binding = module.bindings.get(expression.referenceId);

  if (binding?.statement.kind !== "variable" || binding.statement.declarationKind !== "const")
    return;

  const declarations = binding.declarations ?? [];

  if (declarations.length !== 1) return;

  const initializer = declarations[0]?.initializer;

  if (!initializer || isCanonicalChild(initializer)) return;

  return intrinsicGlobalName(initializer, module, seen);
}

function isIntrinsicCallableValue(
  expression: CanonicalExpression,
  module?: ModuleInfo,
  seen = new Set<string>(),
): boolean {
  expression = sequenceValue(expression);
  const root = intrinsicGlobalName(expression, module);

  if (root && INTRINSIC_CALLABLE_GLOBALS.has(root)) return true;

  if (expression.kind === "identifier" && module && expression.referenceId) {
    if (seen.has(expression.referenceId)) return false;

    seen.add(expression.referenceId);

    const binding = module.bindings.get(expression.referenceId);

    if (binding?.statement.kind === "variable" && binding.statement.declarationKind === "const") {
      const declarations = binding.declarations ?? [];

      if (declarations.length === 1) {
        const initializer = declarations[0]?.initializer;

        if (initializer && !isCanonicalChild(initializer))
          return isIntrinsicCallableValue(initializer, module, seen);
      }
    }
  }

  if (expression.kind === "call") {
    return (
      expression.callee.kind === "member" &&
      memberNames(expression.callee, module)?.length === 1 &&
      memberNames(expression.callee, module)?.[0] === "bind" &&
      isIntrinsicCallableValue(expression.callee.object, module, seen)
    );
  }

  if (expression.kind !== "member") return false;

  const names = memberNames(expression, module);

  if (!names || names.length !== 1) return false;

  const name = names[0]!;

  if (name === "constructor") {
    if (root !== undefined || isIntrinsicCallableValue(expression.object, module, seen))
      return true;

    return (
      expression.object.kind === "member" &&
      memberNames(expression.object, module)?.length === 1 &&
      memberNames(expression.object, module)?.[0] === "prototype" &&
      intrinsicGlobalName(expression.object.object, module) !== undefined
    );
  }

  const namespace = intrinsicGlobalName(expression.object, module);

  if (namespace === "Function" && name === "prototype") return true;

  if (
    INTRINSIC_FUNCTION_PROTOTYPE_MEMBERS.has(name) &&
    isIntrinsicCallableValue(expression.object, module, seen)
  )
    return true;

  return namespace !== undefined && INTRINSIC_CALLABLE_MEMBERS.get(namespace)?.has(name) === true;
}

function isNativeFunctionValue(expression: CanonicalExpression, module?: ModuleInfo): boolean {
  return (
    unboundIdentifier(expression) === "Function" ||
    isNativeGlobalFunctionValue(expression, module) ||
    isIntrinsicCallableValue(expression, module) ||
    isFunctionObjectExpression(expression, module) ||
    isNativeFunctionConstructor(expression, module)
  );
}

function isIntrinsicNativeFunctionValue(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): boolean {
  return (
    unboundIdentifier(expression) === "Function" ||
    isNativeGlobalFunctionValue(expression, module) ||
    isNativeFunctionConstructor(expression, module)
  );
}

function isFunctionObjectExpression(expression: CanonicalExpression, module?: ModuleInfo): boolean {
  expression = sequenceValue(expression);

  if (expression.kind === "arrow" || expression.kind === "function-expression") return true;

  return (
    module !== undefined &&
    expression.kind === "identifier" &&
    expression.referenceId !== undefined &&
    isFunctionBinding(expression.referenceId, module)
  );
}

function unresolvedFunctionMember(
  expression: Extract<CanonicalExpression, { kind: "member" }>,
  module?: ModuleInfo,
): Reference | undefined {
  if (!isFunctionObjectExpression(expression.object, module)) return;

  if (memberNames(expression, module) !== undefined) return;

  return { name: "Reflect.get", span: expression.span };
}

function isNativeFunctionConstructor(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): boolean {
  expression = sequenceValue(expression);

  if (
    unboundIdentifier(expression) === "Function" ||
    isNativeGlobalFunctionValue(expression, module)
  )
    return true;

  if (expression.kind !== "member") return false;

  const names = memberNames(expression, module);

  if (!names || !names.includes("constructor")) return false;

  const object = expression.object;

  if (object.kind === "arrow" || object.kind === "function-expression") return true;

  if (
    module &&
    object.kind === "identifier" &&
    object.referenceId &&
    isFunctionBinding(object.referenceId, module) &&
    !hasActiveCustomPropertyOverride(
      module,
      object.referenceId,
      "constructor",
      expression.span.start,
    )
  )
    return true;

  return isIntrinsicCallableValue(object, module);
}

function isConstructorMember(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): expression is Extract<CanonicalExpression, { kind: "member" }> {
  return (
    expression.kind === "member" &&
    memberNames(expression, module)?.length === 1 &&
    memberNames(expression, module)?.[0] === "constructor"
  );
}

function mayBeConstructorMember(expression: CanonicalExpression, module?: ModuleInfo): boolean {
  if (expression.kind !== "member") return false;

  const names = memberNames(expression, module);
  return names?.includes("constructor") === true;
}

function isKnownSafeConstructorValue(value: CanonicalExpression, module: ModuleInfo): boolean {
  value = sequenceValue(value);
  return (
    isFunctionObjectExpression(value, module) ||
    (isIntrinsicCallableValue(value, module) && !isNativeFunctionConstructor(value, module))
  );
}

type KnownConstructorState = boolean | "unknown";

function knownOwnConstructorState(
  expression: CanonicalExpression,
  module: ModuleInfo,
  seen = new Set<string>(),
): KnownConstructorState {
  expression = sequenceValue(expression);

  if (expression.kind === "object") {
    let state: KnownConstructorState = false;

    for (const property of expression.properties) {
      if (property.kind === "spread") {
        const spread = knownOwnConstructorState(property.argument, module, seen);

        if (spread === "unknown") state = "unknown";
        else if (spread) state = true;

        continue;
      }

      const names = property.computed
        ? finiteStringValues(property.key as CanonicalExpression, module)
        : typeof property.key === "string"
          ? [property.key]
          : undefined;

      if (!names) {
        if (property.computed) state = "unknown";

        continue;
      }

      if (!names.includes("constructor")) continue;

      if (names.length !== 1) {
        state = "unknown";
        continue;
      }

      state = isKnownSafeConstructorValue(property.value, module) ? true : "unknown";
    }

    return state;
  }

  if (expression.kind !== "identifier" || !expression.referenceId) return "unknown";

  if (seen.has(expression.referenceId)) return "unknown";

  seen.add(expression.referenceId);

  const binding = module.bindings.get(expression.referenceId);

  if (binding?.statement.kind !== "variable" || binding.statement.declarationKind !== "const")
    return "unknown";

  const declarations = binding.declarations ?? [];

  if (declarations.length !== 1) return "unknown";

  const initializer = declarations[0]?.initializer;
  return initializer && !isCanonicalChild(initializer)
    ? knownOwnConstructorState(initializer, module, seen)
    : "unknown";
}

function isKnownOwnConstructorMember(
  expression: CanonicalExpression,
  module?: ModuleInfo,
  seen = new Set<string>(),
): boolean {
  expression = sequenceValue(expression);

  if (!module) return false;

  if (expression.kind === "object") return knownOwnConstructorState(expression, module) === true;

  if (expression.kind !== "identifier" || !expression.referenceId) return false;

  if (
    isFunctionBinding(expression.referenceId, module) &&
    hasActiveCustomPropertyOverride(
      module,
      expression.referenceId,
      "constructor",
      expression.span.start,
    )
  )
    return true;

  if (seen.has(expression.referenceId)) return false;

  seen.add(expression.referenceId);

  const binding = module.bindings.get(expression.referenceId);

  if (binding?.statement.kind !== "variable" || binding.statement.declarationKind !== "const")
    return false;

  const declarations = binding.declarations ?? [];

  if (declarations.length !== 1) return false;

  const initializer = declarations[0]?.initializer;
  const initial = knownOwnConstructorState(expression, module);
  const active =
    initializer !== null &&
    initializer !== undefined &&
    !isCanonicalChild(initializer) &&
    initial === true;
  return hasActiveCustomPropertyOverride(
    module,
    expression.referenceId,
    "constructor",
    expression.span.start,
    active,
  );
}

function isKnownOrdinaryConstructorMember(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): boolean {
  expression = sequenceValue(expression);

  if (!isConstructorMember(expression, module)) return false;

  const object = expression.object;

  if (intrinsicGlobalName(object, module) && !isIntrinsicCallableValue(object, module)) return true;

  return (
    object.kind === "member" &&
    memberNames(object, module)?.length === 1 &&
    memberNames(object, module)?.[0] === "prototype" &&
    intrinsicGlobalName(object.object, module) !== undefined &&
    !isIntrinsicCallableValue(object, module)
  );
}

function unresolvedConstructorMember(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): Reference | undefined {
  expression = sequenceValue(expression);

  if (
    !mayBeConstructorMember(expression, module) ||
    (isConstructorMember(expression, module) &&
      (isNativeFunctionConstructor(expression, module) ||
        isKnownOwnConstructorMember(expression.object, module) ||
        isKnownOrdinaryConstructorMember(expression, module)))
  )
    return;

  return { name: "Function", span: expression.span };
}

function unknownFunctionMetadataConstructor(
  expression: CanonicalExpression,
  module?: ModuleInfo,
): Extract<CanonicalExpression, { kind: "member" }> | undefined {
  if (expression.kind !== "member") return;

  const names = memberNames(expression, module);
  const constructor = sequenceValue(expression.object);

  if (
    names !== undefined &&
    names.every((name) => name === "name" || name === "length") &&
    isConstructorMember(constructor, module) &&
    !isNativeFunctionConstructor(constructor, module) &&
    !isKnownOwnConstructorMember(constructor.object, module) &&
    !isKnownOrdinaryConstructorMember(constructor, module)
  )
    return constructor;
}

function isFunctionBinding(
  bindingId: string,
  module: ModuleInfo,
  seen = new Set<string>(),
): boolean {
  if (seen.has(bindingId)) return false;

  seen.add(bindingId);

  const binding = module.bindings.get(bindingId);

  if (!binding) return false;

  if (binding.statement.kind === "function" || binding.statement.kind === "class") return true;

  if (binding.statement.kind !== "variable") return false;

  const declarations = binding.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (declaration.initializer === null || isCanonicalChild(declaration.initializer))
        return false;

      const initializer = sequenceValue(declaration.initializer);
      return (
        initializer.kind === "arrow" ||
        initializer.kind === "function-expression" ||
        (initializer.kind === "identifier" &&
          initializer.referenceId !== undefined &&
          isFunctionBinding(initializer.referenceId, module, new Set(seen)))
      );
    })
  );
}

function hasActiveCustomPropertyOverride(
  module: ModuleInfo,
  bindingId: string,
  property: string,
  accessStart: number,
  initiallyActive = false,
): boolean {
  const path = containingBlockPath(module.ir.body, accessStart);
  let active = initiallyActive;

  for (const body of path) {
    for (const statement of body) {
      if (statement.span.start >= accessStart) break;

      for (const mutation of statementPropertyMutations(statement, bindingId, property, module)) {
        if (mutation.span.end > accessStart) continue;

        active = mutation.kind === "set" && mutation.safe === true;
      }
    }
  }

  return active;
}

function containingBlockPath(
  body: readonly CanonicalStatement[],
  accessStart: number,
): readonly (readonly CanonicalStatement[])[] {
  return findContainingBlockPath(body, accessStart, [body]) ?? [body];
}

function findContainingBlockPath(
  body: readonly CanonicalStatement[],
  accessStart: number,
  path: readonly (readonly CanonicalStatement[])[],
): readonly (readonly CanonicalStatement[])[] | undefined {
  for (const statement of body) {
    if (!containsOffset(statement.span, accessStart)) continue;

    const nested = findContainingStatementPath(statement, accessStart, path);
    return nested ?? path;
  }
}

function findContainingStatementPath(
  statement: CanonicalStatement,
  accessStart: number,
  path: readonly (readonly CanonicalStatement[])[],
): readonly (readonly CanonicalStatement[])[] | undefined {
  if (statement.kind === "function")
    return containsOffset(statement.body.span, accessStart)
      ? findContainingBlockPath(statement.body.body, accessStart, [...path, statement.body.body])
      : undefined;

  if (statement.kind === "block")
    return findContainingBlockPath(statement.body, accessStart, [...path, statement.body]);

  if (statement.kind === "export")
    return findContainingStatementPath(statement.declaration, accessStart, path);

  if (statement.kind === "if") {
    return (
      findContainingExpressionPath(statement.test, accessStart, path) ??
      findContainingStatementPath(statement.consequent, accessStart, path) ??
      (statement.alternate !== null
        ? findContainingStatementPath(statement.alternate, accessStart, path)
        : undefined)
    );
  }

  if (statement.kind === "switch") {
    for (const branch of statement.cases) {
      const nested =
        (branch.test !== null
          ? findContainingExpressionPath(branch.test, accessStart, path)
          : undefined) ??
        findContainingBlockPath(branch.consequent, accessStart, [...path, branch.consequent]);

      if (nested) return nested;
    }

    return;
  }

  if (statement.kind === "try") {
    const nested = findContainingBlockPath(statement.body.body, accessStart, [
      ...path,
      statement.body.body,
    ]);

    if (nested) return nested;

    if (statement.handler) {
      const handler = findContainingBlockPath(statement.handler.body.body, accessStart, [
        ...path,
        statement.handler.body.body,
      ]);

      if (handler) return handler;
    }

    if (statement.finalizer)
      return findContainingBlockPath(statement.finalizer.body, accessStart, [
        ...path,
        statement.finalizer.body,
      ]);

    return;
  }

  if (statement.kind === "for") {
    const nestedInit =
      statement.init !== null && statement.init.kind === "variable"
        ? findContainingStatementPath(statement.init, accessStart, path)
        : statement.init !== null
          ? findContainingExpressionPath(statement.init, accessStart, path)
          : undefined;
    return (
      nestedInit ??
      (statement.test !== null
        ? findContainingExpressionPath(statement.test, accessStart, path)
        : undefined) ??
      (statement.update !== null
        ? findContainingExpressionPath(statement.update, accessStart, path)
        : undefined) ??
      findContainingStatementPath(statement.body, accessStart, path)
    );
  }

  if (statement.kind === "for-of" || statement.kind === "for-in")
    return (
      findContainingExpressionPath(statement.right, accessStart, path) ??
      (statement.left.kind === "assignment"
        ? findContainingExpressionPath(statement.left.target, accessStart, path)
        : undefined) ??
      findContainingStatementPath(statement.body, accessStart, path)
    );

  if (statement.kind === "while")
    return (
      findContainingExpressionPath(statement.test, accessStart, path) ??
      findContainingStatementPath(statement.body, accessStart, path)
    );

  if (statement.kind === "do-while")
    return (
      findContainingStatementPath(statement.body, accessStart, path) ??
      findContainingExpressionPath(statement.test, accessStart, path)
    );

  if (statement.kind === "labeled")
    return findContainingStatementPath(statement.body, accessStart, path);

  if (statement.kind === "return" || statement.kind === "throw")
    return statement.argument !== null && !isCanonicalChild(statement.argument)
      ? findContainingExpressionPath(statement.argument, accessStart, path)
      : undefined;

  if (statement.kind === "expression")
    return findContainingExpressionPath(statement.expression, accessStart, path);

  if (statement.kind === "variable")
    for (const declaration of statement.declarations)
      if (declaration.initializer && !isCanonicalChild(declaration.initializer)) {
        const nested = findContainingExpressionPath(declaration.initializer, accessStart, path);

        if (nested) return nested;
      }
}

function findContainingExpressionPath(
  expression: CanonicalExpression,
  accessStart: number,
  path: readonly (readonly CanonicalStatement[])[],
): readonly (readonly CanonicalStatement[])[] | undefined {
  if (!containsOffset(expression.span, accessStart)) return;

  if (expression.kind === "arrow" || expression.kind === "function-expression") {
    if (expression.body.kind === "block" && containsOffset(expression.body.span, accessStart))
      return findContainingBlockPath(expression.body.body, accessStart, [
        ...path,
        expression.body.body,
      ]);

    return;
  }

  for (const child of expressionChildren(expression)) {
    const nested = findContainingExpressionPath(child, accessStart, path);

    if (nested) return nested;
  }
}

function containsOffset(span: SourceSpan, offset: number): boolean {
  return span.start <= offset && offset < span.end;
}

function statementPropertyMutations(
  statement: CanonicalStatement,
  bindingId: string,
  property: string,
  module: ModuleInfo,
): readonly PropertyMutation[] {
  if (statement.kind === "export")
    return statementPropertyMutations(statement.declaration, bindingId, property, module);

  if (statement.kind === "expression") {
    return expressionPropertyMutations(statement.expression, bindingId, property, module);
  }

  if (statement.kind === "variable") {
    return statement.declarations.flatMap((declaration) => {
      const initializer = declaration.initializer;
      return initializer !== null && !isCanonicalChild(initializer)
        ? expressionPropertyMutations(initializer, bindingId, property, module)
        : [];
    });
  }

  if (statement.kind === "if") {
    return statementMayMutateProperty(statement.consequent, bindingId, property, module) ||
      (statement.alternate !== null &&
        statementMayMutateProperty(statement.alternate, bindingId, property, module))
      ? [{ kind: "unknown", span: statement.span }]
      : [];
  }

  if (
    statement.kind === "for" ||
    statement.kind === "for-of" ||
    statement.kind === "for-in" ||
    statement.kind === "while" ||
    statement.kind === "do-while" ||
    statement.kind === "switch" ||
    statement.kind === "try"
  )
    return statementMayMutateProperty(statement, bindingId, property, module)
      ? [{ kind: "unknown", span: statement.span }]
      : [];

  if (statement.kind === "block") {
    return statement.body.flatMap((child) =>
      statementPropertyMutations(child, bindingId, property, module),
    );
  }

  return [];
}

type PropertyMutation = {
  readonly kind: "set" | "delete" | "unknown";
  readonly safe?: boolean;
  readonly span: SourceSpan;
};

function expressionPropertyMutations(
  expression: CanonicalExpression,
  bindingId: string,
  property: string,
  module: ModuleInfo,
): readonly PropertyMutation[] {
  if (expression.kind === "assignment") {
    const left = expression.left;
    const target =
      left.kind === "member" &&
      left.object.kind === "identifier" &&
      left.object.referenceId === bindingId
        ? propertyMutationTarget(left, property, module)
        : "other";

    if (expression.operator === "=" && target === "match")
      return [
        {
          kind: "set",
          safe: isKnownSafeConstructorValue(expression.right, module),
          span: expression.span,
        },
      ];

    return expressionMayMutateProperty(expression, bindingId, property, module)
      ? [{ kind: "unknown", span: expression.span }]
      : [];
  }

  if (
    expression.kind === "unary" &&
    expression.operator === "delete" &&
    expression.argument.kind === "member" &&
    expression.argument.object.kind === "identifier" &&
    expression.argument.object.referenceId === bindingId
  )
    return propertyMutationTarget(expression.argument, property, module) === "match"
      ? [{ kind: "delete", span: expression.span }]
      : propertyMutationTarget(expression.argument, property, module) === "unknown"
        ? [{ kind: "unknown", span: expression.span }]
        : [];

  return expressionMayMutateProperty(expression, bindingId, property, module)
    ? [{ kind: "unknown", span: expression.span }]
    : [];
}

type PropertyMutationTarget = "match" | "other" | "unknown";

function propertyMutationTarget(
  expression: Extract<CanonicalExpression, { kind: "member" }>,
  property: string,
  module: ModuleInfo,
): PropertyMutationTarget {
  const names = memberNames(expression, module);

  if (!names) return "unknown";

  if (!names.includes(property)) return "other";

  return names.length === 1 ? "match" : "unknown";
}

function statementMayMutateProperty(
  statement: CanonicalStatement,
  bindingId: string,
  property: string,
  module: ModuleInfo,
): boolean {
  if (statement.kind === "export")
    return statementMayMutateProperty(statement.declaration, bindingId, property, module);

  if (statement.kind === "expression")
    return expressionMayMutateProperty(statement.expression, bindingId, property, module);

  if (statement.kind === "variable")
    return statement.declarations.some(
      (declaration) =>
        declaration.initializer !== null &&
        !isCanonicalChild(declaration.initializer) &&
        expressionMayMutateProperty(declaration.initializer, bindingId, property, module),
    );

  if (statement.kind === "if")
    return (
      expressionMayMutateProperty(statement.test, bindingId, property, module) ||
      statementMayMutateProperty(statement.consequent, bindingId, property, module) ||
      (statement.alternate !== null &&
        statementMayMutateProperty(statement.alternate, bindingId, property, module))
    );

  if (statement.kind === "block")
    return statement.body.some((child) =>
      statementMayMutateProperty(child, bindingId, property, module),
    );

  if (statement.kind === "switch")
    return (
      expressionMayMutateProperty(statement.discriminant, bindingId, property, module) ||
      statement.cases.some(
        (entry) =>
          (entry.test !== null &&
            expressionMayMutateProperty(entry.test, bindingId, property, module)) ||
          entry.consequent.some((child) =>
            statementMayMutateProperty(child, bindingId, property, module),
          ),
      )
    );

  if (statement.kind === "for")
    return (
      (statement.init !== null &&
        ("kind" in statement.init && statement.init.kind === "variable"
          ? statementMayMutateProperty(statement.init, bindingId, property, module)
          : expressionMayMutateProperty(statement.init, bindingId, property, module))) ||
      (statement.test !== null &&
        expressionMayMutateProperty(statement.test, bindingId, property, module)) ||
      (statement.update !== null &&
        expressionMayMutateProperty(statement.update, bindingId, property, module)) ||
      statementMayMutateProperty(statement.body, bindingId, property, module)
    );

  if (statement.kind === "for-of" || statement.kind === "for-in")
    return (
      expressionMayMutateProperty(statement.right, bindingId, property, module) ||
      (statement.left.kind === "assignment" &&
        expressionMayMutateProperty(statement.left.target, bindingId, property, module)) ||
      statementMayMutateProperty(statement.body, bindingId, property, module)
    );

  if (statement.kind === "while")
    return (
      expressionMayMutateProperty(statement.test, bindingId, property, module) ||
      statementMayMutateProperty(statement.body, bindingId, property, module)
    );

  if (statement.kind === "do-while")
    return (
      statementMayMutateProperty(statement.body, bindingId, property, module) ||
      expressionMayMutateProperty(statement.test, bindingId, property, module)
    );

  if (statement.kind === "labeled")
    return statementMayMutateProperty(statement.body, bindingId, property, module);

  if (statement.kind === "return" || statement.kind === "throw")
    return (
      statement.argument !== null &&
      !isCanonicalChild(statement.argument) &&
      expressionMayMutateProperty(statement.argument, bindingId, property, module)
    );

  if (statement.kind === "try")
    return (
      statement.body.body.some((child) =>
        statementMayMutateProperty(child, bindingId, property, module),
      ) ||
      (statement.handler !== null &&
        statement.handler.body.body.some((child) =>
          statementMayMutateProperty(child, bindingId, property, module),
        )) ||
      (statement.finalizer !== null &&
        statement.finalizer.body.some((child) =>
          statementMayMutateProperty(child, bindingId, property, module),
        ))
    );

  if (statement.kind === "function" || statement.kind === "class") return false;

  return false;
}

function expressionMayMutateProperty(
  expression: CanonicalExpression,
  bindingId: string,
  property: string,
  module: ModuleInfo,
): boolean {
  if (expression.kind === "assignment") {
    const left = expression.left;

    if (
      left.kind === "member" &&
      left.object.kind === "identifier" &&
      left.object.referenceId === bindingId &&
      propertyMutationTarget(left, property, module) !== "other"
    )
      return true;
  }

  if (
    expression.kind === "unary" &&
    expression.operator === "delete" &&
    expression.argument.kind === "member" &&
    expression.argument.object.kind === "identifier" &&
    expression.argument.object.referenceId === bindingId &&
    propertyMutationTarget(expression.argument, property, module) !== "other"
  )
    return true;

  if (expression.kind === "arrow" || expression.kind === "function-expression") return false;

  return expressionChildren(expression).some((child) =>
    expressionMayMutateProperty(child, bindingId, property, module),
  );
}

function expressionChildren(expression: CanonicalExpression): readonly CanonicalExpression[] {
  switch (expression.kind) {
    case "member":
      return expression.computed ? [expression.object, expression.property] : [expression.object];
    case "call":
    case "new":
      return [
        expression.callee,
        ...expression.arguments.flatMap((item) =>
          item.kind === "spread" ? [item.argument] : [item],
        ),
      ];
    case "import-expression":
      return expression.options ? [expression.source, expression.options] : [expression.source];
    case "await":
      return [expression.expression];
    case "yield":
      return expression.expression ? [expression.expression] : [];
    case "unary":
      return [expression.argument];
    case "binary":
    case "assignment":
      return [expression.left, expression.right];
    case "conditional":
      return [expression.test, expression.consequent, expression.alternate];
    case "template":
      return expression.expressions;
    case "sequence":
      return expression.expressions;
    case "object":
      return expression.properties.flatMap((property) =>
        property.kind === "spread"
          ? [property.argument]
          : [
              ...(property.computed && typeof property.key !== "string" ? [property.key] : []),
              property.value,
            ],
      );
    case "array":
      return expression.elements.flatMap((item) =>
        item ? [item.kind === "spread" ? item.argument : item] : [],
      );
    default:
      return [];
  }
}

function isGlobalObjectExpression(
  expression: CanonicalExpression,
  module: ModuleInfo | undefined,
  seen = new Set<string>(),
): boolean {
  expression = sequenceValue(expression);
  const name = unboundIdentifier(expression);

  if (name === "globalThis" || name === "window" || name === "self") return true;

  if (expression.kind !== "identifier" || !module || !expression.referenceId) return false;

  if (seen.has(expression.referenceId)) return false;

  seen.add(expression.referenceId);

  const binding = module.bindings.get(expression.referenceId);

  if (binding?.statement.kind !== "variable" || binding.statement.declarationKind !== "const")
    return false;

  const declarations = binding.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        declaration.initializer !== null &&
        !isCanonicalChild(declaration.initializer) &&
        isGlobalObjectExpression(declaration.initializer, module, new Set(seen)),
    )
  );
}

function intrinsicCallableMember(
  expression: CanonicalExpression,
  module?: ModuleInfo,
  seen = new Set<string>(),
): { readonly namespace: string; readonly name: string } | undefined {
  expression = sequenceValue(expression);

  if (expression.kind === "member") {
    const namespace = intrinsicGlobalName(expression.object, module);
    const names = memberNames(expression, module);

    if (
      namespace !== undefined &&
      names?.length === 1 &&
      INTRINSIC_CALLABLE_MEMBERS.get(namespace)?.has(names[0]!)
    )
      return { namespace, name: names[0]! };

    return;
  }

  if (expression.kind !== "identifier" || !module || !expression.referenceId) return;

  if (seen.has(expression.referenceId)) return;

  seen.add(expression.referenceId);

  const binding = module.bindings.get(expression.referenceId);

  if (binding?.statement.kind !== "variable" || binding.statement.declarationKind !== "const")
    return;

  const declarations = binding.declarations ?? [];

  if (declarations.length !== 1) return;

  const initializer = declarations[0]?.initializer;
  return initializer && !isCanonicalChild(initializer)
    ? intrinsicCallableMember(initializer, module, seen)
    : undefined;
}

function reflectedNativeExecution(
  expression: Extract<CanonicalExpression, { kind: "call" }>,
  module?: ModuleInfo,
): Reference | undefined {
  const callable = intrinsicCallableMember(expression.callee, module);
  const readsGlobalProperty = callable?.namespace === "Reflect" && callable.name === "get";
  const readsGlobalDescriptor =
    (callable?.namespace === "Object" || callable?.namespace === "Reflect") &&
    callable.name === "getOwnPropertyDescriptor";

  if ((!readsGlobalProperty && !readsGlobalDescriptor) || expression.arguments.length < 2) return;

  const object = expression.arguments[0];
  const property = expression.arguments[1];

  if (!object || !property || object.kind === "spread" || property.kind === "spread") return;

  if (!isGlobalObjectExpression(object, module)) return;

  const name = constantString(property, module);

  if (
    name === "eval" ||
    name === "Function" ||
    name === "process" ||
    name === "Bun" ||
    name === "Deno"
  )
    return { name, span: expression.span };

  return readsGlobalProperty ? { name: "Reflect.get", span: expression.span } : undefined;
}

function constantString(
  expression: CanonicalExpression,
  module: ModuleInfo | undefined,
): string | undefined {
  const values = finiteStringValues(expression, module);
  return values?.length === 1 ? values[0] : undefined;
}

function finiteStringValues(
  expression: CanonicalExpression,
  module: ModuleInfo | undefined,
): readonly string[] | undefined {
  return module ? enumerateFiniteStrings(sequenceValue(expression), module.constants) : undefined;
}

function sequenceValue(expression: CanonicalExpression): CanonicalExpression {
  while (expression.kind === "sequence") {
    const value = expression.expressions.at(-1);

    if (!value) return expression;

    expression = value;
  }

  return expression;
}

function collectBlock(
  block: CanonicalStatementBlock,
  references: Reference[],
  module?: ModuleInfo,
): void {
  for (const statement of block.body) collectStatementReferences(statement, references, module);
}

interface ClassContents {
  readonly superClass: CanonicalExpression | null;
  readonly elements: readonly CanonicalClassElement[];
}

function collectClassReferences(
  value: ClassContents,
  references: Reference[],
  module?: ModuleInfo,
): void {
  if (value.superClass) collectExpression(value.superClass, references, module);

  for (const element of value.elements) {
    if (element.kind === "static-block") {
      collectBlock(element.body, references, module);

      continue;
    }

    if (element.computed && typeof element.key === "object")
      collectExpression(element.key, references, module);

    if (element.kind === "field") {
      if (element.initializer) collectExpression(element.initializer, references, module);
    } else {
      for (const parameter of element.parameters)
        visitPatternDefaults(parameter, (expression) =>
          collectExpression(expression, references, module),
        );

      collectBlock(element.body, references, module);
    }
  }
}

function collectClassEvaluation(
  value: ClassContents,
  visit: (reference: Reference) => void,
  module?: ModuleInfo,
): void {
  if (value.superClass) collectEvaluationExpression(value.superClass, visit, module);

  for (const element of value.elements) {
    if (element.kind === "static-block") {
      collectStatementEvaluation(element.body, visit, module);

      continue;
    }

    if (element.computed && typeof element.key === "object")
      collectEvaluationExpression(element.key, visit, module);

    if (element.kind === "field" && element.static && element.initializer)
      collectEvaluationExpression(element.initializer, visit, module);
  }
}

function collectChild(child: CanonicalChild, references: Reference[], module?: ModuleInfo): void {
  switch (child.kind) {
    case "element":
      for (const attribute of child.attributes)
        if (attribute.kind !== "static")
          collectExpression(attribute.expression, references, module);

      for (const item of child.children) collectChild(item, references, module);

      return;
    case "fragment":
      for (const item of child.children) collectChild(item, references, module);

      return;
    case "text":
      return;
    case "dynamic-child":
      collectExpression(child.expression, references, module);

      return;
    case "component":
    case "await-child":
      collectExpression(child.reference, references, module);

      for (const prop of child.props) {
        if (prop.kind === "value") collectExpression(prop.expression, references, module);
        else if (prop.kind === "children")
          for (const item of prop.children) collectChild(item, references);
        else collectChild(prop.child, references);
      }

      return;
    case "raw-html":
      if (child.host) collectChild(child.host, references);

      collectExpression(child.html, references, module);

      return;
    case "conditional":
      collectExpression(child.test, references, module);

      if (child.consequent) collectChild(child.consequent, references);

      if (child.alternate) collectChild(child.alternate, references);

      return;
    case "list":
      collectExpression(child.collection, references, module);

      visitPatternDefaults(child.parameter, (expression) =>
        collectExpression(expression, references, module),
      );

      collectExpression(child.key, references, module);

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

  return [
    ...pattern.properties.flatMap((item) => patternBindingIds(item.value)),
    ...(pattern.rest ? patternBindingIds(pattern.rest) : []),
  ];
}

function visitPatternDefaults(
  pattern: CanonicalPattern,
  visit: (expression: CanonicalExpression) => void,
): void {
  if (pattern.kind === "identifier") return;

  if (pattern.kind === "rest") return visitPatternDefaults(pattern.argument, visit);

  if (pattern.kind === "default") {
    visit(pattern.right);

    visitPatternDefaults(pattern.left, visit);
  } else if (pattern.kind === "array") {
    for (const element of pattern.elements) if (element) visitPatternDefaults(element, visit);
  } else {
    for (const property of pattern.properties) visitPatternDefaults(property.value, visit);

    if (pattern.rest) visitPatternDefaults(pattern.rest, visit);
  }
}

function isBrowserEntry(filename: string, root: string): boolean {
  const absolute = key(resolvePath(root, filename));

  if (absolute === key(join(root, "app.tsx")) || absolute === key(join(root, "app.config.ts")))
    return true;

  const routeRoot = `${key(resolvePath(root, "src/routes"))}/`;

  if (!absolute.startsWith(routeRoot)) return false;

  return BROWSER_ROUTE_FILES.has(absolute.slice(absolute.lastIndexOf("/") + 1).toLowerCase());
}

function authoredSpan(module: ModuleInfo, span: SourceSpan): SourceSpan {
  if (!module.mapOffset) return span;

  const start = module.mapOffset(span.start);

  if (span.end <= span.start) return { start, end: start };

  const end = module.mapOffset(span.end);
  const previous = module.mapOffset(span.end - 1);
  return { start, end: end > previous ? end : previous + 1 };
}

function displayFile(filename: string): string {
  return filename.replaceAll("\\", "/");
}
