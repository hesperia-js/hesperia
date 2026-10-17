import { dirname, extname, resolve } from "node:path";
import { SaxNamespaceParser, type QName } from "@federicocarboni/saxe";
import {
  GenMapping,
  maybeAddSegment,
  setSourceContent,
  toEncodedMap,
} from "@jridgewell/gen-mapping";
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type {
  CapturedPluginFile,
  PluginImportResult,
  PluginOrigin,
  PluginSourceMap,
} from "./plugins.ts";

const svgNamespace = "http://www.w3.org/2000/svg";
const htmlNamespace = "http://www.w3.org/1999/xhtml";
const mathmlNamespace = "http://www.w3.org/1998/Math/MathML";
const xlinkNamespace = "http://www.w3.org/1999/xlink";

type MarkupAttribute = {
  name: string;
  localName: string;
  value: string;
  namespace?: string;
  parts?: readonly MarkupValuePart[];
  sourceStart?: number;
  sourceEnd?: number;
};

type MarkupValuePart = { start: number; end: number; resource: number; suffix: string };

type MarkupText = { kind: "text"; value: string; parts?: readonly MarkupValuePart[] };

type MarkupElement = {
  kind: "element";
  name: string;
  localName: string;
  namespace: string;
  attributes: MarkupAttribute[];
  children: MarkupNode[];
  omit?: boolean;
  sourceStart?: number;
  sourceEnd?: number;
};

type MarkupNode = MarkupText | MarkupElement;

const resourceAttributes: Readonly<Record<string, ReadonlySet<string>>> = {
  audio: new Set(["src"]),
  img: new Set(["src", "srcset"]),
  input: new Set(["src"]),
  source: new Set(["src", "srcset"]),
  track: new Set(["src"]),
  video: new Set(["src", "poster"]),
};
const svgPresentationAttributes = new Set([
  "clip-path",
  "cursor",
  "fill",
  "filter",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "stroke",
  "color-profile",
]);

export interface BuiltinMarkupMetadata {
  readonly ownerId: string;
  readonly resources: readonly string[];
  readonly styles: readonly {
    readonly id: string;
    readonly css: string;
    readonly inputFilename: string;
    readonly origin: PluginOrigin;
    readonly link?: {
      readonly rel: string;
      readonly media?: string;
      readonly disabled?: boolean;
      readonly title?: string;
      readonly requestAttributes?: Readonly<Record<string, string>>;
    };
    readonly native?: {
      readonly href: string;
      readonly sourceFilename?: string;
      readonly suffix: string;
    };
  }[];
}

export type InterpretedBuiltinAsset =
  | PluginImportResult
  | { readonly result: PluginImportResult; readonly markup: BuiltinMarkupMetadata };

const mediaTypes: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"]);

/** Whether a relative import without attributes has a built-in asset meaning. */
export function isDefaultAsset(specifier: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;

  const extension = extname(specifier).toLowerCase();
  return extension !== ".css" && !sourceExtensions.has(extension);
}

/** CSS and imported markup components have their own compilation paths. */
export function isBuiltinType(type: string): boolean {
  return (
    type === "string" ||
    type === "json" ||
    type === "html" ||
    type === "svg" ||
    type === "image" ||
    type === "audio" ||
    type === "video" ||
    validMime(type)
  );
}

export async function interpretBuiltinAsset(
  file: CapturedPluginFile,
  type: string | undefined,
  origin: PluginOrigin,
  options: {
    readonly allowUnsafeHTML: boolean;
    readonly resourceImportPrefix?: string;
    readonly styleRuntimeModule?: string;
  } = { allowUnsafeHTML: false },
): Promise<InterpretedBuiltinAsset> {
  const extension = extname(file.filename).toLowerCase();
  const knownMime = mediaTypes[extension];

  if (type === "html" || type === "svg") {
    if (!options.allowUnsafeHTML)
      throw new TypeError(`Imported ${type} components require allowUnsafeHTML: true`);

    const source = await decodeText(file, origin);
    const roots = type === "html" ? parseHTMLFragment(source) : parseSVGDocument(source);
    const markup = validateMarkup(roots, type, file.filename, origin);
    return {
      result: markupProjection(
        roots,
        type,
        origin,
        file.filename,
        source,
        markup.resources,
        markup.styles.length > 0,
        markup.ownerId,
        options.resourceImportPrefix,
        options.styleRuntimeModule,
      ),
      markup,
    };
  }

  if (!type && knownMime && extension !== ".svg")
    throw new TypeError(
      `Binary asset ${file.filename} requires an explicit type at ${origin.filename}:${origin.start}`,
    );

  const selected = type ?? "string";

  if (selected === "string" || selected === "json") {
    const decoded = await decodeText(file, origin);

    if (selected === "string")
      return {
        declaration: { code: "declare const value: string; export default value;", origin },
        browser: { code: `export default ${JSON.stringify(decoded)};`, origin },
      };

    let parsed: unknown;

    try {
      parsed = JSON.parse(decoded);
    } catch (error) {
      throw new TypeError(
        `Invalid JSON in ${file.filename} at ${origin.filename}:${origin.start}: ${String(error)}`,
      );
    }

    return {
      declaration: {
        code: `declare const value: ${jsonType(parsed)}; export default value;`,
        origin,
      },
      browser: { code: `export default JSON.parse(${JSON.stringify(decoded)});`, origin },
    };
  }

  let mime: string;

  if (selected === "image" || selected === "audio" || selected === "video") {
    if (!knownMime?.startsWith(`${selected}/`))
      throw new TypeError(
        `Asset ${file.filename} needs a full MIME type instead of ${selected} at ${origin.filename}:${origin.start}`,
      );

    mime = knownMime;
  } else if (validMime(selected)) mime = selected.toLowerCase();
  else
    throw new TypeError(
      `Unsupported asset import type ${selected} at ${origin.filename}:${origin.start}`,
    );

  const bytes = Buffer.from(await file.blob.arrayBuffer()).toString("base64");
  return {
    declaration: { code: "declare const value: Blob; export default value;", origin },
    browser: {
      code: `const bytes=Uint8Array.from(atob(${JSON.stringify(bytes)}),char=>char.charCodeAt(0)); export default new Blob([bytes],{type:${JSON.stringify(mime)}});`,
      origin,
    },
    ...(knownMime && type?.includes("/") && knownMime !== mime
      ? {
          diagnostics: [
            {
              severity: "warning" as const,
              message: `Declared MIME type ${mime} differs from ${knownMime} for ${file.filename}; bytes are not converted.`,
              origin,
            },
          ],
        }
      : {}),
  };
}

