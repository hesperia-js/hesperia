import { captureInput, captureServerInput, isRecord, resolveMountPath } from "./captured-build.ts";
import type { ResolvedDeployment } from "./deployment.ts";
import { resolveGeneratedAssets } from "./generated-assets.ts";
import { snapshotHostSelection } from "./host-selection.ts";
import type { CapturedBuild, CapturedServerBuild, HostSelection } from "./index.ts";

/**
 * Resolve the deployment binding for one captured build without reading artifact bytes or
 * evaluating an application entry.
 *
 * Selection is captured before any build property is read. An inherited deployment is the base
 * binding for a redeployment: an empty or omitted selection preserves its exact identity, a
 * mount-only override preserves its generated-assets object, and an explicit generated-assets
 * selection replaces that complete selection at the effective mount.
 *
 * @param build - Captured browser or server build whose saved mount supplies the initial default.
 * @param selection - Optional own-data deployment overrides, captured synchronously.
 * @param inherited - Previously validated deployment used as the base for redeployment.
 * @returns A frozen resolved deployment; the inherited object is returned unchanged when there is
 * no effective override.
 * @throws TypeError for malformed build data, selections, or mount paths.
 */
export function resolveCapturedDeployment(
  build: CapturedBuild | CapturedServerBuild,
  selection?: HostSelection,
  inherited?: ResolvedDeployment,
): ResolvedDeployment {
  const selected = snapshotHostSelection(selection);
  const hosting = isRecord(build) ? build.hosting : undefined;
  const serverBuild = isRecord(hosting) && hosting.version === 3;
  const snapshot = serverBuild
    ? captureServerInput(build as CapturedServerBuild, selected).browserInput
    : captureInput(build as CapturedBuild, selected);
  const capturedMountPathname = resolveMountPath(snapshot);
  const hasMountOverride = selected?.mountURL !== undefined;
  const generatedAssetSelection = selected?.generatedAssets;

  const selectedOrigin = selected?.applicationOrigin;

  if (
    inherited &&
    !hasMountOverride &&
    generatedAssetSelection === undefined &&
    selectedOrigin === undefined
  )
    return inherited;

  const mountPathname = hasMountOverride
    ? capturedMountPathname
    : (inherited?.mountPathname ?? capturedMountPathname);
  const generatedAssets =
    inherited && generatedAssetSelection === undefined
      ? inherited.generatedAssets
      : resolveGeneratedAssets(mountPathname, generatedAssetSelection);

  const applicationOrigin =
    selectedOrigin ?? (inherited?.version === 2 ? inherited.applicationOrigin : undefined);

  return applicationOrigin === undefined
    ? Object.freeze({ version: 1, mountPathname, generatedAssets })
    : Object.freeze({ version: 2, mountPathname, generatedAssets, applicationOrigin });
}
