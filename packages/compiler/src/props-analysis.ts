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
import type {
  CanonicalChild,
  CanonicalComponentProp,
  CanonicalModule,
  CompilerDiagnostic,
} from "./ir.ts";
import { checkedDataEncoding } from "./checking-origin.ts";
import {
  captureStructuralEvidence,
  retainComponentPropsTypeEvidence,
  type CheckedTypeEvidence,
  type ComponentPropTypeEvidence,
} from "./typing-inputs.ts";

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

type RenderedProp = Extract<CanonicalComponentProp, { kind: "rendered" }>;
type RenderedComponent = Extract<CanonicalChild, { kind: "component" | "await-child" }>;

const checkedRenderedProps = new WeakMap<
  ComponentPropsAnalysis,
  {
    readonly module: CanonicalModule;
    readonly encoding: string;
    readonly props: ReadonlySet<RenderedProp>;
  }
>();
const renderedPropMessage =
  "A JSX-valued component prop requires a checked ordinary Component.Props contract.";

export function isPendingRenderedPropDiagnostic(diagnostic: CompilerDiagnostic): boolean {
  return diagnostic.code === "HES-EXPRESSION" && diagnostic.message === renderedPropMessage;
}

export function unprovedRenderedPropDiagnostics(
  analysis: ComponentPropsAnalysis | undefined,
  module: CanonicalModule,
  mapOffset: (offset: number) => number = (offset) => offset,
): readonly CompilerDiagnostic[] {
  const checked = analysis && checkedRenderedProps.get(analysis);
  const admitted =
    checked?.module === module && checked.encoding === checkedDataEncoding(module, true)
      ? checked.props
      : undefined;

  return renderedPropCandidates(module).flatMap(({ prop }) =>
    admitted?.has(prop)
      ? []
      : [
          {
            code: "HES-EXPRESSION",
            severity: "error" as const,
            message: renderedPropMessage,
            span: { start: mapOffset(prop.span.start), end: mapOffset(prop.span.end) },
          },
        ],
  );
}

function renderedPropCandidates(
  module: CanonicalModule,
): readonly { readonly component: RenderedComponent; readonly prop: RenderedProp }[] {
  const candidates: { component: RenderedComponent; prop: RenderedProp }[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }

    const record = value as Record<string, unknown>;

    if (
      (record.kind === "component" || record.kind === "await-child") &&
      Array.isArray(record.props)
    ) {
      const component = value as RenderedComponent;

      for (const prop of component.props)
        if (prop.kind === "rendered") candidates.push({ component, prop });
    }

    for (const child of Object.values(record)) visit(child);
  };

  visit(module);
  return candidates;
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

interface CallExpressionNode extends Node {
  readonly expression?: Node;
  readonly arguments?: readonly Node[];
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
  includeStructuralEvidence = false,
  rendered?: {
    readonly module: CanonicalModule;
    readonly mapOffset: (offset: number) => number;
    readonly checkingSource: string;
    readonly helperFilename: string;
  },
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
  const typeEvidenceByParameterStart: Record<string, ComponentPropTypeEvidence> =
    Object.create(null);
  const diagnostics: CompilerDiagnostic[] = [];
  const trusted = await findTrustedBrands(project);

  for (const functionNode of functions)
    await analyzeFunction(
      functionNode,
      source,
      project,
      trusted,
      byParameterStart,
      typeEvidenceByParameterStart,
      includeStructuralEvidence,
      diagnostics,
      mapOffset,
    );

  const result = { byParameterStart, diagnostics };
  const encoding =
    rendered && renderedPropCandidates(rendered.module).length
      ? checkedDataEncoding(rendered.module, true)
      : undefined;

  if (
    rendered &&
    encoding !== undefined &&
    source.text === rendered.checkingSource &&
    trusted.helperSource?.fileName.replaceAll("\\", "/") ===
      rendered.helperFilename.replaceAll("\\", "/")
  ) {
    const props = await admitRenderedProps(
      project,
      source,
      trusted,
      rendered.module,
      mapOffset,
      rendered.mapOffset,
    );

    if (encoding === checkedDataEncoding(rendered.module, true))
      checkedRenderedProps.set(result, { module: rendered.module, encoding, props });
  }

  if (includeStructuralEvidence)
    retainComponentPropsTypeEvidence(result, {
      byParameterStart: typeEvidenceByParameterStart,
    });

  return result;
}

