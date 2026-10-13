import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SymbolFlags, TypeFlags, type Symbol, type Type } from "typescript/unstable/async";
import {
  NodeFlags,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import type { PluginProjectInput, PluginProjectResult } from "@hesperia/tooling/project-service";
import { appRoutesModuleId, type AppRouteFact } from "./route-facts.ts";

export { appRoutesModuleId } from "./route-facts.ts";
export type { AppRouteFact } from "./route-facts.ts";

/** Explicit source and import bindings for one configured Elysia App. */
export interface ConfiguredAppBinding {
  /** Server module path, resolved against the configured project root. */
  readonly serverModule: string;
  /** Value export in `serverModule` whose `~Routes` type is selected. */
  readonly serverExport: string;
  /** Optional client source for the internal explicit-association path. */
  readonly clientModule?: string;
  /** Local App type import name paired with `clientModule`. */
  readonly clientAppImport?: string;
}

interface ImportDeclarationNode extends Node {
  readonly importClause?: ImportClauseNode;
}

interface ImportClauseNode extends Node {
  readonly name?: Node;
  readonly namedBindings?: Node;
}

interface NamedImportsNode extends Node {
  readonly elements: readonly Node[];
}

interface ImportSpecifierNode extends Node {
  readonly name: Identifier;
}

interface TypeAliasNode extends Node {
  readonly type?: Node;
}

interface TypeQueryNode extends Node {
  readonly exprName: Node;
}

interface TypeReferenceNode extends Node {
  readonly typeName: Node;
}

interface CallExpressionNode extends Node {
  readonly expression: Node;
  readonly arguments: readonly Node[];
  readonly typeArguments?: readonly Node[];
}

interface ExpressionNode extends Node {
  readonly expression: Node;
}

interface VariableDeclarationNode extends Node {
  readonly initializer?: Node;
}

interface BindingElementNode extends Node {
  readonly name: Node;
  readonly propertyName?: Node;
}

interface ShorthandPropertyAssignmentNode extends Node {
  readonly name: Node;
}

interface NamedDeclarationNode extends Node {
  readonly name?: Node;
}

interface ReferenceNode extends Node {
  readonly expression?: Node;
}

interface ExportAssignmentNode extends Node {
  readonly expression: Node;
}

type PackageFunctionOrigin = "verified" | "mutable-alias" | "unresolved-alias" | "none";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const packageClientDeclarations = new Set(
  [
    resolve(packageDirectory, "client.ts"),
    resolve(packageDirectory, "client.d.ts"),
    resolve(packageDirectory, "../dist/client.d.ts"),
  ].map(comparableSourcePath),
);

interface ImportTypeNode extends Node {
  readonly isTypeOf: boolean;
  readonly qualifier?: Node;
}

interface ParenthesizedTypeNode extends Node {
  readonly type: Node;
}

interface MethodNode extends Node {
  readonly name: Node;
}

export interface ConfiguredAppAnalysis {
  readonly result: PluginProjectResult;
  readonly routes: readonly AppRouteFact[];
  readonly streamingResponses: readonly StreamingResponseFact[];
  readonly origin: { readonly filename: string; readonly start: number; readonly end: number };
}

interface StreamingResponseFact extends AppRouteFact {
  readonly statuses: readonly string[];
}

interface RouteResponseIdentity {
  readonly symbolId: number;
  readonly objectBranchKeys: ReadonlySet<string>;
  readonly streamTypes: NativeStreamTypeIdentities;
}

interface NativeStreamTypeIdentities {
  readonly generator: number;
  readonly asyncGenerator: number;
  readonly readableStream: number;
}

interface CollectedRouteFacts {
  readonly routes: AppRouteFact[];
  readonly streamingResponses: StreamingResponseFact[];
  readonly error?: string;
}

const edenSuccessStatusCodes = new Set([
  "200",
  "201",
  "202",
  "203",
  "204",
  "205",
  "206",
  "207",
  "208",
  "226",
]);

/**
 * Analyze one explicitly bound App and emit its browser-safe method/path facts.
 *
 * The server module is inspected through the project checker and never executed.
 * An invalid binding or incomplete route tree returns an error diagnostic with
 * an empty private route module. Successful checked facts remain available to
 * the configured plugin policy before the ordinary result is published.
 */
export async function analyzeConfiguredApp(
  input: PluginProjectInput,
  binding: ConfiguredAppBinding,
): Promise<ConfiguredAppAnalysis> {
  const serverSource = await input.types.sourceFile(binding.serverModule);
  const clientSource = binding.clientModule
    ? await input.types.sourceFile(binding.clientModule)
    : undefined;
  const origin = sourceOrigin(input, binding.serverModule, serverSource);
  const checker = input.types.checker;

  const failure = (message: string): ConfiguredAppAnalysis => ({
    result: failed(origin, message),
    routes: [],
    streamingResponses: [],
    origin,
  });

  if (!serverSource)
    return failure(`Configured Elysia server module could not be found: ${binding.serverModule}`);

  const serverModuleSymbol = await checker.getSymbolAtLocation(serverSource);
  const serverExport = serverModuleSymbol
    ? await checker.getMemberInModuleExports(serverModuleSymbol, binding.serverExport)
    : undefined;
  const serverValue = serverExport ? await resolveAliases(checker, serverExport) : undefined;

  if (!serverValue || !(serverValue.flags & SymbolFlags.Value))
    return failure(
      `Configured Elysia server export "${binding.serverExport}" must resolve to an exported value.`,
    );

  if (binding.clientModule !== undefined && binding.clientAppImport !== undefined) {
    if (!clientSource)
      return failure(`Configured Elysia client module could not be found: ${binding.clientModule}`);

    const clientImportNodes = findClientTypeImports(clientSource, binding.clientAppImport);

    if (clientImportNodes.length !== 1)
      return failure(
        `Configured Elysia client App type import "${binding.clientAppImport}" must appear exactly once in ${binding.clientModule}.`,
      );

    const clientImportSymbol = await checker.getSymbolAtLocation(clientImportNodes[0]!);
    const clientType = clientImportSymbol
      ? await resolveAliases(checker, clientImportSymbol)
      : undefined;

    if (!clientType || !(clientType.flags & SymbolFlags.TypeAlias))
      return failure(
        `Configured Elysia client App import "${binding.clientAppImport}" must resolve to a type alias.`,
      );

    if (!(await clientTypeIsReferenced(input, clientSource, clientType.id)))
      return failure(
        `Configured Elysia client App type import "${binding.clientAppImport}" is not referenced by ${binding.clientModule}.`,
      );

    const associated = await typeAliasReferencesValue(input, clientType, serverValue.id, new Set());

    if (!associated)
      return failure(
        `Configured Elysia client App type "${binding.clientAppImport}" does not refer to the configured server value export "${binding.serverExport}" by TypeScript symbol identity.`,
      );
  } else if (binding.clientModule !== undefined || binding.clientAppImport !== undefined) {
    return failure(
      "The private Elysia client module and App type binding must be supplied together.",
    );
  } else {
    const associationError = await checkPublicClientAssociations(input, serverValue.id);

    if (associationError) return failure(associationError);
  }

  const appType = await checker.getTypeOfSymbol(serverValue);

  if (!appType)
    return failure(
      `Configured Elysia server export "${binding.serverExport}" has no checked value type.`,
    );

  const routeMapSymbol = await checker.getPropertyOfType(appType, "~Routes");
  const routeMap = routeMapSymbol ? await checker.getTypeOfSymbol(routeMapSymbol) : undefined;

  if (!routeMap || routeMap.isErrorType() || !isObjectLike(routeMap))
    return failure(
      `Configured Elysia server export "${binding.serverExport}" does not expose a checked "~Routes" type.`,
    );

  const routeResponse = await findElysiaRouteResponseIdentity(input, appType, new Set());

  if (!routeResponse)
    return failure(
      `Configured Elysia server export "${binding.serverExport}" does not expose the pinned Elysia route response type or its canonical native stream type identities.`,
    );

  const collected = await collectRouteFacts(input, routeMap, routeResponse, [], new Set());

  if (collected.error)
    return failure(
      `Configured Elysia server export "${binding.serverExport}" has incomplete "~Routes" metadata: ${collected.error}`,
    );

  collected.routes.sort(compareRouteFacts);

  return {
    result: { browserModules: [routeModule(appRoutesModuleId, origin, collected.routes)] },
    routes: collected.routes,
    streamingResponses: collected.streamingResponses,
    origin,
  };
}

function findClientTypeImports(source: SourceFile, localName: string): Node[] {
  const imports: Node[] = [];

  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.ImportDeclaration) {
      const clause = (node as ImportDeclarationNode).importClause;

      if (clause) {
        if (identifierText(clause.name) === localName) imports.push(clause.name!);

        const bindings = clause.namedBindings;

        if (bindings?.kind === SyntaxKind.NamedImports)
          for (const specifier of (bindings as NamedImportsNode).elements) {
            const name = (specifier as ImportSpecifierNode).name;

            if (identifierText(name) === localName) imports.push(name);
          }
      }
    }

    node.forEachChild(visit);
  };

  visit(source);

  return imports;
}