async function decodeText(file: CapturedPluginFile, origin: PluginOrigin): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.blob.arrayBuffer());
  } catch {
    throw new TypeError(
      `Malformed UTF-8 in ${file.filename} at ${origin.filename}:${origin.start}`,
    );
  }
}

function parseHTMLFragment(source: string): MarkupNode[] {
  const document = parse(source, { sourceCodeLocationInfo: true });

  const explicit = (node: DefaultTreeAdapterTypes.Node): boolean => {
    if (node.nodeName === "#documentType" && node.sourceCodeLocation) return true;

    if ("tagName" in node) {
      if (["html", "head", "body"].includes(node.tagName) && node.sourceCodeLocation) return true;

      return node.childNodes.some(explicit);
    }

    return false;
  };

  if (document.childNodes.some(explicit))
    throw new TypeError("HTML component imports accept fragments and reject document wrappers");

  const fragment = parseFragment(source, { sourceCodeLocationInfo: true });
  return fragment.childNodes.flatMap((node) => htmlNodes(node));
}

function htmlNodes(node: DefaultTreeAdapterTypes.ChildNode): MarkupNode[] {
  if (node.nodeName === "#text") {
    const text = node as DefaultTreeAdapterTypes.TextNode;
    return text.value ? [{ kind: "text", value: text.value }] : [];
  }

  if (!("tagName" in node)) return [];

  const element = node as DefaultTreeAdapterTypes.Element;
  const children =
    element.tagName === "template"
      ? (element as DefaultTreeAdapterTypes.Template).content.childNodes
      : element.childNodes;
  return [
    {
      kind: "element",
      name: element.tagName,
      localName: element.tagName,
      namespace: element.namespaceURI,
      attributes: element.attrs.map((attribute) => {
        const qualifiedName = attribute.prefix
          ? `${attribute.prefix}:${attribute.name}`
          : attribute.name;
        return {
          name: qualifiedName,
          localName: attribute.name,
          value: attribute.value,
          ...(attribute.namespace ? { namespace: attribute.namespace } : {}),
          ...(element.sourceCodeLocation?.attrs?.[qualifiedName]
            ? {
                sourceStart: element.sourceCodeLocation.attrs[qualifiedName]!.startOffset,
                sourceEnd: element.sourceCodeLocation.attrs[qualifiedName]!.endOffset,
              }
            : {}),
        };
      }),
      children: children.flatMap((child) => htmlNodes(child)),
      ...(element.sourceCodeLocation
        ? {
            sourceStart: element.sourceCodeLocation.startOffset,
            sourceEnd: element.sourceCodeLocation.endOffset,
          }
        : {}),
    },
  ];
}

