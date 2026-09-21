import {
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Project,
  type Symbol,
  type Type,
} from "typescript/unstable/sync";
import { SyntaxKind, type Node } from "typescript/unstable/ast";
import type { PropSchema } from "../runtime/components.ts";
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

/**
 * Recover runtime prop contracts from the native TypeScript checker.
 *
 * The checker sees the checking view, so `mapOffset` converts its generated
 * offsets back to authored offsets. The result is intentionally data-only;
 * generation can carry it into `defineComponent` without retaining checker
 * objects or parsing authored type syntax a second time.
 */
export function analyzeComponentProps(
  project: Project,
  filename: string,
  mapOffset: (offset: number) => number = (offset) => offset,
): ComponentPropsAnalysis {
  const source = project.program.getSourceFile(filename);
  if (!source) return { byParameterStart: {}, diagnostics: [] };
  const byParameterStart: Record<string, ComponentPropsMetadata> = {};
  const diagnostics: CompilerDiagnostic[] = [];
  const trusted = findTrustedBrands(project);

  const visit = (node: Node): void => {
    if (
      node.kind === SyntaxKind.FunctionDeclaration ||
      node.kind === SyntaxKind.FunctionExpression ||
      node.kind === SyntaxKind.ArrowFunction
    ) {
      analyzeFunction(node as FunctionLikeNode);
    }
    node.forEachChild(visit);
  };

  const analyzeFunction = (functionNode: FunctionLikeNode): void => {
    const parameter = functionNode.parameters?.[0] as ParameterNode | undefined;
    if (!parameter) return;
    const mapped = project.checker.getTypeAtLocation(parameter.type ?? parameter);
    if (!mapped) return;
    const pageBrand = findBrandProperty(project, mapped, trusted.pageProps);
    const brand = findBrandProperty(project, mapped, trusted.component);
    if (!pageBrand && !brand) return;
    if (pageBrand) {
      analyzePageFunction(parameter, mapped, pageBrand, source);
      return;
    }
    if (!brand) return;
    const branded = project.checker.getTypeOfSymbol(brand);
    const raw = branded && project.checker.getNonNullableType(branded);
    if (!raw) {
      diagnostics.push(
        unsupported(parameter, mapOffset, "The component prop type could not be resolved."),
      );
      return;
    }
    const properties = project.checker.getPropertiesOfType(raw);
    if (properties.length === 0 && !raw.isObjectType() && !raw.isTypeParameter()) {
      diagnostics.push(
        unsupported(parameter, mapOffset, "The component prop type could not be resolved."),
      );
      return;
    }
    if (project.checker.getIndexInfosOfType(raw).length) {
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
      const type = project.checker.getTypeOfSymbol(property);
      Object.defineProperty(props, name, {
        configurable: true,
        enumerable: true,
        value: {
          kind:
            name === "bind" ? "binding" : type && isCallable(project, type) ? "callback" : "value",
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
  };

  visit(source);
  return { byParameterStart, diagnostics };

  function analyzePageFunction(
    parameter: ParameterNode,
    mapped: Type,
    pageBrand: Symbol,
    sourceFile: NonNullable<typeof source>,
  ): void {
    const authoredType = project.checker.getTypeOfSymbol(pageBrand);
    const authored = authoredType && project.checker.getNonNullableType(authoredType);
    if (!authored) {
      diagnostics.push(
        unsupported(parameter, mapOffset, "The page prop type could not be resolved."),
      );
      return;
    }
    const authoredQuery = project.checker
      .getPropertiesOfType(authored)
      .find((property) => String(property.name) === "queryParams");
    if (authoredQuery) {
      const queryType = project.checker.getTypeOfSymbol(authoredQuery);
      const query = queryType && project.checker.getNonNullableType(queryType);
      if (!query) return;
      for (const property of project.checker.getPropertiesOfType(query)) {
        const type = project.checker.getTypeOfSymbol(property);
        if (!type || !isStringOrUndefined(type)) {
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
    if (project.checker.getIndexInfosOfType(authored).length) {
      diagnostics.push(
        unsupported(
          parameter,
          mapOffset,
          "Page props must expose named properties so their runtime contract can be emitted.",
        ),
      );
      return;
    }
    const props: Record<string, PropSchema> = {};
    for (const property of project.checker.getPropertiesOfType(mapped)) {
      const name = String(property.name);
      if (name.startsWith("__@")) continue;
      const authoredProperty = project.checker
        .getPropertiesOfType(authored)
        .find((candidate) => String(candidate.name) === name);
      const plain = name === "params" || name === "queryParams";
      Object.defineProperty(props, name, {
        configurable: true,
        enumerable: true,
        value: {
          kind: plain
            ? "plain"
            : name === "bind"
              ? "binding"
              : authoredProperty &&
                  (() => {
                    const authoredType = project.checker.getTypeOfSymbol(authoredProperty);
                    return authoredType ? isCallable(project, authoredType) : false;
                  })()
                ? "callback"
                : "value",
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
}

function findBrandProperty(
  project: Project,
  mapped: Type,
  expected: ReadonlySet<number>,
): Symbol | undefined {
  if (expected.size === 0) return undefined;
  for (const property of project.checker.getPropertiesOfType(mapped)) {
    for (const handle of property.declarations) {
      const declaration = handle.resolve(project) as NamedDeclarationNode | undefined;
      const name = declaration?.name as ComputedNameNode | undefined;
      if (!declaration || declaration.kind !== SyntaxKind.PropertySignature) continue;
      if (!name || name.kind !== SyntaxKind.ComputedPropertyName || !name.expression) continue;
      const brand = project.checker.getSymbolAtLocation(name.expression);
      if (!brand) continue;
      if (expected.has(brand.id)) return property;
    }
  }
  return undefined;
}

function findTrustedBrands(project: Project): {
  readonly component: ReadonlySet<number>;
  readonly pageProps: ReadonlySet<number>;
} {
  const component = new Set<number>();
  const pageProps = new Set<number>();
  const virtualSource = project.program
    .getSourceFileNames()
    .find((filename) => filename.replaceAll("\\", "/").endsWith("/.hesperia/jsx.d.ts"));
  if (!virtualSource) return { component, pageProps };
  const source = project.program.getSourceFile(virtualSource);
  if (!source) return { component, pageProps };
  const visitImportType = (node: Node): void => {
    if (node.kind === SyntaxKind.ImportType) {
      const importType = node as Node & {
        readonly argument?: Node;
        readonly qualifier?: Node;
      };
      const qualifier = importType.qualifier?.getText(source);
      if (
        importType.argument?.getText(source) === '"hesperia/runtime"' &&
        (qualifier === "ComponentProps" || qualifier === "PagePropsBrand")
      ) {
        if (!importType.qualifier) return;
        const exported = project.checker.getSymbolAtLocation(importType.qualifier);
        const target = qualifier === "ComponentProps" ? component : pageProps;
        if (exported) addBrandSymbols(project, project.checker.getAliasedSymbol(exported), target);
      }
    }
    node.forEachChild(visitImportType);
  };
  visitImportType(source);
  return { component, pageProps };
}

function addBrandSymbols(project: Project, target: Symbol, brands: Set<number>): void {
  for (const handle of target.declarations) {
    const declaration = handle.resolve(project) as NamedDeclarationNode | undefined;
    if (!declaration || declaration.kind !== SyntaxKind.TypeAliasDeclaration) continue;
    const type = declaration.type;
    if (!type) continue;
    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.PropertySignature) {
        const property = node as NamedDeclarationNode;
        const name = property.name as ComputedNameNode | undefined;
        if (name?.kind === SyntaxKind.ComputedPropertyName && name.expression) {
          const brand = project.checker.getSymbolAtLocation(name.expression);
          if (brand) brands.add(brand.id);
        }
      }
      node.forEachChild(visit);
    };
    visit(type);
  }
}

function isCallable(project: Project, type: Type): boolean {
  return project.checker.getSignaturesOfType(type, SignatureKind.Call).length !== 0;
}

function isStringOrUndefined(type: Type): boolean {
  if (type.isUnionType()) return type.getTypes().every(isStringOrUndefined);
  return Boolean(type.flags & (TypeFlags.StringLike | TypeFlags.Undefined));
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
