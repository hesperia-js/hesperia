import { parseSync } from "oxc-parser";
import type { CompilerDiagnostic, SourceSpan } from "./ir.ts";
import type { NativeEventHandlerContext } from "./event-options.ts";
import { childNamespace, namespaceForTag, type NamespaceContext } from "./namespace.ts";

/** Authored-to-checking source mapping shared by diagnostics and editor positions. */
export interface CheckingView {
  readonly source: string;
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly mapOffset: (offset: number) => number;
  readonly generatedOffset: (offset: number) => number;
}

/** Authored and checking-view anchors for an explicit-pattern route configuration. */
export interface CheckingViewRouteLoadProjection {
  readonly identifier: string;
  readonly authoredCallSpan: SourceSpan;
  readonly authoredConfigurationSpan: SourceSpan;
  readonly authoredPatternSpan: SourceSpan;
  readonly authoredPatternText: string;
  readonly generatedCallSpan: SourceSpan;
  readonly generatedConfigurationSpan: SourceSpan;
  readonly generatedConfigurationIdentifierSpan: SourceSpan;
  readonly generatedTypeArgumentsSpan: SourceSpan;
  readonly generatedConfigTypeQuerySpan: SourceSpan;
  readonly generatedArgumentSpan: SourceSpan;
}

/** Exact authored and generated source for route configuration projections. */
export interface CheckingViewRouteLoadCapture {
  readonly authoredSource: string;
  readonly generatedSource: string;
  readonly complete: boolean;
  readonly projections: readonly CheckingViewRouteLoadProjection[];
}

const checkingViewRouteLoadCaptures = new WeakMap<CheckingView, CheckingViewRouteLoadCapture>();

/** @internal Read the route projection retained for this exact checking view. */
export function checkingViewRouteLoadCapture(
  view: CheckingView,
): CheckingViewRouteLoadCapture | undefined {
  const capture = checkingViewRouteLoadCaptures.get(view);

  return capture?.generatedSource === view.source ? capture : undefined;
}

type Syntax = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
};

