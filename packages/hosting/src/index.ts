import {
  captureInput,
  resolveMountPath,
  validateAssets,
  validatePublicFiles,
  assertCanonicalAssetPath,
} from "./captured-build.ts";
import type { ConcreteRoutePlan } from "./route-capabilities.ts";
import { createBrowserArtifacts } from "./browser-artifacts.ts";
import type { InProcessTargetedCapturedBuild } from "./build-control.ts";

export type { ConcreteRoutePlan, RoutePlanCapabilitiesV1 } from "./route-capabilities.ts";
export { snapshotProductionTarget } from "./target.ts";
export { createTargetedHost } from "./targeted-host.ts";
export type { TargetedHostResource } from "./targeted-host.ts";
export type {
  ProductionTargetV1,
  CapturedProductionTargetV1,
  BrowserStaticBinding,
} from "./target.ts";
export type {
  BrowserControlProvenanceV1,
  BrowserControlV3,
  ServerControlV3,
  TargetedControlRecordV3,
  PersistedBrowserV3,
  PersistedServerV3,
  PersistedTargetedBuildV3,
  TargetedCapturedBuild,
  InProcessTargetedCapturedBuild,
  WorkerCaptureDataV1,
} from "./build-control.ts";

/** A verified browser artifact inventory in the legacy captured record format. */
export interface HostingRecordV1 {
  /** The legacy captured record version. */
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

/** One unimported public file captured for exact requests under the application mount. */
export interface HostingPublicFileRecord {
  /** Raw slash-separated path relative to the public source directory, without a leading slash. */
  readonly relativePath: string;
  /** Canonical application-relative URL path for this file. */
  readonly urlPath: string;
  /** Lowercase, unprefixed SHA-256 digest of the captured file bytes. */
  readonly sha256: string;
  /** Response media type for this file. */
  readonly contentType: string;
}

/** A captured hosting record with a separate inventory for public files. */
export interface HostingRecordV2 {
  /** The public-file captured record version. */
  readonly version: 2;
  /** The build mode that produced the captured assets. */
  readonly mode: "development" | "production";
  /** The canonical mount path saved with the standalone build. */
  readonly standaloneMountURL: string;
  /** The full logical `/assets/...` key of the browser startup module. */
  readonly startupAsset: string;
  /** The complete immutable managed-asset inventory and its expected digests. */
  readonly assets: readonly HostingAssetRecord[];
  /** The complete immutable public-file inventory and its expected digests. */
  readonly publicFiles: readonly HostingPublicFileRecord[];
}

/** Resolved rendering choices recorded for one request-time SSR route. */
export type ResolvedSSRRouteProjection = Extract<ConcreteRoutePlan, { readonly producer: "ssr" }>;

/** Shared identity and entry metadata for one generated request-time page plan. */
export interface HostingServerPagePlanBase {
  /** Page-plan record version. */
  readonly version: 1;
  /** Canonical route identity selected from the captured route manifest. */
  readonly routeId: string;
  /** Build identity shared by the plan, generated entry and resume module. */
  readonly buildIdentity: string;
  /** Server renderer output format. */
  readonly format: "document";
  /** Generated server-entry module and export selected for this page plan. */
  readonly serverEntry: {
    /** Private capture-relative module path. */
    readonly path: string;
    /** Named export that implements the captured request dispatcher. */
    readonly exportName: string;
  };
}

/** One route's resolved SSR projection and generated browser resume asset. */
export type HostingServerPagePlan = HostingServerPagePlanBase &
  (
    | {
        /** Hydrated output has an exact managed resume module. */
        readonly projection: ResolvedSSRRouteProjection & {
          readonly delivery: "complete";
          readonly activation: "hydrate";
        };
        /** Canonical managed `/assets/...` path for the generated resume module. */
        readonly resumeAsset: string;
      }
    | {
        /** Non-hydrated output does not carry a browser resume module. */
        readonly projection: ResolvedSSRRouteProjection & {
          readonly delivery: "complete";
          readonly activation: "none";
        };
        /** No resume asset belongs to a non-hydrated route. */
        readonly resumeAsset?: never;
      }
  );

/** Digest inventory row for a non-servable generated server artifact. */
export interface HostingServerArtifactRecord {
  /** Slash-separated path relative to the private server capture directory. */
  readonly path: string;
  /** Lowercase, unprefixed SHA-256 digest of the captured artifact bytes. */
  readonly sha256: string;
}

/** A captured hosting record with a separate, non-servable server-artifact inventory. */
export interface HostingRecordV3 extends Omit<HostingRecordV2, "version"> {
  /** The request-time SSR captured record version. */
  readonly version: 3;
  /** Resolved per-route server plans contained by this build. */
  readonly serverPages: readonly HostingServerPagePlan[];
  /** Complete private server-artifact inventory and expected digests. */
  readonly serverArtifacts: readonly HostingServerArtifactRecord[];
}

/** A hosting record version accepted by this package. */
export type HostingRecord = HostingRecordV1 | HostingRecordV2;

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

/** A captured build with separate managed-asset and public-file byte maps. */
export interface CapturedPublicBuild {
  /** Versioned deployment settings and both captured inventories. */
  readonly hosting: HostingRecordV2;
  /** Managed browser asset bytes keyed by the exact logical path in `hosting.assets`. */
  readonly files: ReadonlyMap<string, Blob>;
  /** Public-file bytes keyed by the exact application URL path in `hosting.publicFiles`. */
  readonly publicFiles: ReadonlyMap<string, Blob>;
}

/** A request-time SSR build with separate managed, public, and private server maps. */
export interface CapturedServerBuild {
  /** Versioned deployment settings and the resolved server-page plans. */
  readonly hosting: HostingRecordV3;
  /** Managed browser asset bytes keyed by the exact logical path in `hosting.assets`. */
  readonly files: ReadonlyMap<string, Blob>;
  /** Public-file bytes keyed by the exact application URL path in `hosting.publicFiles`. */
  readonly publicFiles: ReadonlyMap<string, Blob>;
  /** Private server artifact bytes keyed by the exact path in `hosting.serverArtifacts`. */
  readonly serverFiles: ReadonlyMap<string, Blob>;
}

/** A captured build version accepted by this package. */
export type CapturedBuild = CapturedBrowserBuild | CapturedPublicBuild;

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
   * Serve the wrapper or captured assets in the managed namespace, exact public
   * file GET/HEAD requests under the application mount, and HTML GET/HEAD
   * document requests. Managed namespace misses return 404. Public-file misses
   * follow the HTML document fallback or backend fallthrough policy. Other
   * methods for known managed resources return 405; other public-file methods
   * return `undefined` so another host can try them.
   */
  handle(request: Request): Response | undefined;
}

