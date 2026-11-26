import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertSafeServerArtifactPath,
  captureInput,
  captureServerInput,
  resolveMountPath,
  validateAssets,
  validatePublicFiles,
  validateServerFiles,
  assertCanonicalAssetPath,
  isRecord,
  snapshotPublicFileMetadata,
  snapshotTargetedControl,
  validateTargetedCapturedBuild,
  validateTargetedDeploymentCapturedBuild,
} from "./captured-build.ts";
import type {
  InProcessTargetedCapturedBuild,
  InProcessTargetedDeploymentCapturedBuildV4,
  TargetedCapturedBuild,
  TargetedControlRecordV3,
  TargetedDeploymentCapturedBuildV4,
} from "./build-control.ts";
import { snapshotDeployment, type ResolvedDeployment } from "./deployment.ts";
import type {
  CapturedBuild,
  CapturedBrowserBuild,
  CapturedPublicBuild,
  CapturedServerBuild,
  HostingRecordV1,
  HostingRecordV2,
  HostingRecordV3,
} from "./index.ts";

const captureIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

export async function readBuildDirectory(buildDirectory: string): Promise<CapturedBuild> {
  return readBuildDirectoryWithRetry(buildDirectory, readCapture);
}

/**
 * Read a supplied legacy development record and its verified managed and optional public bytes.
 *
 * Unversioned or outer-V1 records with development hosting V1 or V2 are accepted. Rich legacy metadata
 * remains valid; this reader neither converts it to a targeted control nor changes its mode.
 * It reads no current pointer or archive, retries no publication, and evaluates no application
 * entry. The caller owns the relationship between the supplied record and its publication.
 *
 * @param buildDirectory - Real build root containing the record's captured directories.
 * @param recordSource - Supplied unversioned or outer-V1 development record text.
 * @returns Development hosting metadata and owned, digest-verified managed and public bytes.
 * @throws TypeError through rejection for a different mode or record branch, crossed captures,
 * unsafe paths, links or invalid bytes. Record and filesystem failures retain their rejection.
 */
export async function readDevelopmentBuildRecord(
  buildDirectory: string,
  recordSource: string,
): Promise<CapturedBuild> {
  const output = await resolveBuildDirectory(buildDirectory);

  return readLegacyCapture(output, recordSource, "development");
}

/**
 * Load a completed outer-V2, hosting-V3 server capture without executing its private entry.
 *
 * @throws {TypeError} If the record version, same-capture directories, captured paths, inventory,
 * or artifact digests are invalid.
 */
export async function readServerBuildDirectory(
  buildDirectory: string,
): Promise<CapturedServerBuild> {
  return readBuildDirectoryWithRetry(buildDirectory, readServerCapture);
}

/**
 * Read a completed build using its outer record version to retain legacy or targeted controls.
 * A corrupt selected record fails without falling back to the other reader.
 */
export async function readCompletedBuildDirectory(
  buildDirectory: string,
): Promise<
  CapturedBuild | CapturedServerBuild | TargetedCapturedBuild | TargetedDeploymentCapturedBuildV4
> {
  return readBuildDirectoryWithRetry<
    CapturedBuild | CapturedServerBuild | TargetedCapturedBuild | TargetedDeploymentCapturedBuildV4
  >(buildDirectory, (output, recordSource) => {
    const record = JSON.parse(recordSource) as Record<string, unknown>;

    if (!isRecord(record)) throw new TypeError("The completed build record must be an object");

    if (record.version === 4) return readTargetedDeploymentCapture(output, recordSource, record);

    if (!isRecord(record.hosting))
      throw new TypeError("The completed build record has no hosting metadata");

    if (record.version === undefined || record.version === 1)
      return readCapture(output, recordSource);

    if (record.version === 2) return readServerCapture(output, recordSource);

    if (record.version === 3) return readTargetedCapture(output, recordSource, record);

    throw new TypeError("unsupported completed build record version");
  });
}

