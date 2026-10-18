import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  generatedStyleFilename,
  type PreparedStyleImport,
  type PreparedMarkupNativeStyle,
  type PluginPipeline,
} from "./plugin-pipeline.ts";
import type { PluginOrigin, PluginStyleArtifact } from "./plugins.ts";

/** One independent logical CSS root after Bun has bundled its dependencies. */
export interface BundledCssRoot {
  readonly id: string;
  readonly source: string;
  readonly path: string;
  readonly revision: string;
  /** Captured filesystem inputs used by this root, including nested CSS and assets. */
  readonly dependencies: readonly string[];
  /** Logical outputs produced by this independent root. */
  readonly outputs: readonly string[];
  /** Optional authored or mirrored URL relative to the generated style-plan module. */
  readonly href?: string;
}

/** Pure build product; the caller chooses how private runtime plans reference these files. */
export interface BundledCss {
  readonly roots: readonly BundledCssRoot[];
  readonly files: ReadonlyMap<string, Blob>;
}

interface NativeCssCapturedFile {
  readonly captured: Awaited<ReturnType<PluginPipeline["capture"]>>;
  readonly stylesheet: boolean;
}

const nativeCssResponseTypes = new WeakMap<
  ReadonlyMap<string, Blob>,
  ReadonlyMap<string, string>
>();

/** Return private response metadata for native stylesheet files in a bundle. */
export function nativeCssResponseType(
  files: ReadonlyMap<string, Blob>,
  path: string,
): string | undefined {
  return nativeCssResponseTypes.get(files)?.get(path);
}

export class CssBundleError extends TypeError {
  constructor(
    readonly source: string,
    detail: string,
    readonly origin?: PluginOrigin,
  ) {
    super(`CSS bundling failed for ${source}: ${detail}`);
  }
}

