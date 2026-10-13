import {
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Project,
  type Symbol,
  type Type,
} from "typescript/unstable/async";
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast";
import type { PropSchema } from "hesperia/runtime";
import type { CompilerDiagnostic } from "./ir.ts";

/** Prop metadata for one authored component parameter. */
export interface ComponentPropsMetadata {
  /** Authored start of the first component parameter. */
  readonly parameterStart: number;
  /** Authored end of the first component parameter. */
  readonly parameterEnd: number;
  /** Runtime schema keyed by the declared prop name. */
  readonly props: Readonly<Record<string, PropSchema>>;
}

/** Native-checker results keyed by the authored first-parameter start offset. */
export interface ComponentPropsAnalysis {
  /** String keys keep the result serializable across compiler stages. */
  readonly byParameterStart: Readonly<Record<string, ComponentPropsMetadata>>;
  /** Unsupported branded prop types fail closed before generation. */
  readonly diagnostics: readonly CompilerDiagnostic[];
}

interface FunctionLikeNode extends Node {
  readonly parameters?: readonly Node[];
}

interface ParameterNode extends Node {
  readonly type?: Node;
}

interface NamedDeclarationNode extends Node {
  readonly name?: Node;
  readonly type?: Node;
}

interface ComputedNameNode extends Node {
  readonly expression?: Node;
}

interface ImportTypeNode extends Node {
  readonly argument?: Node;
  readonly qualifier?: Node;
}

/**
 * Recover runtime prop contracts from the native TypeScript checker.
 *
 * Syntax traversal stays local and deterministic. Semantic requests then run
 * sequentially in source order, and the result retains only plain data for
 * emission after the project snapshot is disposed.
 *
 * @param project Native TypeScript project from an open checking session.
 * @param filename Absolute authored source filename in that project.
 * @param mapOffset Converts checking-view offsets back to authored source offsets.
 * @returns A promise for serializable prop metadata and diagnostics. Native checker failures reject
 * the promise and must be followed by disposal of the owning checking session.
 */
export async function analyzeComponentProps(
  project: Project,
  filename: string,
  mapOffset: (offset: number) => number = (offset) => offset,
): Promise<ComponentPropsAnalysis> {
  const source = await project.program.getSourceFile(filename);

  if (!source) return { byParameterStart: {}, diagnostics: [] };

  const functions: FunctionLikeNode[] = [];

  const collectFunctions = (node: Node): void => {
    if (
      node.kind === SyntaxKind.FunctionDeclaration ||
      node.kind === SyntaxKind.FunctionExpression ||
      node.kind === SyntaxKind.ArrowFunction
    )
      functions.push(node as FunctionLikeNode);

    node.forEachChild(collectFunctions);
  };

  collectFunctions(source);

  const byParameterStart: Record<string, ComponentPropsMetadata> = {};
  const diagnostics: CompilerDiagnostic[] = [];
  const trusted = await findTrustedBrands(project);

  for (const functionNode of functions)
    await analyzeFunction(
      functionNode,
      source,
      project,
      trusted,
      byParameterStart,
      diagnostics,
      mapOffset,
    );

  return { byParameterStart, diagnostics };
}