function identifierText(node: Node | undefined): string | undefined {
  return node?.kind === SyntaxKind.Identifier ? (node as Identifier).text : undefined;
}

async function resolveAliases(
  checker: PluginProjectInput["types"]["checker"],
  initial: Symbol,
): Promise<Symbol | undefined> {
  let symbol = initial;
  const seen = new Set<number>();

  while (symbol.flags & SymbolFlags.Alias) {
    if (seen.has(symbol.id)) return undefined;

    seen.add(symbol.id);

    symbol = await checker.getAliasedSymbol(symbol);

    if (await checker.isUnknownSymbol(symbol)) return undefined;
  }

  return symbol;
}

async function checkPublicClientAssociations(
  input: PluginProjectInput,
  serverValueId: number,
): Promise<string | undefined> {
  const calls: CallExpressionNode[] = [];
  const factoryReferences: Node[] = [];
  const bindingElements: BindingElementNode[] = [];
  const shorthandProperties: ShorthandPropertyAssignmentNode[] = [];

  for (const checkingSource of input.checkingSources.values()) {
    const source = await input.types.sourceFile(checkingSource.filename);

    if (!source) continue;

    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.CallExpression) calls.push(node as CallExpressionNode);

      if (node.kind === SyntaxKind.BindingElement) bindingElements.push(node as BindingElementNode);

      if (node.kind === SyntaxKind.ShorthandPropertyAssignment)
        shorthandProperties.push(node as ShorthandPropertyAssignmentNode);

      if (
        (node.kind === SyntaxKind.Identifier ||
          node.kind === SyntaxKind.PropertyAccessExpression) &&
        !isPropertyName(node) &&
        !isDeclarationName(node) &&
        !isImportOrExportReference(node) &&
        !isTypeOnlyReference(node)
      )
        factoryReferences.push(node);

      node.forEachChild(visit);
    };

    visit(source);
  }

  for (const bindingElement of bindingElements) {
    if (await bindsPublicFactoryProperty(input, bindingElement))
      return (
        "withAeolia is destructured from a value that exposes the public factory. " +
        "The checker cannot establish the App association through that binding."
      );
  }

  for (const shorthandProperty of shorthandProperties) {
    const valueSymbol =
      await input.types.checker.getShorthandAssignmentValueSymbol(shorthandProperty);

    if (valueSymbol && (await symbolReferencesPublicFactory(input, valueSymbol)))
      return (
        "withAeolia is captured by an object shorthand property. " +
        "The checker cannot establish the App association through that value."
      );
  }

  for (const reference of factoryReferences) {
    const origin = await packageFunctionOrigin(
      input,
      reference,
      "@hesperia/elysia",
      "withAeolia",
      new Set(),
    );

    if (origin === "verified" && !isSupportedFactoryReference(reference))
      return (
        "withAeolia is referenced outside a direct call, immutable alias, or module export. " +
        "The checker cannot establish the App association for that factory value."
      );
  }

  for (const call of calls) {
    const factoryOrigin = await packageFunctionOrigin(
      input,
      call.expression,
      "@hesperia/elysia",
      "withAeolia",
      new Set(),
    );

    if (factoryOrigin === "none") continue;

    if (factoryOrigin !== "verified")
      return "The withAeolia call uses a mutable or unresolved factory alias, so its package origin cannot be verified.";

    const client = call.arguments[0];

    if (!client)
      return "withAeolia requires a native Eden client associated with the configured Elysia App.";

    const appType = await edenClientAppType(input, client, new Set());

    if (!appType)
      return (
        "withAeolia requires a client whose value resolves to the native @elysia/eden treaty factory and a checked App type argument. " +
        "The checker cannot establish that origin through a mutable binding, object-property alias, inferred App type, or untraceable factory."
      );

    if (!(await typeNodeReferencesValue(input, appType, serverValueId, new Set())))
      return "The Eden client's App type does not resolve to the configured server export by TypeScript symbol identity.";
  }

  return undefined;
}

