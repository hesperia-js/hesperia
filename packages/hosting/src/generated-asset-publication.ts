import type { ResolvedGeneratedAssets } from "hesperia/runtime";

/**
 * Reject a generated resource that would replace a captured public URL on the application origin.
 * Absolute URL roots need the deployment's actual application origin, which this host input does
 * not supply, so they do not imply an origin match here.
 *
 * @param mountPathname - Canonical application mount used to publish public files.
 * @param generatedAssets - Resolved generated-resource directory for this deployment.
 * @param assets - Complete verified managed asset map, keyed by logical `/assets/...` paths.
 * @param publicFiles - Complete verified public-file map, keyed by application-relative URL paths.
 * @throws {TypeError} If a selected generated resource and captured public file have the same URL.
 * @internal
 */
export function assertGeneratedAssetPublication(
  mountPathname: string,
  generatedAssets: ResolvedGeneratedAssets,
  assets: ReadonlyMap<string, unknown>,
  publicFiles: ReadonlyMap<string, unknown>,
): void {
  const root = generatedAssets.root;

  if (root.kind !== "path") return;

  const generatedPaths = new Set([
    `${root.pathname}startup.js`,
    ...[...assets.keys()].map((path) => `${root.pathname}${path.slice(1)}`),
  ]);
  const mountPrefix = mountPathname === "/" ? "" : mountPathname;

  for (const publicPath of publicFiles.keys()) {
    const pathname = `${mountPrefix}${publicPath}`;

    if (generatedPaths.has(pathname))
      throw new TypeError(`Generated resource collides with captured public file: ${pathname}`);
  }
}
