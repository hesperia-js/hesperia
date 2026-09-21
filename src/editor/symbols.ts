import { parseSync } from "oxc-parser";
import {
  SymbolKind,
  type DocumentSymbol,
  type Position,
  type Range,
} from "vscode-languageserver/node";

/**
 * Extract an outline from the authored TypeScript source of a document.
 *
 * Oxc offsets and editor character offsets are both UTF-16 offsets. Parsing the
 * source supplied by the editor keeps generated Hesperia helpers out of the
 * outline and also makes this usable for documents that have not been saved.
 * A source that is temporarily incomplete simply produces the symbols Oxc can
 * recover, or an empty outline when it cannot produce a program.
 * @param filename - Source filename used to select TypeScript or TSX parsing.
 * @param source - Current authored text, including unsaved changes.
 * @returns Nested declarations with full ranges and name selection ranges.
 */
export function extractDocumentSymbols(filename: string, source: string): DocumentSymbol[] {
  const lines = lineStarts(source);
  let program: Syntax | undefined;
  try {
    const lang = filename.toLowerCase().endsWith(".tsx")
      ? "tsx"
      : filename.toLowerCase().endsWith(".jsx")
        ? "jsx"
        : filename.toLowerCase().endsWith(".ts") ||
            filename.toLowerCase().endsWith(".mts") ||
            filename.toLowerCase().endsWith(".cts")
          ? "ts"
          : "js";
    program =
      node(
        parseSync(filename, source, {
          lang,
          astType: "ts",
          range: true,
          sourceType: "module",
        }).program,
      ) ?? undefined;
  } catch {
    return [];
  }
  if (!program || program.type !== "Program") return [];
  return declarationSymbols(nodes(program.body), source, lines);
}