/**
 * Read a completed targeted capture admitted to the in-process build type.
 *
 * The completed reader validates the selected control, same-capture directories, inventory
 * correspondence, and captured bytes before this function returns the same wrapper. It does not
 * evaluate an application entry. Recognized non-Workerd targets remain readable even when their
 * host profile is unavailable; `createTargetedHost` owns that separate admission decision.
 *
 * @param buildDirectory - Completed build directory containing `hesperia-build.json`.
 * @returns The validated V3 or V4 control and inventory wrapper, unchanged.
 * @throws {TypeError} If the selected record is not targeted data, selects Workerd, or
 * contains invalid controls, directories, inventories, paths, or artifact bytes. Filesystem,
 * record-parsing, and digest failures retain their original rejection. A changed publication
 * record may trigger the shared bounded retry, which makes at most three read attempts.
 */
export async function readTargetedBuildDirectory(
  buildDirectory: string,
): Promise<InProcessTargetedCapturedBuild | InProcessTargetedDeploymentCapturedBuildV4> {
  const completed = await readCompletedBuildDirectory(buildDirectory);

  if (!("control" in completed))
    throw new TypeError(
      "readTargetedBuild requires an outer version 3 targeted capture or an outer version 4 deployment capture",
    );

  if (!isInProcessTargetedCapturedBuild(completed))
    throw new TypeError("workerd captures require their separate worker package and preview owner");

  return completed;
}

function isInProcessTargetedCapturedBuild(
  completed: TargetedCapturedBuild | TargetedDeploymentCapturedBuildV4,
): completed is InProcessTargetedCapturedBuild | InProcessTargetedDeploymentCapturedBuildV4 {
  return completed.control.productionTarget.declaration.runtime !== "workerd";
}

/**
 * Read the managed projection of a supplied canonical outer-V3 or outer-V4 completed record.
 *
 * The record's directories remain relative to the build root. Target controls and same-capture
 * directories are validated, and all inner hosting versions yield a V1 managed inventory.
 * This function proves only the supplied metadata and managed bytes. It does not consult a
 * current pointer, require an archived receipt, or establish that the record was published.
 * Public and private bytes are neither read nor returned, and no application entry is evaluated.
 *
 * @param buildDirectory - Build root containing the record's managed asset directory.
 * @param recordSource - Original canonical outer-V3 or outer-V4 completed record text.
 * @returns The record's canonical capture ID and owned, digest-verified managed inventory.
 * @throws TypeError through rejection for malformed controls, crossed captures, unsafe paths,
 * links or invalid managed bytes. Record and filesystem failures retain their rejection.
 */
export async function readManagedBuildRecord(
  buildDirectory: string,
  recordSource: string,
): Promise<ManagedBuildCapture> {
  const output = await resolveBuildDirectory(buildDirectory);
  const capture = snapshotManagedBuildRecord(recordSource);

  return readManagedCapture(output, capture);
}

interface ManagedBuildCapture {
  readonly captureId: string;
  readonly inventory: CapturedBrowserBuild;
  readonly deployment?: ResolvedDeployment;
}

/**
 * Read only the managed bytes of one retained, target-bound production capture.
 *
 * The archive is the original canonical outer-V3 or outer-V4 completed record at
 * `.captures/<captureId>/hesperia-build.json`; its directories remain relative to the build root.
 * All inner hosting versions are projected to a legacy V1 managed inventory. Public and private
 * files are neither read nor returned, and no application entry is evaluated. This function does
 * not consult the current completed record or provide an HTTP document fallback.
 *
 * @param buildDirectory - Build root containing the retained capture directory.
 * @param captureId - Canonical lowercase UUID naming that exact retained capture.
 * @returns The captured mount, managed metadata and owned, digest-verified asset bytes.
 * @throws TypeError through rejection for malformed records, crossed captures, unsafe paths,
 * links or invalid managed bytes. Record and filesystem failures retain their rejection.
 */
