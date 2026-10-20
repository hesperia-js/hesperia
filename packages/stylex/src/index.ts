import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformAsync, types as babelTypes, type PluginItem, type PluginObj } from "@babel/core";
import stylexBabelPlugin from "@stylexjs/babel-plugin";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import valueParser from "postcss-value-parser";
import type {
  Plugin,
  PluginOrigin,
  PluginSourceInput,
  PluginSourceMap,
  PluginStyleAssetReference,
  PluginStyleArtifact,
  PluginWatch,
} from "@hesperia/tooling/project-service";

type StyleXRule = readonly unknown[];

interface StyleXSourceData {
  readonly cssFilename: string;
  readonly rules: readonly StyleXRule[];
  readonly assetReferences: readonly PluginStyleAssetReference[];
}

interface BabelNode {
  readonly type: string;
  readonly name?: string;
  value?: unknown;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly source?: BabelNode;
  readonly specifiers?: readonly BabelNode[];
  readonly local?: BabelNode;
  readonly imported?: BabelNode;
  readonly callee?: BabelNode;
  readonly object?: BabelNode;
  readonly property?: BabelNode;
  readonly computed?: boolean;
  readonly arguments?: readonly (BabelNode | null)[];
  readonly properties?: readonly (BabelNode | null)[];
  readonly elements?: readonly (BabelNode | null)[];
  readonly key?: BabelNode | null;
  readonly expression?: BabelNode;
  readonly consequent?: BabelNode;
  readonly alternate?: BabelNode;
  readonly left?: BabelNode;
  readonly right?: BabelNode;
  readonly declarations?: readonly BabelNode[];
  readonly init?: BabelNode | null;
  readonly body?: BabelNode;
}

interface BabelImportBinding {
  readonly path: {
    readonly node: BabelNode;
    readonly parentPath?: { readonly node: BabelNode };
  };
}

interface BabelPath {
  readonly node: BabelNode;
  readonly scope: { getBinding(name: string): BabelImportBinding | undefined };
}

interface ValueNode {
  type: string;
  value: string;
  quote?: string;
  nodes?: ValueNode[];
}

interface ParsedCssValue {
  nodes: ValueNode[];

  toString(): string;
}

interface StyleXProcessor {
  processStylexRules(rules: readonly StyleXRule[]): string;
}

const stylexProcessor = stylexBabelPlugin as unknown as StyleXProcessor;
const parseCssValue = valueParser as unknown as (source: string) => ParsedCssValue;

/** Apply StyleX's Babel transform and emit its globally ordered application stylesheet. */
export function stylex(): Plugin<StyleXSourceData> {
  return {
    name: "@hesperia/stylex",

    async transformSource(input) {
      if (!input.current.includes("@stylexjs/stylex")) return undefined;

      const cssFilename = resolve(input.projectRoot, ".hesperia", "stylex.css");
      const assetReferences: PluginStyleAssetReference[] = [];
      const urlPlugin = createAssetRebasePlugin({
        filename: input.filename,
        cssFilename,
        authored: input.authored,
        current: input.current,
        previousMap: input.map,
        assetReferences,
      });
      let result: Awaited<ReturnType<typeof transformAsync>>;

      try {
        result = await transformAsync(input.current, {
          filename: input.filename,
          sourceFileName: input.filename,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          parserOpts: { sourceType: "module", plugins: ["typescript", "jsx"] },
          plugins: [
            urlPlugin as PluginItem,
            [
              stylexBabelPlugin as PluginItem,
              {
                unstable_moduleResolution: {
                  type: "commonJS",
                  rootDir: input.projectRoot,
                },
              },
            ],
            compiledStyleTypesPlugin(),
          ],
        });
      } catch (error) {
        return {
          code: input.current,
          diagnostics: [
            {
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              origin: wholeFileOrigin(input),
            },
          ],
        };
      }

      if (!result?.code)
        return {
          code: input.current,
          diagnostics: [
            {
              severity: "error",
              message: "StyleX did not produce a transformed module.",
              origin: wholeFileOrigin(input),
            },
          ],
        };

      const metadata = result.metadata as { readonly stylex?: readonly StyleXRule[] } | undefined;
      const rules = Array.isArray(metadata?.stylex) ? metadata.stylex : [];

      if (!rules.length && !assetReferences.length) return undefined;

      const watch = uniqueWatches(assetReferences.map((item) => item.filename));
      return {
        code: result.code,
        ...(result.map ? { map: result.map as PluginSourceMap } : {}),
        data: Object.freeze({
          cssFilename,
          rules: Object.freeze([...rules]),
          assetReferences: Object.freeze([...assetReferences]),
        }),
        ...(watch.length ? { watch } : {}),
      };
    },

    async generateStyles(sources) {
      const contributors = sources.flatMap((source) =>
        source.data ? [{ source, data: source.data }] : [],
      );
      const rules = contributors.flatMap(({ data }) => [...data.rules]);

      if (!rules.length) return { styles: [] };

      const assetReferences = contributors.flatMap(({ data }) => [...data.assetReferences]);

      let css: string;

      try {
        css = stylexProcessor.processStylexRules(rules);
      } catch (error) {
        const origin = contributors[0]!.source.components[0]?.origin ?? {
          filename: contributors[0]!.source.filename,
          start: 0,
          end: 0,
        };
        return {
          styles: [],
          diagnostics: [
            {
              severity: "error",
              message: `StyleX could not generate application CSS: ${error instanceof Error ? error.message : String(error)}`,
              origin,
            },
          ],
        };
      }

      const first = contributors[0]!;
      const origin = first.source.components[0]?.origin ?? {
        filename: first.source.filename,
        start: 0,
        end: 0,
      };
      const style: PluginStyleArtifact = {
        id: "stylex:application",
        owner: { kind: "application" },
        css,
        inputFilename: first.data.cssFilename,
        assetReferences,
        origin,
      };
      return { styles: [style] };
    },
  };
}