async function analyzeFunction(
  functionNode: FunctionLikeNode,
  source: SourceFile,
  project: Project,
  trusted: { readonly component: ReadonlySet<number>; readonly pageProps: ReadonlySet<number> },
  byParameterStart: Record<string, ComponentPropsMetadata>,
  diagnostics: CompilerDiagnostic[],
  mapOffset: (offset: number) => number,
): Promise<void> {
  const parameter = functionNode.parameters?.[0] as ParameterNode | undefined;

  if (!parameter) return;

  const mapped = await project.checker.getTypeAtLocation(parameter.type ?? parameter);

  if (!mapped) return;

  const pageBrand = await findBrandProperty(project, mapped, trusted.pageProps);
  const brand = await findBrandProperty(project, mapped, trusted.component);

  if (!pageBrand && !brand) return;

  if (pageBrand) {
    await analyzePageFunction(
      parameter,
      mapped,
      pageBrand,
      source,
      project,
      byParameterStart,
      diagnostics,
      mapOffset,
    );

    return;
  }

  if (!brand) return;

  const branded = await project.checker.getTypeOfSymbol(brand);
  const raw = branded ? await project.checker.getNonNullableType(branded) : undefined;

  if (!raw) {
    diagnostics.push(
      unsupported(parameter, mapOffset, "The component prop type could not be resolved."),
    );

    return;
  }

  const properties = await project.checker.getPropertiesOfType(raw);

  if (properties.length === 0 && !raw.isObjectType() && !raw.isTypeParameter()) {
    diagnostics.push(
      unsupported(parameter, mapOffset, "The component prop type could not be resolved."),
    );

    return;
  }

  if ((await project.checker.getIndexInfosOfType(raw)).length) {
    diagnostics.push(
      unsupported(
        parameter,
        mapOffset,
        "Component props must expose named properties so their runtime contract can be emitted.",
      ),
    );

    return;
  }

  const props: Record<string, PropSchema> = {};

  for (const property of properties) {
    const name = String(property.name);
    const type = await project.checker.getTypeOfSymbol(property);

    Object.defineProperty(props, name, {
      configurable: true,
      enumerable: true,
      value: {
        kind:
          name === "bind"
            ? "binding"
            : type && (await isCallable(project, type))
              ? "callback"
              : "value",
        optional: Boolean(property.flags & SymbolFlags.Optional),
      },
      writable: true,
    });
  }

  const parameterStart = mapOffset(parameter.getStart(source));
  byParameterStart[String(parameterStart)] = {
    parameterStart,
    parameterEnd: mapOffset(parameter.end),
    props,
  };
}

async function analyzePageFunction(
  parameter: ParameterNode,
  mapped: Type,
  pageBrand: Symbol,
  sourceFile: SourceFile,
  project: Project,
  byParameterStart: Record<string, ComponentPropsMetadata>,
  diagnostics: CompilerDiagnostic[],
  mapOffset: (offset: number) => number,
): Promise<void> {
  const authoredType = await project.checker.getTypeOfSymbol(pageBrand);
  const authored = authoredType
    ? await project.checker.getNonNullableType(authoredType)
    : undefined;

  if (!authored) {
    diagnostics.push(
      unsupported(parameter, mapOffset, "The page prop type could not be resolved."),
    );

    return;
  }

  const authoredProperties = await project.checker.getPropertiesOfType(authored);
  const authoredQuery = authoredProperties.find(
    (property) => String(property.name) === "queryParams",
  );

  if (authoredQuery) {
    const queryType = await project.checker.getTypeOfSymbol(authoredQuery);
    const query = queryType ? await project.checker.getNonNullableType(queryType) : undefined;

    if (!query) return;

    for (const property of await project.checker.getPropertiesOfType(query)) {
      const type = await project.checker.getTypeOfSymbol(property);

      if (!type || !(await isStringOrUndefined(type))) {
        diagnostics.push(
          unsupported(
            parameter,
            mapOffset,
            `Page query parameter ${String(property.name)} must be string or optional string.`,
          ),
        );

        break;
      }
    }
  }

  if ((await project.checker.getIndexInfosOfType(authored)).length) {
    diagnostics.push(
      unsupported(
        parameter,
        mapOffset,
        "Page props must expose named properties so their runtime contract can be emitted.",
      ),
    );

    return;
  }

  const mappedProperties = await project.checker.getPropertiesOfType(mapped);
  const props: Record<string, PropSchema> = {};

  for (const property of mappedProperties) {
    const name = String(property.name);

    if (name.startsWith("__@")) continue;

    const authoredProperty = authoredProperties.find(
      (candidate) => String(candidate.name) === name,
    );
    const plain = name === "params" || name === "queryParams";
    let callback = false;

    if (!plain && name !== "bind" && authoredProperty) {
      const authoredType = await project.checker.getTypeOfSymbol(authoredProperty);
      callback = Boolean(authoredType && (await isCallable(project, authoredType)));
    }

    Object.defineProperty(props, name, {
      configurable: true,
      enumerable: true,
      value: {
        kind: plain ? "plain" : name === "bind" ? "binding" : callback ? "callback" : "value",
        optional: authoredProperty
          ? Boolean(authoredProperty.flags & SymbolFlags.Optional)
          : name === "bind",
      },
      writable: true,
    });
  }

  const parameterStart = mapOffset(parameter.getStart(sourceFile));
  byParameterStart[String(parameterStart)] = {
    parameterStart,
    parameterEnd: mapOffset(parameter.end),
    props,
  };
}