export async function readRetainedManagedBuild(
  buildDirectory: string,
  captureId: string,
): Promise<CapturedBrowserBuild> {
  return (await readRetainedManagedCapture(buildDirectory, captureId)).inventory;
}

/**
 * Read verified managed bytes and any explicit deployment from their archived publication.
 * @param buildDirectory - Build root containing the retained capture.
 * @param captureId - Canonical capture ID that must match the archived record.
 * @returns Managed bytes paired with the original resolved deployment when available.
 * @throws TypeError through rejection for mismatched IDs, malformed records or invalid artifacts.
 * @internal
 */
export async function readRetainedManagedCapture(
  buildDirectory: string,
  captureId: string,
): Promise<ManagedBuildCapture> {
  if (typeof captureId !== "string" || !captureIdPattern.test(captureId))
    throw new TypeError("The retained capture ID must be a canonical UUID");

  const output = await resolveBuildDirectory(buildDirectory);
  const retainedRoot = await resolveRealDirectory(
    output,
    `.captures/${captureId}`,
    "retained capture directory",
  );
  const recordSource = await readBuildRecord(join(retainedRoot, "hesperia-build.json"));
  const retained = snapshotManagedBuildRecord(recordSource);

  if (retained.captureId !== captureId)
    throw new TypeError("The retained build record must name its own capture");

  return readManagedCapture(output, retained);
}

function snapshotManagedBuildRecord(recordSource: string) {
  const record: unknown = JSON.parse(recordSource);

  if (!isRecord(record) || (record.version !== 3 && record.version !== 4))
    throw new TypeError("A managed build record must use outer version 3 or 4");

  const capture =
    record.version === 4
      ? snapshotTargetedDeploymentCaptureRecord(recordSource, record)
      : snapshotTargetedCaptureRecord(recordSource, record);

  if (!captureIdPattern.test(capture.captureId))
    throw new TypeError("The managed build capture ID must be a canonical UUID");

  return capture;
}

async function readManagedCapture(
  output: string,
  capture: TargetedCaptureLocations | TargetedDeploymentCaptureLocations,
): Promise<ManagedBuildCapture> {
  const capturedHosting = capture.control.hosting;
  const hosting: HostingRecordV1 = {
    version: 1,
    mode: capturedHosting.mode,
    standaloneMountURL: capturedHosting.standaloneMountURL,
    startupAsset: capturedHosting.startupAsset,
    assets: capturedHosting.assets,
  };
  const assetsRoot = await resolveRealDirectory(output, capture.assetDirectory, "asset directory");
  const files = await readManagedCaptureFiles(assetsRoot, hosting.assets);
  const snapshot = captureInput({ hosting, files });

  resolveMountPath(snapshot);

  const assets = await validateAssets(snapshot);

  if (!assets.has(hosting.startupAsset))
    throw new TypeError("startupAsset is missing from the captured asset inventory");

  return {
    captureId: capture.captureId,
    inventory: {
      hosting,
      files: new Map([...assets].map(([path, asset]) => [path, asset.blob])),
    },
    ...("deployment" in capture ? { deployment: capture.deployment } : {}),
  };
}

async function readBuildDirectoryWithRetry<T>(
  buildDirectory: string,
  readCaptureForRecord: (output: string, recordSource: string) => Promise<T>,
): Promise<T> {
  const output = await resolveBuildDirectory(buildDirectory);
  const recordPath = join(output, "hesperia-build.json");
  let recordSource = await readBuildRecord(recordPath);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readCaptureForRecord(output, recordSource);
    } catch (error) {
      if (attempt === 2) throw error;

      let current: string;

      try {
        current = await readBuildRecord(recordPath);
      } catch {
        throw error;
      }

      if (current === recordSource) throw error;

      recordSource = current;
    }
  }

  throw new Error("Build loading exhausted its publication attempts");
}