function compiledStyleTypesPlugin(): PluginObj {
  return {
    name: "hesperia-stylex-compiled-types",
    visitor: {
      Program: {
        exit(programPath) {
          programPath.traverse({
            ObjectExpression(path) {
              if (!isCompiledStyleObject(path.node)) return;

              path.replaceWith(typeAssert(path.node, stylexImportType("CompiledStyles")));

              path.skip();
            },

            ArrayExpression(path) {
              if (!isCompiledStyleTuple(path.node)) return;

              path.replaceWith(typeAssert(path.node, compiledStyleTupleType()));

              path.skip();
            },
          });
        },
      },
    },
  };
}

function isCompiledStyleObject(node: babelTypes.ObjectExpression): boolean {
  return node.properties.some(
    (property) =>
      babelTypes.isObjectProperty(property) &&
      !property.computed &&
      ((babelTypes.isIdentifier(property.key) && property.key.name === "$$css") ||
        (babelTypes.isStringLiteral(property.key) && property.key.value === "$$css")) &&
      babelTypes.isBooleanLiteral(property.value, { value: true }),
  );
}

function isCompiledStyleTuple(node: babelTypes.ArrayExpression): boolean {
  const [styles, inline] = node.elements;
  return (
    node.elements.length === 2 &&
    babelTypes.isObjectExpression(styles) &&
    isCompiledStyleObject(styles) &&
    babelTypes.isObjectExpression(inline)
  );
}

function compiledStyleTupleType(): babelTypes.TSType {
  return babelTypes.tsTupleType([
    stylexImportType("CompiledStyles"),
    stylexImportType("InlineStyles"),
  ]);
}

function stylexImportType(name: "CompiledStyles" | "InlineStyles"): babelTypes.TSType {
  return babelTypes.tsImportType(
    babelTypes.stringLiteral("@stylexjs/stylex"),
    babelTypes.identifier(name),
  );
}

function typeAssert(
  expression: babelTypes.Expression,
  target: babelTypes.TSType,
): babelTypes.Expression {
  return babelTypes.tsAsExpression(
    babelTypes.tsAsExpression(expression, babelTypes.tsUnknownKeyword()),
    target,
  );
}

interface AssetRebaseContext {
  readonly filename: string;
  readonly cssFilename: string;
  readonly authored: string;
  readonly current: string;
  readonly previousMap?: PluginSourceMap;
  readonly assetReferences: PluginStyleAssetReference[];
}

function createAssetRebasePlugin(context: AssetRebaseContext): unknown {
  return () => ({
    visitor: {
      CallExpression(path: BabelPath) {
        const call = path.node;

        if (!isStylexCreateCall(call, path)) return;

        const definitions = call.arguments?.[0];

        if (!definitions) return;

        visitStyleDefinitions(definitions, (literal) => {
          if (typeof literal.value !== "string" || literal.start == null || literal.end == null)
            return;

          const rewritten = rebaseCssUrls(literal.value, literal.start, literal.end, context);

          if (rewritten !== literal.value) literal.value = rewritten;
        });
      },
    },
  });
}

function isStylexCreateCall(call: BabelNode, path: BabelPath): boolean {
  const callee = call.callee;

  if (!callee) return false;

  if (callee.type === "Identifier" && callee.name)
    return isNamedCreateImport(path.scope.getBinding(callee.name));

  if (callee.type !== "MemberExpression" || callee.object?.type !== "Identifier") return false;

  const property = callee.computed ? callee.property?.value : callee.property?.name;
  return (
    property === "create" && isNamespaceImport(path.scope.getBinding(callee.object.name ?? ""))
  );
}

