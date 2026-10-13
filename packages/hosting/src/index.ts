import {
  captureInput,
  resolveMountPath,
  validateAssets,
  assertCanonicalAssetPath,
} from "./captured-build.ts";

/** A verified browser artifact inventory captured for one host instance. */
export interface HostingRecordV1 {
  /** The only supported captured record version. */
  readonly version: 1;
  /** The build mode that produced the captured assets. */
  readonly mode: "development" | "production";
  /** The canonical mount path saved with the standalone build. */
  readonly standaloneMountURL: string;
  /** The full logical `/assets/...` key of the browser startup module. */
  readonly startupAsset: string;
  /** The complete immutable asset inventory and its expected SHA-256 digests. */
  readonly assets: readonly HostingAssetRecord[];
}

/** One browser asset in a captured hosting record. */
export interface HostingAssetRecord {
  /** Canonical logical asset key, beginning with `/assets/`. */
  readonly path: string;
  /** Lowercase, unprefixed SHA-256 digest of the captured file bytes. */
  readonly sha256: string;
  /** Response media type for this asset. */
  readonly contentType: string;
}

/** The host's input projection of a browser build; no source or control files belong here. */
export interface CapturedBrowserBuild {
  /** Versioned deployment settings and browser asset inventory. */
  readonly hosting: HostingRecordV1;
  /** Browser asset bytes keyed by the exact logical path in `hosting.assets`. */
  readonly files: ReadonlyMap<string, Blob>;
}

/** Optional per-host deployment selection. */
export interface HostSelection {
  /** Path-only mount override; raw Unicode is canonicalized before use. */
  readonly mountURL?: string;
}

/** A mounted application and its synchronous Fetch request handler. */
export interface ApplicationHost {
  /** Canonical application and managed asset namespace paths. */
  readonly mount: {
    /** Application path prefix, with `/` representing the origin root. */
    readonly pathname: string;
    /** Managed namespace path that serves the wrapper and captured assets. */
    readonly assetPath: string;
  };

  /**
   * Serve the wrapper or captured assets in the managed namespace and HTML
   * GET/HEAD document requests under the application mount. Managed namespace
   * misses return 404; unclaimed backend requests return `undefined` so another
   * host can try them. Other methods for a known managed resource return 405.
   */
  handle(request: Request): Response | undefined;
}

/**
 * Load and validate a completed production build directory, without its source tree.
 * Returns the saved hosting metadata and a Blob map containing exactly its verified
 * browser assets. Rejects missing, modified, unsafe, or development builds before
 * returning. The build directory must be real; the build record and captured asset
 * paths must not contain symbolic links.
 * If publication retires a capture while it is being read, retries only when the
 * published record changed, for at most three attempts. Unchanged corruption fails.
 */
export async function readBuild(buildDirectory: string): Promise<CapturedBrowserBuild> {
  return (await import("./read-build.ts")).readBuildDirectory(buildDirectory);
}

/**
 * Capture, validate, and host one immutable browser build at a selected mount.
 *
 * With no selection, an empty selection object, or `mountURL: undefined`, the
 * saved canonical mount is used. A supplied mount override is canonicalized.
 * The build and selection are copied synchronously before the first digest
 * operation, so later caller changes cannot alter the host's inventory.
 *
 * The promise rejects with `TypeError` when the record version or mode is
 * unsupported, a mount or asset key is unsafe or noncanonical, the startup
 * asset is absent, the inventory does not exactly match the file map, a media
 * type or digest is invalid, or the selection contains unknown fields.
 */
export async function createHost(
  build: CapturedBrowserBuild,
  selection?: HostSelection,
): Promise<ApplicationHost> {
  const snapshot = captureInput(build, selection);
  const mountPathname = resolveMountPath(snapshot);
  const assets = await validateAssets(snapshot);
  const startup = assets.get(snapshot.startupAsset as string);

  if (!startup) throw new TypeError("startupAsset is missing from the captured asset inventory");

  const assetPath = `${mountPathname === "/" ? "" : mountPathname}/_hesperia`;
  const startupURL = `${assetPath}/startup.js`;
  const startupImport = `./assets/${(snapshot.startupAsset as string).slice("/assets/".length)}`;
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
  const wrapperBlob = new Blob([wrapper], { type: "text/javascript; charset=utf-8" });
  const documentBlob = new Blob([document], { type: "text/html; charset=utf-8" });
  const mount = Object.freeze({ pathname: mountPathname, assetPath });

  return Object.freeze({
    mount,

    handle(request: Request): Response | undefined {
      const pathname = new URL(request.url).pathname;

      if (isWithinPathname(pathname, assetPath)) {
        if (pathname === startupURL) return staticResponse(request, wrapperBlob);

        const assetPrefix = `${assetPath}/assets/`;

        if (pathname.startsWith(assetPrefix)) {
          const logicalPath = `/assets/${pathname.slice(assetPrefix.length)}`;

          try {
            assertCanonicalAssetPath(logicalPath, "asset path");
          } catch {
            return new Response(null, { status: 404 });
          }

          const asset = assets.get(logicalPath);
          return asset
            ? staticResponse(request, asset.blob, asset.contentType)
            : new Response(null, { status: 404 });
        }

        return new Response(null, { status: 404 });
      }

      if (!isWithinPathname(pathname, mountPathname)) return undefined;

      if (
        (request.method !== "GET" && request.method !== "HEAD") ||
        !acceptsHTML(request.headers.get("accept"))
      )
        return undefined;

      return staticResponse(request, documentBlob);
    },
  });
}

function isWithinPathname(pathname: string, prefix: string): boolean {
  return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function acceptsHTML(accept: string | null): boolean {
  if (!accept) return false;

  return accept.split(",").some((range) => {
    const [mediaType, ...parameters] = range.trim().split(";");

    if (mediaType?.trim().toLowerCase() !== "text/html") return false;

    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.toLowerCase().startsWith("q="));

    if (!quality) return true;

    const value = Number(quality.slice(2));
    return Number.isFinite(value) && value > 0;
  });
}

function staticResponse(request: Request, blob: Blob, contentType = blob.type): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });

  const headers = new Headers({ "content-type": contentType, "content-length": String(blob.size) });
  return new Response(request.method === "HEAD" ? null : blob, { status: 200, headers });
}