async function bindsPublicFactoryProperty(
  input: PluginProjectInput,
  bindingElement: BindingElementNode,
): Promise<boolean> {
  const property = bindingElement.propertyName ?? bindingElement.name;
  const propertyName = identifierText(property);

  if (propertyName !== "withAeolia") return false;

  let context = bindingElement.parent.parent;

  if (context.kind === SyntaxKind.VariableDeclaration) {
    const initializer = (context as VariableDeclarationNode).initializer;

    if (!initializer) return false;

    const namespaceSymbol = await input.types.checker.getSymbolAtLocation(initializer);
    const resolvedNamespace =
      namespaceSymbol && namespaceSymbol.flags & SymbolFlags.Alias
        ? await resolveAliases(input.types.checker, namespaceSymbol)
        : undefined;
    const exportedFactory = resolvedNamespace
      ? await input.types.checker.getMemberInModuleExports(resolvedNamespace, propertyName)
      : undefined;

    if (exportedFactory && (await symbolIsPublicFactory(input, exportedFactory))) return true;

    const type = await input.types.checker.getTypeAtLocation(initializer);
    const symbol = type
      ? await input.types.checker.getPropertyOfType(type, propertyName)
      : undefined;
    return symbol ? symbolIsPublicFactory(input, symbol) : false;
  }

  if (context.kind === SyntaxKind.Parameter) {
    const type = await input.types.checker.getTypeAtLocation(context);
    const symbol = type
      ? await input.types.checker.getPropertyOfType(type, propertyName)
      : undefined;
    return symbol ? symbolIsPublicFactory(input, symbol) : false;
  }

  return false;
}

async function symbolIsPublicFactory(input: PluginProjectInput, symbol: Symbol): Promise<boolean> {
  const resolved = await resolveAliases(input.types.checker, symbol);

  if (!resolved || resolved.name !== "withAeolia") return false;

  for (const handle of resolved.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (
      declaration &&
      packageClientDeclarations.has(comparableSourcePath(declaration.getSourceFile().fileName))
    )
      return true;
  }

  return false;
}

async function symbolReferencesPublicFactory(
  input: PluginProjectInput,
  symbol: Symbol,
): Promise<boolean> {
  if (await symbolIsPublicFactory(input, symbol)) return true;

  const resolved = await resolveAliases(input.types.checker, symbol);

  if (!resolved) return false;

  for (const handle of resolved.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (declaration?.kind !== SyntaxKind.VariableDeclaration) continue;

    const initializer = (declaration as VariableDeclarationNode).initializer;

    if (!initializer) continue;

    const origin = await packageFunctionOrigin(
      input,
      initializer,
      "@hesperia/elysia",
      "withAeolia",
      new Set(),
    );

    if (origin !== "none") return true;
  }

  return false;
}

