import {
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Project,
  type Symbol,
  type Type,
} from "typescript/unstable/async";
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast";
import type { CompilerDiagnostic, SourceSpan } from "./ir.ts";

/** Checked argument placement for an authored contract operation call. */
export interface OperationCallMetadata {
  /** Exact authored call span, independent of normalized JavaScript offsets. */
  readonly span: SourceSpan;
  /** Explicit argument position required to preserve the checked interpretation. */
  readonly argument: "input" | "options";
}

/** Serializable call decisions retained after the native checking snapshot is disposed. */
export interface OperationCallAnalysis {
  /** Decisions keyed by authored start and end offsets. */
  readonly bySpan: Readonly<Record<string, OperationCallMetadata>>;
  /** Checked overlap and unsupported options-only calls prevent emission. */
  readonly diagnostics: readonly CompilerDiagnostic[];
}

interface CallNode extends Node {
  readonly expression: Node;
  readonly arguments: readonly Node[];
}

interface TypeNode extends Node {
  readonly typeName?: Node;
  readonly qualifier?: Node;
  readonly argument?: Node;
}

interface DeclarationNode extends Node {
  readonly type?: Node;
  readonly name?: Node;
}

interface ComputedNameNode extends Node {
  readonly expression?: Node;
}

interface ImportNode extends Node {
  readonly moduleSpecifier?: Node;
}

/**
 * Resolve the actual public contract declarations once for a checking project.
 * The returned analyzer retains native handles only while that project is open;
 * its results contain authored spans, placement decisions and diagnostics.
 */
export async function createOperationCallAnalyzer(
  project: Project,
): Promise<
  (filename: string, mapOffset: (offset: number) => number) => Promise<OperationCallAnalysis>
