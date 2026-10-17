import { parseSync } from "oxc-parser";
import { transformSync } from "oxc-transform";
import remapping from "@jridgewell/remapping";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { canonicalize } from "./canonical.ts";
import {
  validateComponentBindingReads,
  validateComponentAsyncIteration,
  validateStructuralAssignments,
} from "./body-validation.ts";
import {
  canonicalDebugSidecar,
  encodeCanonicalModule,
  type CanonicalDebugSidecar,
  type CanonicalModule,
  type CompilerDiagnostic,
  type SourceSpan,
} from "./ir.ts";
import { generateModule, type ClientBinding } from "./generate.ts";
import type { ComponentPropsAnalysis } from "./props-analysis.ts";
import type { OperationCallAnalysis } from "./operation-call-analysis.ts";
import { resolveModuleSemantics, type ModuleSemantics } from "./semantics.ts";
import { lfLineStarts as lineStarts } from "./utils.ts";

interface SourceMap {
  readonly version: 3;
  readonly sources: string[];
  readonly names: string[];
  readonly mappings: string;
  readonly sourcesContent?: (string | null)[];
}

/** Options controlling one immutable compiler snapshot. */
export interface CompileOptions {
  /** Stable source name used in diagnostics and source maps. */
  readonly filename?: string;
  /** Runtime module imported by generated browser code. */
  readonly runtimeModule?: string;
  /** Oxc target used for the final browser syntax lowering. */
  readonly target?: string;
  /** Permit the explicit unsafeHTML escape hatch in authored modules. */
  readonly allowUnsafeHTML?: boolean;
  /** Associate the project's embedded-document permission with compiled definitions. */
  readonly allowUnsafeEmbed?: boolean;
  /** Permit the validated whole-document root shell in this module. */
  readonly documentShell?: boolean;
  /** Enable finite dynamic-import lowering for browser bundlers. */
  readonly browserTarget?: boolean;
  /** @internal Shared private CSS plan module imported only by generated browser components. */
  readonly styleRuntimeModule?: string;
  /** @internal Stable module entry ID in the private CSS plan. */
  readonly styleEntryId?: string;
  /** @internal Only entries with nonempty static CSS closures need an inactive preload. */
  readonly stylePreloadEntry?: boolean;
  /** @internal Stable project-relative path used only for private CSS owner IDs. */
  readonly styleIdentity?: string;
}

/** Result of compiling one module, including canonical meaning and debug metadata. */
export interface CompileResult {
  /** Executable JavaScript, or an empty string when parsing or lowering reports an error. */
  readonly code: string;
  /** Composed source map back to authored source when the completed stages supply one. */
  readonly map: unknown;
  /**
   * Resolved canonical module with spans in normalized JavaScript coordinates.
   * Use `debug` for authored locations. Failed parsing supplies an empty module.
   */
  readonly ir: CanonicalModule;
  /** Compiler diagnostics; use the checking API separately for TypeScript diagnostics. */
  readonly diagnostics: readonly CompilerDiagnostic[];
  /** SHA-256 hex digest of canonical semantic encoding, excluding source locations. */
  readonly semanticHash: string;
  /** Collected import, declaration, export, and component names for this module. */
  readonly semantics: ModuleSemantics;
  /** @internal Generated component IDs and names used by the private CSS plan. */
  readonly styleOwners?: readonly { readonly id: string; readonly name?: string }[];
  /** Authored source spans keyed by deterministic canonical traversal IDs, not binding IDs. */
  readonly debug: CanonicalDebugSidecar;
}

/** One analyzed source snapshot, before executable generation. */
export interface ModuleAnalysis {
  /** Validated snapshot before executable emission; `code` is initially empty. */
  readonly result: CompileResult;
  /** TypeScript-erased source and its map to authored source, when normalization succeeded. */
  readonly normalized?: { readonly code: string; readonly map?: unknown };
  /** Translate a normalized string offset to its authored offset for subsequent compiler stages. */
  readonly mapOffset?: (offset: number) => number;
  /** Native-checker prop contracts keyed by authored parameter offset. */
  readonly componentProps?: ComponentPropsAnalysis;
  /** @internal Checked operation arguments keyed by their exact authored call span. */
  readonly operationCalls?: OperationCallAnalysis;
}