function parseSVGDocument(source: string): MarkupNode[] {
  const roots: MarkupNode[] = [];
  const stack: MarkupElement[] = [];
  const parser = new SaxNamespaceParser(
    {
      startTag(name, attributes) {
        const node: MarkupElement = {
          kind: "element",
          name: xmlName(name),
          localName: name.localName,
          namespace: name.namespace ?? "",
          attributes: [...attributes].map(([attribute, value]) => ({
            name: xmlName(attribute),
            localName: attribute.localName,
            value,
            ...(attribute.namespace ? { namespace: attribute.namespace } : {}),
          })),
          children: [],
        };

        (stack.at(-1)?.children ?? roots).push(node);

        stack.push(node);
      },

      endTag() {
        stack.pop();
      },

      text(value) {
        if (value) (stack.at(-1)?.children ?? roots).push({ kind: "text", value });
      },
    },
    { dtd: "prohibit", maxElementDepth: 128, maxNamespacePrefixes: 128 },
  );

  try {
    parser.parse(source);
  } catch (error) {
    throw new TypeError(
      `Invalid standalone SVG/XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const elementRoots = roots.filter((node): node is MarkupElement => node.kind === "element");

  if (
    stack.length ||
    elementRoots.length !== 1 ||
    roots.some((node) => node.kind === "text" && node.value.trim().length > 0)
  )
    throw new TypeError("Invalid standalone SVG/XML: expected one well-formed document element");

  if (elementRoots[0]?.namespace !== svgNamespace)
    throw new TypeError("Standalone SVG/XML imports require an SVG-namespace document element");

  return roots;
}

function xmlName(name: QName): string {
  return name.prefix ? `${name.prefix}:${name.localName}` : name.localName;
}

function validateMarkup(
  roots: readonly MarkupNode[],
  type: "html" | "svg",
  filename: string,
  importOrigin: PluginOrigin,
): BuiltinMarkupMetadata {
  const resources: string[] = [];
  const resourceIndices = new Map<string, number>();
  const styles: BuiltinMarkupMetadata["styles"][number][] = [];

  const localResource = (
    value: string,
  ): { readonly filename: string; readonly suffix: string } | undefined => {
    const trimmed = value.trim();

    if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z\d+.-]*:/iu.test(trimmed))
      return undefined;

    let parsed: URL;

    try {
      parsed = new URL(trimmed, "https://hesperia.invalid/");
    } catch {
      return undefined;
    }

    if (parsed.origin !== "https://hesperia.invalid") return undefined;

    const pathEnd = trimmed.search(/[?#]/u);
    const path = pathEnd < 0 ? trimmed : trimmed.slice(0, pathEnd);

    if (!path || path.startsWith("/")) return undefined;

    let decoded: string;

    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new TypeError("Imported markup contains an invalid encoded resource path");
    }

    const target = resolve(
      dirname(filename),
      decoded.replaceAll("/", process.platform === "win32" ? "\\" : "/"),
    );
    return { filename: target, suffix: pathEnd < 0 ? "" : trimmed.slice(pathEnd) };
  };

  const resource = (
    value: string,
  ): { readonly index: number; readonly suffix: string } | undefined => {
    const local = localResource(value);

    if (!local) return undefined;

    let index = resourceIndices.get(local.filename);

    if (index === undefined) {
      index = resources.length;

      resources.push(local.filename);

      resourceIndices.set(local.filename, index);
    }

    return { index, suffix: local.suffix };
  };

  const makeStyle = (
    node: MarkupElement,
    css: string,
    index: number,
    link?: BuiltinMarkupMetadata["styles"][number]["link"],
    native?: BuiltinMarkupMetadata["styles"][number]["native"],
  ): void => {
    const token = new Bun.CryptoHasher("sha256")
      .update(filename)
      .update("\0")
      .update(String(index))
      .digest("hex")
      .slice(0, 16);

    styles.push({
      id: String(index),
      css,
      inputFilename: resolve(dirname(filename), ".hesperia-inline-" + token + ".css"),
      origin:
        node.sourceStart === undefined
          ? importOrigin
          : { filename, start: node.sourceStart, end: node.sourceEnd ?? node.sourceStart },
      ...(link ? { link } : {}),
      ...(native ? { native } : {}),
    });
  };

  let styleIndex = 0;

  const visit = (node: MarkupNode, inertTemplate = false): void => {
    if (node.kind === "text") return;

    const tag = node.localName.toLowerCase();
    const html = node.namespace === htmlNamespace;
    const svg = node.namespace === svgNamespace;
    const attributes = new Map(
      node.attributes
        .filter((attribute) => !attribute.namespace)
        .map((attribute) => [attribute.localName.toLowerCase(), attribute.value]),
    );

    if (svg && ["animate", "animatemotion", "animatetransform", "set"].includes(tag))
      throw new TypeError("Imported SVG cannot contain SMIL animation element <" + tag + ">");

    if (html && ["iframe", "object", "embed"].includes(tag))
      throw new TypeError("Imported markup cannot contain <" + tag + "> embedded documents");

    if (html && tag === "base") throw new TypeError("Imported markup cannot contain <base>");

    if (html && tag === "meta" && attributes.get("http-equiv")?.trim().toLowerCase() === "refresh")
      throw new TypeError("Imported markup cannot contain meta refresh controls");

    if ((html || svg) && tag === "script") {
      const mime = (attributes.get("type") ?? "").split(";", 1)[0]!.trim().toLowerCase();

      if (mime !== "application/json" && mime !== "application/ld+json")
        throw new TypeError(
          "Imported markup cannot contain executable scripts or browser instructions",
        );

      if (attributes.has("src"))
        throw new TypeError("Typed script data blocks cannot load external sources");
    }

    if (!inertTemplate && (html || svg) && tag === "style") {
      const css = node.children.map((child) => (child.kind === "text" ? child.value : "")).join("");

      const hasAttribute = (name: string): boolean =>
        node.attributes.some(
          (attribute) => !attribute.namespace && attribute.localName.toLowerCase() === name,
        );

      makeStyle(node, css, styleIndex++, {
        rel: "stylesheet",
        ...(hasAttribute("media") ? { media: attributes.get("media") ?? "" } : {}),
        ...(hasAttribute("title") ? { title: attributes.get("title") ?? "" } : {}),
      });

      node.omit = true;
    } else if (
      !inertTemplate &&
      html &&
      tag === "link" &&
      (attributes.get("rel") ?? "").toLowerCase().split(/\s+/u).includes("stylesheet")
    ) {
      const href = attributes.get("href");

      if (href) {
        const target = new URL(href.trim(), "https://hesperia.invalid/");

        if (target.protocol === "javascript:" || target.protocol === "vbscript:")
          throw new TypeError("Imported markup contains an executable stylesheet URL");

        const hasAttribute = (name: string): boolean =>
          node.attributes.some(
            (attribute) => !attribute.namespace && attribute.localName.toLowerCase() === name,
          );

        const requestControls = new Set([
          "crossorigin",
          "fetchpriority",
          "integrity",
          "nonce",
          "referrerpolicy",
        ]);
        const preserveRequest = node.attributes.some(
          (attribute) =>
            !attribute.namespace && requestControls.has(attribute.localName.toLowerCase()),
        );
        const requestAttributes = Object.fromEntries(
          node.attributes
            .filter(
              (attribute) =>
                !attribute.namespace &&
                !["disabled", "href", "media", "rel", "title"].includes(
                  attribute.localName.toLowerCase(),
                ),
            )
            .map((attribute) => [attribute.localName.toLowerCase(), attribute.value]),
        );
        const link = {
          rel: attributes.get("rel") ?? "stylesheet",
          ...(hasAttribute("media") ? { media: attributes.get("media") ?? "" } : {}),
          ...(hasAttribute("disabled") ? { disabled: true } : {}),
          ...(hasAttribute("title") ? { title: attributes.get("title") ?? "" } : {}),
          ...(Object.keys(requestAttributes).length ? { requestAttributes } : {}),
        };

        if (preserveRequest) {
          const local = localResource(href);

          makeStyle(node, "", styleIndex++, link, {
            href: href.trim(),
            suffix: local?.suffix ?? "",
            ...(local ? { sourceFilename: local.filename } : {}),
          });
        } else {
          makeStyle(node, "@import " + cssString(href.trim()) + ";", styleIndex++, link);
        }

        node.omit = true;
      }
    }

    for (const attribute of node.attributes) {
      const name = attribute.localName.toLowerCase();

      if (!attribute.namespace && name.startsWith("on"))
        throw new TypeError(
          "Imported markup cannot contain inline event handlers (" + attribute.name + ")",
        );

      if (isExecutableUrl(node, attribute))
        throw new TypeError(
          "Imported markup contains an executable URL in " + tag + "[" + attribute.name + "]",
        );

      const valueParts: MarkupValuePart[] = [];

      if (!node.omit && isResourceAttribute(node, attribute)) {
        if (name === "srcset" || name === "imagesrcset") {
          for (const candidate of srcsetCandidates(attribute.value)) {
            if (isExecutableUrlValue(candidate.value))
              throw new TypeError(
                "Imported markup contains an executable URL in " + tag + "[" + attribute.name + "]",
              );

            const target = resource(candidate.value);

            if (target)
              valueParts.push({
                start: candidate.start,
                end: candidate.end,
                resource: target.index,
                suffix: target.suffix,
              });
          }
        } else {
          const url = trimSpan(attribute.value);
          const target = resource(url.value);

          if (target)
            valueParts.push({
              start: url.start,
              end: url.end,
              resource: target.index,
              suffix: target.suffix,
            });
        }
      }

      const hasCssValue =
        (!attribute.namespace && name === "style") ||
        (svg && !attribute.namespace && svgPresentationAttributes.has(name));

      if (!node.omit && hasCssValue) {
        for (const token of scanCssUrls(attribute.value)) {
          const decoded = decodeCssValue(token.value);

          if (isExecutableCssUrl(decoded))
            throw new TypeError(
              "Imported markup contains an executable CSS URL in " +
                tag +
                "[" +
                attribute.name +
                "]",
            );

          const target = resource(decoded);

          if (target)
            valueParts.push({
              start: token.start,
              end: token.end,
              resource: target.index,
              suffix: target.suffix,
            });
        }
      }

      attribute.parts = valueParts.sort((left, right) => left.start - right.start);
    }

    for (const child of node.children) visit(child, inertTemplate || (html && tag === "template"));
  };

  for (const root of roots) visit(root);

  if (type === "svg" && roots.filter((node) => node.kind === "element" && !node.omit).length !== 1)
    throw new TypeError("Standalone SVG/XML imports require one SVG root element");

  return { ownerId: filename + "#__markup", resources, styles };
}

function isExecutableUrl(node: MarkupElement, attribute: MarkupAttribute): boolean {
  if (!isUrlAttribute(node, attribute)) return false;

  return isExecutableUrlValue(attribute.value, isNavigation(node, attribute));
}

function isExecutableUrlValue(value: string, navigation = false): boolean {
  let parsed: URL;

  try {
    parsed = new URL(value.trim(), "https://hesperia.invalid/");
  } catch {
    return false;
  }

  if (parsed.protocol === "javascript:" || parsed.protocol === "vbscript:") return true;

  return parsed.protocol === "data:" && navigation;
}

function isUrlAttribute(node: MarkupElement, attribute: MarkupAttribute): boolean {
  const name = attribute.localName.toLowerCase();
  const tag = node.localName.toLowerCase();

  if (!attribute.namespace && name === "href") return true;

  if (node.namespace === svgNamespace && attribute.namespace === xlinkNamespace && name === "href")
    return true;

  if (!attribute.namespace && ["action", "formaction"].includes(name)) return true;

  return !attribute.namespace && (resourceAttributes[tag]?.has(name) ?? false);
}

function isNavigation(node: MarkupElement, attribute: MarkupAttribute): boolean {
  const name = attribute.localName.toLowerCase();

  if (name === "action" || name === "formaction") return true;

  if (name !== "href" || (attribute.namespace && attribute.namespace !== xlinkNamespace))
    return false;

  const tag = node.localName.toLowerCase();
  return (
    (node.namespace === htmlNamespace || node.namespace === svgNamespace) &&
    ["a", "area"].includes(tag)
  );
}

function isResourceAttribute(node: MarkupElement, attribute: MarkupAttribute): boolean {
  const name = attribute.localName.toLowerCase();
  const tag = node.localName.toLowerCase();

  if (
    attribute.namespace &&
    !(node.namespace === svgNamespace && attribute.namespace === xlinkNamespace)
  )
    return false;

  if (name === "href") {
    if (node.namespace === svgNamespace) return tag !== "a";

    if (node.namespace === htmlNamespace && tag === "link")
      return (node.attributes.find((item) => item.localName.toLowerCase() === "rel")?.value ?? "")
        .toLowerCase()
        .split(/\s+/u)
        .includes("preload");

    return false;
  }

  if (tag === "link" && name === "imagesrcset")
    return (node.attributes.find((item) => item.localName.toLowerCase() === "rel")?.value ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .includes("preload");

  return resourceAttributes[tag]?.has(name) ?? false;
}

function trimSpan(value: string): {
  readonly value: string;
  readonly start: number;
  readonly end: number;
} {
  const start = value.search(/[^\t\n\f\r ]/u);

  if (start < 0) return { value: "", start: 0, end: 0 };

  let end = value.length;

  while (end > start && /[\t\n\f\r ]/u.test(value[end - 1]!)) end--;

  return { value: value.slice(start, end), start, end };
}

function srcsetCandidates(
  value: string,
): readonly { readonly value: string; readonly start: number; readonly end: number }[] {
  const candidates: { value: string; start: number; end: number }[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    while (cursor < value.length && /[\t\n\f\r ,]/u.test(value[cursor]!)) cursor++;

    if (cursor >= value.length) break;

    const start = cursor;

    while (cursor < value.length && !/[\t\n\f\r ]/u.test(value[cursor]!)) cursor++;

    let end = cursor;

    while (end > start && value[end - 1] === ",") end--;

    if (end > start) candidates.push({ value: value.slice(start, end), start, end });

    let depth = 0;
    let quote = "";
    let escaped = false;

    while (cursor < value.length) {
      const char = value[cursor]!;

      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (quote) {
        if (char === quote) quote = "";
      } else if (char === "'" || char === '"') quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && depth > 0) depth--;
      else if (char === "," && depth === 0) {
        cursor++;
        break;
      }

      cursor++;
    }
  }

  return candidates;
}

function scanCssUrls(
  value: string,
): readonly { readonly start: number; readonly end: number; readonly value: string }[] {
  const output: { start: number; end: number; value: string }[] = [];
  let index = 0;

  while (index < value.length) {
    if (value.startsWith("/*", index)) {
      index = skipCssComment(value, index);
      continue;
    }

    if (value[index] === "'" || value[index] === '"') {
      index = skipCssString(value, index);
      continue;
    }

    if (!/[a-zA-Z_\\-]/u.test(value[index]!)) {
      index++;
      continue;
    }

    const name = readCssIdentifier(value, index);

    if (!name) {
      index++;
      continue;
    }

    index = name.end;

    if (name.value.toLowerCase() !== "url") continue;

    const functionStart = skipCssComments(value, index);

    if (value[functionStart] !== "(") continue;

    const parsed = consumeCssUrl(value, functionStart + 1);

    if (parsed) output.push(parsed.token);

    index = parsed?.end ?? consumeBadCssUrl(value, functionStart + 1);
  }

  return output;
}

type ConsumedCssUrl = {
  readonly token: { readonly start: number; readonly end: number; readonly value: string };
  readonly end: number;
};

function consumeCssUrl(value: string, start: number): ConsumedCssUrl | undefined {
  let cursor = skipCssWhitespaceAndComments(value, start);
  const quote = value[cursor];

  if (quote === "'" || quote === '"') {
    cursor++;
    const contentStart = cursor;

    while (cursor < value.length) {
      const char = value[cursor]!;

      if (char === quote) {
        const contentEnd = cursor++;
        cursor = skipCssWhitespaceAndComments(value, cursor);

        if (value[cursor] !== ")") return undefined;

        return {
          token: {
            start: contentStart,
            end: contentEnd,
            value: value.slice(contentStart, contentEnd),
          },
          end: cursor + 1,
        };
      }

      if (char === "\\") {
        const escapeEnd = cssEscapeEnd(value, cursor);

        if (escapeEnd === undefined) return undefined;

        cursor = escapeEnd;
        continue;
      }

      if (/[\n\r\f]/u.test(char)) return undefined;

      cursor++;
    }

    return undefined;
  }

  const contentStart = cursor;

  while (cursor < value.length) {
    const char = value[cursor]!;

    if (char === ")")
      return {
        token: { start: contentStart, end: cursor, value: value.slice(contentStart, cursor) },
        end: cursor + 1,
      };

    if (char === "\\") {
      const escapeEnd = cssEscapeEnd(value, cursor);

      if (escapeEnd === undefined) return undefined;

      cursor = escapeEnd;
      continue;
    }

    if (/[\t\n\f\r ]/u.test(char)) {
      const end = cursor;
      cursor = skipCssWhitespaceAndComments(value, cursor);

      if (value[cursor] === ")")
        return {
          token: { start: contentStart, end, value: value.slice(contentStart, end) },
          end: cursor + 1,
        };

      return undefined;
    }

    const codePoint = char.charCodeAt(0);

    if (
      char === '"' ||
      char === "'" ||
      char === "(" ||
      codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 31) ||
      codePoint === 127
    )
      return undefined;

    cursor++;
  }

  const end = cursor;

  while (cursor > contentStart && /[\t\n\f\r ]/u.test(value[cursor - 1]!)) cursor--;

  return cursor === end
    ? { token: { start: contentStart, end, value: value.slice(contentStart, end) }, end }
    : undefined;
}

function consumeBadCssUrl(value: string, start: number): number {
  let cursor = start;

  while (cursor < value.length) {
    if (value[cursor] === ")") return cursor + 1;

    if (value[cursor] === "\\") {
      const escapeEnd = cssEscapeEnd(value, cursor);
      cursor = escapeEnd ?? cursor + 1;
    } else cursor++;
  }

  return cursor;
}

function cssEscapeEnd(value: string, start: number): number | undefined {
  if (value[start] !== "\\" || start + 1 >= value.length || /[\n\r\f]/u.test(value[start + 1]!))
    return undefined;

  let cursor = start + 1;
  const hex = /^[a-fA-F0-9]{1,6}/u.exec(value.slice(cursor));

  if (hex) {
    cursor += hex[0].length;

    if (/[\t\n\f\r ]/u.test(value[cursor] ?? "")) {
      if (value[cursor] === "\r" && value[cursor + 1] === "\n") cursor += 2;
      else cursor++;
    }

    return cursor;
  }

  return cursor + 1;
}

function skipCssString(value: string, start: number): number {
  const quote = value[start];

  if (quote !== "'" && quote !== '"') return start + 1;

  let cursor = start + 1;

  while (cursor < value.length) {
    if (value[cursor] === quote) return cursor + 1;

    if (value[cursor] === "\\") {
      const escapeEnd = cssEscapeEnd(value, cursor);

      if (escapeEnd !== undefined) {
        cursor = escapeEnd;
        continue;
      }
    }

    if (/[\n\r\f]/u.test(value[cursor]!)) return cursor;

    cursor++;
  }

  return cursor;
}

function skipCssComments(value: string, start: number): number {
  let cursor = start;

  while (value.startsWith("/*", cursor)) cursor = skipCssComment(value, cursor);

  return cursor;
}

function skipCssComment(value: string, start: number): number {
  const end = value.indexOf("*/", start + 2);
  return end < 0 ? value.length : end + 2;
}

function skipCssWhitespaceAndComments(value: string, start: number): number {
  let cursor = start;

  while (cursor < value.length) {
    if (/[\t\n\f\r ]/u.test(value[cursor]!)) cursor++;
    else if (value.startsWith("/*", cursor)) cursor = skipCssComment(value, cursor);
    else break;
  }

  return cursor;
}

function readCssIdentifier(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  let decoded = "";
  let index = start;

  while (index < value.length) {
    const char = value[index]!;

    if (/[a-zA-Z0-9_-]/u.test(char)) {
      decoded += char;
      index++;
      continue;
    }

    if (char !== "\\" || index + 1 >= value.length || /[\n\r\f]/u.test(value[index + 1]!)) break;

    index++;
    const hex = /^[a-fA-F0-9]{1,6}/u.exec(value.slice(index));

    if (hex) {
      const codepoint = Number.parseInt(hex[0], 16);
      decoded += String.fromCodePoint(codepoint === 0 || codepoint > 0x10ffff ? 0xfffd : codepoint);
      index += hex[0].length;

      if (/[\t\n\f\r ]/u.test(value[index] ?? "")) index++;
    } else {
      decoded += value[index]!;
      index++;
    }
  }

  return index === start ? undefined : { value: decoded, end: index };
}

function decodeCssValue(value: string): string {
  return value.replace(
    /\\(?:([a-fA-F0-9]{1,6})[\t\n\f\r ]?|([^\n\r\f]))/gu,
    (_match, hex: string | undefined, escaped: string | undefined) => {
      if (!hex) return escaped ?? "";

      const codepoint = Number.parseInt(hex, 16);
      return String.fromCodePoint(codepoint === 0 || codepoint > 0x10ffff ? 0xfffd : codepoint);
    },
  );
}

function cssString(value: string): string {
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\a ")
      .replaceAll("\r", "\\d ")
      .replaceAll("\f", "\\c ") +
    '"'
  );
}

function isExecutableCssUrl(value: string): boolean {
  try {
    const protocol = new URL(value.trim(), "https://hesperia.invalid/").protocol;
    return protocol === "javascript:" || protocol === "vbscript:";
  } catch {
    return false;
  }
}

function markupProjection(
  roots: readonly MarkupNode[],
  type: "html" | "svg",
  origin: PluginOrigin,
  sourceFilename: string,
  source: string,
  resources: readonly string[] = [],
  hasStyles = false,
  ownerId = "",
  resourceImportPrefix = "hesperia:markup-resource",
  styleRuntimeModule = "hesperia:markup-style-runtime",
): PluginImportResult {
  const renderedRoots = roots.filter((node) =>
    node.kind === "element" ? !node.omit : node.value.trim().length > 0,
  );
  const single = renderedRoots.length === 1 && renderedRoots[0]?.kind === "element";
  const root = single && renderedRoots[0]?.kind === "element" ? renderedRoots[0] : undefined;
  const rootType = root ? markupElementType(root, type) : undefined;
  const props = rootType
    ? `HesperiaNativeProperties<${rootType}> & HesperiaEventAttributes<${rootType}> & HesperiaSourceAttributes<${rootType}> & { readonly [name: string]: unknown; readonly bind?: ${rootType}; readonly key?: string | number; readonly children?: never }`
    : `{ readonly [name: string]: never; readonly bind?: never; readonly children?: never }`;
  const declarations = `import type { Component } from "hesperia";\ntype MarkupProps = ${props};\ndeclare const value: Component<MarkupProps>;\nexport default value;`;
  const rootProps = root ? "__callerProps" : "{}";
  const rendered = root
    ? [markupNodeCode(root, rootProps, resources.length)]
    : renderedRoots.map((node) => markupNodeCode(node, "{}", resources.length));
  const rootOutput = root ? rendered[0] : undefined;
  const browser = [
    'import { defineComponent as __defineComponent, element as __element, forwardComponentProp as __forwardComponentProp } from "hesperia/runtime";',
    ...resources.map(
      (_resource, index) =>
        "import __resource" + index + ' from "' + resourceImportPrefix + ":" + index + '";',
    ),
    ...(hasStyles ? ['import { styles as __styles } from "' + styleRuntimeModule + '";'] : []),
    "const __component = __defineComponent((owner, props) => {",
    '  const __callerProps = Object.fromEntries(Object.entries(props).filter(([name]) => name !== "children" && name !== "bind").map(([name, value]) => [name, __forwardComponentProp(value)]));',
    ...(hasStyles ? ["  __styles.bindStyles(owner, " + JSON.stringify(ownerId) + ");"] : []),
    ...(root
      ? [
          "  const __root = " + rootOutput!.code + ";",
          "  if (props.bind !== undefined) props.bind.set(__root);",
          "  return __root;",
        ]
      : ["  return [" + rendered.map((item) => item.code).join(",") + "];"]),
    "});",
    ...(hasStyles
      ? [
          "__styles.bindEntry(__component, " + JSON.stringify(ownerId) + ");",
          "await __styles.preloadEntry(" + JSON.stringify(ownerId) + ", document.head);",
        ]
      : []),
    "export default __component;",
  ].join("\n");
  const browserMappings: MarkupMapSegment[] = [];

  if (rootOutput) {
    const start = browser.indexOf("  const __root = ") + "  const __root = ".length;

    browserMappings.push(
      ...rootOutput.mappings.map((item) => ({
        ...item,
        generatedStart: item.generatedStart + start,
        generatedEnd: item.generatedEnd + start,
      })),
    );
  } else {
    let start = browser.indexOf("  return [") + "  return [".length;

    for (const item of rendered) {
      browserMappings.push(
        ...item.mappings.map((mapping) => ({
          ...mapping,
          generatedStart: mapping.generatedStart + start,
          generatedEnd: mapping.generatedEnd + start,
        })),
      );

      start += item.code.length + 1;
    }
  }

  const declarationMappings: MarkupMapSegment[] = [];

  if (root?.sourceStart !== undefined) {
    const valueStart = declarations.indexOf("declare const value") + "declare const ".length;

    declarationMappings.push({
      generatedStart: valueStart,
      generatedEnd: valueStart + "value".length,
      sourceStart: root.sourceStart + 1,
      sourceEnd: root.sourceStart + 1 + root.name.length,
    });
  }

  return {
    declaration: {
      code: declarations,
      origin,
      ...(declarationMappings.length
        ? { map: markupSourceMap(declarations, sourceFilename, source, declarationMappings) }
        : {}),
    },
    browser: {
      code: browser,
      origin,
      ...(browserMappings.length
        ? { map: markupSourceMap(browser, sourceFilename, source, browserMappings) }
        : {}),
    },
  };
}

function markupElementType(root: MarkupElement, type: "html" | "svg"): string {
  const namespace =
    root.namespace === svgNamespace || type === "svg"
      ? "svg"
      : root.namespace === mathmlNamespace
        ? "mathml"
        : "html";
  return `HesperiaNativeElement<${JSON.stringify(root.localName.toLowerCase())}, ${JSON.stringify(namespace)}>`;
}

interface MarkupMapSegment {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

interface MarkupNodeCode {
  readonly code: string;
  readonly mappings: readonly MarkupMapSegment[];
}

function markupNodeCode(
  node: MarkupNode,
  rootProps: string,
  resourceCount: number,
): MarkupNodeCode {
  if (node.kind === "text") return { code: JSON.stringify(node.value), mappings: [] };

  if (node.omit) return { code: "null", mappings: [] };

  const attributes = node.attributes.filter((attribute) => !attribute.namespace);
  const namespace =
    node.namespace || (node.name.toLowerCase() === "svg" ? svgNamespace : undefined);
  const children = node.children
    .map((child) => markupNodeCode(child, "{}", resourceCount))
    .filter((child) => child.code !== "null");
  const staticPropsPrefix = "Object.fromEntries([";
  let staticPropsBody = "";
  const staticMappings: MarkupMapSegment[] = [];

  for (const [index, attribute] of attributes.entries()) {
    if (index) staticPropsBody += ",";

    const entryStart = staticPropsBody.length;
    const name = JSON.stringify(attribute.name);
    staticPropsBody += `[${name},${markupAttributeCode(attribute, resourceCount)}]`;

    if (attribute.sourceStart !== undefined) {
      staticMappings.push({
        generatedStart: entryStart + 1,
        generatedEnd: entryStart + 2 + attribute.name.length,
        sourceStart: attribute.sourceStart,
        sourceEnd: attribute.sourceStart + attribute.name.length,
      });
    }
  }

  const staticProps = `${staticPropsPrefix}${staticPropsBody}])`;
  const merged =
    rootProps === "{}"
      ? `Object.assign(Object.create(null), ${staticProps})`
      : `Object.assign(Object.create(null), ${staticProps}, ${rootProps})`;
  const childrenCode = `[${children.map((child) => child.code).join(",")}]`;
  const prefix = `__element(owner, ${JSON.stringify(node.name)}, ${merged}, `;
  const nodeCode = `${prefix}${childrenCode}${namespace ? `, ${JSON.stringify(namespace)}` : ""})`;
  const staticPropsOffset = nodeCode.indexOf(staticProps);
  const nameLiteral = JSON.stringify(node.name);
  const nameLiteralStart = nodeCode.indexOf(nameLiteral, "__element(owner, ".length);
  const mappings: MarkupMapSegment[] = staticMappings.map((item) => ({
    ...item,
    generatedStart: item.generatedStart + staticPropsOffset + staticPropsPrefix.length,
    generatedEnd: item.generatedEnd + staticPropsOffset + staticPropsPrefix.length,
  }));

  if (node.sourceStart !== undefined && nameLiteralStart >= 0) {
    mappings.push({
      generatedStart: nameLiteralStart,
      generatedEnd: nameLiteralStart + 1 + node.name.length,
      sourceStart: node.sourceStart + 1,
      sourceEnd: node.sourceStart + 1 + node.name.length,
    });
  }

  let childOffset = prefix.length + 1;

  for (const child of children) {
    mappings.push(
      ...child.mappings.map((item) => ({
        ...item,
        generatedStart: item.generatedStart + childOffset,
        generatedEnd: item.generatedEnd + childOffset,
      })),
    );

    childOffset += child.code.length + 1;
  }

  let output: MarkupNodeCode = { code: nodeCode, mappings };
  const namespaced = node.attributes.filter((attribute) => attribute.namespace);

  if (namespaced.length === 0) return output;

  let operations = "";
  const namespaceMappings: MarkupMapSegment[] = [];

  for (const [index, attribute] of namespaced.entries()) {
    if (index) operations += " ";

    const operation = `__node.setAttributeNS(${JSON.stringify(attribute.namespace)}, ${JSON.stringify(attribute.name)}, ${markupAttributeCode(attribute, resourceCount)});`;
    const operationOffset = operations.length;
    operations += operation;

    if (attribute.sourceStart !== undefined) {
      const nameOffset = operation.indexOf(JSON.stringify(attribute.name));

      namespaceMappings.push({
        generatedStart:
          nodeCode.length + "(() => { const __node = ".length + 2 + operationOffset + nameOffset,
        generatedEnd:
          nodeCode.length +
          "(() => { const __node = ".length +
          2 +
          operationOffset +
          nameOffset +
          1 +
          attribute.name.length,
        sourceStart: attribute.sourceStart,
        sourceEnd: attribute.sourceStart + attribute.name.length,
      });
    }
  }

  output = {
    code: `(() => { const __node = ${nodeCode}; ${operations} return __node; })()`,
    mappings: [
      ...output.mappings.map((item) => ({
        ...item,
        generatedStart: item.generatedStart + "(() => { const __node = ".length,
        generatedEnd: item.generatedEnd + "(() => { const __node = ".length,
      })),
      ...namespaceMappings,
    ],
  };
  return output;
}

function markupSourceMap(
  generated: string,
  sourceFilename: string,
  source: string,
  mappings: readonly MarkupMapSegment[],
): PluginSourceMap {
  const map = new GenMapping();

  setSourceContent(map, sourceFilename, source);

  const points = mappings
    .flatMap((item) => [
      { generated: item.generatedStart, original: item.sourceStart },
      { generated: item.generatedEnd, original: item.sourceEnd },
    ])
    .filter(
      (item) =>
        item.generated >= 0 &&
        item.generated <= generated.length &&
        item.original >= 0 &&
        item.original <= source.length,
    )
    .sort((left, right) => left.generated - right.generated);

  for (const item of points) {
    const generatedPosition = offsetPosition(generated, item.generated);
    const originalPosition = offsetPosition(source, item.original);

    maybeAddSegment(
      map,
      generatedPosition.line,
      generatedPosition.column,
      sourceFilename,
      originalPosition.line,
      originalPosition.column,
    );
  }

  return toEncodedMap(map) as PluginSourceMap;
}

function offsetPosition(source: string, offset: number): { line: number; column: number } {
  let line = 0;
  let column = 0;

  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") {
      line++;
      column = 0;
    } else column++;
  }

  return { line, column };
}

function markupAttributeCode(attribute: MarkupAttribute, resourceCount: number): string {
  const parts = attribute.parts ?? [];

  if (!parts.length) return JSON.stringify(attribute.value);

  const values: string[] = [];
  let cursor = 0;

  for (const part of parts) {
    if (part.start < cursor || part.end < part.start || part.end > attribute.value.length) continue;

    if (part.start > cursor) values.push(JSON.stringify(attribute.value.slice(cursor, part.start)));

    if (part.resource < resourceCount) {
      const emitted = "new URL(__resource" + part.resource + ", import.meta.url).href";

      values.push(emitted + (part.suffix ? " + " + JSON.stringify(part.suffix) : ""));
    } else values.push(JSON.stringify(attribute.value.slice(part.start, part.end)));

    cursor = part.end;
  }

  if (cursor < attribute.value.length) values.push(JSON.stringify(attribute.value.slice(cursor)));

  return values.length ? "(" + values.join(" + ") + ")" : JSON.stringify(attribute.value);
}

function validMime(type: string): boolean {
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u.test(type);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
    return typeof value;

  if (Array.isArray(value)) {
    const types = [...new Set(value.map(jsonType))];
    return `${types.length > 1 ? `(${types.join(" | ")})` : (types[0] ?? "unknown")}[]`;
  }

  if (typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([name, item]) => `${JSON.stringify(name)}: ${jsonType(item)};`)
      .join(" ")} }`;

  throw new TypeError("JSON value cannot be represented as a declaration");
}
