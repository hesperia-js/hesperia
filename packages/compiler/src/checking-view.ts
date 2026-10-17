import { parseSync } from "oxc-parser";
import type { CompilerDiagnostic } from "./ir.ts";
import type { NativeEventHandlerContext } from "./event-options.ts";
import { childNamespace, namespaceForTag, type NamespaceContext } from "./namespace.ts";

/** Authored-to-checking source mapping shared by diagnostics and editor positions. */
export interface CheckingView {
  readonly source: string;
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly mapOffset: (offset: number) => number;
  readonly generatedOffset: (offset: number) => number;
}

type Syntax = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
};

interface Piece {
  text: string;
  offsets: number[];
}

/** Compiler-only route context used to specialize trusted Page.Props types. */
export interface CheckingViewOptions {
  readonly pageRouteContext?: string;
  /** Exact import and export source replacements used by project resolution overrides. */
  readonly importReplacements?: Readonly<Record<string, string>>;
  /** Recognized inline native handlers that need tag-specific checker context. */
  readonly nativeEventHandlers?: readonly NativeEventHandlerContext[];
}

/** Preserve author expressions while replacing JSX syntax with typed checking calls. */
export function checkingView(
  source: string,
  filename: string,
  allowUnsafeHTML: boolean,
  options: CheckingViewOptions = {},
): CheckingView {
  const parsed = parseSync(filename, source, {
    lang: filename.endsWith(".tsx") ? "tsx" : "ts",
    astType: "ts",
    range: true,
    sourceType: "module",
  });
  const diagnostics: CompilerDiagnostic[] = parsed.errors.map((error) => ({
    code: "HES-OXC",
    severity: error.severity === "Warning" ? "warning" : "error",
    message: error.message,
    ...(error.labels[0]
      ? { span: { start: error.labels[0].start, end: error.labels[0].end } }
      : {}),
  }));
  const root = parsed.program as unknown as Syntax;
  const importRanges = options.importReplacements
    ? importSourceRanges(root, options.importReplacements)
    : [];
  const routeTypeRanges = options.pageRouteContext ? parameterTypeRanges(root) : [];
  const handlerContextRanges = resolveNativeHandlerRanges(
    root,
    source,
    options.nativeEventHandlers ?? [],
  ).flatMap((context) => [
    { start: context.start, end: context.start, prefix: "(" },
    {
      start: context.end,
      end: context.end,
      suffix: `) satisfies HesperiaNativeEventHandler<${JSON.stringify(context.tag)},${JSON.stringify(context.namespace)},${JSON.stringify(context.eventName)}>`,
    },
  ]);
  const closingNames: { opening: Syntax; closing: Syntax }[] = [];
  const namespaces = new Set<string>();
  const functions = new Set<string>();

  for (const statement of nodes(root.body)) {
    if (statement.type !== "ImportDeclaration") continue;

    const module = node(statement.source)?.value;

    if (module !== "hesperia/client" && module !== "hesperia") continue;

    for (const specifier of nodes(statement.specifiers)) {
      const local = node(specifier.local)?.name;
      const imported = node(specifier.imported)?.name;

      if (typeof local !== "string") continue;

      if (
        (specifier.type === "ImportNamespaceSpecifier" && module === "hesperia/client") ||
        imported === "client"
      )
        namespaces.add(local);

      if (imported === "unsafeHTML") functions.add(local);
    }
  }

  walk(root, (item) => {
    if (allowUnsafeHTML || item.type !== "CallExpression") return;

    const callee = node(item.callee);
    const object = node(callee?.object);
    const property = node(callee?.property);
    const direct = callee?.type === "Identifier" && functions.has(String(callee.name));
    const member =
      callee?.type === "MemberExpression" &&
      object?.type === "Identifier" &&
      namespaces.has(String(object.name)) &&
      (property?.name === "unsafeHTML" || property?.value === "unsafeHTML");

    if (direct || member)
      diagnostics.push({
        code: "HES-RAW-DISABLED",
        severity: "error",
        message: "unsafeHTML requires allowUnsafeHTML in the project configuration.",
        span: { start: item.start, end: item.end },
      });
  });

  const literal = (text: string, anchor: number): Piece => ({
    text,
    offsets: Array(text.length).fill(anchor),
  });

  const copySource = (start: number, end: number): Piece => ({
    text: source.slice(start, end),
    offsets: Array.from({ length: end - start }, (_, index) => start + index),
  });

  const copy = (start: number, end: number): Piece => {
    const ranges: CheckingReplacementRange[] = [
      ...routeTypeRanges.map((range) => ({ ...range })),
      ...importRanges,
      ...handlerContextRanges,
    ]
      .filter((range) => range.start >= start && range.end <= end)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    if (!ranges.length) return copySource(start, end);

    const parts: Piece[] = [];
    let cursor = start;

    for (const range of ranges) {
      if (range.start < cursor) continue;

      parts.push(copySource(cursor, range.start));

      if (range.start === range.end) {
        if (range.prefix) parts.push(literal(range.prefix, range.start));

        if (range.replacement !== undefined)
          parts.push(literal(JSON.stringify(range.replacement), range.start));

        if (range.suffix) parts.push(literal(range.suffix, range.start));
      } else if (range.replacement !== undefined) {
        parts.push(literal(JSON.stringify(range.replacement), range.start));
      } else {
        parts.push(
          literal('import("hesperia/runtime").AtPageRoute<', range.start),
          copySource(range.start, range.end),
          literal(`, ${options.pageRouteContext}>`, range.end),
        );
      }

      cursor = range.end;
    }

    parts.push(copySource(cursor, end));

    return concat(...parts);
  };

  const concat = (...parts: Piece[]): Piece => ({
    text: parts.map((part) => part.text).join(""),
    offsets: parts.flatMap((part) => part.offsets),
  });

  const join = (parts: Piece[], separator: string, anchor: number): Piece =>
    concat(
      ...parts.flatMap((part, index) => (index ? [literal(separator, anchor), part] : [part])),
    );

  function expression(item: Syntax | null, context: NamespaceContext): Piece {
    if (!item) return literal("undefined", 0);

    if (item.type === "JSXEmptyExpression")
      return concat(literal("undefined", item.start), copy(item.start, item.end));

    return range(item.start, item.end, item, context);
  }

  function children(item: Syntax, context: NamespaceContext): Piece {
    const rendered: Piece[] = [];

    for (const child of nodes(item.children)) {
      if (child.type === "JSXText") {
        if (String(child.value).trim())
          rendered.push(literal(JSON.stringify(String(child.value)), child.start));
      } else if (child.type === "JSXExpressionContainer") {
        const value = node(child.expression);

        if (value) rendered.push(expression(value, context));
      } else rendered.push(jsx(child, context));
    }

    return concat(
      literal("[", item.start),
      join(rendered, ",", item.start),
      literal("]", item.end),
    );
  }

  function jsx(item: Syntax, context: NamespaceContext): Piece {
    if (item.type === "JSXFragment")
      return concat(
        literal("__hesperia_fragment(", item.start),
        children(item, context),
        literal(")", item.end),
      );

    const opening = node(item.openingElement);
    const nameNode = node(opening?.name);

    if (!opening || !nameNode) return copy(item.start, item.end);

    const name = source.slice(nameNode.start, nameNode.end);
    const typeArguments = node(opening.typeArguments);
    const native = /^[a-z]/.test(name) && !name.includes(".");
    const closing = node(node(item.closingElement)?.name);

    if (closing) closingNames.push({ opening: nameNode, closing });

    const current = namespaceForTag(context, name);
    const encodingAttribute = nodes(opening.attributes).find(
      (attribute) => node(attribute.name)?.name === "encoding",
    );
    const encodingNode = node(encodingAttribute?.value);
    const encoding =
      encodingNode?.type === "JSXExpressionContainer"
        ? node(encodingNode.expression)?.value
        : encodingNode?.value;
    const childContext = native
      ? childNamespace(typeof encoding === "string" ? { ...current, encoding } : current)
      : context;
    const props: Piece[] = [];

    for (const attribute of nodes(opening.attributes)) {
      if (attribute.type === "JSXSpreadAttribute") {
        props.push(
          concat(
            literal("...(", attribute.start),
            expression(node(attribute.argument), context),
            literal(")", attribute.end),
          ),
        );

        continue;
      }

      const name = node(attribute.name);

      if (!name) continue;

      const value = node(attribute.value);
      const rendered =
        value?.type === "JSXExpressionContainer"
          ? expression(node(value.expression), context)
          : value
            ? literal(JSON.stringify(value.value), value.start)
            : literal("true", attribute.end);

      props.push(
        concat(
          literal('"', name.start),
          copy(name.start, name.end),
          literal('":', name.end),
          rendered,
        ),
      );
    }

    if (!native && nodes(item.children).length)
      props.push(concat(literal("children:", item.start), children(item, childContext)));

    return concat(
      literal(
        native
          ? `__hesperia_element<${JSON.stringify(name)},${JSON.stringify(current.namespace)}>(`
          : "__hesperia_component(",
        item.start,
      ),
      native
        ? concat(
            literal('"', nameNode.start),
            copy(nameNode.start, nameNode.end),
            literal('"', nameNode.end),
          )
        : copy(nameNode.start, typeArguments?.end ?? nameNode.end),
      ...(native ? [literal("," + JSON.stringify(current.namespace), nameNode.start)] : []),
      literal(",{", typeArguments?.end ?? nameNode.end),
      join(props, ",", opening.start),
      literal("}", opening.end),
      ...(native ? [literal(",", opening.end), children(item, childContext)] : []),
      literal(")", item.end),
    );
  }

  function range(start: number, end: number, item: Syntax, context: NamespaceContext): Piece {
    const replacements: Syntax[] = [];

    function collect(value: Syntax): void {
      if (value.type === "JSXElement" || value.type === "JSXFragment") {
        replacements.push(value);

        return;
      }

      for (const child of descendants(value)) collect(child);
    }

    collect(item);

    replacements.sort((a, b) => a.start - b.start);

    const result: Piece[] = [];
    let cursor = start;

    for (const replacement of replacements) {
      result.push(copy(cursor, replacement.start), jsx(replacement, context));

      cursor = replacement.end;
    }

    result.push(copy(cursor, end));

    return concat(...result);
  }

  const result = diagnostics.some((item) => item.code === "HES-OXC" && item.severity === "error")
    ? copy(0, source.length)
    : range(0, source.length, root, { namespace: "html" });
  const reverse = new Map<number, number>();

  for (let offset = 0; offset < result.offsets.length; offset++) {
    const authored = result.offsets[offset]!;

    if (!reverse.has(authored)) reverse.set(authored, offset);
  }

  for (const { opening, closing } of closingNames) {
    for (let index = 0; index < closing.end - closing.start; index++) {
      const target = reverse.get(opening.start + index);

      if (target !== undefined) reverse.set(closing.start + index, target);
    }
  }

  return {
    source: result.text,
    diagnostics,
    mapOffset: (offset) => result.offsets[offset] ?? source.length,
    generatedOffset: (offset) => reverse.get(offset) ?? result.text.length,
  };
}