/** Share compiler validation and authored diagnostics with checking and editor snapshots. */
export function analyzeModule(source: string, options: CompileOptions = {}): ModuleAnalysis {
  const filename = options.filename ?? "module.tsx";
  const diagnostics: CompilerDiagnostic[] = [];
  const normalized = transformSync(filename, source, {
    lang: filename.endsWith(".tsx") ? "tsx" : "ts",
    jsx: "preserve",
    target: "esnext",
    sourcemap: true,
  });

  diagnostics.push(...oxcDiagnostics(normalized.errors));

  if (diagnostics.some((item) => item.severity === "error"))
    return { result: failedResult(filename, diagnostics) };

  const authoredOffset = offsetMapper(normalized.code, source, normalized.map);
  const parsed = parseSync(filename, normalized.code, {
    lang: "jsx",
    astType: "js",
    range: true,
    sourceType: "module",
  });

  diagnostics.push(
    ...oxcDiagnostics(parsed.errors).map((item) => mapDiagnostic(item, authoredOffset)),
  );

  if (diagnostics.some((item) => item.severity === "error"))
    return { result: failedResult(filename, diagnostics) };

  const ir = canonicalize(parsed.program, filename, { documentShell: options.documentShell });

  diagnostics.push(...ir.diagnostics.map((item) => mapDiagnostic(item, authoredOffset)));

  diagnostics.push(
    ...validateComponentBindingReads(ir).map((item) => mapDiagnostic(item, authoredOffset)),
    ...validateStructuralAssignments(ir).map((item) => mapDiagnostic(item, authoredOffset)),
    ...validateComponentAsyncIteration(ir).map((item) => mapDiagnostic(item, authoredOffset)),
  );

  if (
    !options.allowUnsafeHTML &&
    hasUnsafeHTML(ir) &&
    !diagnostics.some((item) => item.code === "HES-RAW-DISABLED")
  )
    diagnostics.push({
      code: "HES-RAW-DISABLED",
      severity: "error",
      message: "unsafeHTML requires allowUnsafeHTML in the project configuration.",
    });

  const semanticHash = sha256(encodeCanonicalModule(ir));
  const semantics = resolveModuleSemantics(ir);
  return {
    normalized,
    mapOffset: authoredOffset,
    result: {
      code: "",
      map: normalized.map,
      ir,
      diagnostics,
      semanticHash,
      semantics,
      debug: authoredDebug(ir, authoredOffset),
    },
  };
}

/** Emit one already analyzed canonical snapshot through esrap and Oxc browser lowering. */
export function emitAnalysis(
  analysis: ModuleAnalysis,
  options: CompileOptions = {},
): CompileResult {
  const { result, normalized } = analysis;

  if (!normalized || result.diagnostics.some((item) => item.severity === "error")) return result;

  const filename = options.filename ?? "module.tsx";
  const runtimeModule = options.runtimeModule ?? "hesperia/runtime";
  const ir = attachCheckedMetadata(
    result.ir,
    analysis.componentProps,
    analysis.operationCalls,
    analysis.mapOffset,
  );
  const diagnostics = [...result.diagnostics, ...obsoleteNavigationDiagnostics(ir)];
  const clientBindings = resolveClientBindings(ir);
  const generated = generateModule(ir, {
    filename,
    runtimeModule,
    source: normalized.code,
    clientBindings,
    browserTarget: options.browserTarget,
    allowUnsafeEmbed: options.allowUnsafeEmbed,
    styleRuntimeModule: options.styleRuntimeModule,
    styleEntryId: options.styleEntryId,
    stylePreloadEntry: options.stylePreloadEntry,
    styleIdentity: options.styleIdentity,
  });
  const lowered = transformSync("generated.js", generated.code, {
    lang: "js",
    target: options.target ?? "esnext",
    sourcemap: true,
  });

  diagnostics.push(...oxcDiagnostics(lowered.errors));

  const stages = [lowered.map, generated.map, normalized.map].filter(Boolean) as SourceMap[];
  const map = stages.length ? remapping(stages, () => null) : undefined;
  return {
    ...result,
    code: diagnostics.some((item) => item.severity === "error") ? "" : lowered.code,
    map,
    ir,
    semanticHash: sha256(encodeCanonicalModule(ir)),
    styleOwners: generated.styleOwners,
    diagnostics,
  };
}

