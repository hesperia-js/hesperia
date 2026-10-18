import { dirname, resolve as resolvePath } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import remapping, { type SourceMapInput } from "@jridgewell/remapping";
import { SymbolFlags, type Symbol } from "typescript/unstable/async";
import {
  NodeFlags,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import type {
  PluginProjectInput,
  PluginProjectResult,
  PluginDiagnostic,
  PluginSourceMap,
} from "@hesperia/tooling/project-service";
import {
  ModuleResolver,
  analyzeBrowserCapabilities,
  emitRouteGuardArtifact,
  extractBindingClosure,
} from "@hesperia/compiler/tooling";
import { isNonNullObject } from "./utils.ts";
import { typeNodeReferencesValue } from "./app-analysis.ts";
import { appEffectsModuleId } from "./effect-facts.ts";
import type { ConfiguredAppBinding } from "./app-analysis.ts";
import type { AppRouteFact } from "./route-facts.ts";

interface CallNode extends Node {
  readonly expression: Node;
  readonly arguments: readonly Node[];
  readonly typeArguments?: readonly Node[];
}

interface PropertyNode extends Node {
  readonly name: Node;
  readonly initializer?: Node;
}

interface VariableNode extends Node {
  readonly name: Node;
  readonly initializer?: Node;
}

interface FunctionNode extends Node {
  readonly body?: Node;
  readonly name?: Identifier;
}

interface ArrayNode extends Node {
  readonly elements: readonly Node[];
}

interface EffectRow {
  readonly source: AppRouteFact;
  readonly target: AppRouteFact;
  readonly on: "invalidate" | "revalidate";
  readonly identity: string;
  readonly binding: { readonly filename: string; readonly name: string } & {
    readonly expressionSpan?: { readonly start: number; readonly end: number };
  };
  readonly side: "server" | "client";
}

/** Configured declaration exports analyzed beside the selected native Elysia App. */
export interface ConfiguredEffectExports extends Pick<
  ConfiguredAppBinding,
  "serverModule" | "serverExport"
> {
  /** Optional static effects array exported by the configured server module. */
  readonly serverEffectsExport?: string;
  /** Client effects module path, paired with `clientEffectsExport`. */
  readonly clientEffectsModule?: string;
  /** Static effects array export, paired with `clientEffectsModule`. */
  readonly clientEffectsExport?: string;
}

const emptyCode = "export const effects = Object.freeze([]);\n";
const packageDirectory = dirname(fileURLToPath(import.meta.url));
const helperDeclarations = new Set(
  [
    resolvePath(packageDirectory, "effects.ts"),
    resolvePath(packageDirectory, "effects.d.ts"),
    resolvePath(packageDirectory, "../dist/effects.d.ts"),
  ].map(pathKey),
);

/**
 * Read configured, statically declared Eden effects without evaluating either module.
 * Only the selected selector declarations and their checked dependency closure are emitted.
 */
export async function analyzeConfiguredEffects(
  input: PluginProjectInput,
  configuration: ConfiguredEffectExports,
  routes: readonly AppRouteFact[],
): Promise<PluginProjectResult> {
  const filename = resolvePath(input.root, configuration.serverModule);
  const origin = { filename, start: 0, end: capturedSource(input, filename)?.source.length ?? 0 };

  const fail = (message: string): PluginProjectResult => ({
    diagnostics: [{ severity: "error", origin, message }],
    browserModules: [{ id: appEffectsModuleId, origin, code: emptyCode }],
  });

  try {
    if (
      (configuration.clientEffectsModule === undefined) !==
      (configuration.clientEffectsExport === undefined)
    )
      return fail("clientEffectsModule and clientEffectsExport must be configured together.");

    if (
      configuration.serverEffectsExport === undefined &&
      configuration.clientEffectsExport === undefined
    )
      return { browserModules: [{ id: appEffectsModuleId, origin, code: emptyCode }] };

    const serverSource = await input.types.sourceFile(origin.filename);
    const checker = input.types.checker;
    const serverModuleSymbol = serverSource
      ? await checker.getSymbolAtLocation(serverSource)
      : undefined;
    const serverExport = serverModuleSymbol
      ? await checker.getMemberInModuleExports(serverModuleSymbol, configuration.serverExport)
      : undefined;
    const serverValue = serverExport ? await resolveAlias(checker, serverExport) : undefined;

    if (!serverValue || !(serverValue.flags & SymbolFlags.Value))
      return fail(
        `Configured Elysia server export "${configuration.serverExport}" must resolve to an exported value.`,
      );

    const collected: EffectRow[] = [];
    const diagnostics: PluginDiagnostic[] = [];

    if (configuration.serverEffectsExport !== undefined) {
      const result = await readEffectExport(
        input,
        resolvePath(input.root, configuration.serverModule),
        configuration.serverEffectsExport,
        "server",
        serverValue.id,
        routes,
      );

      if (result.error) diagnostics.push({ severity: "error", origin, message: result.error });
      else collected.push(...result.rows);
    }

    if (
      configuration.clientEffectsModule !== undefined &&
      configuration.clientEffectsExport !== undefined
    ) {
      const filename = resolvePath(input.root, configuration.clientEffectsModule);
      const result = await readEffectExport(
        input,
        filename,
        configuration.clientEffectsExport,
        "client",
        serverValue.id,
        routes,
      );

      if (result.error)
        diagnostics.push({ severity: "error", origin: { filename }, message: result.error });
      else collected.push(...result.rows);
    }

    if (diagnostics.length)
      return {
        diagnostics,
        browserModules: [{ id: appEffectsModuleId, origin, code: emptyCode }],
      };

    const selected = selectRows(collected);

    if (selected.error)
      return {
        diagnostics: [{ severity: "error", origin, message: selected.error }],
        browserModules: [{ id: appEffectsModuleId, origin, code: emptyCode }],
      };

    if (selected.rows.length === 0)
      return { browserModules: [{ id: appEffectsModuleId, origin, code: emptyCode }] };

    const emitted = await emitSelectedEffects(input, selected.rows, selected.warnings);

    if (emitted.error)
      return {
        watch: emitted.watch,
        diagnostics: [
          { severity: "error", origin: emitted.origin ?? origin, message: emitted.error },
        ],
        browserModules: [{ id: appEffectsModuleId, origin, code: emptyCode }],
      };

    const warnings = selected.warnings.map((warning): PluginDiagnostic => ({
      severity: "warning",
      origin,
      message: warning,
    }));
    return {
      ...(warnings.length ? { diagnostics: warnings } : {}),
      watch: emitted.watch,
      browserModules: [
        {
          id: appEffectsModuleId,
          origin,
          code: emitted.code!,
          ...(emitted.map ? { map: emitted.map } : {}),
        },
      ],
    };
  } catch (error) {
    return fail(
      `Configured Elysia effects could not be analyzed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readEffectExport(
  input: PluginProjectInput,
  filename: string,
  exportName: string,
  side: EffectRow["side"],
  appValueId: number,
  routes: readonly AppRouteFact[],
): Promise<{ readonly rows: readonly EffectRow[]; readonly error?: string }> {
  const source = await input.types.sourceFile(filename);

  if (!source)
    return { rows: [], error: `Configured effects module could not be found: ${filename}` };

  if (!sourceMatchesCapture(input, source))
    return {
      rows: [],
      error: `Configured effects module ${filename} was transformed before checking; effects must be read from an unchanged captured source.`,
    };

  const checker = input.types.checker;
  const moduleSymbol = await checker.getSymbolAtLocation(source);
  const exported = moduleSymbol
    ? await checker.getMemberInModuleExports(moduleSymbol, exportName)
    : undefined;
  const target = exported ? await resolveAlias(checker, exported) : undefined;

  if (!target || !(target.flags & SymbolFlags.Value))
    return {
      rows: [],
      error: `Configured effects export "${exportName}" must resolve to an exported value.`,
    };

  let declaration: Node | undefined;

  for (const handle of target.declarations) {
    declaration = await input.types.resolveDeclaration(handle);

    if (declaration) break;
  }

  if (!declaration)
    return {
      rows: [],
      error: `Configured effects export "${exportName}" has no checked declaration.`,
    };

  let expression: Node | undefined;

  if (declaration.kind === SyntaxKind.VariableDeclaration) {
    const variable = declaration as VariableNode;
    const list = variable.parent;

    if (
      list.kind !== SyntaxKind.VariableDeclarationList ||
      ((list as Node & { readonly flags: number }).flags & NodeFlags.Const) === 0
    )
      return {
        rows: [],
        error: `Configured effects export "${exportName}" must be an immutable const binding.`,
      };

    expression = variable.initializer;
  } else if (declaration.kind === SyntaxKind.ExportAssignment) {
    expression = (declaration as Node & { readonly expression: Node }).expression;
  }

  expression = await resolveStaticExpression(input, expression, new Set());

  if (!expression || expression.kind !== SyntaxKind.ArrayLiteralExpression)
    return {
      rows: [],
      error: `Configured effects export "${exportName}" must resolve to a static array literal.`,
    };

  const rows: EffectRow[] = [];

  for (const element of (expression as ArrayNode).elements) {
    if (element.kind === SyntaxKind.SpreadElement)
      return {
        rows: [],
        error: `Configured effects export "${exportName}" cannot contain spread elements.`,
      };

    const effect = await resolveStaticExpression(input, element, new Set());

    if (!effect)
      return {
        rows: [],
        error: `Configured effect in "${exportName}" is not statically declared.`,
      };

    const row = await readEffectCall(input, effect, side, appValueId, routes);

    if (typeof row === "string") return { rows: [], error: row };

    rows.push(row);
  }

  return { rows };
}

async function resolveStaticExpression(
  input: PluginProjectInput,
  expression: Node | undefined,
  seen: Set<number>,
): Promise<Node | undefined> {
  if (!expression) return undefined;

  if (
    expression.kind === SyntaxKind.ParenthesizedExpression ||
    expression.kind === SyntaxKind.AsExpression ||
    expression.kind === SyntaxKind.TypeAssertionExpression ||
    expression.kind === SyntaxKind.SatisfiesExpression
  )
    return resolveStaticExpression(
      input,
      (expression as Node & { readonly expression: Node }).expression,
      seen,
    );

  if (expression.kind !== SyntaxKind.Identifier) return expression;

  const symbol = await input.types.checker.getSymbolAtLocation(expression);

  if (!symbol || seen.has(symbol.id)) return undefined;

  seen.add(symbol.id);

  const target = await resolveAlias(input.types.checker, symbol);

  if (!target) return undefined;

  let declaration: Node | undefined;

  for (const handle of target.declarations) {
    declaration = await input.types.resolveDeclaration(handle);

    if (declaration) break;
  }

  if (declaration?.kind !== SyntaxKind.VariableDeclaration) return expression;

  const variable = declaration as VariableNode;
  const list = variable.parent;

  if (
    list.kind !== SyntaxKind.VariableDeclarationList ||
    ((list as Node & { readonly flags: number }).flags & NodeFlags.Const) === 0
  )
    return undefined;

  return resolveStaticExpression(input, variable.initializer, seen);
}

async function readEffectCall(
  input: PluginProjectInput,
  expression: Node,
  side: EffectRow["side"],
  appValueId: number,
  routes: readonly AppRouteFact[],
): Promise<EffectRow | string> {
  if (!sourceMatchesCapture(input, expression.getSourceFile()))
    return "The configured effect declaration was transformed before checking and cannot be safely published.";

  if (expression.kind !== SyntaxKind.CallExpression)
    return "Each configured effect must call defineEdenEffect<App>()(...).";

  const call = expression as CallNode;
  const factoryExpression = unwrapExpression(call.expression);

  if (call.arguments.length !== 4)
    return "Each configured effect must call defineEdenEffect<App>() with source, target, selector, and mode.";

  const resolvedFactory = await resolveStaticExpression(input, factoryExpression, new Set());

  if (!resolvedFactory || resolvedFactory.kind !== SyntaxKind.CallExpression)
    return "Configured effects must use the public defineEdenEffect<App>() factory.";

  const factoryCall = resolvedFactory as CallNode;

  if (
    factoryCall.arguments.length !== 0 ||
    factoryCall.typeArguments?.length !== 1 ||
    (factoryCall.expression.kind !== SyntaxKind.Identifier &&
      factoryCall.expression.kind !== SyntaxKind.PropertyAccessExpression) ||
    !(await isOfficialFactory(input, factoryCall.expression))
  )
    return "Configured effects must use the public defineEdenEffect<App>() factory.";

  if (!(await typeNodeReferencesValue(input, factoryCall.typeArguments[0]!, appValueId, new Set())))
    return "The effect App type does not resolve to the configured server export by TypeScript symbol identity.";

  const source = await routeReference(input, call.arguments[0]);
  const target = await routeReference(input, call.arguments[1]);

  if (!source || !target)
    return "Effect source and target must use literal { method, path } route references.";

  const mode = await staticStringValue(input, call.arguments[3]);

  if (mode !== "invalidate" && mode !== "revalidate")
    return 'Effect mode must be the literal "invalidate" or "revalidate".';

  if (!routes.some((route) => sameRoute(route, source)))
    return `Effect source ${source.method} ${source.path} is not a route of the configured App.`;

  if (!routes.some((route) => sameRoute(route, target)))
    return `Effect target ${target.method} ${target.path} is not a route of the configured App.`;

  if (source.method === "GET" || source.method === "HEAD")
    return `Effect source ${source.method} ${source.path} must be a mutation route.`;

  if (target.method !== "GET" && target.method !== "HEAD")
    return `Effect target ${target.method} ${target.path} must be a GET or HEAD query route.`;

  const selector = unwrapExpression(call.arguments[2]!);

  if (
    selector.kind !== SyntaxKind.ArrowFunction &&
    selector.kind !== SyntaxKind.FunctionExpression &&
    selector.kind !== SyntaxKind.Identifier
  )
    return "Effect selector must be a function expression or an immutable function binding.";

  const selectorRoot = await selectorBinding(input, selector);

  if (!selectorRoot)
    return "Effect selector binding could not be resolved to a captured source declaration.";

  const identity = await selectorIdentity(input, selector);

  if (!identity) return "Effect selector identity could not be resolved by the project checker.";

  return { source, target, on: mode, identity, binding: selectorRoot, side };
}

async function selectorBinding(
  input: PluginProjectInput,
  selector: Node,
): Promise<EffectRow["binding"] | undefined> {
  const source = selector.getSourceFile();

  if (
    selector.kind === SyntaxKind.ArrowFunction ||
    selector.kind === SyntaxKind.FunctionExpression
  ) {
    const span = authoredExpressionSpan(input, selector);

    if (!span) return undefined;

    const captured = capturedSource(input, source.fileName);

    if (!captured) return undefined;

    const name = uniqueSyntheticName(captured.source, span.start, span.end);
    return {
      filename: captured.filename,
      name,
      expressionSpan: span,
    };
  }

  const identifier = selector as Identifier;
  const symbol = await input.types.checker.getSymbolAtLocation(identifier);

  if (!symbol || !(await isStableFunctionValue(input, symbol, new Set()))) return undefined;

  const localImport = symbol.flags & SymbolFlags.Alias;
  let declaration: Node | undefined;

  if (!localImport) {
    const target = await resolveAlias(input.types.checker, symbol);

    for (const handle of target?.declarations ?? []) {
      declaration = await input.types.resolveDeclaration(handle);

      if (declaration) break;
    }
  }

  const rootNode = declaration ?? identifier;
  const rootSource = rootNode.getSourceFile();
  const rootCaptured = capturedSource(input, rootSource.fileName);

  if (!rootCaptured) return undefined;

  const bindingName = localImport
    ? identifier.text
    : declaration?.kind === SyntaxKind.FunctionDeclaration
      ? (declaration as FunctionNode).name?.text
      : declaration?.kind === SyntaxKind.VariableDeclaration
        ? (declaration as VariableNode).name.kind === SyntaxKind.Identifier
          ? ((declaration as VariableNode).name as Identifier).text
          : undefined
        : undefined;

  if (!bindingName) return undefined;

  return { filename: rootCaptured.filename, name: bindingName };
}

async function isStableFunctionValue(
  input: PluginProjectInput,
  symbol: Symbol,
  seen: Set<number>,
): Promise<boolean> {
  if (seen.has(symbol.id)) return false;

  seen.add(symbol.id);

  const target = await resolveAlias(input.types.checker, symbol);

  if (!target) return false;

  for (const handle of target.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (!declaration) continue;

    if (declaration.kind === SyntaxKind.FunctionDeclaration)
      return (
        (declaration as FunctionNode).body !== undefined || (symbol.flags & SymbolFlags.Alias) !== 0
      );

    if (declaration.kind !== SyntaxKind.VariableDeclaration) continue;

    const variable = declaration as VariableNode;
    const list = variable.parent;

    if (
      list.kind !== SyntaxKind.VariableDeclarationList ||
      ((list as Node & { readonly flags: number }).flags & NodeFlags.Const) === 0 ||
      !variable.initializer
    )
      return false;

    const initializer = unwrapExpression(variable.initializer);

    if (
      initializer.kind === SyntaxKind.ArrowFunction ||
      initializer.kind === SyntaxKind.FunctionExpression
    )
      return true;

    if (initializer.kind === SyntaxKind.Identifier) {
      const alias = await input.types.checker.getSymbolAtLocation(initializer);
      return alias ? isStableFunctionValue(input, alias, seen) : false;
    }
  }

  return false;
}

async function selectorIdentity(
  input: PluginProjectInput,
  selector: Node,
): Promise<string | undefined> {
  if (
    selector.kind === SyntaxKind.ArrowFunction ||
    selector.kind === SyntaxKind.FunctionExpression
  ) {
    const source = selector.getSourceFile();
    return `expression:${pathKey(source.fileName)}:${selector.getStart(source)}:${selector.getEnd()}`;
  }

  const symbol = await input.types.checker.getSymbolAtLocation(selector);
  return symbol ? selectorValueIdentity(input, symbol, new Set()) : undefined;
}

async function selectorValueIdentity(
  input: PluginProjectInput,
  symbol: Symbol,
  seen: Set<number>,
): Promise<string | undefined> {
  if (seen.has(symbol.id)) return undefined;

  seen.add(symbol.id);

  const target = await resolveAlias(input.types.checker, symbol);

  if (!target) return undefined;

  for (const handle of target.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (!declaration) continue;

    if (declaration.kind === SyntaxKind.FunctionDeclaration) return `symbol:${target.id}`;

    if (declaration.kind !== SyntaxKind.VariableDeclaration) continue;

    const variable = declaration as VariableNode;

    if (!variable.initializer) return undefined;

    const initializer = unwrapExpression(variable.initializer);

    if (
      initializer.kind === SyntaxKind.ArrowFunction ||
      initializer.kind === SyntaxKind.FunctionExpression
    ) {
      const source = initializer.getSourceFile();
      return `expression:${pathKey(source.fileName)}:${initializer.getStart(source)}:${initializer.getEnd()}`;
    }

    if (initializer.kind === SyntaxKind.Identifier) {
      const alias = await input.types.checker.getSymbolAtLocation(initializer);
      return alias ? selectorValueIdentity(input, alias, seen) : undefined;
    }
  }

  return `symbol:${target.id}`;
}

async function isOfficialFactory(input: PluginProjectInput, expression: Node): Promise<boolean> {
  const symbol = await input.types.checker.getSymbolAtLocation(expression);
  const target = symbol ? await resolveAlias(input.types.checker, symbol) : undefined;

  if (!target || target.name !== "defineEdenEffect") return false;

  for (const handle of target.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (declaration && helperDeclarations.has(pathKey(declaration.getSourceFile().fileName)))
      return true;
  }

  return false;
}

async function routeReference(
  input: PluginProjectInput,
  node: Node | undefined,
): Promise<AppRouteFact | undefined> {
  node = await resolveStaticExpression(input, node, new Set());

  if (!node) return undefined;

  node = unwrapExpression(node);

  if (node.kind !== SyntaxKind.ObjectLiteralExpression) return undefined;

  const values = new Map<string, string>();

  for (const property of (node as Node & { readonly properties: readonly PropertyNode[] })
    .properties) {
    if (property.kind !== SyntaxKind.PropertyAssignment) return undefined;

    const name = propertyName(property.name);
    const value = await staticStringValue(input, property.initializer);

    if (!name || value === undefined || values.has(name)) return undefined;

    values.set(name, value);
  }

  const method = values.get("method")?.toUpperCase();
  const path = values.get("path");
  return method && path !== undefined && values.size === 2 ? { method, path } : undefined;
}

async function staticStringValue(
  input: PluginProjectInput,
  node: Node | undefined,
): Promise<string | undefined> {
  return stringValue(await resolveStaticExpression(input, node, new Set()));
}

function propertyName(node: Node): string | undefined {
  if (node.kind === SyntaxKind.Identifier) return (node as Identifier).text;

  return stringValue(node);
}

function stringValue(node: Node | undefined): string | undefined {
  if (!node) return undefined;

  if (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  )
    return (node as Identifier).text;

  return undefined;
}

function unwrapExpression(node: Node | undefined): Node {
  if (!node) throw new Error("Missing effect expression.");

  while (
    node.kind === SyntaxKind.ParenthesizedExpression ||
    node.kind === SyntaxKind.AsExpression ||
    node.kind === SyntaxKind.SatisfiesExpression ||
    node.kind === SyntaxKind.TypeAssertionExpression
  )
    node = (node as Node & { readonly expression: Node }).expression;

  return node;
}

function selectRows(rows: readonly EffectRow[]): {
  readonly rows: readonly EffectRow[];
  readonly warnings: readonly string[];
  readonly error?: string;
} {
  const bySide = new Map<EffectRow["side"], Map<string, EffectRow[]>>();

  for (const row of rows) {
    const key = routePairKey(row);
    let entries = bySide.get(row.side);

    if (!entries) bySide.set(row.side, (entries = new Map()));

    const existing = entries.get(key) ?? [];

    if (existing.some((item) => item.identity !== row.identity))
      return {
        rows: [],
        warnings: [],
        error: `Conflicting ${row.side} effect selectors for ${row.source.method} ${row.source.path} → ${row.target.method} ${row.target.path}.`,
      };

    if (!existing.some((item) => item.on === row.on)) existing.push(row);

    entries.set(key, existing);
  }

  const server = bySide.get("server") ?? new Map<string, EffectRow[]>();
  const client = bySide.get("client") ?? new Map<string, EffectRow[]>();
  const selected = new Map(server);
  const warnings: string[] = [];

  for (const [key, clientRows] of client) {
    const previous = server.get(key);
    const sameBehavior =
      previous !== undefined &&
      previous.length === clientRows.length &&
      previous.every((row) =>
        clientRows.some(
          (candidate) => candidate.identity === row.identity && candidate.on === row.on,
        ),
      );

    if (previous && !sameBehavior) {
      const row = clientRows[0]!;

      warnings.push(
        `Hesperia client effect overrides the Elysia server effect for ${row.source.method} ${row.source.path} → ${row.target.method} ${row.target.path}.`,
      );
    }

    selected.set(key, clientRows);
  }

  return { rows: [...selected.values()].flat(), warnings };
}

async function emitSelectedEffects(
  input: PluginProjectInput,
  rows: readonly EffectRow[],
  warnings: readonly string[],
): Promise<{
  readonly code?: string;
  readonly map?: PluginSourceMap;
  readonly watch?: PluginProjectResult["watch"];
  readonly error?: string;
  readonly origin?: { readonly filename: string };
}> {
  const captured = new Map(
    [...input.capturedSources.values()].map((item) => [pathKey(item.filename), item]),
  );
  const roots = new Map<string, EffectRow["binding"]>();

  for (const row of rows) roots.set(row.identity, row.binding);

  const bindings = [...roots.values()].map((binding) => {
    if (binding.expressionSpan) {
      const source = captured.get(pathKey(binding.filename));

      if (!source || binding.expressionSpan.end > source.source.length) return undefined;
    }

    return binding;
  });

  if (bindings.some((item) => item === undefined))
    return {
      error: "A selected effect selector span is outside the immutable captured source snapshot.",
    };

  const modules = [...captured.values()].map((item) => ({
    filename: item.filename,
    source: item.source,
  }));
  const resolver = new ModuleResolver(
    input.root,
    new Map([...captured.values()].map((item) => [item.filename, item.source])),
    "production",
  );
  const closure = extractBindingClosure(
    modules,
    bindings as NonNullable<(typeof bindings)[number]>[],
    { resolution: resolver },
  );

  if (!closure.artifact || !closure.entries)
    return {
      error:
        closure.diagnostics.map((item) => item.message).join("\n") ||
        "Selected effect selector closure could not be extracted.",
      origin: { filename: bindings[0]?.filename ?? input.root },
    };

  const transformedClosureModule = closure.artifact.modules.find((module) => {
    const checking =
      input.checkingSources.get(module.filename) ??
      [...input.checkingSources.values()].find(
        (item) => pathKey(item.filename) === pathKey(module.filename),
      );
    return checking !== undefined && checking.checking !== checking.authored;
  });

  if (transformedClosureModule)
    return {
      error: `Selected effect dependency ${transformedClosureModule.filename} was transformed before checking; publishing the captured source would not preserve the checked selector.`,
      origin: { filename: transformedClosureModule.filename },
    };

  const runtimeModule = "hesperia/runtime";
  let runtimeEntry: ReturnType<ModuleResolver["captureCompilerEntry"]>;

  try {
    runtimeEntry = resolver.captureCompilerEntry(Bun.resolveSync(runtimeModule, import.meta.dir));
  } catch {
    return {
      error: "The Hesperia compiler runtime could not be captured for effect selector emission.",
    };
  }

  const generatedRuntimeModule = "hesperia:compiler-runtime:elysia-effects";
  const emitted = emitRouteGuardArtifact(closure.artifact, {
    runtimeModule,
    generatedRuntimeModule,
  });

  const emittedModule = (filename: string) =>
    emitted.modules.find((module) => pathKey(module.filename) === pathKey(filename));

  const projectionResolution = {
    resolve(from: string, specifier: string) {
      if (specifier === generatedRuntimeModule && emittedModule(from))
        return resolver.resolveCompilerEntry(from, specifier, runtimeEntry.filename);

      return resolver.resolve(from, specifier);
    },
  };
  const selectorExports = closure.entries.map((entry, index) => ({
    module: emitted.modules.find((item) => pathKey(item.filename) === pathKey(entry.filename)),
    name: entry.name,
    exportName: `__hesperia_effect_selector_${index}`,
    identity: [...roots.keys()][index]!,
  }));

  if (selectorExports.some((item) => !item.module))
    return { error: "A selected effect selector was omitted from the emitted closure." };

  const patchedModules = emitted.modules.map((item) => {
    const exports = selectorExports
      .filter((selector) => pathKey(selector.module!.filename) === pathKey(item.filename))
      .map((selector) => `${selector.name} as ${selector.exportName}`);
    return {
      ...item,
      code: exports.length ? `${item.code}\nexport { ${exports.join(", ")} };\n` : item.code,
    };
  });
  const diagnostics = analyzeBrowserCapabilities(
    patchedModules.map((item) => ({ filename: item.filename, source: item.code })),
    input.root,
    projectionResolution,
    selectorExports.map((item) => item.module!.filename),
  );
  const errors = diagnostics.filter((item) => item.severity === "error");

  if (errors.length)
    return {
      error: errors.map((item) => `${item.filename}: ${item.message}`).join("\n"),
      origin: { filename: errors[0]!.filename },
    };

  const moduleIds = new Map(
    patchedModules.map((item, index) => [
      pathKey(item.filename),
      `hesperia-effect-module:${index}`,
    ]),
  );
  const entryPoint = "hesperia-effect-entry:configured";
  const selectorIndexes = new Map(selectorExports.map((item, index) => [item.identity, index]));
  const imports = selectorExports.map(
    (item, index) =>
      `import { ${item.exportName} as selector${index} } from ${JSON.stringify(moduleIds.get(pathKey(item.module!.filename)))};`,
  );
  const effects = rows.map(
    (row) =>
      `{ source: ${JSON.stringify(row.source)}, target: ${JSON.stringify(row.target)}, select: selector${selectorIndexes.get(row.identity)}, on: ${JSON.stringify(row.on)} }`,
  );
  const privateEntry = [
    ...imports,
    `const selectedWarnings = ${JSON.stringify(warnings)};`,
    "for (const warning of selectedWarnings) console.warn(warning);",
    `export const effects = Object.freeze([${effects.join(",")}].map((effect) => Object.freeze(effect)));`,
  ].join("\n");
  const privateEntryFilename = resolvePath(input.root, ".hesperia-internal/elysia-effects.ts");
  const generatedImports = new Map(
    patchedModules.map((item) => [moduleIds.get(pathKey(item.filename))!, item.filename]),
  );
  const finalResolver = resolver.forkWithGeneratedSources(
    new Map([[privateEntryFilename, privateEntry]]),
    generatedImports,
  );
  const finalResolution = {
    resolve(from: string, specifier: string) {
      if (specifier === generatedRuntimeModule && emittedModule(from))
        return resolver.resolveCompilerEntry(from, specifier, runtimeEntry.filename);

      return finalResolver.resolve(from, specifier);
    },
  };
  const finalDiagnostics = analyzeBrowserCapabilities(
    [
      ...patchedModules.map((item) => ({ filename: item.filename, source: item.code })),
      { filename: privateEntryFilename, source: privateEntry },
    ],
    input.root,
    finalResolution,
    [privateEntryFilename],
  );
  const finalErrors = finalDiagnostics.filter((item) => item.severity === "error");

  if (finalErrors.length)
    return {
      error: finalErrors.map((item) => `${item.filename}: ${item.message}`).join("\n"),
      origin: { filename: finalErrors[0]!.filename },
    };

  const bundled = await bundlePrivateModule({
    root: input.root,
    resolver,
    resolution: projectionResolution,
    modules: patchedModules,
    moduleIds,
    entryPoint,
    privateEntry,
  });
  const watchedFiles = new Set([
    ...closure.artifact.modules.map((item) => item.filename),
    runtimeEntry.filename,
    ...resolver.capturedEdges.flatMap((item) =>
      item.resolvedFilename ? [item.resolvedFilename] : [],
    ),
    ...resolver.capturedManifests.map((item) => item.filename),
  ]);
  return {
    ...bundled,
    watch: [...watchedFiles].map((file) => ({ kind: "file" as const, file })),
  };
}

async function bundlePrivateModule(options: {
  readonly root: string;
  readonly resolver: ModuleResolver;
  readonly resolution: Pick<ModuleResolver, "resolve">;
  readonly modules: readonly {
    readonly filename: string;
    readonly code: string;
    readonly map?: unknown;
    readonly imports: readonly { readonly source: string; readonly resolvedFilename?: string }[];
  }[];
  readonly moduleIds: ReadonlyMap<string, string>;
  readonly entryPoint: string;
  readonly privateEntry: string;
}): Promise<{
  readonly code?: string;
  readonly map?: PluginSourceMap;
  readonly error?: string;
}> {
  const moduleById = new Map(
    options.modules.map((item) => [options.moduleIds.get(pathKey(item.filename))!, item]),
  );
  const result = await Bun.build({
    entrypoints: [options.entryPoint],
    root: options.root,
    target: "browser",
    format: "esm",
    sourcemap: "external",
    conditions: [...options.resolver.activeConditions],
    splitting: false,
    throw: false,
    plugins: [
      {
        name: "hesperia-elysia-effects",

        setup(builder) {
          builder.onResolve({ filter: /^hesperia-effect-entry:/u }, () => ({
            path: options.entryPoint,
            namespace: "hesperia-effect-entry",
          }));

          builder.onResolve({ filter: /^hesperia-effect-module:/u }, (args) => ({
            path: args.path,
            namespace: "hesperia-effect-module",
          }));

          builder.onResolve({ filter: /.*/u }, (args) => {
            const importerModule = moduleById.get(args.importer);
            const importer = importerModule?.filename ?? args.importer;
            const projected = importerModule?.imports.find((item) => item.source === args.path);
            const projectedFilename = projected?.resolvedFilename;

            if (projectedFilename) {
              const internalId = options.moduleIds.get(pathKey(projectedFilename));

              if (internalId) return { path: internalId, namespace: "hesperia-effect-module" };
            }

            const resolved = options.resolution.resolve(importer, args.path);

            if (resolved.kind === "failure") throw new Error(resolved.message);

            const selectedId = options.moduleIds.get(pathKey(resolved.filename));

            if (selectedId) return { path: selectedId, namespace: "hesperia-effect-module" };

            return { path: resolved.filename, namespace: "hesperia-effect-captured" };
          });

          builder.onLoad({ filter: /.*/u, namespace: "hesperia-effect-entry" }, () => ({
            contents: options.privateEntry,
            loader: "js",
          }));

          builder.onLoad({ filter: /.*/u, namespace: "hesperia-effect-module" }, (args) => {
            const module = moduleById.get(args.path);
            return module
              ? { contents: module.code, loader: loaderFor(module.filename) }
              : undefined;
          });

          builder.onLoad({ filter: /.*/u, namespace: "hesperia-effect-captured" }, (args) => {
            const captured = options.resolver.capturedSources.find(
              (item) => pathKey(item.filename) === pathKey(args.path),
            );

            if (!captured) throw new Error(`Resolver did not capture module source: ${args.path}`);

            return { contents: captured.source, loader: loaderFor(captured.filename) };
          });
        },
      },
    ],
  });

  if (!result.success) return { error: result.logs.map((item) => item.message).join("\n") };

  const output = result.outputs.find((item) => item.kind === "entry-point");
  const sourceMapOutput = result.outputs.find((item) => item.kind === "sourcemap");

  if (!output || !sourceMapOutput)
    return { error: "Effect module bundling produced no code and source map outputs." };

  const bundleMap = JSON.parse(await sourceMapOutput.text()) as SourceMapInput;
  const moduleMaps = new Map(
    options.modules.map((item) => [options.moduleIds.get(pathKey(item.filename))!, item.map]),
  );
  const map = stripSourcesContent(
    remapping(
      bundleMap,
      (source) => {
        const moduleId = source.startsWith("hesperia-effect-module:")
          ? source.slice("hesperia-effect-module:".length)
          : source;
        return (
          (moduleMaps.get(source) as SourceMapInput | undefined) ??
          (moduleMaps.get(moduleId) as SourceMapInput | undefined) ??
          null
        );
      },
      { excludeContent: true },
    ),
  );
  const code = (await output.text()).replace(/\s*\/\/# sourceMappingURL=[^\r\n]*\s*$/u, "\n");
  return { code, map };
}

function stripSourcesContent(value: unknown): PluginSourceMap {
  if (!isNonNullObject(value))
    throw new Error("Effect module bundling produced an invalid source map.");

  const map = { ...(value as PluginSourceMap), sourcesContent: undefined };
  delete (map as { sourcesContent?: readonly (string | null)[] }).sourcesContent;
  return map;
}

async function resolveAlias(
  checker: PluginProjectInput["types"]["checker"],
  input: Symbol,
): Promise<Symbol | undefined> {
  let current = input;
  const seen = new Set<number>();

  while (current.flags & SymbolFlags.Alias) {
    if (seen.has(current.id)) return undefined;

    seen.add(current.id);

    current = await checker.getAliasedSymbol(current);

    if (await checker.isUnknownSymbol(current)) return undefined;
  }

  return current;
}

function routePairKey(row: Pick<EffectRow, "source" | "target">): string {
  return `${row.source.method}\0${row.source.path}\0${row.target.method}\0${row.target.path}`;
}

function sameRoute(left: AppRouteFact, right: AppRouteFact): boolean {
  return left.method.toUpperCase() === right.method.toUpperCase() && left.path === right.path;
}

function pathKey(filename: string): string {
  let path = resolvePath(filename);

  try {
    path = realpathSync(path);
  } catch {
    // Generated and unsaved source paths have no filesystem identity.
  }

  path = path.replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function uniqueSyntheticName(source: string, start: number, end: number): string {
  const stem = `__hesperia_effect_selector_${start}_${end}`;
  let name = stem;
  let index = 0;

  while (source.includes(name)) name = `${stem}_${++index}`;

  return name;
}

function authoredExpressionSpan(
  input: PluginProjectInput,
  expression: Node,
): { readonly start: number; readonly end: number } | undefined {
  const sourceFile = expression.getSourceFile();

  if (!sourceMatchesCapture(input, sourceFile)) return undefined;

  return { start: expression.getStart(sourceFile), end: expression.getEnd() };
}

function sourceMatchesCapture(input: PluginProjectInput, sourceFile: SourceFile): boolean {
  const captured = capturedSource(input, sourceFile.fileName);

  if (!captured || captured.source !== sourceFile.text) return false;

  const checking = [...input.checkingSources.values()].find(
    (item) => pathKey(item.filename) === pathKey(sourceFile.fileName),
  );
  return (
    checking === undefined ||
    (checking.checking === checking.authored && checking.authored === captured.source)
  );
}

function capturedSource(input: PluginProjectInput, filename: string) {
  return [...input.capturedSources.values()].find(
    (item) => pathKey(item.filename) === pathKey(filename),
  );
}

function loaderFor(filename: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();

  if (extension === ".tsx") return "tsx";

  if (extension === ".jsx") return "jsx";

  if ([".ts", ".mts", ".cts"].includes(extension)) return "ts";

  return "js";
}
