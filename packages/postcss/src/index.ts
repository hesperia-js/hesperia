import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import postcssRunner, { type AcceptedPlugin } from "postcss";
import type {
  Plugin,
  PluginCssInput,
  PluginDiagnostic,
  PluginDiagnosticOrigin,
  PluginOrigin,
  PluginSourceMap,
  PluginWatch,
} from "@hesperia/tooling/project-service";

/** PostCSS processors supplied explicitly by the application configuration. */
export interface PostcssOptions {
  /** Ordered PostCSS plugins; the author owns their dependencies and options. */
  readonly plugins: readonly AcceptedPlugin[];
}

/** Run an explicit PostCSS plugin list as one source-mapped Hesperia CSS stage. */
export function postcss(options: PostcssOptions): Plugin {
  if (!Array.isArray(options.plugins))
    throw new TypeError("PostCSS plugins must be provided as an array");

  const plugins = [...options.plugins];

  return {
    name: "@hesperia/postcss",

    async transformCss(input) {
      const result = await postcssRunner(plugins).process(input.css, {
        from: input.filename,
        to: input.filename,
        map: { inline: false, annotation: false, sourcesContent: true },
      });
      const diagnostics = result.warnings().map((warning): PluginDiagnostic => {
        const location = warningOrigin(warning, input);
        return {
          severity: "warning",
          message: `${warning.text}${location.unavailable ? " (Original CSS source location unavailable after plugin transform.)" : ""}`,
          origin: location.origin,
        };
      });
      const watch = dependencyWatches(result.messages, input);
      const map = result.map?.toJSON() as unknown as PluginSourceMap | undefined;
      return {
        css: result.css,
        ...(map ? { map } : {}),
        ...(diagnostics.length ? { diagnostics } : {}),
        ...(watch.length ? { watch } : {}),
      };
    },
  };
}

interface PostcssWarningLike {
  readonly text: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly node?: {
    readonly source?: {
      readonly input?: { readonly file?: string; readonly css?: string };
    };
  };
}

interface PostcssWarningOrigin {
  readonly origin: PluginDiagnosticOrigin;
  readonly unavailable: boolean;
}

function warningOrigin(warningValue: unknown, input: PluginCssInput): PostcssWarningOrigin {
  const warning = warningValue as PostcssWarningLike;
  const warningInput = warning.node?.source?.input;
  const filename = absolutePath(
    warning.file ?? warningInput?.file ?? input.filename,
    input.filename,
  );
  const css = warningInput?.css ?? (samePath(filename, input.filename) ? input.css : undefined);
  const start = positionOffset(css, warning.line, warning.column);
  const end = positionOffset(
    css,
    warning.endLine ?? warning.line,
    warning.endColumn ?? warning.column,
  );

  if (start === undefined) return unavailableWarningOrigin(input);

  if (samePath(filename, input.filename) && input.map) {
    const mapped = mappedWarningOrigin(input.map, input.filename, css!, start, end ?? start);

    if (mapped) return { origin: mapped, unavailable: false };

    return unavailableWarningOrigin(input);
  }

  if (samePath(filename, input.filename) && input.kind === "generated")
    return unavailableWarningOrigin(input);

  if (css !== undefined)
    return {
      origin: { filename, start, end: end !== undefined && end >= start ? end : start },
      unavailable: false,
    };

  return unavailableWarningOrigin(input);
}

function unavailableWarningOrigin(input: PluginCssInput): PostcssWarningOrigin {
  return { origin: { filename: input.origin.filename }, unavailable: true };
}