interface CheckingReplacementRange {
  readonly start: number;
  readonly end: number;
  readonly replacement?: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

function importSourceRanges(
  root: Syntax,
  replacements: Readonly<Record<string, string>>,
): readonly CheckingReplacementRange[] {
  const ranges: CheckingReplacementRange[] = [];

  walk(root, (item) => {
    if (
      item.type !== "ImportDeclaration" &&
      item.type !== "ExportNamedDeclaration" &&
      item.type !== "ExportAllDeclaration" &&
      item.type !== "ImportExpression"
    )
      return;

    const source = node(item.source);
    const value = source?.value;

    if (
      !source ||
      typeof value !== "string" ||
      !Object.prototype.hasOwnProperty.call(replacements, value)
    )
      return;

    ranges.push({ start: source.start, end: source.end, replacement: replacements[value] });
  });

  return ranges;
}

function parameterTypeRanges(root: Syntax): readonly { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];

  walk(root, (item) => {
    const parameters = (item as Syntax & { readonly params?: readonly Syntax[] }).params;

    if (!parameters) return;

    for (const parameter of parameters) {
      const annotation = node(
        (parameter as Syntax & { readonly typeAnnotation?: unknown }).typeAnnotation,
      );
      const type = node(annotation?.typeAnnotation);

      if (type) ranges.push({ start: type.start, end: type.end });
    }
  });

  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

function resolveNativeHandlerRanges(
  root: Syntax,
  source: string,
  contexts: readonly NativeEventHandlerContext[],
): readonly { start: number; end: number; tag: string; namespace: string; eventName: string }[] {
  const openings: { readonly tag: string; readonly attributes: readonly Syntax[] }[] = [];
  const allFunctions: Syntax[] = [];

  walk(root, (item) => {
    if (item.type === "ArrowFunctionExpression" || item.type === "FunctionExpression")
      allFunctions.push(item);

    if (item.type !== "JSXOpeningElement") return;

    const name = node(item.name);

    if (!name) return;

    openings.push({ tag: source.slice(name.start, name.end), attributes: nodes(item.attributes) });
  });

  const distance = (
    left: { start: number; end: number },
    right: { start: number; end: number },
  ): number => Math.abs(left.start - right.start) + Math.abs(left.end - right.end);

  const resolved: {
    start: number;
    end: number;
    tag: string;
    namespace: string;
    eventName: string;
  }[] = [];

  for (const context of contexts) {
    const attributes = openings
      .filter((opening) => opening.tag === context.tag)
      .flatMap((opening) =>
        opening.attributes
          .filter((attribute) => {
            const name = node(attribute.name);
            return (
              name !== null && source.slice(name.start, name.end) === `on:${context.eventName}`
            );
          })
          .map((attribute) => ({ attribute, opening })),
      )
      .sort(
        (left, right) =>
          distance(left.attribute, context.attributeSpan) -
          distance(right.attribute, context.attributeSpan),
      );
    const selected = attributes[0]?.attribute;
    const value = node(selected?.value);
    const expression = value?.type === "JSXExpressionContainer" ? node(value.expression) : null;

    if (!expression) continue;

    const functions: Syntax[] = [];

    walk(expression, (item) => {
      if (item.type === "ArrowFunctionExpression" || item.type === "FunctionExpression")
        functions.push(item);
    });

    functions.sort((left, right) => distance(left, context.span) - distance(right, context.span));

    const handler =
      functions[0] ??
      allFunctions.find(
        (item) => item.start === context.span.start && Math.abs(item.end - context.span.end) <= 2,
      );

    if (!handler) continue;

    resolved.push({
      start: handler.start,
      end: handler.end,
      tag: context.tag,
      namespace: context.namespace,
      eventName: context.eventName,
    });
  }

  return resolved;
}

function node(value: unknown): Syntax | null {
  return typeof value === "object" && value !== null && "type" in value ? (value as Syntax) : null;
}

function nodes(value: unknown): Syntax[] {
  return Array.isArray(value) ? value.flatMap((item) => node(item) ?? []) : [];
}

function descendants(value: Syntax): Syntax[] {
  return Object.values(value).flatMap((item) =>
    Array.isArray(item) ? nodes(item) : (node(item) ?? []),
  );
}

function walk(value: Syntax, visit: (item: Syntax) => void): void {
  visit(value);

  for (const child of descendants(value)) walk(child, visit);
}