async function packageFunctionOrigin(
  input: PluginProjectInput,
  expression: Node,
  packageName: string,
  functionName: string,
  seen: Set<number>,
): Promise<PackageFunctionOrigin> {
  if (
    expression.kind === SyntaxKind.ParenthesizedExpression ||
    expression.kind === SyntaxKind.AsExpression ||
    expression.kind === SyntaxKind.TypeAssertionExpression ||
    expression.kind === SyntaxKind.NonNullExpression ||
    expression.kind === SyntaxKind.SatisfiesExpression
  )
    return packageFunctionOrigin(
      input,
      (expression as ExpressionNode).expression,
      packageName,
      functionName,
      seen,
    );

  const symbol = await input.types.checker.getSymbolAtLocation(expression);
  const resolved = symbol ? await resolveAliases(input.types.checker, symbol) : undefined;

  if (!resolved) return "none";

  if (seen.has(resolved.id)) return "unresolved-alias";

  seen.add(resolved.id);

  if (resolved.name === functionName) {
    for (const handle of resolved.declarations) {
      const declaration = await input.types.resolveDeclaration(handle);

      if (!declaration) continue;

      const filename = comparableSourcePath(declaration.getSourceFile().fileName);

      if (isPackageFunctionDeclaration(filename, packageName)) return "verified";
    }
  }

  let unresolvedAlias: PackageFunctionOrigin = "none";

  for (const handle of resolved.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (!declaration) continue;

    let initializer: Node | undefined;
    let immutable = false;

    if (declaration.kind === SyntaxKind.VariableDeclaration) {
      initializer = (declaration as VariableDeclarationNode).initializer;
      const declarationList = declaration.parent;
      immutable =
        declarationList.kind === SyntaxKind.VariableDeclarationList &&
        (declarationList.flags & NodeFlags.Const) !== 0;
    } else if (declaration.kind === SyntaxKind.ExportAssignment) {
      initializer = (declaration as ExportAssignmentNode).expression;
      immutable = true;
    }

    if (!initializer) continue;

    const nested = await packageFunctionOrigin(input, initializer, packageName, functionName, seen);

    if (nested === "verified") return immutable ? "verified" : "mutable-alias";

    if (nested !== "none") unresolvedAlias = nested;
  }

  return unresolvedAlias;
}

function isPackageFunctionDeclaration(filename: string, packageName: string): boolean {
  if (packageName === "@elysia/eden")
    return (
      filename.endsWith("/node_modules/@elysia/eden/dist/treaty2.d.ts") ||
      filename.endsWith("/node_modules/@elysia/eden/dist/treaty2/index.d.ts")
    );

  if (packageName === "@hesperia/elysia")
    return packageClientDeclarations.has(comparableSourcePath(filename));

  return false;
}

function comparableSourcePath(filename: string): string {
  const absolute = resolve(filename);
  let comparable: string;

  try {
    comparable = realpathSync.native(absolute);
  } catch {
    comparable = absolute;
  }

  comparable = comparable.replaceAll("\\", "/");
  return process.platform === "win32" ? comparable.toLowerCase() : comparable;
}

function isPropertyName(node: Node): boolean {
  const parent = node.parent;
  return (
    parent.kind === SyntaxKind.PropertyAccessExpression &&
    (parent as NamedDeclarationNode).name === node
  );
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  return (
    (parent.kind === SyntaxKind.VariableDeclaration ||
      parent.kind === SyntaxKind.FunctionDeclaration ||
      parent.kind === SyntaxKind.FunctionExpression ||
      parent.kind === SyntaxKind.Parameter ||
      parent.kind === SyntaxKind.ClassDeclaration ||
      parent.kind === SyntaxKind.ClassExpression ||
      parent.kind === SyntaxKind.MethodDeclaration ||
      parent.kind === SyntaxKind.PropertyDeclaration) &&
    (parent as NamedDeclarationNode).name === node
  );
}

function isImportOrExportReference(node: Node): boolean {
  return (
    node.parent.kind === SyntaxKind.ImportSpecifier ||
    node.parent.kind === SyntaxKind.ImportClause ||
    node.parent.kind === SyntaxKind.NamespaceImport ||
    node.parent.kind === SyntaxKind.ExportSpecifier
  );
}

function isTypeOnlyReference(node: Node): boolean {
  let parent = node.parent;

  while (
    parent.kind === SyntaxKind.PropertyAccessExpression ||
    parent.kind === SyntaxKind.QualifiedName ||
    parent.kind === SyntaxKind.ParenthesizedExpression
  )
    parent = parent.parent;

  return parent.kind === SyntaxKind.TypeQuery || parent.kind === SyntaxKind.ImportType;
}

function isSupportedFactoryReference(node: Node): boolean {
  let expression = node;

  while (
    (expression.parent.kind === SyntaxKind.ParenthesizedExpression ||
      expression.parent.kind === SyntaxKind.AsExpression ||
      expression.parent.kind === SyntaxKind.TypeAssertionExpression ||
      expression.parent.kind === SyntaxKind.NonNullExpression ||
      expression.parent.kind === SyntaxKind.SatisfiesExpression) &&
    (expression.parent as ReferenceNode).expression === expression
  )
    expression = expression.parent;

  const parent = expression.parent;

  if (parent.kind === SyntaxKind.CallExpression)
    return (parent as CallExpressionNode).expression === expression;

  if (parent.kind === SyntaxKind.VariableDeclaration) {
    const declarationList = parent.parent;
    return (
      (parent as VariableDeclarationNode).initializer === expression &&
      declarationList.kind === SyntaxKind.VariableDeclarationList &&
      (declarationList.flags & NodeFlags.Const) !== 0
    );
  }

  if (parent.kind === SyntaxKind.ExportAssignment)
    return (parent as ExportAssignmentNode).expression === expression;

  return parent.kind === SyntaxKind.TypeOfExpression;
}