interface Syntax {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface SymbolContext {
  readonly rangeStart?: number;
  readonly rangeEnd?: number;
}

interface Binding {
  readonly node: Syntax;
  readonly name: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

function declarationSymbols(
  statements: readonly Syntax[],
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  return statements.flatMap((statement) => {
    if (
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
    ) {
      const declaration = node(statement.declaration);
      return declaration
        ? symbolsForDeclaration(declaration, source, lines, {
            rangeStart: statement.start,
            rangeEnd: statement.end,
          })
        : [];
    }
    return symbolsForDeclaration(statement, source, lines);
  });
}

function symbolsForDeclaration(
  declaration: Syntax,
  source: string,
  lines: readonly number[],
  context: SymbolContext = {},
): DocumentSymbol[] {
  switch (declaration.type) {
    case "VariableDeclaration":
      return nodes(declaration.declarations).flatMap((item) =>
        variableSymbols(
          item,
          source,
          lines,
          {
            rangeStart: context.rangeStart ?? declaration.start,
            rangeEnd: context.rangeEnd ?? declaration.end,
          },
          declaration.kind,
        ),
      );
    case "FunctionDeclaration":
    case "TSDeclareFunction": {
      const id = node(declaration.id);
      return id
        ? [
            symbol(
              source,
              lines,
              idName(id, source),
              SymbolKind.Function,
              declaration,
              childrenForFunction(declaration, source, lines),
              context,
              id,
            ),
          ]
        : [];
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      const id = node(declaration.id);
      return id
        ? [
            symbol(
              source,
              lines,
              idName(id, source),
              SymbolKind.Class,
              declaration,
              childrenForClass(declaration, source, lines),
              context,
              id,
            ),
          ]
        : [];
    }
    case "TSInterfaceDeclaration": {
      const id = node(declaration.id);
      return id
        ? [
            symbol(
              source,
              lines,
              idName(id, source),
              SymbolKind.Interface,
              declaration,
              childrenForInterface(declaration, source, lines),
              context,
              id,
            ),
          ]
        : [];
    }
    case "TSTypeAliasDeclaration": {
      const id = node(declaration.id);
      return id
        ? [
            symbol(
              source,
              lines,
              idName(id, source),
              SymbolKind.TypeParameter,
              declaration,
              childrenForType(node(declaration.typeAnnotation), source, lines),
              context,
              id,
            ),
          ]
        : [];
    }
    case "TSEnumDeclaration": {
      const id = node(declaration.id);
      return id
        ? [
            symbol(
              source,
              lines,
              idName(id, source),
              SymbolKind.Enum,
              declaration,
              nodes(node(declaration.body)?.members).flatMap((member) =>
                enumMember(member, source, lines),
              ),
              context,
              id,
            ),
          ]
        : [];
    }
    case "TSModuleDeclaration":
    case "TSGlobalDeclaration": {
      const id = node(declaration.id);
      return id
        ? [
            symbol(
              source,
              lines,
              idName(id, source),
              SymbolKind.Namespace,
              declaration,
              declarationSymbols(nodes(node(declaration.body)?.body), source, lines),
              context,
              id,
            ),
          ]
        : [];
    }
    default:
      return [];
  }
}

function variableSymbols(
  declaration: Syntax,
  source: string,
  lines: readonly number[],
  context: SymbolContext = {},
  declarationKind: unknown = "let",
): DocumentSymbol[] {
  const id = node(declaration.id);
  if (!id) return [];
  const bindings = bindingSymbols(id, source);
  const children = childrenForExpression(node(declaration.init), source, lines);
  if (bindings.length === 1 && id.type === "Identifier") {
    const binding = bindings[0]!;
    return [
      symbol(
        source,
        lines,
        binding.name,
        declarationKind === "const" ? SymbolKind.Constant : SymbolKind.Variable,
        declaration,
        children,
        context,
        binding.node,
      ),
    ];
  }
  return bindings.map((binding) =>
    symbol(
      source,
      lines,
      binding.name,
      declarationKind === "const" ? SymbolKind.Constant : SymbolKind.Variable,
      { start: binding.rangeStart, end: binding.rangeEnd },
      [],
      {},
      binding.node,
    ),
  );
}

function childrenForFunction(
  declaration: Syntax,
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  return declarationSymbols(nodes(node(declaration.body)?.body), source, lines);
}

function childrenForClass(
  declaration: Syntax,
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  return nodes(node(declaration.body)?.body).flatMap((member) => {
    if (member.type === "MethodDefinition" || member.type === "TSAbstractMethodDefinition") {
      const key = node(member.key);
      if (!key) return [];
      return [
        symbol(
          source,
          lines,
          keyName(key, source),
          member.kind === "constructor" ? SymbolKind.Constructor : SymbolKind.Method,
          member,
          childrenForFunction(node(member.value) ?? member, source, lines),
          {},
          key,
        ),
      ];
    }
    if (
      member.type === "PropertyDefinition" ||
      member.type === "TSAbstractPropertyDefinition" ||
      member.type === "AccessorProperty"
    ) {
      const key = node(member.key);
      if (!key) return [];
      return [
        symbol(
          source,
          lines,
          keyName(key, source),
          SymbolKind.Field,
          member,
          childrenForExpression(node(member.value), source, lines),
          {},
          key,
        ),
      ];
    }
    if (member.type === "StaticBlock") return declarationSymbols(nodes(member.body), source, lines);
    return [];
  });
}

function childrenForInterface(
  declaration: Syntax,
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  return signatureSymbols(nodes(node(declaration.body)?.body), source, lines);
}

function childrenForType(
  type: Syntax | null,
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  if (!type) return [];
  if (type.type === "TSTypeLiteral") return signatureSymbols(nodes(type.members), source, lines);
  if (type.type === "TSParenthesizedType")
    return childrenForType(node(type.typeAnnotation), source, lines);
  return [];
}

function signatureSymbols(
  signatures: readonly Syntax[],
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  return signatures.flatMap((member) => {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") return [];
    const key = node(member.key);
    if (!key) return [];
    return [
      symbol(
        source,
        lines,
        keyName(key, source),
        member.type === "TSMethodSignature" ? SymbolKind.Method : SymbolKind.Property,
        member,
        member.type === "TSPropertySignature"
          ? childrenForType(node(node(member.typeAnnotation)?.typeAnnotation), source, lines)
          : [],
        {},
        key,
      ),
    ];
  });
}

function enumMember(member: Syntax, source: string, lines: readonly number[]): DocumentSymbol[] {
  const id = node(member.id);
  return id
    ? [symbol(source, lines, keyName(id, source), SymbolKind.EnumMember, member, [], {}, id)]
    : [];
}

function childrenForExpression(
  expression: Syntax | null,
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  if (!expression) return [];
  switch (expression.type) {
    case "ObjectExpression":
      return nodes(expression.properties).flatMap((property) =>
        objectProperty(property, source, lines),
      );
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return childrenForFunction(expression, source, lines);
    case "ClassExpression":
      return childrenForClass(expression, source, lines);
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSInstantiationExpression":
    case "ParenthesizedExpression":
      return childrenForExpression(node(expression.expression), source, lines);
    default:
      return [];
  }
}

function objectProperty(
  property: Syntax,
  source: string,
  lines: readonly number[],
): DocumentSymbol[] {
  if (property.type === "SpreadElement") return [];
  if (property.type !== "Property") return [];
  const key = node(property.key);
  if (!key) return [];
  const value = node(property.value);
  return [
    symbol(
      source,
      lines,
      keyName(key, source),
      property.method || value?.type === "FunctionExpression"
        ? SymbolKind.Method
        : SymbolKind.Property,
      property,
      childrenForExpression(value, source, lines),
      {},
      key,
    ),
  ];
}

function bindingSymbols(binding: Syntax, source: string): Binding[] {
  switch (binding.type) {
    case "Identifier":
      return [
        {
          node: binding,
          name: idName(binding, source),
          rangeStart: binding.start,
          rangeEnd: binding.end,
        },
      ];
    case "AssignmentPattern":
      return node(binding.left) ? bindingSymbols(node(binding.left)!, source) : [];
    case "RestElement":
      return node(binding.argument) ? bindingSymbols(node(binding.argument)!, source) : [];
    case "ObjectPattern":
      return nodes(binding.properties).flatMap((property) => {
        if (property.type === "RestElement")
          return node(property.argument) ? bindingSymbols(node(property.argument)!, source) : [];
        if (property.type !== "Property") return [];
        const value = node(property.value);
        const nested = value ? bindingSymbols(value, source) : [];
        return nested.map((item) => ({
          ...item,
          rangeStart: property.start,
          rangeEnd: property.end,
        }));
      });
    case "ArrayPattern":
      return nodes(binding.elements).flatMap((item) => bindingSymbols(item, source));
    default:
      return [];
  }
}

function symbol(
  source: string,
  lines: readonly number[],
  name: string,
  kind: SymbolKind,
  item: { readonly start: number; readonly end: number },
  children: readonly DocumentSymbol[],
  context: SymbolContext = {},
  selection: { readonly start: number; readonly end: number } = item,
): DocumentSymbol {
  const range = makeRange(
    source,
    lines,
    context.rangeStart ?? item.start,
    context.rangeEnd ?? item.end,
  );
  const selectionRange = makeRange(source, lines, selection.start, selection.end);
  return {
    name,
    kind,
    range,
    selectionRange,
    ...(children.length ? { children: [...children] } : {}),
  };
}

function idName(id: Syntax, source: string): string {
  return typeof id.name === "string" ? id.name : source.slice(id.start, id.end);
}

function keyName(key: Syntax, source: string): string {
  if (typeof key.name === "string")
    return key.type === "PrivateIdentifier" ? `#${key.name}` : key.name;
  if (typeof key.value === "string" || typeof key.value === "number") return String(key.value);
  return source.slice(key.start, key.end).trim();
}

function makeRange(source: string, lines: readonly number[], start: number, end: number): Range {
  return { start: positionAt(source, lines, start), end: positionAt(source, lines, end) };
}

function positionAt(source: string, lines: readonly number[], offset: number): Position {
  const target = Math.max(0, Math.min(offset, source.length));
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  const line = Math.max(0, low - 1);
  return { line, character: target - lines[line]! };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let offset = 0; offset < source.length; offset++) {
    const character = source.charCodeAt(offset);
    if (character === 13) {
      if (source.charCodeAt(offset + 1) === 10) offset++;
      starts.push(offset + 1);
    } else if (character === 10) starts.push(offset + 1);
  }
  return starts;
}

function node(value: unknown): Syntax | null {
  return typeof value === "object" && value !== null && "type" in value ? (value as Syntax) : null;
}

function nodes(value: unknown): Syntax[] {
  return Array.isArray(value) ? value.flatMap((item) => (node(item) ? [node(item)!] : [])) : [];
}