function isNamespaceImport(binding: BabelImportBinding | undefined): boolean {
  const specifier = binding?.path.node;
  return (
    (specifier?.type === "ImportNamespaceSpecifier" ||
      specifier?.type === "ImportDefaultSpecifier") &&
    importedFromStylex(binding)
  );
}

function isNamedCreateImport(binding: BabelImportBinding | undefined): boolean {
  const specifier = binding?.path.node;
  return (
    specifier?.type === "ImportSpecifier" &&
    (specifier.imported?.name === "create" || specifier.imported?.value === "create") &&
    importedFromStylex(binding)
  );
}

function importedFromStylex(binding: BabelImportBinding | undefined): boolean {
  const parent = binding?.path.parentPath?.node;
  return parent?.type === "ImportDeclaration" && parent.source?.value === "@stylexjs/stylex";
}

function visitStyleDefinitions(node: BabelNode, visit: (literal: BabelNode) => void): void {
  if (node.type !== "ObjectExpression") {
    visitStyleValues(node, visit);

    return;
  }

  for (const definition of node.properties ?? []) {
    if (!definition || definition.type !== "ObjectProperty") continue;

    const value = definition.value as BabelNode | undefined;

    if (value?.type === "ArrowFunctionExpression" && value.body?.type === "ObjectExpression")
      visitStyleValues(value.body, visit);
    else visitStyleValues(definition, visit);
  }
}

function visitStyleValues(node: BabelNode, visit: (literal: BabelNode) => void): void {
  if (node.type === "StringLiteral") {
    visit(node);

    return;
  }

  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration"
  )
    return;

  if (node.type === "ObjectExpression") {
    for (const property of node.properties ?? []) if (property) visitStyleValues(property, visit);

    return;
  }

  if (node.type === "ObjectProperty") {
    if (node.value && typeof node.value === "object")
      visitStyleValues(node.value as BabelNode, visit);

    return;
  }

  if (node.type === "ArrayExpression") {
    for (const element of node.elements ?? []) if (element) visitStyleValues(element, visit);

    return;
  }

  if (node.type === "ConditionalExpression") {
    if (node.consequent) visitStyleValues(node.consequent, visit);

    if (node.alternate) visitStyleValues(node.alternate, visit);

    return;
  }

  if (node.type === "LogicalExpression") {
    if (node.right) visitStyleValues(node.right, visit);

    return;
  }

  if (
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression"
  ) {
    if (node.expression) visitStyleValues(node.expression, visit);
  }
}

function rebaseCssUrls(
  source: string,
  start: number,
  end: number,
  context: AssetRebaseContext,
): string {
  const parsed = parseCssValue(source);

  const visit = (nodes: readonly ValueNode[]): void => {
    for (const node of nodes) {
      if (node.type === "function" && node.value.toLowerCase() === "url") {
        const values = (node.nodes ?? []).filter((item) => item.type !== "space");

        if (values.length !== 1) continue;

        const value = values[0]!;

        if (value.type !== "word" && value.type !== "string") continue;

        const replacement = rebaseUrl(value.value, context);

        if (replacement) {
          value.value = replacement.value;

          context.assetReferences.push({
            filename: replacement.filename,
            origin: authoredOrigin(context, start, end),
          });
        }
      } else if (node.nodes) visit(node.nodes);
    }
  };

  visit(parsed.nodes);

  return parsed.toString();
}

function rebaseUrl(
  source: string,
  context: AssetRebaseContext,
): { value: string; filename: string } | undefined {
  const { path: rawPath, suffix } = splitUrlSuffix(source);

  if (!rawPath) return undefined;

  const decoded = decodeCssEscapes(rawPath);
  let pathname: string;

  try {
    pathname = decodeURIComponent(decoded);
  } catch {
    pathname = decoded;
  }

  if (
    !pathname ||
    isAbsolute(pathname) ||
    pathname.startsWith("/") ||
    pathname.startsWith("\\") ||
    /^[a-z][a-z\d+.-]*:/iu.test(pathname)
  )
    return undefined;

  const target = resolve(dirname(context.filename), pathname);
  const relativeTarget = relative(dirname(context.cssFilename), target).replaceAll("\\", "/");

  if (!relativeTarget || isAbsolute(relativeTarget)) return undefined;

  const encodedPath = relativeTarget
    .split("/")
    .map((segment) => (segment === "." || segment === ".." ? segment : encodeURIComponent(segment)))
    .join("/");
  return {
    value: `${encodedPath.startsWith(".") ? encodedPath : `./${encodedPath}`}${suffix}`,
    filename: target,
  };
}