async function edenClientAppType(
  input: PluginProjectInput,
  expression: Node,
  seen: Set<number>,
): Promise<Node | undefined> {
  if (
    expression.kind === SyntaxKind.ParenthesizedExpression ||
    expression.kind === SyntaxKind.AsExpression ||
    expression.kind === SyntaxKind.TypeAssertionExpression ||
    expression.kind === SyntaxKind.NonNullExpression ||
    expression.kind === SyntaxKind.SatisfiesExpression
  )
    return edenClientAppType(input, (expression as ExpressionNode).expression, seen);

  if (expression.kind === SyntaxKind.CallExpression) {
    const call = expression as CallExpressionNode;

    if (
      (await packageFunctionOrigin(input, call.expression, "@elysia/eden", "treaty", new Set())) !==
      "verified"
    )
      return undefined;

    return call.typeArguments?.[0];
  }

  if (
    expression.kind !== SyntaxKind.Identifier &&
    expression.kind !== SyntaxKind.PropertyAccessExpression
  )
    return undefined;

  const symbol = await input.types.checker.getSymbolAtLocation(expression);
  const resolved = symbol ? await resolveAliases(input.types.checker, symbol) : undefined;

  if (!resolved || seen.has(resolved.id)) return undefined;

  seen.add(resolved.id);

  for (const handle of resolved.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (!declaration) continue;

    if (declaration.kind === SyntaxKind.VariableDeclaration) {
      const initializer = (declaration as VariableDeclarationNode).initializer;

      if (initializer) {
        const declarationList = declaration.parent;

        if (
          declarationList.kind !== SyntaxKind.VariableDeclarationList ||
          (declarationList.flags & NodeFlags.Const) === 0
        )
          return undefined;

        const appType = await edenClientAppType(input, initializer, seen);

        if (appType) return appType;
      }
    } else if (declaration.kind === SyntaxKind.ExportAssignment) {
      const appType = await edenClientAppType(
        input,
        (declaration as ExportAssignmentNode).expression,
        seen,
      );

      if (appType) return appType;
    }
  }

  return undefined;
}

async function clientTypeIsReferenced(
  input: PluginProjectInput,
  source: SourceFile,
  typeSymbolId: number,
): Promise<boolean> {
  const references: Node[] = [];

  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.TypeReference) references.push(node);

    node.forEachChild(visit);
  };

  visit(source);

  const checker = input.types.checker;

  for (const reference of references) {
    const referenced = await checker.getSymbolAtLocation((reference as TypeReferenceNode).typeName);
    const target = referenced ? await resolveAliases(checker, referenced) : undefined;

    if (target?.id === typeSymbolId) return true;
  }

  return false;
}

async function typeAliasReferencesValue(
  input: PluginProjectInput,
  initial: Symbol,
  valueSymbolId: number,
  seen: Set<number>,
): Promise<boolean> {
  const checker = input.types.checker;
  const symbol = await resolveAliases(checker, initial);

  if (!symbol || !(symbol.flags & SymbolFlags.TypeAlias) || seen.has(symbol.id)) return false;

  seen.add(symbol.id);

  for (const handle of symbol.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (!declaration || declaration.kind !== SyntaxKind.TypeAliasDeclaration) continue;

    const type = (declaration as TypeAliasNode).type;

    if (type && (await typeNodeReferencesValue(input, type, valueSymbolId, seen))) return true;
  }

  return false;
}

/**
 * Resolve an App type node to its exact configured value declaration.
 *
 * @internal Shared by native Eden client association and effect declarations
 * during the same retained project-checker lease. Import/export aliases and
 * type queries preserve value provenance; structural type equality does not
 * establish association. Checker identities never enter browser metadata.
 */
export async function typeNodeReferencesValue(
  input: PluginProjectInput,
  type: Node,
  valueSymbolId: number,
  seen: Set<number>,
): Promise<boolean> {
  if (type.kind === SyntaxKind.ParenthesizedType)
    return typeNodeReferencesValue(
      input,
      (type as ParenthesizedTypeNode).type,
      valueSymbolId,
      seen,
    );

  if (type.kind === SyntaxKind.TypeQuery) {
    const checker = input.types.checker;
    const referenced = await checker.getSymbolAtLocation((type as TypeQueryNode).exprName);
    const value = referenced ? await resolveAliases(checker, referenced) : undefined;
    return value?.id === valueSymbolId;
  }

  if (type.kind === SyntaxKind.TypeReference) {
    const referenced = await input.types.checker.getSymbolAtLocation(
      (type as TypeReferenceNode).typeName,
    );
    return referenced ? typeAliasReferencesValue(input, referenced, valueSymbolId, seen) : false;
  }

  if (type.kind === SyntaxKind.ImportType) {
    const importType = type as ImportTypeNode;

    if (!importType.qualifier) return false;

    const referenced = await input.types.checker.getSymbolAtLocation(importType.qualifier);
    const target = referenced ? await resolveAliases(input.types.checker, referenced) : undefined;

    if (importType.isTypeOf) return target?.id === valueSymbolId;

    return referenced ? typeAliasReferencesValue(input, referenced, valueSymbolId, seen) : false;
  }

  return false;
}