async function resolveBuildDirectory(buildDirectory: string): Promise<string> {
  const output = resolve(buildDirectory);

  for (const directory of [dirname(output), output]) {
    const stats = await lstatBuildPath(directory);

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new TypeError("The completed build directory must be a real directory");
  }

  return output;
}

async function readBuildRecord(recordPath: string): Promise<string> {
  const recordStat = await lstatBuildPath(recordPath);

  if (!recordStat.isFile() || recordStat.isSymbolicLink())
    throw new TypeError("The completed build record must be a regular file");

  return readFile(recordPath, "utf8");
}

async function readCapture(output: string, recordSource: string): Promise<CapturedBuild> {
  return readLegacyCapture(output, recordSource, "production");
}

async function readLegacyCapture(
  output: string,
  recordSource: string,
  expectedMode: "development" | "production",
): Promise<CapturedBuild> {
  const record = JSON.parse(recordSource) as Record<string, unknown>;

  if (!isRecord(record) || !isRecord(record.hosting))
    throw new TypeError("The completed build record has no hosting metadata");

  if (
    (record.version !== undefined && record.version !== 1) ||
    Object.hasOwn(record, "productionTarget") ||
    Object.hasOwn(record, "kind")
  )
    throw new TypeError(
      "A legacy browser build record must be unversioned or use outer version 1 without targeted fields",
    );

  const hosting = record.hosting as unknown as HostingRecordV1 | HostingRecordV2;
  const version = hosting.version;

  if (version !== 1 && version !== 2) throw new TypeError("unsupported hosting record version");

  if (hosting.mode !== expectedMode)
    throw new TypeError(
      expectedMode === "production"
        ? `Cannot serve a ${hosting.mode} build as production`
        : `Cannot read a ${hosting.mode} build as development`,
    );

  if (!Array.isArray(hosting.assets))
    throw new TypeError("The completed build record has no asset inventory");

  const assetDirectory =
    version === 2 ? record.assetDirectory : (record.assetDirectory ?? "assets");

  if (
    typeof assetDirectory !== "string" ||
    (version === 1 && !/^(?:assets|\.captures\/[0-9a-f-]{36}\/assets)$/u.test(assetDirectory))
  )
    throw new TypeError("The completed build asset directory is invalid");

  let publicDirectory: string | undefined;

  if (version === 2) {
    publicDirectory = record.publicDirectory as string | undefined;
    const captureId = /^\.captures\/([0-9a-f-]{36})\/assets$/u.exec(assetDirectory)?.[1];

    if (
      !captureId ||
      typeof publicDirectory !== "string" ||
      publicDirectory !== `.captures/${captureId}/public`
    )
      throw new TypeError("The completed build public directory must share the asset capture");
  } else if ("publicDirectory" in record) {
    throw new TypeError("A version 1 build cannot include a public directory");
  }

  let assetsRoot = output;

  for (const segment of assetDirectory.split("/")) {
    assetsRoot = join(assetsRoot, segment);
    const stats = await lstatBuildPath(assetsRoot);

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new TypeError("The completed build asset path must be a real directory");
  }

  const files = new Map<string, Blob>();

  for (const item of hosting.assets) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.contentType !== "string")
      throw new TypeError("The completed build contains an invalid asset record");

    assertCanonicalAssetPath(item.path, "asset path");

    const segments = item.path.slice("/assets/".length).split("/");
    let current = assetsRoot;

    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      let stats: Awaited<ReturnType<typeof lstat>>;

      try {
        stats = await lstat(current);
      } catch (error) {
        if (isMissingFile(error))
          throw new TypeError(`The completed build asset is missing: ${item.path}`);

        throw error;
      }

      if (stats.isSymbolicLink())
        throw new TypeError(`The completed build contains a symlinked asset path: ${item.path}`);

      if (index === segments.length - 1 ? !stats.isFile() : !stats.isDirectory())
        throw new TypeError(`The completed build asset is missing: ${item.path}`);
    }

    files.set(item.path, new Blob([await readFile(current)], { type: item.contentType }));
  }

  if (hosting.version === 1) {
    const build: CapturedBrowserBuild = { hosting, files };
    const snapshot = captureInput(build);

    resolveMountPath(snapshot);

    const assets = await validateAssets(snapshot);

    if (!assets.has(hosting.startupAsset))
      throw new TypeError("startupAsset is missing from the captured asset inventory");

    return { hosting, files: new Map([...assets].map(([path, item]) => [path, item.blob])) };
  }

  const publicRecords = snapshotPublicFileMetadata((hosting as HostingRecordV2).publicFiles);
  const publicRoot = await resolveRealDirectory(output, publicDirectory!, "public file directory");
  const publicFiles = new Map<string, Blob>();

  for (const item of publicRecords) {
    const segments = item.relativePath.split("/");
    let current = publicRoot;

    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      let stats: Awaited<ReturnType<typeof lstat>>;

      try {
        stats = await lstat(current);
      } catch (error) {
        if (isMissingFile(error))
          throw new TypeError(`The completed build public file is missing: ${item.urlPath}`);

        throw error;
      }

      if (stats.isSymbolicLink())
        throw new TypeError(
          `The completed build contains a symlinked public file path: ${item.urlPath}`,
        );

      if (index === segments.length - 1 ? !stats.isFile() : !stats.isDirectory())
        throw new TypeError(`The completed build public file is missing: ${item.urlPath}`);
    }

    publicFiles.set(
      item.urlPath,
      new Blob([await readFile(current)], { type: item.contentType as string }),
    );
  }

  const build: CapturedPublicBuild = { hosting, files, publicFiles };
  const snapshot = captureInput(build);

  resolveMountPath(snapshot);

  const assets = await validateAssets(snapshot);
  const verifiedPublicFiles = await validatePublicFiles(snapshot);

  if (!assets.has(hosting.startupAsset))
    throw new TypeError("startupAsset is missing from the captured asset inventory");

  return {
    hosting,
    files: new Map([...assets].map(([path, item]) => [path, item.blob])),
    publicFiles: new Map([...verifiedPublicFiles].map(([path, item]) => [path, item.blob])),
  };
}