const CLIENT_OPERATIONS = new Set([
  "state",
  "derived",
  "effect",
  "cleanup",
  "bind",
  "unsafeBind",
  "task",
  "unsafeHTML",
]);

function resolveClientBindings(module: CanonicalModule): ReadonlyMap<string, ClientBinding> {
  const bindings = new Map<string, ClientBinding>();

  for (const statement of module.body) {
    if (statement.kind !== "import") continue;

    const hesperiaClient = statement.source === "hesperia/client";
    const hesperiaRoot = statement.source === "hesperia";
    const hesperiaNavigation = statement.source === "hesperia/navigation";

    if (!hesperiaClient && !hesperiaRoot) {
      for (const specifier of statement.specifiers) {
        if (!specifier.bindingId) continue;

        if (hesperiaNavigation && specifier.kind === "namespace") {
          bindings.set(specifier.bindingId, {
            bindingId: specifier.bindingId,
            local: specifier.local,
            kind: "navigation-namespace",
          });

          continue;
        }

        if (
          hesperiaNavigation &&
          specifier.kind === "named" &&
          specifier.imported === "beforeLeave"
        ) {
          bindings.set(specifier.bindingId, {
            bindingId: specifier.bindingId,
            local: specifier.local,
            kind: "navigation-marker",
          });

          continue;
        }

        bindings.set(specifier.bindingId, {
          bindingId: specifier.bindingId,
          local: specifier.local,
          kind: "import",
          mode: specifier.kind === "namespace" ? "namespace" : "direct",
        });
      }

      continue;
    }

    for (const specifier of statement.specifiers) {
      if (!specifier.bindingId) continue;

      if (specifier.kind === "namespace" || specifier.kind === "default") {
        if (hesperiaClient)
          bindings.set(specifier.bindingId, {
            bindingId: specifier.bindingId,
            local: specifier.local,
            kind: "namespace",
          });

        continue;
      }

      if (specifier.imported === "client") {
        bindings.set(specifier.bindingId, {
          bindingId: specifier.bindingId,
          local: specifier.local,
          kind: "namespace",
        });
      } else if (hesperiaClient && CLIENT_OPERATIONS.has(specifier.imported)) {
        bindings.set(specifier.bindingId, {
          bindingId: specifier.bindingId,
          local: specifier.local,
          kind: "operation",
          operation: specifier.imported,
        });
      }
    }
  }

  addNavigationAliases(module, bindings);

  return bindings;
}

function addNavigationAliases(module: CanonicalModule, bindings: Map<string, ClientBinding>): void {
  const declarations: {
    readonly bindingId: string;
    readonly local: string;
    readonly initializer: unknown;
  }[] = [];

  collectNavigationAliasDeclarations(module, declarations, new Set());

  let changed = true;

  while (changed) {
    changed = false;

    for (const declaration of declarations) {
      if (bindings.has(declaration.bindingId)) continue;

      const kind = navigationAliasKind(declaration.initializer, bindings);

      if (!kind) continue;

      bindings.set(declaration.bindingId, {
        bindingId: declaration.bindingId,
        local: declaration.local,
        kind,
      });

      changed = true;
    }
  }
}

function collectNavigationAliasDeclarations(
  value: unknown,
  declarations: {
    readonly bindingId: string;
    readonly local: string;
    readonly initializer: unknown;
  }[],
  visited: Set<object>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNavigationAliasDeclarations(item, declarations, visited);

    return;
  }

  if (typeof value !== "object" || value === null || visited.has(value)) return;

  visited.add(value);

  const record = value as Record<string, unknown>;

  if (record.kind === "variable" && record.declarationKind === "const") {
    const items = record.declarations;

    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;

        const declaration = item as Record<string, unknown>;
        const pattern = declaration.pattern;

        if (typeof pattern !== "object" || pattern === null) continue;

        const identifier = pattern as Record<string, unknown>;

        if (
          identifier.kind === "identifier" &&
          typeof identifier.bindingId === "string" &&
          typeof identifier.name === "string"
        )
          declarations.push({
            bindingId: identifier.bindingId,
            local: identifier.name,
            initializer: declaration.initializer,
          });
      }
    }
  }

  for (const item of Object.values(record))
    collectNavigationAliasDeclarations(item, declarations, visited);
}

