import type { ResolvedGeneratedAssets } from "hesperia/runtime";
import type { ResolvedDeploymentV1 } from "./deployment.ts";
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
  const selected = snapshotHostSelection(selection);
  const snapshot = captureInput(build, selected);
  const mountPathname = resolveMountPath(snapshot);
  const generatedAssets = resolveGeneratedAssets(mountPathname, selected?.generatedAssets);

  return createBrowserHost(snapshot, { version: 1, mountPathname, generatedAssets });
}

/** Construct a browser host from the exact resolved binding owned by the completed deployment. */
export function createHostForDeployment(
  build: CapturedBuild,
  deployment: ResolvedDeploymentV1,
): Promise<ApplicationHost> {
  return createBrowserHost(captureInput(build), deployment);
}

async function createBrowserHost(
  snapshot: ReturnType<typeof captureInput>,
  { mountPathname, generatedAssets }: ResolvedDeploymentV1,
): Promise<ApplicationHost> {
  const assets = await validateAssets(snapshot);
  const publicFiles = await validatePublicFiles(snapshot);

  assertGeneratedAssetPublication(mountPathname, generatedAssets, assets, publicFiles);

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
  generatedAssets: ResolvedGeneratedAssets,
  wrapperBlob: Blob,
  assets: ReadonlyMap<string, { readonly blob: Blob; readonly contentType: string }>,
  publicFiles: ReadonlyMap<string, { readonly blob: Blob; readonly contentType: string }>,
): Response | undefined {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const generated = relativeGeneratedRequestPath(url, generatedAssets);

  if (generated === "startup.js") return staticResponse(request, wrapperBlob);

  if (generated?.startsWith("assets/")) {
    const logicalPath = `/${generated}`;

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