async function readServerCapture(
  output: string,
  recordSource: string,
): Promise<CapturedServerBuild> {
  const record = JSON.parse(recordSource) as Record<string, unknown>;

  if (!isRecord(record) || !isRecord(record.hosting))
    throw new TypeError("The completed server build record has no hosting metadata");

  if (record.version !== 2) throw new TypeError("A server build record must use outer version 2");

  const recordKeys = ["version", "hosting", "assetDirectory", "publicDirectory", "serverDirectory"];

  if (
    Reflect.ownKeys(record).length !== recordKeys.length ||
    recordKeys.some((key) => !Object.hasOwn(record, key))
  )
    throw new TypeError("The completed server build record has unknown or missing fields");

  const hosting = record.hosting as unknown as HostingRecordV3;

  if (hosting.version !== 3)
    throw new TypeError("A server build record must use hosting version 3");

  if (hosting.mode !== "production")
    throw new TypeError(`Cannot serve a ${hosting.mode} build as production`);

  if (!Array.isArray(hosting.assets))
    throw new TypeError("The completed server build record has no asset inventory");

  const assetDirectory = record.assetDirectory;
  const publicDirectory = record.publicDirectory;
  const serverDirectory = record.serverDirectory;

  if (
    typeof assetDirectory !== "string" ||
    typeof publicDirectory !== "string" ||
    typeof serverDirectory !== "string"
  )
    throw new TypeError("The completed server build directories must be strings");

  const captureId = /^\.captures\/([0-9a-f-]{36})\/assets$/u.exec(assetDirectory)?.[1];

  if (
    !captureId ||
    publicDirectory !== `.captures/${captureId}/public` ||
    serverDirectory !== `.captures/${captureId}/server`
  )
    throw new TypeError("The completed server build directories must share one capture");

  const assetsRoot = await resolveRealDirectory(output, assetDirectory, "asset directory");
  const publicRoot = await resolveRealDirectory(output, publicDirectory, "public file directory");
  const serverRoot = await resolveRealDirectory(
    output,
    serverDirectory,
    "server artifact directory",
  );
  const files = new Map<string, Blob>();

  for (const item of hosting.assets) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.contentType !== "string")
      throw new TypeError("The completed server build contains an invalid asset record");

    assertCanonicalAssetPath(item.path, "asset path");

    const relativePath = item.path.slice("/assets/".length);
    const bytes = await readCaptureFile(
      assetsRoot,
      relativePath,
      `The completed build asset is missing: ${item.path}`,
      `The completed build contains a symlinked asset path: ${item.path}`,
    );

    files.set(item.path, new Blob([bytes], { type: item.contentType }));
  }

  const publicRecords = snapshotPublicFileMetadata(hosting.publicFiles);
  const publicFiles = new Map<string, Blob>();

  for (const item of publicRecords) {
    const bytes = await readCaptureFile(
      publicRoot,
      item.relativePath,
      `The completed build public file is missing: ${item.urlPath}`,
      `The completed build contains a symlinked public file path: ${item.urlPath}`,
    );

    publicFiles.set(item.urlPath, new Blob([bytes], { type: item.contentType as string }));
  }

  if (!Array.isArray(hosting.serverArtifacts))
    throw new TypeError("The completed server build has no private artifact inventory");

  const serverFiles = new Map<string, Blob>();

  for (const artifact of hosting.serverArtifacts) {
    if (!isRecord(artifact) || typeof artifact.path !== "string")
      throw new TypeError("The completed server build contains an invalid artifact record");

    assertSafeServerArtifactPath(artifact.path, "server artifact path");

    const bytes = await readCaptureFile(
      serverRoot,
      artifact.path,
      `The completed server artifact is missing: ${artifact.path}`,
      `The completed server build contains a symlinked artifact path: ${artifact.path}`,
    );

    serverFiles.set(artifact.path, new Blob([bytes]));
  }

  const build: CapturedServerBuild = { hosting, files, publicFiles, serverFiles };
  const snapshot = captureServerInput(build);

  resolveMountPath(snapshot.browserInput);

  const assets = await validateAssets(snapshot.browserInput);
  const verifiedPublicFiles = await validatePublicFiles(snapshot.browserInput);
  const verifiedServerFiles = await validateServerFiles(snapshot);

  if (!assets.has(hosting.startupAsset))
    throw new TypeError("startupAsset is missing from the captured asset inventory");

  return {
    hosting,
    files: new Map([...assets].map(([path, item]) => [path, item.blob])),
    publicFiles: new Map([...verifiedPublicFiles].map(([path, item]) => [path, item.blob])),
    serverFiles: verifiedServerFiles,
  };
}