> {
  const declarations = new Set<string>();
  const optionSymbols = new Set<number>();
  const brands = new Set<number>();
  const visited = new Set<number>();

  const followAlias = async (symbol: Symbol): Promise<Symbol> =>
    symbol.flags & SymbolFlags.Alias ? project.checker.getAliasedSymbol(symbol) : symbol;

  const collectAlias = async (symbol: Symbol): Promise<void> => {
    const target = await followAlias(symbol);

    if (visited.has(target.id)) return;

    visited.add(target.id);

    for (const handle of target.declarations) {
      const declaration = (await handle.resolve(project)) as DeclarationNode | undefined;

      if (declaration?.kind !== SyntaxKind.TypeAliasDeclaration || !declaration.type) continue;

      const references: Node[] = [];

      const walk = (node: Node): void => {
        if (node.kind === SyntaxKind.FunctionType) declarations.add(nodeKey(node));

        if (node.kind === SyntaxKind.TypeReference) {
          const name = (node as TypeNode).typeName;

          if (name) references.push(name);
        } else if (node.kind === SyntaxKind.ImportType) {
          const qualifier = (node as TypeNode).qualifier;

          if (qualifier) references.push(qualifier);
        }

        node.forEachChild(walk);
      };

      walk(declaration.type);

      for (const reference of references) {
        const referenced = await project.checker.getSymbolAtLocation(reference);

        if (referenced) await collectAlias(referenced);
      }
    }
  };

  const sourceNames = await project.program.getSourceFileNames();
  const anchorName = sourceNames.find((name) =>
    name.replaceAll("\\", "/").endsWith("/.hesperia/jsx.d.ts"),
  );
  const anchor = anchorName ? await project.program.getSourceFile(anchorName) : undefined;

  if (anchor) {
    const imports: TypeNode[] = [];

    const collect = (node: Node): void => {
      if (node.kind === SyntaxKind.ImportType) imports.push(node as TypeNode);

      node.forEachChild(collect);
    };

    collect(anchor);

    for (const item of imports) {
      if (!item.qualifier) continue;

      const moduleName = item.argument?.getText(anchor);
      const exportName = item.qualifier.getText(anchor);

      if (moduleName !== '"aeolia"' && moduleName !== '"hesperia/aeolia"') continue;

      const symbol = await project.checker.getSymbolAtLocation(item.qualifier);

      if (!symbol) continue;

      const target = await followAlias(symbol);

      if (exportName === "StoreOptions" || exportName === "MutationOptions")
        optionSymbols.add(target.id);
      else if (exportName === "ContractApi" || exportName === "ImportedApi")
        await collectAlias(target);
      else if (exportName === "queryOptions") {
        for (const handle of target.declarations) {
          const declaration = await handle.resolve(project);

          if (!declaration) continue;

          const names: Node[] = [];

          const walk = (node: Node): void => {
            if (node.kind === SyntaxKind.ComputedPropertyName) {
              const expression = (node as ComputedNameNode).expression;

              if (expression) names.push(expression);
            }

            node.forEachChild(walk);
          };

          const returnType = (declaration as DeclarationNode).type;

          if (returnType) walk(returnType);

          for (const name of names) {
            const brand = await project.checker.getSymbolAtLocation(name);

            if (brand) brands.add((await followAlias(brand)).id);
          }
        }
      }
    }
  }

  // The optional provider contributes its actual resolved public type, only when loaded.
  for (const name of sourceNames) {
    const source = await project.program.getSourceFile(name);

    if (!source) continue;

    for (const statement of source.statements) {
      if (statement.kind !== SyntaxKind.ImportDeclaration) continue;

      const specifier = (statement as ImportNode).moduleSpecifier;

      if (specifier?.getText(source).slice(1, -1) !== "@hesperia/elysia/client") continue;

      const module = await project.checker.getSymbolAtLocation(specifier);
      const exported = module
        ? await project.checker.getMemberInModuleExports(module, "ElysiaHttpApi")
        : undefined;

      if (exported) await collectAlias(exported);
    }
  }

  const isOptions = async (type: Type): Promise<boolean> => {
    const raw = await project.checker.getNonNullableType(type);
    const symbol = await raw?.getSymbol();
    return symbol !== undefined && optionSymbols.has(symbol.id);
  };

  const isInputless = async (type: Type): Promise<boolean> => {
    if (type.isUnionType()) {
      const members = await type.getTypes();

      for (const member of members) if (!(await isInputless(member))) return false;

      return members.length !== 0;
    }

    return Boolean(type.flags & (TypeFlags.Void | TypeFlags.Undefined));
  };

  const isBranded = async (type: Type): Promise<boolean> => {
    for (const property of await project.checker.getPropertiesOfType(type)) {
      for (const handle of property.declarations) {
        const declaration = (await handle.resolve(project)) as DeclarationNode | undefined;
        const name = declaration?.name as ComputedNameNode | undefined;

        if (name?.kind !== SyntaxKind.ComputedPropertyName || !name.expression) continue;

        const symbol = await project.checker.getSymbolAtLocation(name.expression);

        if (symbol && brands.has((await followAlias(symbol)).id)) return true;
      }
    }

    return false;
  };

  return async (filename, mapOffset) => {
    const bySpan: Record<string, OperationCallMetadata> = {};
    const diagnostics: CompilerDiagnostic[] = [];
    const source = await project.program.getSourceFile(filename);

    if (!source || declarations.size === 0) return { bySpan, diagnostics };

    const calls: CallNode[] = [];

    const collect = (node: Node): void => {
      if (node.kind === SyntaxKind.CallExpression) calls.push(node as CallNode);

      node.forEachChild(collect);
    };

    collect(source);

    for (const call of calls) {
      const argument = call.arguments.length === 1 ? call.arguments[0] : undefined;

      if (!argument || argument.kind === SyntaxKind.SpreadElement) continue;

      const callable = await project.checker.getTypeAtLocation(call.expression);

      if (!callable) continue;

      const candidates: { input: Type; options: Type }[] = [];

      for (const signature of await project.checker.getSignaturesOfType(
        callable,
        SignatureKind.Call,
      )) {
        const declaration = await signature.declaration?.resolve(project);

        if (!declaration || !declarations.has(nodeKey(declaration))) continue;

        const input = await project.checker.getParameterType(signature, 0);
        const options = await project.checker.getParameterType(signature, 1);

        if (input && options && (await isOptions(options))) {
          const definedOptions = await project.checker.getNonNullableType(options);

          if (definedOptions) candidates.push({ input, options: definedOptions });
        }
      }

      if (!candidates.length) continue;

      const type = await project.checker.getTypeAtLocation(argument);

      if (!type || type.isErrorType()) continue;

      const span = authoredSpan(call, source, mapOffset);
      const branded = await isBranded(type);
      let inputMatch = false;
      let optionsMatch = false;
      let inputless = true;

      for (const candidate of candidates) {
        inputMatch ||= await project.checker.isTypeAssignableTo(type, candidate.input);
        optionsMatch ||= await project.checker.isTypeAssignableTo(type, candidate.options);
        inputless &&= await isInputless(candidate.input);
      }

      const fault = (message: string): void => {
        diagnostics.push({ code: "HES-API-CALL", severity: "error", message, span });
      };

      if (branded) {
        if (!inputless)
          fault(
            "This operation declares an input. Supply its input and queryOptions in separate arguments.",
          );
        else bySpan[`${span.start}:${span.end}`] = { span, argument: "options" };
      } else if (inputless && optionsMatch) {
        bySpan[`${span.start}:${span.end}`] = { span, argument: "options" };
      } else if (inputMatch && optionsMatch) {
        fault(
          "This argument matches both the operation input and its options. Supply input and options explicitly as two arguments, or use queryOptions for an inputless operation.",
        );
      } else if (inputMatch) {
        bySpan[`${span.start}:${span.end}`] = { span, argument: "input" };
      } else if (optionsMatch && !inputless) {
        fault(
          "This operation declares an input. Supply its input and options explicitly as two arguments.",
        );
      }
    }

    return { bySpan, diagnostics };
  };
}

function nodeKey(node: Node): string {
  const source = node.getSourceFile();
  return `${source.fileName.replaceAll("\\", "/").toLowerCase()}:${node.getStart(source)}:${node.end}`;
}

function authoredSpan(
  node: Node,
  source: SourceFile,
  mapOffset: (offset: number) => number,
): SourceSpan {
  const start = mapOffset(node.getStart(source));
  return { start, end: Math.max(start, mapOffset(node.end - 1) + 1) };
}