function navigationAliasKind(
  value: unknown,
  bindings: ReadonlyMap<string, ClientBinding>,
): "navigation-marker" | "navigation-namespace" | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const expression = value as Record<string, unknown>;

  if (expression.kind === "identifier" && typeof expression.referenceId === "string") {
    const binding = bindings.get(expression.referenceId);
    return binding?.kind === "navigation-marker" || binding?.kind === "navigation-namespace"
      ? binding.kind
      : undefined;
  }

  if (expression.kind !== "member" || expression.computed === true) return undefined;

  const property = expression.property;
  const object = expression.object;

  if (
    typeof property !== "object" ||
    property === null ||
    (property as Record<string, unknown>).kind !== "identifier" ||
    (property as Record<string, unknown>).name !== "beforeLeave" ||
    typeof object !== "object" ||
    object === null
  )
    return undefined;

  const namespace = object as Record<string, unknown>;

  if (namespace.kind !== "identifier" || typeof namespace.referenceId !== "string")
    return undefined;

  return bindings.get(namespace.referenceId)?.kind === "navigation-namespace"
    ? "navigation-marker"
    : undefined;
}

function obsoleteNavigationDiagnostics(module: CanonicalModule): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const clientBindings = new Set<string>();

  for (const statement of module.body) {
    if (statement.kind !== "import") continue;

    if (statement.source === "hesperia/client") {
      for (const specifier of statement.specifiers)
        if ((specifier.kind === "default" || specifier.kind === "namespace") && specifier.bindingId)
          clientBindings.add(specifier.bindingId);
    } else if (statement.source === "hesperia") {
      for (const specifier of statement.specifiers)
        if (specifier.kind === "named" && specifier.imported === "client" && specifier.bindingId)
          clientBindings.add(specifier.bindingId);
    } else if (statement.source === "hesperia/routing") {
      for (const specifier of statement.specifiers)
        if (specifier.kind === "named" && specifier.imported === "beforeLeave")
          diagnostics.push({
            code: "HES-NAVIGATION-IMPORT",
            severity: "error",
            message:
              'Import beforeLeave from "hesperia/navigation"; "hesperia/routing" is for route declarations and types.',
            span: statement.span,
          });
    }
  }

  if (!clientBindings.size) return diagnostics;

  const visit = (value: unknown, visited: Set<object>): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, visited);

      return;
    }

    if (typeof value !== "object" || value === null || visited.has(value)) return;

    visited.add(value);

    const expression = value as Record<string, unknown>;

    if (
      expression.kind === "call" &&
      isLegacyClientNavigationCall(
        value as Parameters<typeof isLegacyClientNavigationCall>[0],
        clientBindings,
      )
    )
      diagnostics.push({
        code: "HES-NAVIGATION-CLIENT-MEMBER",
        severity: "error",
        message:
          'Use beforeLeave from "hesperia/navigation"; client.navigation.beforeLeave is no longer an authored API.',
        span: (expression.span as SourceSpan | undefined) ?? { start: 0, end: 0 },
      });

    for (const item of Object.values(expression)) visit(item, visited);
  };

  visit(module, new Set());

  return diagnostics;
}

function isLegacyClientNavigationCall(
  expression: {
    readonly kind: string;
    readonly callee?: unknown;
  },
  clientBindings: ReadonlySet<string>,
): boolean {
  const callee = expression.callee;

  if (typeof callee !== "object" || callee === null) return false;

  const beforeLeave = callee as Record<string, unknown>;

  if (beforeLeave.kind !== "member" || beforeLeave.computed === true) return false;

  const beforeLeaveProperty = beforeLeave.property;
  const navigation = beforeLeave.object;

  if (
    typeof beforeLeaveProperty !== "object" ||
    beforeLeaveProperty === null ||
    (beforeLeaveProperty as Record<string, unknown>).kind !== "identifier" ||
    (beforeLeaveProperty as Record<string, unknown>).name !== "beforeLeave" ||
    typeof navigation !== "object" ||
    navigation === null
  )
    return false;

  const navigationMember = navigation as Record<string, unknown>;

  if (navigationMember.kind !== "member" || navigationMember.computed === true) return false;

  const navigationProperty = navigationMember.property;
  const client = navigationMember.object;
  return (
    typeof navigationProperty === "object" &&
    navigationProperty !== null &&
    (navigationProperty as Record<string, unknown>).kind === "identifier" &&
    (navigationProperty as Record<string, unknown>).name === "navigation" &&
    typeof client === "object" &&
    client !== null &&
    (client as Record<string, unknown>).kind === "identifier" &&
    typeof (client as Record<string, unknown>).referenceId === "string" &&
    clientBindings.has((client as Record<string, unknown>).referenceId as string)
  );
}