async function findBrandProperty(
  project: Project,
  mapped: Type,
  expected: ReadonlySet<number>,
): Promise<Symbol | undefined> {
  if (expected.size === 0) return undefined;

  for (const property of await project.checker.getPropertiesOfType(mapped)) {
    for (const handle of property.declarations) {
      const declaration = (await handle.resolve(project)) as NamedDeclarationNode | undefined;
      const name = declaration?.name as ComputedNameNode | undefined;

      if (!declaration || declaration.kind !== SyntaxKind.PropertySignature) continue;

      if (!name || name.kind !== SyntaxKind.ComputedPropertyName || !name.expression) continue;

      const brand = await project.checker.getSymbolAtLocation(name.expression);

      if (brand && expected.has(brand.id)) return property;
    }
  }

  return undefined;
}

async function findTrustedBrands(project: Project): Promise<{
  readonly component: ReadonlySet<number>;
  readonly pageProps: ReadonlySet<number>;
}> {
  const component = new Set<number>();
  const pageProps = new Set<number>();
  const virtualSource = (await project.program.getSourceFileNames()).find((filename) =>
    filename.replaceAll("\\", "/").endsWith("/.hesperia/jsx.d.ts"),
  );

  if (!virtualSource) return { component, pageProps };

  const source = await project.program.getSourceFile(virtualSource);

  if (!source) return { component, pageProps };

  const imports: { readonly qualifier: Node; readonly name: string }[] = [];

  const collectImports = (node: Node): void => {
    if (node.kind === SyntaxKind.ImportType) {
      const importType = node as ImportTypeNode;
      const qualifier = importType.qualifier;
      const name = qualifier?.getText(source);

      if (
        qualifier &&
        importType.argument?.getText(source) === '"hesperia/runtime"' &&
        (name === "ComponentProps" || name === "PagePropsBrand")
      )
        imports.push({ qualifier, name });
    }

    node.forEachChild(collectImports);
  };

  collectImports(source);

  for (const item of imports) {
    const exported = await project.checker.getSymbolAtLocation(item.qualifier);

    if (!exported) continue;

    const target = item.name === "ComponentProps" ? component : pageProps;

    await addBrandSymbols(project, await project.checker.getAliasedSymbol(exported), target);
  }

  return { component, pageProps };
}

async function addBrandSymbols(
  project: Project,
  target: Symbol,
  brands: Set<number>,
): Promise<void> {
  for (const handle of target.declarations) {
    const declaration = (await handle.resolve(project)) as NamedDeclarationNode | undefined;

    if (!declaration || declaration.kind !== SyntaxKind.TypeAliasDeclaration || !declaration.type)
      continue;

    const expressions: Node[] = [];

    const collectBrandExpressions = (node: Node): void => {
      if (node.kind === SyntaxKind.PropertySignature) {
        const property = node as NamedDeclarationNode;
        const name = property.name as ComputedNameNode | undefined;

        if (name?.kind === SyntaxKind.ComputedPropertyName && name.expression)
          expressions.push(name.expression);
      }

      node.forEachChild(collectBrandExpressions);
    };

    collectBrandExpressions(declaration.type);

    for (const expression of expressions) {
      const brand = await project.checker.getSymbolAtLocation(expression);

      if (brand) brands.add(brand.id);
    }
  }
}

async function isCallable(project: Project, type: Type): Promise<boolean> {
  return (await project.checker.getSignaturesOfType(type, SignatureKind.Call)).length !== 0;
}

async function isStringOrUndefined(type: Type): Promise<boolean> {
  if (!type.isUnionType())
    return Boolean(type.flags & (TypeFlags.StringLike | TypeFlags.Undefined));

  const types = await type.getTypes();

  if (!types) return false;

  for (const member of types) if (!(await isStringOrUndefined(member))) return false;

  return true;
}

function unsupported(
  parameter: Node,
  mapOffset: (offset: number) => number,
  message: string,
): CompilerDiagnostic {
  return {
    code: "HES-PROPS",
    severity: "error",
    message,
    span: {
      start: mapOffset(parameter.getStart(parameter.getSourceFile())),
      end: mapOffset(parameter.end),
    },
  };
}