async function collectRouteFacts(
  input: PluginProjectInput,
  routeMap: Type,
  routeResponse: RouteResponseIdentity,
  path: readonly string[],
  ancestry: ReadonlySet<number>,
): Promise<CollectedRouteFacts> {
  const checker = input.types.checker;
  const routeResponseSymbolId = routeResponse.symbolId;

  if (routeMap.isErrorType())
    return {
      routes: [],
      streamingResponses: [],
      error: "the checker produced an error type while walking the route tree",
    };

  if (ancestry.has(routeMap.id))
    return {
      routes: [],
      streamingResponses: [],
      error: "the route tree contains a recursive type",
    };

  const nextAncestry = new Set(ancestry);

  nextAncestry.add(routeMap.id);

  const routes: AppRouteFact[] = [];
  const streamingResponses: StreamingResponseFact[] = [];

  for (const property of await checker.getPropertiesOfType(routeMap)) {
    const segment = property.name;

    if (segment.startsWith("__@")) continue;

    const child = await checker.getTypeOfSymbol(property);

    if (!child || child.isErrorType())
      return {
        routes: [],
        streamingResponses: [],
        error: `the route entry "${segment}" could not be resolved`,
      };

    const entryKind = await propertyElysiaRouteKind(input, property, child, routeResponse);

    if (entryKind === "websocket") continue;

    if (entryKind === "ambiguous")
      return {
        routes: [],
        streamingResponses: [],
        error: `the route entry "${segment}" has unresolved Elysia method provenance`,
      };

    const routeShape = await isRouteShape(checker, child, routeResponseSymbolId);

    if (entryKind === "http" || routeShape) {
      const route = {
        method: segment.toUpperCase(),
        path: path.length ? `/${path.join("/")}` : "/",
      };

      routes.push(route);

      const response = await successfulStreamingStatuses(input, child, routeResponse.streamTypes);

      if (response.error) return { routes: [], streamingResponses: [], error: response.error };

      if (response.statuses.length)
        streamingResponses.push({ ...route, statuses: response.statuses });

      continue;
    }

    if (!isObjectLike(child))
      return {
        routes: [],
        streamingResponses: [],
        error: `the route entry "${segment}" is neither a path node nor an Elysia HTTP method`,
      };

    const nested = await collectRouteFacts(
      input,
      child,
      routeResponse,
      [...path, segment],
      nextAncestry,
    );

    if (nested.error) return nested;

    routes.push(...nested.routes);

    streamingResponses.push(...nested.streamingResponses);
  }

  return { routes, streamingResponses };
}

async function successfulStreamingStatuses(
  input: PluginProjectInput,
  route: Type,
  streamTypes: NativeStreamTypeIdentities,
): Promise<{ readonly statuses: string[]; readonly error?: string }> {
  const checker = input.types.checker;
  const responseProperty = await checker.getPropertyOfType(route, "response");
  const response = responseProperty ? await checker.getTypeOfSymbol(responseProperty) : undefined;

  if (!response || response.isErrorType())
    return { statuses: [], error: "an HTTP route response type could not be checked" };

  const responseMaps = response.isUnionType() ? await response.getTypes() : [response];
  const statuses = new Set<string>();

  for (const responseMap of responseMaps) {
    if (responseMap.isErrorType())
      return { statuses: [], error: "an HTTP route response map contains a checker error" };

    for (const property of await checker.getPropertiesOfType(responseMap)) {
      const status = property.name;

      if (!edenSuccessStatusCodes.has(status)) continue;

      const value = await checker.getTypeOfSymbol(property);

      if (!value || value.isErrorType())
        return {
          statuses: [],
          error: `the successful response status "${status}" could not be checked`,
        };

      const containsStream = await responseContainsNativeStream(
        input,
        value,
        streamTypes,
        new Set(),
      );

      if (typeof containsStream === "string")
        return {
          statuses: [],
          error: `the successful response status "${status}" could not be classified: ${containsStream}`,
        };

      if (containsStream) statuses.add(status);
    }
  }

  return { statuses: [...statuses].sort((left, right) => Number(left) - Number(right)) };
}

async function responseContainsNativeStream(
  input: PluginProjectInput,
  type: Type,
  streamTypes: NativeStreamTypeIdentities,
  seen: Set<number>,
): Promise<boolean | string> {
  if (type.isErrorType()) return "the checker produced an error type";

  if (seen.has(type.id)) return false;

  seen.add(type.id);

  if (type.isUnionType() || type.isIntersectionType()) {
    for (const part of await type.getTypes()) {
      const containsStream = await responseContainsNativeStream(input, part, streamTypes, seen);

      if (typeof containsStream === "string" || containsStream) return containsStream;
    }

    return false;
  }

  if (!type.isTypeReference()) return false;

  const target = await type.getTarget();

  if (target.isErrorType()) return "a native stream type target could not be resolved";

  const symbol = await target.getSymbol();

  if (!symbol) return false;

  if (symbol.id === streamTypes.readableStream) return true;

  if (symbol.id === streamTypes.generator || symbol.id === streamTypes.asyncGenerator) {
    const arguments_ = await input.types.checker.getTypeArguments(type);

    if (arguments_.length < 2 || arguments_[0]!.isErrorType() || arguments_[1]!.isErrorType())
      return "the checked native generator type arguments are incomplete";

    const yields = (arguments_[0]!.flags & TypeFlags.Never) === 0;
    const acceptsVoidCompletion = await input.types.checker.isTypeAssignableTo(
      await input.types.checker.getVoidType(),
      arguments_[1]!,
    );
    return yields || acceptsVoidCompletion;
  }

  if (type.isClassOrInterface()) {
    for (const base of (await input.types.checker.getBaseTypes(type)) ?? []) {
      const containsStream = await responseContainsNativeStream(input, base, streamTypes, seen);

      if (typeof containsStream === "string" || containsStream) return containsStream;
    }
  }

  return false;
}