/** Bundle each logical root separately so conditional ownership cannot merge at build time. */
export async function bundleCssRoots(
  projectRoot: string,
  imports: readonly PreparedStyleImport[],
  generated: readonly PluginStyleArtifact[],
  pipeline: PluginPipeline,
  nativeMarkupStyles: readonly PreparedMarkupNativeStyle[] = [],
): Promise<BundledCss> {
  const files = new Map<string, Blob>();
  const responseTypes = new Map<string, string>();
  const roots: BundledCssRoot[] = [];
  const inputs = new Map<
    string,
    {
      id: string;
      imported?: boolean;
      css?: string;
      assetOrigins?: ReadonlyMap<string, PluginOrigin>;
      native?: PreparedMarkupNativeStyle;
    }
  >();
  const transformedImports = new Map<string, Promise<string>>();
  const nativeByStyleId = new Map(nativeMarkupStyles.map((item) => [item.styleId, item]));

  for (const item of imports) {
    const path = resolve(item.filename);

    if (!inputs.has(path))
      inputs.set(path, {
        id: `css:${relative(projectRoot, path).replaceAll("\\", "/")}`,
        imported: true,
      });
  }

  for (const style of generated) {
    const path = generatedStyleFilename(style);

    if (inputs.has(path)) throw new TypeError(`Generated stylesheet path collision: ${path}`);

    const assetOrigins = new Map<string, PluginOrigin>();

    for (const reference of style.assetReferences ?? []) {
      if (!isAbsolute(reference.filename))
        throw new TypeError(
          `Generated stylesheet asset path must be absolute: ${reference.filename}`,
        );

      const key = pathKey(reference.filename);

      if (!assetOrigins.has(key)) assetOrigins.set(key, reference.origin);
    }

    const id = `generated:${style.id}`;

    inputs.set(path, {
      id,
      css: style.css,
      assetOrigins,
      ...(nativeByStyleId.has(id) ? { native: nativeByStyleId.get(id)! } : {}),
    });
  }

  const importedCss = (path: string): Promise<string> => {
    const absolute = resolve(path);
    const key = pathKey(absolute);
    const existing = transformedImports.get(key);

    if (existing) return existing;

    const pending = (async () => {
      const css = await (await pipeline.capture(absolute)).blob.text();
      const transformed = await pipeline.transformCss({
        kind: "import",
        id: `css:${relative(projectRoot, absolute).replaceAll("\\", "/")}`,
        filename: absolute,
        css,
        origin: { filename: absolute, start: 0, end: css.length },
      });
      return transformed.css;
    })();

    transformedImports.set(key, pending);

    return pending;
  };

  for (const [source, input] of inputs) {
    if (input.native) {
      const native = input.native;
      const token = digest(input.id).slice(0, 16);

      if (!native.sourceFilename) {
        const href = native.href;
        const revision = digest(href);
        const path = `/assets/native-css/${token}/${revision}/external.css`;

        roots.push({ id: input.id, source, path, revision, href, dependencies: [], outputs: [] });

        continue;
      }

      const closure = await captureNativeCssClosure(native.sourceFilename, projectRoot, pipeline);
      const sourceRoot = commonDirectory([...closure.keys()]);
      const members = [...closure.entries()]
        .map(([filename, file]) => ({
          filename,
          file,
          stylesheet: file.stylesheet,
          relative: relative(sourceRoot, filename).replaceAll("\\", "/"),
          encodedRelative: encodePathSegments(relative(sourceRoot, filename)),
          responseType: mimeType(filename, file.stylesheet),
        }))
        .sort((left, right) => left.relative.localeCompare(right.relative));
      const revision = digest(
        JSON.stringify(
          members.map(({ relative: name, file, responseType }) => [
            name,
            file.captured.digest,
            responseType,
          ]),
        ),
      );
      const prefix = `/assets/native-css/${token}/${revision}`;

      for (const { encodedRelative, file, responseType, stylesheet } of members) {
        const bytes = new Uint8Array(await file.captured.blob.arrayBuffer());
        const path = `${prefix}/${encodedRelative}`;

        files.set(path, new Blob([bytes], { type: responseType }));

        if (stylesheet) responseTypes.set(path, responseType);
      }

      const encodedStylesheet = encodePathSegments(relative(sourceRoot, native.sourceFilename));
      const path = `${prefix}/${encodedStylesheet}`;

      roots.push({
        id: input.id,
        source,
        path,
        revision,
        dependencies: [...closure.keys()],
        outputs: members.map(({ encodedRelative }) => `${prefix}/${encodedRelative}`),
        href: `./native-css/${token}/${revision}/${encodedStylesheet}${native.suffix}`,
      });

      continue;
    }

    let loadFailure: CssBundleError | undefined;
    const importedCssPaths = new Set<string>();
    const dependencies = new Set<string>();
    const generatedAssetOrigins = input.assetOrigins ?? new Map<string, PluginOrigin>();
    const result = await Bun.build({
      entrypoints: [source],
      root: projectRoot,
      target: "browser",
      minify: true,
      metafile: true,
      naming: {
        entry: "assets/[name]-[hash].[ext]",
        asset: "assets/[name]-[hash].[ext]",
      },
      plugins: [
        {
          name: "hesperia-css-capture",

          setup(builder) {
            builder.onResolve({ filter: /.*/u }, ({ path, kind, resolveDir }) => {
              if (kind === "internal" && path.startsWith("/")) return { path, external: true };

              if (kind === "import-rule" && path.startsWith("/")) return { path, external: true };

              const absolute = resolveRequest(path, resolveDir || projectRoot);

              if (generatedAssetOrigins.has(pathKey(absolute))) return { path: absolute };

              if (kind === "import-rule" && (path.startsWith(".") || isAbsolute(path))) {
                importedCssPaths.add(pathKey(absolute));

                return { path: absolute };
              }

              return undefined;
            });

            if (input.css !== undefined)
              builder.onResolve({ filter: /\.css$/iu }, ({ path, resolveDir }) =>
                pathKey(resolveRequest(path, resolveDir || projectRoot)) === pathKey(source)
                  ? { path: source }
                  : undefined,
              );

            builder.onLoad({ filter: /.*/u }, async ({ path }) => {
              const absolute = resolveRequest(path, projectRoot);

              if (!(pathKey(absolute) === pathKey(source) && input.css !== undefined))
                dependencies.add(absolute);

              try {
                const isEntry = pathKey(absolute) === pathKey(source);
                const css =
                  (isEntry && (input.imported === true || input.css !== undefined)) ||
                  importedCssPaths.has(pathKey(absolute)) ||
                  absolute.toLowerCase().endsWith(".css");
                return {
                  contents:
                    isEntry && input.css !== undefined
                      ? input.css
                      : css
                        ? await importedCss(absolute)
                        : new Uint8Array(
                            await (await pipeline.capture(absolute)).blob.arrayBuffer(),
                          ),
                  loader: css ? "css" : "file",
                  resolveDir: dirname(absolute),
                };
              } catch (error) {
                const origin = generatedAssetOrigins.get(pathKey(absolute));
                loadFailure ??= new CssBundleError(
                  absolute,
                  error instanceof Error ? error.message : String(error),
                  origin,
                );
                throw loadFailure;
              }
            });
          },
        },
      ],
    }).catch((error: unknown) => {
      throw (
        loadFailure ??
        new CssBundleError(source, error instanceof Error ? error.message : String(error))
      );
    });

    if (loadFailure) throw loadFailure;

    if (!result.success)
      throw new CssBundleError(source, result.logs.map((item) => item.message).join("; "));

    const css = result.outputs.find((item) => item.path.endsWith(".css"));

    if (!css) throw new TypeError(`Bun emitted no stylesheet for ${source}`);

    const path = outputPath(css.path);
    const contents = new Uint8Array(await css.arrayBuffer());

    roots.push({
      id: input.id,
      source,
      path,
      revision: digest(contents),
      dependencies: [...dependencies],
      outputs: result.outputs.map((item) => outputPath(item.path)),
    });

    for (const artifact of result.outputs) files.set(outputPath(artifact.path), artifact);
  }

  nativeCssResponseTypes.set(files, responseTypes);

  return { roots, files };
}

