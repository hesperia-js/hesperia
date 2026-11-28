import type { ResolvedGeneratedAssets } from "hesperia/runtime";
import {
  captureInput,
  captureServerInput,
  resolveMountPath,
  validateAssets,
  validatePublicFiles,
  validateServerFiles,
  isRecord,
  validateTargetedDeploymentCapturedBuild,
} from "./captured-build.ts";
import { createBrowserArtifacts } from "./browser-artifacts.ts";
import {
  BROWSER_MODULE_PRELOADS_ASSET,
  readBrowserModulePreloads,
} from "./browser-module-preloads.ts";
import { resolveGeneratedAssets } from "./generated-assets.ts";
import type { CapturedBuild, CapturedServerBuild, HostSelection } from "./index.ts";
import { snapshotHostSelection } from "./host-selection.ts";
import { assertGeneratedAssetPublication } from "./generated-asset-publication.ts";
import {
  BROWSER_STATIC_ROUTING_ASSET,
  readVerifiedBrowserStaticRouting,
} from "./static-routing.ts";
import type { TargetedDeploymentCapturedBuildV4 } from "./build-control.ts";
import { resolveCapturedDeployment } from "./captured-deployment.ts";

/** A synchronous request handler for one captured generated-resource directory. */
export interface GeneratedAssetHost {
  /** Resolved directory identity and native module credentials for this host. */
  readonly generatedAssets: ResolvedGeneratedAssets;

  /**
   * Serve the startup wrapper or an exact verified managed asset in the selected directory.
   * Path roots match the request pathname; absolute URL roots also require the selected origin.
   * Only GET and HEAD are served. Known resource paths return 405 for other methods, while
   * requests outside the selected directory or for unknown assets return `undefined`.
   *
   * @param request - The original Fetch request supplied by the provider.
   * @returns A generated-resource response or `undefined` when the provider should continue.
   */
  handle(request: Request): Response | undefined;
}

/**
 * Snapshot and validate one captured build, then serve only its generated wrapper and managed
 * assets from the selected generated-resource directory.
 *
 * Browser builds validate managed and public inventories. Server builds also validate their
 * private inventory without importing or evaluating any captured entry. All build maps and the
 * selected deployment settings are captured synchronously before byte verification begins.
 *
 * @param build - Captured inventory or V4 deployment capture; no server entry is evaluated.
 * @param selection - Optional mount and generated-resource settings. Omitted generated-assets
 * settings retain a V4 capture's resolved binding, including with a mount-only override.
 * @returns A host with its frozen generated-resource binding and synchronous Fetch handler.
 * @throws {TypeError} If the build snapshot, selected mount, generated-resource binding, or any
 * captured inventory is invalid, if a digest fails, or if the startup asset is absent.
 */
export async function createGeneratedAssetHost(
  build: CapturedBuild | CapturedServerBuild | TargetedDeploymentCapturedBuildV4,
  selection?: HostSelection,
): Promise<GeneratedAssetHost> {
  const selected = snapshotHostSelection(selection);
  const input = isDeploymentCapture(build)
    ? {
        kind: "deployment" as const,
        captured: await validateTargetedDeploymentCapturedBuild(build),
      }
    : { kind: "inventory" as const, inventory: build };
  const inventory = input.kind === "deployment" ? input.captured.inventory : input.inventory;
  const deployment =
    input.kind === "deployment"
      ? resolveCapturedDeployment(inventory, selected, input.captured.deployment)
      : undefined;
  const serverSnapshot =
    isRecord(inventory) && isRecord(inventory.hosting) && inventory.hosting.version === 3
      ? captureServerInput(inventory as CapturedServerBuild, selected)
      : undefined;
  const snapshot =
    serverSnapshot?.browserInput ?? captureInput(inventory as CapturedBuild, selected);
  const selectedMountPathname = resolveMountPath(snapshot);
  const mountPathname = deployment?.mountPathname ?? selectedMountPathname;
  const generatedAssets =
    deployment?.generatedAssets ?? resolveGeneratedAssets(mountPathname, selected?.generatedAssets);
  const validation = serverSnapshot
    ? Promise.all([
        validateAssets(snapshot),
        validatePublicFiles(snapshot),
        validateServerFiles(serverSnapshot),
      ])
    : Promise.all([validateAssets(snapshot), validatePublicFiles(snapshot)]);
  const [assets, publicFiles] = await validation;

  const applicationOrigin =
    deployment?.version === 2 ? deployment.applicationOrigin : selected?.applicationOrigin;
  const routing =
    input.kind === "deployment" && input.captured.control.kind === "browser"
      ? await readVerifiedBrowserStaticRouting(
          assets.get(BROWSER_STATIC_ROUTING_ASSET),
          input.captured.control.hosting.standaloneMountURL,
          publicFiles,
        )
      : undefined;

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
  const { startupWrapper } = createBrowserArtifacts(
    mountPathname,
    startupAsset,
    generatedAssets,
    modulePreloads,
  );
  const generatedRoot = generatedAssets.root;
  const generatedRootPathname =
    generatedRoot.kind === "path" ? generatedRoot.pathname : new URL(generatedRoot.href).pathname;
  const generatedRootOrigin =
    generatedRoot.kind === "url" ? new URL(generatedRoot.href).origin : undefined;
  const startupPathname = `${generatedRootPathname}startup.js`;
  const managedAssetPrefix = `${generatedRootPathname}assets/`;

  return Object.freeze({
    generatedAssets,

    handle(request: Request): Response | undefined {
      const requestURL = new URL(request.url);

      if (generatedRootOrigin !== undefined && requestURL.origin !== generatedRootOrigin)
        return undefined;

      const pathname = requestURL.pathname;
      let blob: Blob;
      let contentType: string;

      if (pathname === startupPathname) {
        blob = startupWrapper;
        contentType = startupWrapper.type;
      } else if (pathname.startsWith(managedAssetPrefix)) {
        const logicalPath = `/assets/${pathname.slice(managedAssetPrefix.length)}`;
        const asset = assets.get(logicalPath);

        if (!asset) return undefined;

        blob = asset.blob;
        contentType = asset.contentType;
      } else {
        return undefined;
      }

      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });

      const headers = new Headers({
        "content-type": contentType,
        "content-length": String(blob.size),
      });

      return request.method === "HEAD"
        ? new Response(null, { headers })
        : new Response(blob, { headers });
    },
  });
}

function isDeploymentCapture(
  build: CapturedBuild | CapturedServerBuild | TargetedDeploymentCapturedBuildV4,
): build is TargetedDeploymentCapturedBuildV4 {
  return isRecord(build) && Object.hasOwn(build, "version");
}