async function propertyElysiaRouteKind(
  input: PluginProjectInput,
  property: Symbol,
  type: Type,
  routeResponse: RouteResponseIdentity,
): Promise<"http" | "websocket" | "ambiguous" | undefined> {
  const checker = input.types.checker;
  const kinds = new Set<"http" | "websocket">();

  for (const handle of property.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (!declaration) continue;

    const nodes: TypeReferenceNode[] = [];

    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.TypeReference) nodes.push(node as TypeReferenceNode);

      node.forEachChild(visit);
    };

    visit(declaration);

    for (const reference of nodes) {
      if (identifierText(reference.typeName) !== "CreateEdenResponse") continue;

      const symbol = await checker.getSymbolAtLocation(reference.typeName);
      const target = symbol ? await resolveAliases(checker, symbol) : undefined;

      if (target?.id !== routeResponse.symbolId) continue;

      const methodName = containingMethodName(declaration.getSourceFile(), declaration);

      kinds.add(methodName === "ws" ? "websocket" : "http");
    }
  }

  if (kinds.size === 0 && (await hasElysiaResponseBranch(input, type, routeResponse)))
    kinds.add("http");

  if (kinds.size > 1) return "ambiguous";

  return kinds.values().next().value;
}

async function hasElysiaResponseBranch(
  input: PluginProjectInput,
  type: Type,
  routeResponse: RouteResponseIdentity,
): Promise<boolean> {
  const symbol = await type.getSymbol();

  if (!symbol) return false;

  for (const handle of symbol.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (declaration && routeResponse.objectBranchKeys.has(sourceNodeKey(declaration))) return true;
  }

  return false;
}

function containingMethodName(source: SourceFile, declaration: Node): string | undefined {
  const start = declaration.getStart(source);
  const end = declaration.getEnd();
  let owner: { readonly node: Node; readonly width: number } | undefined;

  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.MethodDeclaration || node.kind === SyntaxKind.MethodSignature) {
      const methodStart = node.getStart(source);
      const methodEnd = node.getEnd();
      const width = methodEnd - methodStart;

      if (methodStart <= start && methodEnd >= end && (!owner || width < owner.width))
        owner = { node, width };
    }

    node.forEachChild(visit);
  };

  visit(source);

  return owner
    ? (identifierText((owner.node as MethodNode).name) ??
        (owner.node as MethodNode).name.getText(source))
    : undefined;
}

async function isRouteShape(
  checker: PluginProjectInput["types"]["checker"],
  type: Type,
  routeResponseSymbolId: number,
): Promise<boolean> {
  if (!isObjectLike(type) || type.isErrorType()) return false;

  if (!(await hasElysiaRouteResponseAlias(type, routeResponseSymbolId))) return false;

  for (const field of ["body", "headers", "params", "query", "response"])
    if (!(await checker.getPropertyOfType(type, field))) return false;

  return true;
}

async function hasElysiaRouteResponseAlias(
  type: Type,
  routeResponseSymbolId: number,
): Promise<boolean> {
  if (type.isErrorType() || type.isUnionType()) return false;

  if ((await type.getAliasSymbol())?.id === routeResponseSymbolId) return true;

  if (!type.isIntersectionType()) return false;

  const constituents = await type.getTypes();

  if (!constituents.length) return false;

  for (const constituent of constituents)
    if (!(await hasElysiaRouteResponseAlias(constituent, routeResponseSymbolId))) return false;

  return true;
}