async function captureNativeCssClosure(
  stylesheet: string,
  projectRoot: string,
  pipeline: PluginPipeline,
): Promise<ReadonlyMap<string, NativeCssCapturedFile>> {
  const root = resolve(stylesheet);
  const files = new Map<
    string,
    { filename: string; captured?: NativeCssCapturedFile["captured"]; stylesheet: boolean }
  >();
  const pending = [{ filename: root, inheritedEncoding: "utf-8" }];
  const visited = new Set<string>();

  while (pending.length) {
    const state = pending.shift()!;
    const stateKey = `${pathKey(state.filename)}\0${state.inheritedEncoding}`;

    if (visited.has(stateKey)) continue;

    visited.add(stateKey);

    const sourcePath = resolve(state.filename);
    const sourceKey = pathKey(sourcePath);
    const source = await captureNativeFile(sourcePath, pipeline);
    const sourceBytes = new Uint8Array(await source.blob.arrayBuffer());
    const encoding = cssEncodingDecision(sourceBytes, state.inheritedEncoding).encoding;
    const knownSource = files.get(sourceKey);

    if (knownSource) {
      knownSource.captured = source;
      knownSource.stylesheet = true;
    } else files.set(sourceKey, { filename: sourcePath, captured: source, stylesheet: true });

    let loadFailure: CssBundleError | undefined;
    const localAssets = new Map<string, string>();

    const result = await Bun.build({
      entrypoints: [sourcePath],
      root: projectRoot,
      target: "browser",
      metafile: true,
      plugins: [
        {
          name: "hesperia-native-css-context",

          setup(builder) {
            builder.onResolve({ filter: /.*/u }, ({ path, kind, resolveDir }) => {
              if (pathKey(path) === sourceKey) return { path: sourcePath };

              if (path.startsWith("#") || path.startsWith("//") || path.startsWith("/"))
                return { path, external: true };

              if (/^[a-z][a-z\d+.-]*:/iu.test(path)) return { path, external: true };

              const absolute = resolveRequest(path, resolveDir || dirname(sourcePath));
              const absoluteKey = pathKey(absolute);

              if (kind === "import-rule") {
                pending.push({ filename: absolute, inheritedEncoding: encoding });

                const known = files.get(absoluteKey);

                if (known) known.stylesheet = true;
                else files.set(absoluteKey, { filename: absolute, stylesheet: true });

                return { path: absolute, external: true };
              }

              localAssets.set(absoluteKey, absolute);

              if (!files.has(absoluteKey))
                files.set(absoluteKey, { filename: absolute, stylesheet: false });

              return { path: absolute };
            });

            builder.onLoad({ filter: /.*/u }, async ({ path }) => {
              const absolute = resolveRequest(path, projectRoot);
              const absoluteKey = pathKey(absolute);

              if (absoluteKey === sourceKey)
                return {
                  contents: new TextDecoder(encoding).decode(sourceBytes),
                  loader: "css",
                  resolveDir: dirname(absolute),
                };

              const captured = await captureNativeFile(absolute, pipeline).catch(
                (error: unknown) => {
                  loadFailure ??= new CssBundleError(
                    absolute,
                    error instanceof Error ? error.message : String(error),
                  );
                  throw loadFailure;
                },
              );
              const known = files.get(absoluteKey);

              if (known) known.captured = captured;
              else files.set(absoluteKey, { filename: absolute, captured, stylesheet: false });

              localAssets.set(absoluteKey, absolute);

              return {
                contents: new Uint8Array(await captured.blob.arrayBuffer()),
                loader: "file",
                resolveDir: dirname(absolute),
              };
            });
          },
        },
      ],
    }).catch((error: unknown) => {
      throw (
        loadFailure ??
        new CssBundleError(sourcePath, error instanceof Error ? error.message : String(error))
      );
    });

    if (loadFailure) throw loadFailure;

    if (!result.success)
      throw new CssBundleError(sourcePath, result.logs.map((item) => item.message).join("; "));

    if (!result.metafile)
      throw new CssBundleError(sourcePath, "Bun returned no CSS dependency graph");

    for (const [assetKey, filename] of localAssets) {
      const known = files.get(assetKey);

      if (known?.captured) continue;

      const captured = await captureNativeFile(filename, pipeline);

      if (known) known.captured = captured;
      else files.set(assetKey, { filename, captured, stylesheet: false });
    }
  }

  const closure = new Map<string, NativeCssCapturedFile>();

  for (const file of files.values()) {
    const captured = file.captured ?? (await captureNativeFile(file.filename, pipeline));

    closure.set(resolve(file.filename), { captured, stylesheet: file.stylesheet });
  }

  if (!closure.has(root)) throw new CssBundleError(root, "CSS graph omitted its root stylesheet");

  return closure;
}

