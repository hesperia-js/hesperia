import type { ResolvedGeneratedAssets } from "hesperia/runtime";
import type { BrowserModulePreloads } from "./browser-module-preloads.ts";

/** Shared browser document and startup bytes for a validated captured application. */
export interface BrowserArtifacts {
  /** Resolved deployment binding passed to the actual browser startup. */
  readonly generatedAssets: ResolvedGeneratedAssets;
  /** Managed namespace beneath the selected canonical mount. */
  readonly assetPath: string;
  /** Managed source-serving pathname of the generated startup wrapper. */
  readonly managedStartupURL: string;
  /** Selected pathname or absolute URL referenced by the generated document. */
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
 * @param generatedAssets - Binding resolved by the Hosting deployment authority.
 * @param modulePreloads - Verified dependencies of the startup entry and required imports.
 * @returns Immutable artifact metadata with the shared HTML and JavaScript bytes.
 * @internal
 */
export function createBrowserArtifacts(
  mountPathname: string,
  startupAsset: string,
  generatedAssets: ResolvedGeneratedAssets,
  modulePreloads: BrowserModulePreloads = { modules: [] },
): BrowserArtifacts {
  const assetPath = `${mountPathname === "/" ? "" : mountPathname}/_hesperia`;
  const managedStartupURL = `${assetPath}/startup.js`;
  const root = generatedAssets.root;
  const rootURL = root.kind === "path" ? root.pathname : root.href;
  const startupURL = `${rootURL}startup.js`;
  const startupImport = `./assets/${startupAsset.slice("/assets/".length)}`;
  const imports = modulePreloads.imports ? `, ${JSON.stringify(modulePreloads.imports)}` : "";
  const wrapper = [
    `import { start } from ${JSON.stringify(startupImport)};`,
    `await start(${JSON.stringify(mountPathname)}, ${JSON.stringify(generatedAssets)}${imports});`,
    "",
  ].join("\n");
  const preloadLinks = modulePreloads.modules
    .map(
      (path) =>
        `<link rel="modulepreload" crossorigin="${generatedAssets.moduleCredentials}" href="${escapeAttribute(rootURL + path.slice(1))}">`,
    )
    .join("");
  const document = [
    "<!doctype html>",
    `<html><head><meta charset="utf-8">${preloadLinks}</head><body>`,
    `<script type="module" crossorigin="${generatedAssets.moduleCredentials}" src="${escapeAttribute(startupURL)}"></script>`,
    "</body></html>",
    "",
  ].join("\n");

  return Object.freeze({
    generatedAssets,
    assetPath,
    managedStartupURL,
    startupURL,
    startupWrapper: new Blob([wrapper], { type: "text/javascript; charset=utf-8" }),
    document: new Blob([document], { type: "text/html; charset=utf-8" }),
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