async function admitRenderedProps(
  project: Project,
  source: SourceFile,
  trusted: { readonly component: ReadonlySet<number>; readonly helperSource?: SourceFile },
  module: CanonicalModule,
  checkingOffset: (offset: number) => number,
  canonicalOffset: (offset: number) => number,
): Promise<ReadonlySet<RenderedProp>> {
  const admitted = new Set<RenderedProp>();

  if (!trusted.helperSource) return admitted;
  const calls = new Map<number, CallExpressionNode[]>();
  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.CallExpression) {
      const call = node as CallExpressionNode;

      if (call.expression?.getText(source) === "__hesperia_component") {
        const start = checkingOffset(call.getStart(source));

        calls.set(start, [...(calls.get(start) ?? []), call]);
      }
    }

    node.forEachChild(visit);
  };

  visit(source);

  for (const { component, prop } of renderedPropCandidates(module)) {
    if (prop.name === "bind" || prop.name === "key") continue;
    const matches = calls.get(canonicalOffset(component.span.start));

    if (matches?.length !== 1) continue;
    const call = matches[0]!;
    const reference = call.arguments?.[0];
    const inputs = call.arguments?.[1];

    if (
      !reference ||
      !inputs ||
      inputs.kind !== SyntaxKind.ObjectLiteralExpression ||
      checkingOffset(reference.getStart(source)) !== canonicalOffset(component.reference.span.start)
    )
      continue;

    const helper = call.expression && (await project.checker.getSymbolAtLocation(call.expression));

    if (!helper || helper.declarations.length === 0) continue;
    let trustedHelper = true;

    for (const handle of helper.declarations) {
      const declaration = await handle.resolve(project);

      if (!declaration || declaration.getSourceFile() !== trusted.helperSource)
        trustedHelper = false;
    }

    if (!trustedHelper) continue;
    const target = await project.checker.getTypeAtLocation(reference);

    if (!target) continue;
    const signatures = await project.checker.getSignaturesOfType(target, SignatureKind.Call);

    if (signatures.length !== 1) continue;
    const parameter = (await signatures[0]!.getParameters())[0];
    const mapped = parameter && (await project.checker.getTypeOfSymbol(parameter));
    const brand = mapped && (await findBrandProperty(project, mapped, trusted.component));
    const branded = brand && (await project.checker.getTypeOfSymbol(brand));
    const raw = branded && (await project.checker.getNonNullableType(branded));
    const member = raw && (await project.checker.getPropertyOfType(raw, prop.name));
    const expected = member && (await project.checker.getTypeOfSymbol(member));

    if (!expected || (await isCallable(project, expected))) continue;
    const properties = (inputs as Node & { readonly properties: readonly Node[] }).properties;
    const matching = properties.filter((property) => {
      if (
        property.kind !== SyntaxKind.PropertyAssignment ||
        checkingOffset(property.getStart(source)) !== canonicalOffset(prop.span.start)
      )
        return false;

      const name = (property as NamedDeclarationNode).name;

      if (!name || name.kind !== SyntaxKind.StringLiteral) return false;
      return (name as Node & { readonly text: string }).text === prop.name;
    });

    if (matching.length !== 1) continue;
    const initializer = (matching[0] as Node & { readonly initializer: Node }).initializer;

    if (checkingOffset(initializer.getStart(source)) !== canonicalOffset(prop.child.span.start))
      continue;

    const incoming = await project.checker.getTypeAtLocation(initializer);

    if (!incoming || incoming.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.Never))
      continue;

    if (await project.checker.isTypeAssignableTo(incoming, expected)) admitted.add(prop);
  }

  return admitted;
}

async function analyzeFunction(
  functionNode: FunctionLikeNode,
  source: SourceFile,
  project: Project,
  trusted: { readonly component: ReadonlySet<number>; readonly pageProps: ReadonlySet<number> },
  byParameterStart: Record<string, ComponentPropsMetadata>,
  typeEvidenceByParameterStart: Record<string, ComponentPropTypeEvidence>,
  includeStructuralEvidence: boolean,
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
      typeEvidenceByParameterStart,
      includeStructuralEvidence,
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
  const mappedEvidence: Record<string, CheckedTypeEvidence> = Object.create(null);

  for (const property of properties) {
    const name = String(property.name);
    const type = await project.checker.getTypeOfSymbol(property);

    if (includeStructuralEvidence)
      mappedEvidence[name] = type
        ? await captureStructuralEvidence(project, type)
        : { kind: "unproved", reason: "checker-error" };

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

  if (includeStructuralEvidence)
    typeEvidenceByParameterStart[String(parameterStart)] = { mapped: mappedEvidence };
}

async function analyzePageFunction(
  parameter: ParameterNode,
  mapped: Type,
  pageBrand: Symbol,
  sourceFile: SourceFile,
  project: Project,
  byParameterStart: Record<string, ComponentPropsMetadata>,
  typeEvidenceByParameterStart: Record<string, ComponentPropTypeEvidence>,
  includeStructuralEvidence: boolean,
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
  const mappedEvidence: Record<string, CheckedTypeEvidence> = Object.create(null);
  const authoredEvidence: Record<string, CheckedTypeEvidence> = Object.create(null);

  for (const property of mappedProperties) {
    const name = String(property.name);

    if (name.startsWith("__@")) continue;

    if (includeStructuralEvidence) {
      const mappedType = await project.checker.getTypeOfSymbol(property);

      mappedEvidence[name] = mappedType
        ? await captureStructuralEvidence(project, mappedType)
        : { kind: "unproved", reason: "checker-error" };
    }

    const authoredProperty = authoredProperties.find(
      (candidate) => String(candidate.name) === name,
    );

    if (includeStructuralEvidence && authoredProperty) {
      const authoredPropType = await project.checker.getTypeOfSymbol(authoredProperty);

      authoredEvidence[name] = authoredPropType
        ? await captureStructuralEvidence(project, authoredPropType)
        : { kind: "unproved", reason: "checker-error" };
    }

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

  if (includeStructuralEvidence)
    typeEvidenceByParameterStart[String(parameterStart)] = {
      mapped: mappedEvidence,
      ...(Object.keys(authoredEvidence).length ? { authored: authoredEvidence } : {}),
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
  readonly helperSource?: SourceFile;
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

  return { component, pageProps, helperSource: source };
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