async function captureNativeFile(
  filename: string,
  pipeline: PluginPipeline,
): Promise<Awaited<ReturnType<PluginPipeline["capture"]>>> {
  try {
    return await pipeline.capture(filename);
  } catch (error) {
    throw new CssBundleError(filename, error instanceof Error ? error.message : String(error));
  }
}

function commonDirectory(filenames: readonly string[]): string {
  if (!filenames.length) throw new TypeError("A native stylesheet graph cannot be empty");

  let common = dirname(resolve(filenames[0]!));

  for (const filename of filenames.slice(1)) {
    const target = resolve(filename);

    while (true) {
      const targetRelative = relative(common, target);

      if (!isParentRelative(targetRelative) && !isAbsolute(targetRelative)) break;

      const parent = dirname(common);

      if (parent === common) throw new TypeError("Native stylesheet paths have no common root");

      common = parent;
    }
  }

  return common;
}

function mimeType(path: string, stylesheet: boolean): string {
  if (stylesheet) return "text/css";

  return Bun.file(path).type || "application/octet-stream";
}

interface CssEncodingDecision {
  readonly encoding: string;
}

function cssEncodingDecision(bytes: Uint8Array, inherited?: string): CssEncodingDecision {
  const encoding = cssBomEncoding(bytes) ?? cssDeclaredEncoding(bytes);

  if (encoding) return { encoding };

  return { encoding: inherited ?? "utf-8" };
}

function cssBomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";

  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";

  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";

  return undefined;
}

function cssDeclaredEncoding(bytes: Uint8Array): string | undefined {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 1024));
  const declaration = [0x40, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x20, 0x22];

  if (prefix.length <= declaration.length) return undefined;

  if (declaration.some((byte, index) => prefix[index] !== byte)) return undefined;

  let end = declaration.length;

  while (end < prefix.length && prefix[end] !== 0x22) {
    const byte = prefix[end]!;

    if (!(byte <= 0x21 || (byte >= 0x23 && byte <= 0x7f))) return undefined;

    end++;
  }

  if (end === declaration.length || prefix[end] !== 0x22 || prefix[end + 1] !== 0x3b)
    return undefined;

  const label = String.fromCharCode(...prefix.subarray(declaration.length, end));

  try {
    const encoding = new TextDecoder(label).encoding;
    return encoding === "utf-16be" || encoding === "utf-16le" ? "utf-8" : encoding;
  } catch {
    return undefined;
  }
}

function isParentRelative(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => segment === "..");
}

function encodePathSegments(path: string): string {
  const url = new URL("https://hesperia.invalid");
  url.pathname = `/${path.replaceAll("\\", "/").replaceAll("%", "%25")}`;
  return url.pathname.slice(1);
}

function digest(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function resolveRequest(path: string, resolveDir: string): string {
  if (isAbsolute(path)) return resolve(path);

  const encodedRequest = path.replace(/[?#].*$/u, "");
  let request = encodedRequest;

  try {
    request = decodeURIComponent(encodedRequest);
  } catch {
    // CSS URLs with a literal or malformed percent escape resolve as authored.
  }

  return resolve(resolveDir, request);
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function outputPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/assets/");
  const logical =
    index >= 0
      ? normalized.slice(index)
      : normalized.startsWith("assets/")
        ? `/${normalized}`
        : undefined;

  if (logical) {
    const url = new URL("https://hesperia.invalid");
    url.pathname = logical;
    return url.pathname;
  }

  throw new TypeError(`Unexpected Bun CSS artifact path: ${path}`);
}