/** A mounted application host whose page renderer completes before returning a response. */
export interface AsyncServerApplicationHost {
  /** Canonical application and managed asset namespace paths. */
  readonly mount: ApplicationHost["mount"];

  /**
   * Serve managed/public files first, then await a complete request-time page outcome.
   *
   * @param request - Web request to resolve against the captured host.
   * @returns A promise for the complete response, or `undefined` when the host does not claim it.
   */
  handle(request: Request): Promise<Response | undefined>;
}

/**
 * Load and validate a completed production build directory, without its source tree.
 * Returns the saved hosting metadata and maps containing the verified bytes for
 * each inventory. Version 1 builds return the legacy managed-asset map; version 2
 * builds return separate managed-asset and public-file maps. Rejects missing,
 * modified, unsafe, or development builds before returning. The build directory
 * must be real; the build record and captured paths must not contain symbolic links.
 * If publication retires a capture while it is being read, retries only when the
 * published record changed, for at most three attempts. Unchanged corruption fails.
 */
export async function readBuild(buildDirectory: string): Promise<CapturedBuild> {
  return (await import("./read-build.ts")).readBuildDirectory(buildDirectory);
}

/**
 * Load a completed outer-V3 targeted production capture without its source tree.
 *
 * This reader returns the validated control and its matching verified inventory. It does not
 * evaluate application entries. It accepts only outer-version-3 targeted records and rejects
 * Workerd captures; recognized non-Workerd profiles can still be unavailable to
 * `createTargetedHost`. If publication changes the selected record while its bytes are read, the
 * shared reader retries only after observing that change, with at most three read attempts.
 *
 * @param buildDirectory - Completed build directory containing `hesperia-build.json`.
 * @returns The correlated targeted capture for an in-process owner.
 * @throws {TypeError} If the record is not outer-V3 targeted data, selects Workerd, or has invalid
 * controls, capture directories, inventories, paths, or artifact bytes. Record parsing,
 * filesystem, and digest failures retain their original rejection.
 */
