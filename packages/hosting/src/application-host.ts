import type { ResolvedGeneratedAssets } from "hesperia/runtime";
import type { ResolvedDeployment } from "./deployment.ts";
import type { ApplicationHost, CapturedBuild, HostSelection } from "./index.ts";
import {
  captureInput,
  resolveMountPath,
  validateAssets,
  validatePublicFiles,
  assertCanonicalAssetPath,
} from "./captured-build.ts";
import { createBrowserArtifacts } from "./browser-artifacts.ts";
import {
  BROWSER_MODULE_PRELOADS_ASSET,
  readBrowserModulePreloads,
} from "./browser-module-preloads.ts";
import { assertGeneratedAssetPublication } from "./generated-asset-publication.ts";
import { relativeGeneratedRequestPath, resolveGeneratedAssets } from "./generated-assets.ts";
import { snapshotHostSelection } from "./host-selection.ts";
import { classifyBrowserStaticPath, type BrowserStaticRoutingV1 } from "./static-routing.ts";

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
  return createHostWithRouting(build, selection);
}

/** Construct a browser host with the selected target's verified routing policy. @internal */
export function createHostWithRouting(
  build: CapturedBuild,
  selection?: HostSelection,
  routing?: BrowserStaticRoutingV1,
): Promise<ApplicationHost> {
  const selected = snapshotHostSelection(selection);
  const snapshot = captureInput(build, selected);
  const mountPathname = resolveMountPath(snapshot);
  const generatedAssets = resolveGeneratedAssets(mountPathname, selected?.generatedAssets);

  const deployment: ResolvedDeployment =
    selected?.applicationOrigin === undefined
      ? { version: 1, mountPathname, generatedAssets }
      : {
          version: 2,
          mountPathname,
          generatedAssets,
          applicationOrigin: selected.applicationOrigin,
        };

  return createBrowserHost(snapshot, deployment, routing);
}

/** Construct a browser host from the exact resolved binding owned by the completed deployment. */
export function createHostForDeployment(
  build: CapturedBuild,
  deployment: ResolvedDeployment,
  routing?: BrowserStaticRoutingV1,
): Promise<ApplicationHost> {
  return createBrowserHost(captureInput(build), deployment, routing);
}

async function createBrowserHost(
  snapshot: ReturnType<typeof captureInput>,
  deployment: ResolvedDeployment,
  routing?: BrowserStaticRoutingV1,
): Promise<ApplicationHost> {
  const { mountPathname, generatedAssets } = deployment;
  const applicationOrigin = deployment.version === 2 ? deployment.applicationOrigin : undefined;

  resolveMountPath(snapshot);
  const assets = await validateAssets(snapshot);
  const publicFiles = await validatePublicFiles(snapshot);

  assertGeneratedAssetPublication(
    mountPathname,
    generatedAssets,
    assets,
    publicFiles,
    applicationOrigin,
    routing,
  );

  const startupAsset = snapshot.startupAsset as string;
  const startup = assets.get(startupAsset);

  if (!startup) throw new TypeError("startupAsset is missing from the captured asset inventory");

  const modulePreloads = await readBrowserModulePreloads(
    assets.get(BROWSER_MODULE_PRELOADS_ASSET)?.blob,
    startupAsset,
    assets,
  );
  const {
    assetPath,
    startupWrapper: wrapperBlob,
    document: documentBlob,
  } = createBrowserArtifacts(mountPathname, startupAsset, generatedAssets, modulePreloads);
  const mount = Object.freeze({ pathname: mountPathname, assetPath });

  return Object.freeze({
    mount,
    generatedAssets,

    handle(request: Request): Response | undefined {
      const resourceResponse = respondToStaticRequest(
        request,
        mountPathname,
        assetPath,
        generatedAssets,
        wrapperBlob,
        assets,
        publicFiles,
        routing,
        applicationOrigin,
      );

      if (resourceResponse !== undefined) return resourceResponse;

      if (applicationOrigin !== undefined && new URL(request.url).origin !== applicationOrigin)
        return undefined;

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
  generatedAssets: ResolvedGeneratedAssets,
  wrapperBlob: Blob,
  assets: ReadonlyMap<string, { readonly blob: Blob; readonly contentType: string }>,
  publicFiles: ReadonlyMap<string, { readonly blob: Blob; readonly contentType: string }>,
  routing?: BrowserStaticRoutingV1,
  applicationOrigin?: string,
): Response | undefined {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const onApplicationOrigin = applicationOrigin === undefined || url.origin === applicationOrigin;
  const generated =
    generatedAssets.root.kind === "path" && !onApplicationOrigin
      ? undefined
      : relativeGeneratedRequestPath(url, generatedAssets);

  if (generated === "startup.js") return staticResponse(request, wrapperBlob);

  if (generated?.startsWith("assets/")) {
    const logicalPath = `/${generated}`;

    try {
      assertCanonicalAssetPath(logicalPath, "asset path");
    } catch {
      return new Response(null, { status: 404 });
    }

    const asset = assets.get(logicalPath);

    if (asset) return staticResponse(request, asset.blob, asset.contentType);

    if (onApplicationOrigin && !isWithinPathname(pathname, assetPath)) {
      if (isWithinPathname(pathname, mountPathname)) {
        const publicPath = mountPathname === "/" ? pathname : pathname.slice(mountPathname.length);
        const publicFile = publicFiles.get(publicPath);

        if (publicFile)
          return request.method === "GET" || request.method === "HEAD"
            ? staticResponse(request, publicFile.blob, publicFile.contentType)
            : undefined;
      }

      if (routing && classifyBrowserStaticPath(routing, url, mountPathname).kind === "page")
        return undefined;
    }

    return new Response(null, { status: 404 });
  }

  if (!onApplicationOrigin) return undefined;

  if (isWithinPathname(pathname, assetPath)) return new Response(null, { status: 404 });

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