function splitUrlSuffix(value: string): { path: string; suffix: string } {
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;

    if (character === "\\") {
      index++;
      let digits = 0;

      while (index < value.length && digits < 6 && /[\da-f]/iu.test(value[index]!)) {
        index++;
        digits++;
      }

      if (digits && index < value.length && /\s/u.test(value[index]!)) index++;
      else if (!digits && index >= value.length) return { path: value, suffix: "" };

      index--;
      continue;
    }

    if (character === "?" || character === "#")
      return { path: value.slice(0, index), suffix: value.slice(index) };
  }

  return { path: value, suffix: "" };
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/gu, "")
    .replace(/\\([\da-f]{1,6})\s?/giu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
    })
    .replace(/\\([^\da-f\n\r\f])/giu, "$1");
}

function authoredOrigin(context: AssetRebaseContext, start: number, end: number): PluginOrigin {
  if (!context.previousMap) return { filename: context.filename, start, end };

  try {
    const traceMap = normalizeSourceMapForTrace(context.previousMap, context.filename);
    const trace = new TraceMap(traceMap, pathToFileURL(context.filename).href);
    const originalStart = originalPositionFor(trace, positionAt(context.current, start));
    const originalEnd = originalPositionFor(trace, positionAt(context.current, end));

    if (
      originalStart.source &&
      originalStart.line !== null &&
      originalStart.column !== null &&
      originalEnd.source === originalStart.source &&
      originalEnd.line !== null &&
      originalEnd.column !== null
    ) {
      const sourceIndex = trace.resolvedSources.indexOf(originalStart.source);
      const filename = absoluteAuthoredFilename(originalStart.source, context.filename);

      if (!filename) return { filename: context.filename, start, end };

      const mappedContent = trace.sourcesContent?.[sourceIndex];

      if (
        mappedContent === null ||
        (mappedContent === undefined && !sameSourcePath(filename, context.filename))
      )
        return { filename: context.filename, start, end };

      const content = mappedContent ?? context.authored;
      return {
        filename,
        start: offsetAt(content, originalStart.line, originalStart.column),
        end: offsetAt(content, originalEnd.line, originalEnd.column),
      };
    }
  } catch {
    // Fall back to the current source span when an upstream map has no usable location.
  }

  return { filename: context.filename, start, end };
}

function normalizeSourceMapForTrace(map: PluginSourceMap, mapBase: string): SourceMapInput {
  const { sourceRoot, ...withoutSourceRoot } = map as PluginSourceMap & {
    readonly sourceRoot?: string;
  };
  return {
    ...withoutSourceRoot,
    sources: map.sources.map((source) => sourceMapUrl(source, sourceRoot, mapBase)),
  } as SourceMapInput;
}

function sourceMapUrl(source: string, sourceRoot: string | undefined, mapBase: string): string {
  if (source.startsWith("<") && source.endsWith(">")) return source;

  if (source.startsWith("file:")) return source;

  if (isAbsolute(source) || /^[a-z]:[\\/]/iu.test(source))
    return pathToFileURL(resolve(source)).href;

  if (/^[a-z][a-z\d+.-]*:/iu.test(source)) return source;

  if (sourceRoot?.startsWith("file:")) {
    try {
      return pathToFileURL(resolve(fileURLToPath(sourceRoot), source)).href;
    } catch {
      return source;
    }
  }

  if (sourceRoot && /^[a-z][a-z\d+.-]*:/iu.test(sourceRoot)) {
    const root = new URL(sourceRoot);
    root.pathname = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
    root.search = "";
    root.hash = "";
    return new URL(source, root).href;
  }

  return pathToFileURL(resolve(dirname(mapBase), sourceRoot ?? "", source)).href;
}

function sameSourcePath(first: string, second: string): boolean {
  const left = resolve(first).replaceAll("\\", "/");
  const right = resolve(second).replaceAll("\\", "/");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function absoluteAuthoredFilename(source: string, currentFilename: string): string | undefined {
  if (source.startsWith("file:")) {
    try {
      return resolve(fileURLToPath(source));
    } catch {
      return undefined;
    }
  }

  if (isAbsolute(source) || /^[a-z]:[\\/]/iu.test(source)) return resolve(source);

  if (/^[a-z][a-z\d+.-]*:/iu.test(source)) return undefined;

  if (source.startsWith("<") && source.endsWith(">")) return undefined;

  return resolve(dirname(currentFilename), source);
}

function positionAt(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lastLine = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastLine - 1 };
}

function offsetAt(source: string, line: number, column: number): number {
  let offset = 0;

  for (let current = 1; current < line; current++) {
    const newline = source.indexOf("\n", offset);

    if (newline < 0) return source.length;

    offset = newline + 1;
  }

  return Math.min(offset + column, source.length);
}

function wholeFileOrigin(input: PluginSourceInput): PluginOrigin {
  return { filename: input.filename, start: 0, end: input.authored.length };
}

function uniqueWatches(paths: readonly string[]): PluginWatch[] {
  return [...new Set(paths)].map((file) => ({ kind: "file", file }));
}