interface TargetedCaptureLocations {
  readonly control: TargetedControlRecordV3;
  readonly captureId: string;
  readonly assetDirectory: string;
}

interface TargetedDeploymentCaptureLocations extends TargetedCaptureLocations {
  readonly deployment: ResolvedDeployment;
}

async function readTargetedCapture(
  output: string,
  recordSource: string,
  record: Record<string, unknown>,
): Promise<TargetedCapturedBuild> {
  const capture = snapshotTargetedCaptureRecord(recordSource, record);
  const inventory = await readTargetedCaptureInventory(output, capture);

  return validateTargetedCapturedBuild({ control: capture.control, inventory });
}

async function readTargetedDeploymentCapture(
  output: string,
  recordSource: string,
  record: Record<string, unknown>,
): Promise<TargetedDeploymentCapturedBuildV4> {
  const capture = snapshotTargetedDeploymentCaptureRecord(recordSource, record);
  const inventory = await readTargetedCaptureInventory(output, capture);

  return validateTargetedDeploymentCapturedBuild({
    version: 4,
    control: capture.control,
    inventory,
    deployment: capture.deployment,
  });
}

async function readTargetedCaptureInventory(
  output: string,
  capture: TargetedCaptureLocations,
): Promise<Record<string, unknown>> {
  const { control, captureId, assetDirectory } = capture;
  const hosting = control.hosting;
  const assetsRoot = await resolveRealDirectory(output, assetDirectory, "asset directory");
  const files = await readManagedCaptureFiles(assetsRoot, hosting.assets);
  const inventory: Record<string, unknown> = { hosting, files };

  if (hosting.version !== 1) {
    const publicRoot = await resolveRealDirectory(
      output,
      `.captures/${captureId}/public`,
      "public file directory",
    );
    const publicFiles = new Map<string, Blob>();

    for (const file of hosting.publicFiles) {
      const bytes = await readCaptureFile(
        publicRoot,
        file.relativePath,
        `The completed build public file is missing: ${file.urlPath}`,
        `The completed build contains a symlinked public file path: ${file.urlPath}`,
      );

      publicFiles.set(file.urlPath, new Blob([bytes], { type: file.contentType }));
    }

    inventory.publicFiles = publicFiles;
  }

  if (hosting.version === 3) {
    const serverRoot = await resolveRealDirectory(
      output,
      `.captures/${captureId}/server`,
      "server artifact directory",
    );
    const serverFiles = new Map<string, Blob>();

    for (const artifact of hosting.serverArtifacts) {
      const bytes = await readCaptureFile(
        serverRoot,
        artifact.path,
        `The completed server artifact is missing: ${artifact.path}`,
        `The completed server build contains a symlinked artifact path: ${artifact.path}`,
      );

      serverFiles.set(artifact.path, new Blob([bytes]));
    }

    inventory.serverFiles = serverFiles;
  }

  return inventory;
}