export async function readTargetedBuild(
  buildDirectory: string,
): Promise<InProcessTargetedCapturedBuild> {
  return (await import("./read-build.ts")).readTargetedBuildDirectory(buildDirectory);
}

/**
 * Load and validate a completed production SSR build without its source tree.
 *
 * This reader accepts only the outer version 2 and hosting version 3 record shape. It validates
 * the private server-artifact inventory and returns its bytes separately from browser and public
 * files; it does not execute a generated server entry.
 *
 * @param buildDirectory - Completed build directory containing `hesperia-build.json`.
 * @returns A captured build with separate managed, public, and private server maps.
 * @throws {TypeError} If the record, capture directories, inventories, paths, or digests are invalid.
 */
export async function readServerBuild(buildDirectory: string): Promise<CapturedServerBuild> {
  return (await import("./read-build.ts")).readServerBuildDirectory(buildDirectory);
}

/**
 * Capture, validate, and host one immutable browser build at a selected mount.
 *
 * With no selection, an empty selection object, or `mountURL: undefined`, the
 * saved canonical mount is used. A supplied mount override is canonicalized.
 * The build and selection are copied synchronously before the first digest
 * operation, so later caller changes cannot alter the host's inventory.
 *
 * Version 2 public files are served only at their exact mount-relative URL paths
 * for GET and HEAD requests. Public files stay separate from managed `/assets/...`
 * files under `/_hesperia/assets/...`. Public misses follow the existing HTML
 * document fallback or backend fallthrough policy; non-GET/HEAD methods remain
 * available to another host.
 *
 * The promise rejects with `TypeError` when the record version or mode is
 * unsupported, a mount or inventory path is unsafe or noncanonical, the startup
 * asset is absent, either inventory does not exactly match its file map, a media
 * type or digest is invalid, or the selection contains unknown fields.
 */
export async function createHost(
  build: CapturedBuild,
  selection?: HostSelection,
): Promise<ApplicationHost> {
  const snapshot = captureInput(build, selection);
  const mountPathname = resolveMountPath(snapshot);
  const assets = await validateAssets(snapshot);
  const publicFiles = await validatePublicFiles(snapshot);
  const startup = assets.get(snapshot.startupAsset as string);

  if (!startup) throw new TypeError("startupAsset is missing from the captured asset inventory");

  const {
    assetPath,
    startupURL,
    startupWrapper: wrapperBlob,
    document: documentBlob,
  } = createBrowserArtifacts(mountPathname, snapshot.startupAsset as string);
  const mount = Object.freeze({ pathname: mountPathname, assetPath });

  return Object.freeze({
    mount,

    handle(request: Request): Response | undefined {
      const resourceResponse = respondToStaticRequest(
        request,
        mountPathname,
        assetPath,
        startupURL,
        wrapperBlob,
        assets,
        publicFiles,
      );

      if (resourceResponse !== undefined) return resourceResponse;

      if (!isWithinPathname(new URL(request.url).pathname, mountPathname)) return undefined;

      if (
        (request.method !== "GET" && request.method !== "HEAD") ||
        !acceptsHTML(request.headers.get("accept"))
      )
        return undefined;

      return staticResponse(request, documentBlob);
    },
  });
}

function respondToStaticRequest(
  request: Request,
  mountPathname: string,
  assetPath: string,
  startupURL: string,
  wrapperBlob: Blob,
  assets: ReadonlyMap<string, { readonly blob: Blob; readonly contentType: string }>,
  publicFiles: ReadonlyMap<string, { readonly blob: Blob; readonly contentType: string }>,
): Response | undefined {
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

  const publicPath = mountPathname === "/" ? pathname : pathname.slice(mountPathname.length);
  const publicFile = publicFiles.get(publicPath);

  if (publicFile && (request.method === "GET" || request.method === "HEAD"))
    return staticResponse(request, publicFile.blob, publicFile.contentType);

  return undefined;
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