function mappedWarningOrigin(
  map: PluginSourceMap,
  mapBase: string,
  currentSource: string,
  start: number,
  end: number,
): PluginOrigin | undefined {
  try {
    const trace = new TraceMap(traceableSourceMap(map, mapBase), pathToFileURL(mapBase).href);
    const startPosition = originalPositionFor(trace, offsetPosition(currentSource, start));
    const endPosition = originalPositionFor(trace, offsetPosition(currentSource, end));

    if (
      !startPosition.source ||
      startPosition.line === null ||
      startPosition.column === null ||
      endPosition.source !== startPosition.source ||
      endPosition.line === null ||
      endPosition.column === null
    )
      return undefined;

    const filename = absoluteMappedFilename(startPosition.source);

    if (!filename) return undefined;

    const sourceIndex = trace.resolvedSources.indexOf(startPosition.source);
    const source = trace.sourcesContent?.[sourceIndex];

    if (typeof source !== "string") return undefined;

    const mappedStart = positionOffset(source, startPosition.line, startPosition.column + 1);
    const mappedEnd = positionOffset(source, endPosition.line, endPosition.column + 1);

    if (mappedStart === undefined || mappedEnd === undefined || mappedEnd < mappedStart)
      return undefined;

    return { filename, start: mappedStart, end: mappedEnd };
  } catch {
    return undefined;
  }
}

function traceableSourceMap(map: PluginSourceMap, mapBase: string): SourceMapInput {
  const { sourceRoot, ...withoutSourceRoot } = map as PluginSourceMap & {
    readonly sourceRoot?: string;
  };
  return {
    ...withoutSourceRoot,
    sources: map.sources.map((source) => traceableSourceName(source, sourceRoot, mapBase)),
  } as SourceMapInput;
}

function traceableSourceName(
  source: string,
  sourceRoot: string | undefined,
  mapBase: string,
): string {
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

function offsetPosition(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, offset));
  const lastLine = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastLine - 1 };
}

function dependencyWatches(
  messages: readonly {
    readonly type: string;
    readonly file?: string;
    readonly dir?: string;
    readonly glob?: string;
    readonly parent?: string;
  }[],
  input: PluginCssInput,
): PluginWatch[] {
  const watches: PluginWatch[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.type === "dependency" && message.file) {
      const file = absolutePath(message.file, message.parent ?? input.filename);
      const key = `file:${file}`;

      if (!seen.has(key)) {
        seen.add(key);

        watches.push({ kind: "file", file });
      }
    } else if (message.type === "dir-dependency" && message.dir) {
      const dir = absolutePath(message.dir, message.parent ?? input.filename);
      const glob = message.glob;
      const key = `directory:${dir}:${glob ?? ""}`;

      if (!seen.has(key)) {
        seen.add(key);

        watches.push({ kind: "directory", dir, ...(glob ? { glob } : {}) });
      }
    }
  }

  return watches;
}

function absolutePath(path: string, importer: string): string {
  if (path.startsWith("file:")) {
    try {
      return fileURLToPath(path);
    } catch {
      return resolve(dirname(importer), path);
    }
  }

  return resolve(dirname(importer), path);
}

function absoluteMappedFilename(source: string): string | undefined {
  if (source.startsWith("<") && source.endsWith(">")) return undefined;

  try {
    if (source.startsWith("file:")) return fileURLToPath(source);

    if (isAbsolute(source) || /^[a-z]:[\\/]/iu.test(source)) return resolve(source);

    if (/^[a-z][a-z\d+.-]*:/iu.test(source)) return undefined;

    return resolve(source);
  } catch {
    return undefined;
  }
}

function samePath(first: string, second: string): boolean {
  const left = resolve(first).replaceAll("\\", "/");
  const right = resolve(second).replaceAll("\\", "/");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function positionOffset(
  source: string | undefined,
  line: number | undefined,
  column: number | undefined,
): number | undefined {
  if (
    source === undefined ||
    !Number.isInteger(line) ||
    line! < 1 ||
    !Number.isInteger(column) ||
    column! < 1
  )
    return undefined;

  let offset = 0;

  for (let current = 1; current < line!; current++) {
    const newline = source.indexOf("\n", offset);

    if (newline < 0) return undefined;

    offset = newline + 1;
  }

  return Math.min(offset + column! - 1, source.length);
}
