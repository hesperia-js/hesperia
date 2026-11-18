/** Shared browser document and startup bytes for a validated captured application. */
export interface BrowserArtifacts {
  /** Managed namespace beneath the selected canonical mount. */
  readonly assetPath: string;
  /** Absolute pathname of the generated startup wrapper. */
  readonly startupURL: string;
  /** Module that starts the captured application at the selected mount. */
  readonly startupWrapper: Blob;
  /** Complete browser startup document. */
  readonly document: Blob;
}

/**
 * Generate the canonical browser host and static export artifacts.
 * @param mountPathname - Already validated canonical application mount pathname.
 * @param startupAsset - Already validated captured logical `/assets/...` startup key.
 * @returns Immutable artifact metadata with the shared HTML and JavaScript bytes.
 * @internal
 */
export function createBrowserArtifacts(
  mountPathname: string,
  startupAsset: string,
): BrowserArtifacts {
  const assetPath = `${mountPathname === "/" ? "" : mountPathname}/_hesperia`;
  const startupURL = `${assetPath}/startup.js`;
  const startupImport = `./assets/${startupAsset.slice("/assets/".length)}`;
  const wrapper = [
    `import { start } from ${JSON.stringify(startupImport)};`,
    `await start(${JSON.stringify(mountPathname)});`,
    "",
  ].join("\n");
  const document = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"></head><body>',
    `<script type="module" src="${startupURL.replaceAll("&", "&amp;")}"></script>`,
    "</body></html>",
    "",
  ].join("\n");

  return Object.freeze({
    assetPath,
    startupURL,
    startupWrapper: new Blob([wrapper], { type: "text/javascript; charset=utf-8" }),
    document: new Blob([document], { type: "text/html; charset=utf-8" }),
  });
}