function snapshotTargetedCaptureRecord(recordSource: string, record: Record<string, unknown>) {
  const { assetDirectory, publicDirectory, serverDirectory, ...fields } = record;
  const rawHosting = record.hosting;

  if (!isRecord(rawHosting))
    throw new TypeError("The targeted build record has no hosting metadata");

  const version = rawHosting.version;

  if (version !== 1 && version !== 2 && version !== 3)
    throw new TypeError("unsupported targeted hosting record version");

  const directoryKeys = ["assetDirectory"];

  if (version !== 1) directoryKeys.push("publicDirectory");

  if (version === 3) directoryKeys.push("serverDirectory");

  const actualDirectoryKeys = ["assetDirectory", "publicDirectory", "serverDirectory"].filter(
    (key) => Object.hasOwn(record, key),
  );

  if (
    actualDirectoryKeys.length !== directoryKeys.length ||
    directoryKeys.some((key) => !Object.hasOwn(record, key))
  )
    throw new TypeError("The targeted build record has unknown or missing directory fields");

  if (typeof assetDirectory !== "string")
    throw new TypeError("The targeted build asset directory must be a string");

  const captureId = /^\.captures\/([0-9a-f-]{36})\/assets$/u.exec(assetDirectory)?.[1];

  if (
    !captureId ||
    (version !== 1 && publicDirectory !== `.captures/${captureId}/public`) ||
    (version === 3 && serverDirectory !== `.captures/${captureId}/server`)
  )
    throw new TypeError("The targeted build directories must share one capture");

  const control = snapshotTargetedControl(fields);
  const hosting = control.hosting;
  const normalized = {
    ...control,
    assetDirectory,
    ...(hosting.version !== 1 ? { publicDirectory } : {}),
    ...(hosting.version === 3 ? { serverDirectory } : {}),
  };

  if (JSON.stringify(normalized, null, 2) + "\n" !== recordSource)
    throw new TypeError("The targeted build record must use its canonical JSON encoding");

  return { control, captureId, assetDirectory };
}