function authoredDebug(
  ir: CanonicalModule,
  mapOffset: (offset: number) => number,
): CanonicalDebugSidecar {
  const debug = canonicalDebugSidecar(ir);
  return {
    ...debug,
    spans: Object.fromEntries(
      Object.entries(debug.spans).map(([id, span]) => [id, mapAuthoredSpan(span, mapOffset)]),
    ),
  };
}

function mapDiagnostic(
  diagnostic: CompilerDiagnostic,
  mapOffset: (offset: number) => number,
): CompilerDiagnostic {
  return diagnostic.span
    ? {
        ...diagnostic,
        span: mapAuthoredSpan(diagnostic.span, mapOffset),
      }
    : diagnostic;
}

function mapAuthoredSpan(span: SourceSpan, mapOffset: (offset: number) => number): SourceSpan {
  const start = mapOffset(span.start);
  const end = mapOffset(span.end);

  if (span.end <= span.start) return { start, end };

  const previous = mapOffset(span.end - 1);
  return { start, end: end > previous ? end : previous + 1 };
}

function offsetMapper(generated: string, source: string, map: unknown): (offset: number) => number {
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

function failedResult(filename: string, diagnostics: readonly CompilerDiagnostic[]): CompileResult {
  const ir: CanonicalModule = { version: 1, filename, body: [], diagnostics };
  return {
    code: "",
    map: undefined,
    ir,
    diagnostics,
    semanticHash: sha256(encodeCanonicalModule(ir)),
    semantics: resolveModuleSemantics(ir),
    debug: canonicalDebugSidecar(ir),
  };
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

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");

  hasher.update(value);

  return `sha256-${hasher.digest("hex")}`;
}

function attachCheckedMetadata(
  module: CanonicalModule,
  analysis: ComponentPropsAnalysis | undefined,
  operationCalls: OperationCallAnalysis | undefined,
  normalizedToAuthored: ((offset: number) => number) | undefined,
): CanonicalModule {
  if (!analysis && !operationCalls) return module;

  const map = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(map);

    if (typeof value !== "object" || value === null) return value;

    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(source)) copy[key] = map(child);

    if (
      (source.kind === "function" ||
        source.kind === "arrow" ||
        source.kind === "function-expression") &&
      Array.isArray(source.parameters)
    ) {
      const parameter = source.parameters[0] as { span?: { start: number } } | undefined;
      const authored = parameter?.span
        ? (normalizedToAuthored?.(parameter.span.start) ?? parameter.span.start)
        : undefined;
      const metadata =
        authored === undefined ? undefined : analysis?.byParameterStart[String(authored)];

      if (metadata) copy.props = metadata.props;
    }

    if (
      source.kind === "call" &&
      Array.isArray(source.arguments) &&
      source.arguments.length === 1
    ) {
      const span = source.span as SourceSpan;
      const start = normalizedToAuthored?.(span.start) ?? span.start;
      const end =
        normalizedToAuthored?.(span.end - 1) === undefined
          ? span.end
          : normalizedToAuthored(span.end - 1) + 1;
      const metadata = operationCalls?.bySpan[`${start}:${end}`];

      if (metadata) {
        const empty = { kind: "undefined", span: { start: span.start, end: span.start } };
        const args = copy.arguments as readonly unknown[];
        copy.arguments = metadata.argument === "options" ? [empty, ...args] : [...args, empty];
      }
    }

    return copy;
  };

  return map(module) as CanonicalModule;
}

function hasUnsafeHTML(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeHTML);

  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  if (item.kind === "raw-html") return true;

  return Object.entries(item).some(
    ([key, child]) => key !== "span" && key !== "diagnostics" && hasUnsafeHTML(child),
  );
}