interface RouteLoaderCandidate {
  readonly statement: Syntax;
  readonly bindingStart: number;
  readonly call: Syntax;
  readonly configuration: Syntax;
  readonly typeArguments: Syntax;
  readonly pattern: Syntax;
  readonly identifier: string;
  readonly argumentRange: RouteLoaderReplacementRange;
}

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
  const routeLoaderCandidates = diagnostics.some(
    (item) => item.code === "HES-OXC" && item.severity === "error",
  )
    ? []
    : collectRouteLoaderCandidates(root, source);
  const routeLoaderRanges: RouteLoaderReplacementRange[] = [];
  const routeLoaderCandidatesByStatement = new Map(
    routeLoaderCandidates.map((candidate) => [candidate.statement, candidate] as const),
  );

  for (const candidate of routeLoaderCandidates) {
    routeLoaderRanges.push(
      {
        start: candidate.bindingStart,
        end: candidate.bindingStart,
        routeLoaderConfigBinding: candidate,
      },
      {
        start: candidate.typeArguments.start,
        end: candidate.typeArguments.end,
        routeLoaderTypeArguments: {
          identifier: candidate.identifier,
          patternEnd: candidate.pattern.end,
        },
      },
      candidate.argumentRange,
    );
  }
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

  const copy = (
    start: number,
    end: number,
    excludedRange?: RouteLoaderReplacementRange,
    context: NamespaceContext = { namespace: "html" },
  ): Piece => {
    const ranges: RouteLoaderReplacementRange[] = [
      ...routeTypeRanges.map((range) => ({ ...range })),
      ...importRanges,
      ...handlerContextRanges,
      ...routeLoaderRanges,
    ]
      .filter((range) => range !== excludedRange && range.start >= start && range.end <= end)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    if (!ranges.length) return copySource(start, end);

    const parts: Piece[] = [];
    let cursor = start;

    for (const range of ranges) {
      if (range.start < cursor) continue;

      parts.push(copySource(cursor, range.start));

      if (range.start === range.end && range.routeLoaderConfigBinding) {
        const candidate = range.routeLoaderConfigBinding;

        parts.push(
          literal(`\nconst ${candidate.identifier} = (`, range.start),
          renderRange(
            candidate.configuration.start,
            candidate.configuration.end,
            candidate.configuration,
            context,
            candidate.argumentRange,
          ),
          literal(
            ') satisfies import("hesperia/routing").Route.Declaration<',
            candidate.configuration.end,
          ),
          copySource(candidate.pattern.start, candidate.pattern.end),
          literal(">;\n", candidate.pattern.end),
        );
      } else if (range.start === range.end) {
        if (range.prefix) parts.push(literal(range.prefix, range.start));

        if (range.replacement !== undefined)
          parts.push(literal(JSON.stringify(range.replacement), range.start));

        if (range.suffix) parts.push(literal(range.suffix, range.start));
      } else if (range.routeLoaderTypeArguments) {
        parts.push(
          copySource(range.start, range.routeLoaderTypeArguments.patternEnd),
          literal(
            ", typeof " + range.routeLoaderTypeArguments.identifier,
            range.routeLoaderTypeArguments.patternEnd,
          ),
          copySource(range.routeLoaderTypeArguments.patternEnd, range.end),
        );
      } else if (range.routeLoaderConfigArgument !== undefined) {
        parts.push(literal(range.routeLoaderConfigArgument, range.start));
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

    return renderRange(item.start, item.end, item, context);
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

  function renderRange(
    start: number,
    end: number,
    item: Syntax,
    context: NamespaceContext,
    excludedRange?: RouteLoaderReplacementRange,
  ): Piece {
    type Replacement =
      | { readonly kind: "route"; readonly candidate: RouteLoaderCandidate }
      | { readonly kind: "jsx"; readonly node: Syntax };
    const replacements: Replacement[] = [];

    function collect(value: Syntax): void {
      const candidate = routeLoaderCandidatesByStatement.get(value);

      if (candidate) {
        replacements.push({ kind: "route", candidate });

        return;
      }

      if (value.type === "JSXElement" || value.type === "JSXFragment") {
        replacements.push({ kind: "jsx", node: value });

        return;
      }

      for (const child of descendants(value)) collect(child);
    }

    collect(item);

    replacements.sort((left, right) => {
      const a = left.kind === "route" ? left.candidate.statement : left.node;
      const b = right.kind === "route" ? right.candidate.statement : right.node;

      return a.start - b.start || a.end - b.end;
    });

    const result: Piece[] = [];
    let cursor = start;

    for (const replacement of replacements) {
      const selected =
        replacement.kind === "route" ? replacement.candidate.statement : replacement.node;

      if (selected.start < cursor) continue;

      if (replacement.kind === "route") {
        result.push(
          copy(cursor, selected.start, undefined, context),
          copy(selected.start, selected.end, undefined, context),
        );
      } else {
        result.push(copy(cursor, selected.start, excludedRange, context), jsx(selected, context));
      }

      cursor = selected.end;
    }

    result.push(copy(cursor, end, excludedRange, context));

    return concat(...result);
  }

  const result = diagnostics.some((item) => item.code === "HES-OXC" && item.severity === "error")
    ? copy(0, source.length)
    : renderRange(0, source.length, root, { namespace: "html" });
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

  const routeLoaderProjections: CheckingViewRouteLoadProjection[] = [];
  let routeLoaderCaptureComplete = true;
  const generatedSpan = (start: number, end: number): SourceSpan | undefined => {
    if (end <= start) return undefined;

    const generatedStart = result.offsets.indexOf(start);
    const generatedEnd = result.offsets.lastIndexOf(end - 1) + 1;

    return generatedStart >= 0 && generatedEnd >= generatedStart
      ? { start: generatedStart, end: generatedEnd }
      : undefined;
  };

  for (const candidate of routeLoaderCandidates) {
    const generatedCallSpan = generatedSpan(candidate.call.start, candidate.call.end);
    const generatedConfigurationSpan = generatedSpan(
      candidate.configuration.start,
      candidate.configuration.end,
    );
    const generatedTypeArgumentsSpan = generatedSpan(
      candidate.typeArguments.start,
      candidate.typeArguments.end,
    );
    const occurrences: number[] = [];
    let occurrence = result.text.indexOf(candidate.identifier);

    while (occurrence >= 0) {
      occurrences.push(occurrence);
      occurrence = result.text.indexOf(
        candidate.identifier,
        occurrence + candidate.identifier.length,
      );
    }

    if (
      !generatedCallSpan ||
      !generatedConfigurationSpan ||
      !generatedTypeArgumentsSpan ||
      occurrences.length !== 3
    ) {
      routeLoaderCaptureComplete = false;
      continue;
    }

    routeLoaderProjections.push(
      Object.freeze({
        identifier: candidate.identifier,
        authoredCallSpan: Object.freeze({ start: candidate.call.start, end: candidate.call.end }),
        authoredConfigurationSpan: Object.freeze({
          start: candidate.configuration.start,
          end: candidate.configuration.end,
        }),
        authoredPatternSpan: Object.freeze({
          start: candidate.pattern.start,
          end: candidate.pattern.end,
        }),
        authoredPatternText: source.slice(candidate.pattern.start, candidate.pattern.end),
        generatedCallSpan: Object.freeze(generatedCallSpan),
        generatedConfigurationSpan: Object.freeze(generatedConfigurationSpan),
        generatedConfigurationIdentifierSpan: Object.freeze({
          start: occurrences[0]!,
          end: occurrences[0]! + candidate.identifier.length,
        }),
        generatedTypeArgumentsSpan: Object.freeze(generatedTypeArgumentsSpan),
        generatedConfigTypeQuerySpan: Object.freeze({
          start: occurrences[1]!,
          end: occurrences[1]! + candidate.identifier.length,
        }),
        generatedArgumentSpan: Object.freeze({
          start: occurrences[2]!,
          end: occurrences[2]! + candidate.identifier.length,
        }),
      }),
    );
  }

  const view: CheckingView = {
    source: result.text,
    diagnostics,
    mapOffset: (offset) => result.offsets[offset] ?? source.length,
    generatedOffset: (offset) => reverse.get(offset) ?? result.text.length,
  };
  checkingViewRouteLoadCaptures.set(
    view,
    Object.freeze({
      authoredSource: source,
      generatedSource: result.text,
      complete:
        !diagnostics.some((item) => item.code === "HES-OXC" && item.severity === "error") &&
        routeLoaderCaptureComplete &&
        routeLoaderProjections.length === routeLoaderCandidates.length,
      projections: Object.freeze(routeLoaderProjections),
    }),
  );

  return view;
}

interface CheckingReplacementRange {
  readonly start: number;
  readonly end: number;
  readonly replacement?: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

interface RouteLoaderReplacementRange extends CheckingReplacementRange {
  readonly routeLoaderConfigBinding?: RouteLoaderCandidate;
  readonly routeLoaderConfigArgument?: string;
  readonly routeLoaderTypeArguments?: {
    readonly identifier: string;
    readonly patternEnd: number;
  };
}

function collectRouteLoaderCandidates(root: Syntax, source: string): RouteLoaderCandidate[] {
  const routeBindings = new Map<string, number[]>();
  const body = nodes(root.body);

  for (const [statementIndex, statement] of body.entries()) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (node(statement.source)?.value !== "hesperia/routing") continue;

    for (const specifier of nodes(statement.specifiers)) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;

      const local = node(specifier.local);
      const imported = node(specifier.imported);
      const localName = typeof local?.name === "string" ? local.name : undefined;
      const importedName = typeof imported?.name === "string" ? imported.name : localName;

      if (importedName === "route" && localName) {
        const positions = routeBindings.get(localName) ?? [];

        positions.push(statementIndex);
        routeBindings.set(localName, positions);
      }
    }
  }

  if (routeBindings.size === 0) return [];

  const identifiers = new Set<string>();

  walk(root, (item) => {
    if (item.type === "Identifier" && typeof item.name === "string") identifiers.add(item.name);
  });

  const candidates: RouteLoaderCandidate[] = [];
  let identifierIndex = 0;

  for (const [statementIndex, statement] of body.entries()) {
    if (statement.type !== "ExportDefaultDeclaration") continue;

    const call = node(statement.declaration);
    const callee = node(call?.callee);

    if (call?.type !== "CallExpression" || callee?.type !== "Identifier") continue;
    if (
      typeof callee.name !== "string" ||
      !(routeBindings.get(callee.name) ?? []).some((index) => index < statementIndex)
    )
      continue;

    const arguments_ = nodes(call.arguments);
    const configuration = arguments_.length === 1 ? arguments_[0] : undefined;
    const typeArguments = node(call.typeArguments);
    const patterns = nodes(typeArguments?.params);
    const pattern = patterns.length === 1 ? patterns[0] : undefined;

    if (!configuration || configuration.type !== "ObjectExpression" || !typeArguments || !pattern)
      continue;
    if (pattern.type !== "TSLiteralType" || typeof node(pattern.literal)?.value !== "string")
      continue;

    let identifier = "__hesperia_checking_route_config_" + identifierIndex++;

    while (identifiers.has(identifier) || source.includes(identifier))
      identifier = "__hesperia_checking_route_config_" + identifierIndex++;

    identifiers.add(identifier);

    const bindingStart = body[statementIndex - 1]?.end ?? 0;
    const argumentRange: RouteLoaderReplacementRange = {
      start: configuration.start,
      end: configuration.end,
      routeLoaderConfigArgument: identifier,
    };

    candidates.push({
      statement,
      bindingStart,
      call,
      configuration,
      typeArguments,
      pattern,
      identifier,
      argumentRange,
    });
  }

  return candidates.length === 1 ? candidates : [];
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