function snapshotTargetedDeploymentCaptureRecord(
  recordSource: string,
  record: Record<string, unknown>,
): TargetedDeploymentCaptureLocations {
  if (record.version !== 4)
    throw new TypeError("A targeted deployment build record must use outer version 4");

  const control = snapshotTargetedControl(record.control);
  const deployment = snapshotDeployment(record.deployment);
  const hosting = control.hosting;
  const expectedKeys = ["version", "control", "deployment", "assetDirectory"];

  if (hosting.version !== 1) expectedKeys.push("publicDirectory");

  if (hosting.version === 3) expectedKeys.push("serverDirectory");

  const actualKeys = Reflect.ownKeys(record);

  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  )
    throw new TypeError("The targeted deployment build record has unknown or missing fields");

  const assetDirectory = record.assetDirectory;
  const publicDirectory = record.publicDirectory;
  const serverDirectory = record.serverDirectory;

  if (typeof assetDirectory !== "string")
    throw new TypeError("The targeted deployment asset directory must be a string");

  const captureId = /^\.captures\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/assets$/u.exec(
    assetDirectory,
  )?.[1];

  if (
    !captureId ||
    (hosting.version !== 1 && publicDirectory !== `.captures/${captureId}/public`) ||
    (hosting.version === 3 && serverDirectory !== `.captures/${captureId}/server`)
  )
    throw new TypeError("The targeted deployment directories must share one capture");

  const normalized = {
    version: 4 as const,
    control,
    deployment,
    assetDirectory,
    ...(hosting.version !== 1 ? { publicDirectory } : {}),
    ...(hosting.version === 3 ? { serverDirectory } : {}),
  };

  if (JSON.stringify(normalized, null, 2) + "\n" !== recordSource)
    throw new TypeError(
      "The targeted deployment build record must use its canonical JSON encoding",
    );

  return { control, deployment, captureId, assetDirectory };
}

async function readManagedCaptureFiles(
  assetsRoot: string,
  assets: HostingRecordV1["assets"],
): Promise<Map<string, Blob>> {
  const files = new Map<string, Blob>();

  for (const asset of assets) {
    const bytes = await readCaptureFile(
      assetsRoot,
      asset.path.slice("/assets/".length),
      `The completed build asset is missing: ${asset.path}`,
      `The completed build contains a symlinked asset path: ${asset.path}`,
    );

    files.set(asset.path, new Blob([bytes], { type: asset.contentType }));
  }

  return files;
}

async function readCaptureFile(
  root: string,
  relativePath: string,
  missingMessage: string,
  symlinkMessage: string,
): Promise<Uint8Array<ArrayBuffer>> {
  let current = root;
  const segments = relativePath.split("/");

  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats: Awaited<ReturnType<typeof lstat>>;

    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingFile(error)) throw new TypeError(missingMessage);

      throw error;
    }

    if (stats.isSymbolicLink()) throw new TypeError(symlinkMessage);

    if (index === segments.length - 1 ? !stats.isFile() : !stats.isDirectory())
      throw new TypeError(missingMessage);
  }

  return new Uint8Array(await readFile(current));
}

async function resolveRealDirectory(
  output: string,
  directory: string,
  label: string,
): Promise<string> {
  let current = output;

  for (const segment of directory.split("/")) {
    current = join(current, segment);
    let stats: Awaited<ReturnType<typeof lstat>>;

    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingFile(error)) throw new TypeError(`The completed build ${label} is missing`);

      throw error;
    }

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new TypeError(`The completed build ${label} must be a real directory`);
  }

  return current;
}

async function lstatBuildPath(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error))
      throw new Error("No completed browser build; run hesperia build first");

    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