async function findElysiaRouteResponseIdentity(
  input: PluginProjectInput,
  type: Type,
  seen: Set<number>,
): Promise<RouteResponseIdentity | undefined> {
  if (type.isErrorType() || type.isUnionType() || seen.has(type.id)) return undefined;

  seen.add(type.id);

  const checker = input.types.checker;
  const symbol = await type.getSymbol();

  if (symbol) {
    const routeResponseSymbols = new Map<number, Symbol>();

    for (const handle of symbol.declarations) {
      const declaration = await input.types.resolveDeclaration(handle);

      if (!declaration) continue;

      const references: TypeReferenceNode[] = [];

      const visit = (node: Node): void => {
        if (node.kind === SyntaxKind.TypeReference) references.push(node as TypeReferenceNode);

        node.forEachChild(visit);
      };

      visit(declaration);

      for (const reference of references) {
        if (identifierText(reference.typeName) !== "CreateEdenResponse") continue;

        const referenced = await checker.getSymbolAtLocation(reference.typeName);
        const target = referenced ? await resolveAliases(checker, referenced) : undefined;

        if (target && (target.flags & SymbolFlags.TypeAlias) !== 0)
          routeResponseSymbols.set(target.id, target);
      }
    }

    if (routeResponseSymbols.size === 1) {
      const [symbolId, routeResponseSymbol] = routeResponseSymbols.entries().next().value!;
      const streamTypes = await nativeStreamTypeIdentities(input, routeResponseSymbol);

      if (!streamTypes) return undefined;

      return {
        symbolId,
        objectBranchKeys: await routeResponseObjectBranchKeys(input, routeResponseSymbol),
        streamTypes,
      };
    }

    if (routeResponseSymbols.size > 1) return undefined;
  }

  const relatedTypes = type.isIntersectionType()
    ? await type.getTypes()
    : type.isClassOrInterface()
      ? ((await type.getBaseTypes()) ?? [])
      : [];
  const relatedIdentities: RouteResponseIdentity[] = [];

  for (const relatedType of relatedTypes) {
    const relatedIdentity = await findElysiaRouteResponseIdentity(input, relatedType, seen);

    if (relatedIdentity) relatedIdentities.push(relatedIdentity);
  }

  const relatedSymbolIds = new Set(relatedIdentities.map((identity) => identity.symbolId));

  if (relatedSymbolIds.size !== 1) return undefined;

  const symbolId = relatedSymbolIds.values().next().value!;
  const relatedStreamTypes = new Set(
    relatedIdentities.map(
      ({ streamTypes }) =>
        `${streamTypes.generator}:${streamTypes.asyncGenerator}:${streamTypes.readableStream}`,
    ),
  );

  if (relatedStreamTypes.size !== 1) return undefined;

  return {
    symbolId,
    objectBranchKeys: new Set(
      relatedIdentities.flatMap((identity) => [...identity.objectBranchKeys]),
    ),
    streamTypes: relatedIdentities[0]!.streamTypes,
  };
}

async function nativeStreamTypeIdentities(
  input: PluginProjectInput,
  elysiaResponseType: Symbol,
): Promise<NativeStreamTypeIdentities | undefined> {
  const declarationHandle = elysiaResponseType.declarations[0];
  const declaration = declarationHandle
    ? await input.types.resolveDeclaration(declarationHandle)
    : undefined;

  if (!declaration) return undefined;

  const checker = input.types.checker;

  const resolveNativeType = async (name: string): Promise<number | undefined> => {
    const symbol = await checker.resolveName(name, SymbolFlags.Type, declaration);
    const resolved = symbol ? await resolveAliases(checker, symbol) : undefined;
    return resolved?.id;
  };

  const [generator, asyncGenerator, readableStream] = await Promise.all([
    resolveNativeType("Generator"),
    resolveNativeType("AsyncGenerator"),
    resolveNativeType("ReadableStream"),
  ]);

  if (generator === undefined || asyncGenerator === undefined || readableStream === undefined)
    return undefined;

  return { generator, asyncGenerator, readableStream };
}

async function routeResponseObjectBranchKeys(
  input: PluginProjectInput,
  routeResponseSymbol: Symbol,
): Promise<ReadonlySet<string>> {
  const keys = new Set<string>();

  for (const handle of routeResponseSymbol.declarations) {
    const declaration = await input.types.resolveDeclaration(handle);

    if (!declaration || declaration.kind !== SyntaxKind.TypeAliasDeclaration) continue;

    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.TypeLiteral) {
        keys.add(sourceNodeKey(node));

        return;
      }

      node.forEachChild(visit);
    };

    visit(declaration);
  }

  return keys;
}

function sourceNodeKey(node: Node): string {
  const source = node.getSourceFile();
  const filename = source.fileName.replaceAll("\\", "/");
  return `${process.platform === "win32" ? filename.toLowerCase() : filename}:${node.kind}:${node.getStart(source)}:${node.getEnd()}`;
}

function isObjectLike(type: Type): boolean {
  return type.isObjectType() || type.isIntersectionType();
}

function compareRouteFacts(left: AppRouteFact, right: AppRouteFact): number {
  if (left.path < right.path) return -1;

  if (left.path > right.path) return 1;

  if (left.method < right.method) return -1;

  if (left.method > right.method) return 1;

  return 0;
}

function sourceOrigin(
  input: PluginProjectInput,
  filename: string,
  source: SourceFile | undefined,
): { readonly filename: string; readonly start: number; readonly end: number } {
  const path = source?.fileName ?? resolve(input.root, filename);
  const captured =
    input.capturedSources.get(path) ??
    [...input.capturedSources.values()].find((item) => samePath(item.filename, path));
  return {
    filename: path,
    start: 0,
    end: captured?.source.length ?? 0,
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => path.replaceAll("\\", "/");

  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function routeModule(
  id: string,
  origin: { readonly filename: string; readonly start: number; readonly end: number },
  routes: readonly AppRouteFact[],
) {
  const data = JSON.stringify(routes);
  return {
    id,
    origin,
    code: `export const routes = Object.freeze(${data}.map((route) => Object.freeze(route)));\n`,
  };
}

function failed(
  origin: { readonly filename: string; readonly start: number; readonly end: number },
  message: string,
): PluginProjectResult {
  return {
    diagnostics: [{ severity: "error", origin, message }],
    browserModules: [routeModule(appRoutesModuleId, origin, [])],
  };
}
