import {
  assertCanonicalPublicFilePath,
  canonicalizeMountURL,
  canonicalizePublicFilePath,
} from "./internal/mount.ts";
import type {
  CapturedBuild,
  CapturedServerBuild,
  HostSelection,
  HostingRecordV1,
  HostingRecordV2,
  HostingRecordV3,
  HostingServerArtifactRecord,
  HostingServerPagePlan,
} from "./index.ts";
import type { TargetedCapturedBuild, TargetedControlRecordV3 } from "./build-control.ts";
import { snapshotCapturedProductionTarget } from "./target.ts";

interface HostingAssetSnapshot {
  readonly path: unknown;
  readonly sha256: unknown;
  readonly contentType: unknown;
  readonly blob: Blob;
}

interface HostingPublicFileMetadataSnapshot {
  readonly relativePath: string;
  readonly urlPath: string;
  readonly sha256: unknown;
  readonly contentType: unknown;
}

interface HostingPublicFileSnapshot extends HostingPublicFileMetadataSnapshot {
  readonly blob: Blob;
}

interface CapturedSnapshot {
  readonly version: unknown;
  readonly mode: unknown;
  readonly standaloneMountURL: unknown;
  readonly startupAsset: unknown;
  readonly assets: readonly HostingAssetSnapshot[];
  readonly publicFiles: readonly HostingPublicFileSnapshot[];
  readonly selectedMountURL: unknown;
}

type HostingServerArtifactSnapshot = HostingServerArtifactRecord;

/** One synchronous V3 admission snapshot used by the managed, public, and private validators. */
export interface CapturedServerSnapshot {
  /** Strict V2 projection with the original captured managed/public maps and selection. */
  readonly browserInput: CapturedSnapshot;
  /** Deep copies of the admitted per-route SSR plans. */
  readonly serverPages: readonly HostingServerPagePlan[];
  /** Deep copies of the exact private artifact inventory. */
  readonly serverArtifacts: readonly HostingServerArtifactSnapshot[];
  /** Copy of the private artifact map keyed by its raw slash-relative storage path. */
  readonly serverFiles: ReadonlyMap<unknown, unknown>;
}

interface VerifiedAsset {
  readonly blob: Blob;
  readonly contentType: string;
}

const sha256Pattern = /^[0-9a-f]{64}$/u;

/**
 * Copy an in-memory outer-V3 control using only own data properties.
 *
 * Nested provenance and hosting records are copied and frozen before returning.
 * This validates an artifact contract, not provider availability or source provenance.
 * Proxy reflection traps retain their native synchronous behavior.
 *
 * @param value - Control without persisted capture-directory fields.
 * @returns A fresh control with its correlated target and production hosting record.
 * @throws TypeError for accessors, non-JSON data, unknown fields or crossed variants.
 */
export function snapshotTargetedControl(value: unknown): TargetedControlRecordV3 {
  const control = jsonRecord(snapshotJsonData(value, "control"), "control");

  if (control.version !== 3 || (control.kind !== "browser" && control.kind !== "server"))
    throw new TypeError("unsupported targeted control version or kind");

  const productionTarget = snapshotCapturedProductionTarget(control.productionTarget);
  const hosting = snapshotTargetedHosting(control.hosting);

  if (control.kind === "server") {
    assertExactKeys(control, ["version", "kind", "productionTarget", "hosting"], "server control");

    if (hosting.version !== 3 || productionTarget.declaration.runtime === "browser")
      throw new TypeError("server control requires server hosting and a server-capable target");
  } else {
    assertExactKeys(
      control,
      [
        "version",
        "kind",
        "productionTarget",
        "hosting",
        "target",
        "resolution",
        "checkingInputs",
        "configuration",
        "modules",
        "routeGuards",
        "routeTable",
      ],
      "browser control",
    );

    if (hosting.version === 3) throw new TypeError("browser control cannot contain server hosting");

    validateBrowserProvenance(control);
  }

  return Object.freeze({ ...control, productionTarget, hosting }) as TargetedControlRecordV3;
}

/**
 * Encode the normalized in-memory control as two-space JSON followed by one newline.
 *
 * @param value - A control accepted by snapshotTargetedControl.
 * @returns The exact normalized control text, retaining provenance ordering and omission.
 * @throws TypeError synchronously when control validation fails.
 */
export function encodeTargetedControlRecord(value: unknown): string {
  return JSON.stringify(snapshotTargetedControl(value), null, 2) + "\n";
}

/**
 * Decode canonical in-memory control text without evaluating application code.
 *
 * @param source - Exact text produced by encodeTargetedControlRecord.
 * @returns A fresh validated, frozen control.
 * @throws SyntaxError for invalid JSON; TypeError for invalid or noncanonical controls,
 * including duplicate JSON keys and omitted final newlines.
 */
export function decodeTargetedControlRecord(source: string): TargetedControlRecordV3 {
  if (typeof source !== "string") throw new TypeError("control source must be a string");

  const control = snapshotTargetedControl(JSON.parse(source));

  if (JSON.stringify(control, null, 2) + "\n" !== source)
    throw new TypeError("targeted control must use its canonical JSON encoding");

  return control;
}

/**
 * Verify a source-free targeted wrapper and return its owned artifact snapshot.
 *
 * The exact wrapper, both hosting records and every map entry are captured before
 * the first byte read. All byte verification uses the existing inventory validators.
 * Returned maps expose no mutation methods and contain only verified Blob copies.
 * No entry is imported and no deployment profile becomes available.
 *
 * @param value - Exactly control and its matching strict captured inventory.
 * @returns A frozen wrapper whose control and inventory share one hosting record.
 * @throws TypeError through rejection for malformed, crossed or corrupt artifacts.
 * Blob and digest failures retain their original asynchronous rejection.
 */
export async function validateTargetedCapturedBuild(
  value: unknown,
): Promise<TargetedCapturedBuild> {
  const wrapper = ownDataFields(value, "targeted captured build");

  assertExactKeys(wrapper, ["control", "inventory"], "targeted captured build");

  const control = snapshotTargetedControl(wrapper.control);
  const inventory = ownDataFields(wrapper.inventory, "targeted inventory");
  const inventoryHosting = snapshotTargetedHosting(
    snapshotJsonData(inventory.hosting, "inventory.hosting"),
  );

  if (JSON.stringify(control.hosting) !== JSON.stringify(inventoryHosting))
    throw new TypeError("targeted control and inventory hosting records do not match");

  const hosting = control.hosting;
  const inventoryKeys = ["hosting", "files"];

  if (hosting.version !== 1) inventoryKeys.push("publicFiles");

  if (hosting.version === 3) inventoryKeys.push("serverFiles");

  assertExactKeys(inventory, inventoryKeys, "targeted inventory");

  const files = snapshotBlobMap(inventory.files, "files");
  let serverSnapshot: CapturedServerSnapshot | undefined;
  let browserSnapshot: CapturedSnapshot;

  if (hosting.version === 1) {
    browserSnapshot = captureInput({ hosting, files });
  } else {
    const publicFiles = snapshotBlobMap(inventory.publicFiles, "publicFiles");

    if (hosting.version === 2) {
      browserSnapshot = captureInput({ hosting, files, publicFiles });
    } else {
      const serverFiles = snapshotBlobMap(inventory.serverFiles, "serverFiles");
      serverSnapshot = captureServerInput({ hosting, files, publicFiles, serverFiles });
      browserSnapshot = serverSnapshot.browserInput;
    }
  }

  resolveMountPath(browserSnapshot);

  const assets = await validateAssets(browserSnapshot);
  const verifiedFiles = immutableBlobMap(
    new Map([...assets].map(([path, asset]) => [path, asset.blob] as const)),
  );

  if (control.kind === "server" && serverSnapshot) {
    const verifiedPublic = await validatePublicFiles(browserSnapshot);
    const verifiedServer = await validateServerFiles(serverSnapshot);

    return Object.freeze({
      control,
      inventory: Object.freeze({
        hosting: control.hosting,
        files: verifiedFiles,
        publicFiles: immutableBlobMap(
          new Map([...verifiedPublic].map(([path, file]) => [path, file.blob] as const)),
        ),
        serverFiles: immutableBlobMap(new Map(verifiedServer)),
      }),
    });
  }

  if (control.kind === "browser" && control.hosting.version === 1) {
    return Object.freeze({
      control: Object.freeze({ ...control, hosting: control.hosting }),
      inventory: Object.freeze({ hosting: control.hosting, files: verifiedFiles }),
    });
  }

  if (control.kind === "browser" && control.hosting.version === 2) {
    const verifiedPublic = await validatePublicFiles(browserSnapshot);

    return Object.freeze({
      control: Object.freeze({ ...control, hosting: control.hosting }),
      inventory: Object.freeze({
        hosting: control.hosting,
        files: verifiedFiles,
        publicFiles: immutableBlobMap(
          new Map([...verifiedPublic].map(([path, file]) => [path, file.blob] as const)),
        ),
      }),
    });
  }

  throw new TypeError("targeted control and inventory variants do not match");
}

export function captureInput(build: CapturedBuild, selection?: HostSelection): CapturedSnapshot {
  if (!isRecord(build)) throw new TypeError("build must be a captured browser build");

  const hosting = build.hosting;

  if (!isRecord(hosting)) throw new TypeError("hosting must be a record");

  const version = hosting.version;
  const mode = hosting.mode;
  const standaloneMountURL = hosting.standaloneMountURL;
  const startupAsset = hosting.startupAsset;

  if (version !== 1 && version !== 2) throw new TypeError("unsupported hosting record version");

  const hostingKeys = ["version", "mode", "standaloneMountURL", "startupAsset", "assets"];

  if (version === 2) hostingKeys.push("publicFiles");

  assertExactKeys(hosting, hostingKeys, "hosting record");
  assertExactKeys(
    build,
    version === 1 ? ["hosting", "files"] : ["hosting", "files", "publicFiles"],
    "captured browser build",
  );

  if (!Array.isArray(hosting.assets)) throw new TypeError("hosting.assets must be an array");

  const assets = hosting.assets.map((asset, index): HostingAssetSnapshot => {
    if (!isRecord(asset)) throw new TypeError(`hosting.assets[${index}] must be a record`);

    assertExactKeys(asset, ["path", "sha256", "contentType"], `hosting.assets[${index}]`);

    return {
      path: asset.path,
      sha256: asset.sha256,
      contentType: asset.contentType,
      blob: undefined as unknown as Blob,
    };
  });

  const publicMetadata = version === 2 ? snapshotPublicFileMetadata(hosting.publicFiles) : [];
  const publicFiles = publicMetadata.map((file): HostingPublicFileSnapshot => ({
    ...file,
    blob: undefined as unknown as Blob,
  }));

  const sourceFiles = build.files;

  if (
    typeof sourceFiles !== "object" ||
    sourceFiles === null ||
    typeof sourceFiles[Symbol.iterator] !== "function"
  )
    throw new TypeError("files must be a ReadonlyMap");

  const fileEntries = Array.from(sourceFiles);
  const files = new Map(fileEntries);
  if (assets.some((asset) => typeof asset.path !== "string"))
    throw new TypeError("asset path must be a string");

  const inventoryPaths = new Set(assets.map((asset) => asset.path as string));

  if (
    inventoryPaths.size !== assets.length ||
    files.size !== assets.length ||
    assets.some((asset) => !files.has(asset.path as string)) ||
    [...files.keys()].some((path) => !inventoryPaths.has(path))
  )
    throw new TypeError("asset inventory and file map do not match");

  let publicFileEntries: [unknown, unknown][] = [];
  let publicFileMap = new Map<unknown, unknown>();

  if (version === 2) {
    const sourcePublicFiles = "publicFiles" in build ? build.publicFiles : undefined;

    if (
      typeof sourcePublicFiles !== "object" ||
      sourcePublicFiles === null ||
      !(Symbol.iterator in sourcePublicFiles) ||
      typeof sourcePublicFiles[Symbol.iterator] !== "function"
    )
      throw new TypeError("publicFiles must be a ReadonlyMap");

    publicFileEntries = Array.from(sourcePublicFiles as ReadonlyMap<unknown, unknown>);
    publicFileMap = new Map(publicFileEntries);

    const inventoryURLs = new Set(publicFiles.map((file) => file.urlPath));

    if (
      inventoryURLs.size !== publicFiles.length ||
      publicFileEntries.length !== publicFiles.length ||
      publicFileMap.size !== publicFiles.length ||
      publicFiles.some((file) => !publicFileMap.has(file.urlPath)) ||
      [...publicFileMap.keys()].some(
        (urlPath) => typeof urlPath !== "string" || !inventoryURLs.has(urlPath),
      )
    )
      throw new TypeError("public file inventory and file map do not match");
  }

  let selectedMountURL: unknown;

  if (selection !== undefined) {
    if (!isRecord(selection)) throw new TypeError("selection must be a record");

    const selectionKeys = Reflect.ownKeys(selection);

    if (selectionKeys.some((key) => key !== "mountURL"))
      throw new TypeError("host selection has unexpected fields");

    if (selectionKeys.includes("mountURL")) selectedMountURL = selection.mountURL;
  }

  return {
    version,
    mode,
    standaloneMountURL,
    startupAsset,
    assets: assets.map((asset) => ({ ...asset, blob: files.get(asset.path as string) as Blob })),
    publicFiles: publicFiles.map((file) => ({
      ...file,
      blob: publicFileMap.get(file.urlPath) as Blob,
    })),
    selectedMountURL,
  };
}

/**
 * Snapshot one strictly admitted server build before any asynchronous byte verification.
 * The browser projection is an explicit V2 record so existing managed and public validators
 * retain their exact admission rules.
 *
 * @throws {TypeError} If the V3 record, route plans, artifact paths, or three captured maps do
 * not have the exact required shape and membership.
 */
export function captureServerInput(
  build: CapturedServerBuild,
  selection?: HostSelection,
): CapturedServerSnapshot {
  if (!isRecord(build)) throw new TypeError("build must be a captured server build");

  assertExactKeys(
    build,
    ["hosting", "files", "publicFiles", "serverFiles"],
    "captured server build",
  );

  const hosting = build.hosting;

  if (!isRecord(hosting)) throw new TypeError("hosting must be a record");

  if (hosting.version !== 3) throw new TypeError("unsupported hosting record version");

  assertExactKeys(
    hosting,
    [
      "version",
      "mode",
      "standaloneMountURL",
      "startupAsset",
      "assets",
      "publicFiles",
      "serverPages",
      "serverArtifacts",
    ],
    "hosting record",
  );

  const serverPages = snapshotServerPages(hosting.serverPages);
  const serverArtifacts = snapshotServerArtifacts(hosting.serverArtifacts);
  const serverFileSource = build.serverFiles;

  if (
    typeof serverFileSource !== "object" ||
    serverFileSource === null ||
    typeof serverFileSource[Symbol.iterator] !== "function"
  )
    throw new TypeError("serverFiles must be a ReadonlyMap");

  const serverFileEntries = Array.from(serverFileSource as ReadonlyMap<unknown, unknown>);
  const serverFiles = new Map(serverFileEntries);
  const artifactPaths = new Set(serverArtifacts.map((artifact) => artifact.path));

  if (
    artifactPaths.size !== serverArtifacts.length ||
    serverFileEntries.length !== serverFiles.size ||
    serverFiles.size !== serverArtifacts.length ||
    serverArtifacts.some((artifact) => !serverFiles.has(artifact.path)) ||
    [...serverFiles.keys()].some((path) => typeof path !== "string" || !artifactPaths.has(path))
  )
    throw new TypeError("server artifact inventory and file map do not match");

  const projectedHosting: HostingRecordV2 = {
    version: 2,
    mode: hosting.mode,
    standaloneMountURL: hosting.standaloneMountURL,
    startupAsset: hosting.startupAsset,
    assets: hosting.assets,
    publicFiles: hosting.publicFiles,
  };
  const browserInput = captureInput(
    {
      hosting: projectedHosting,
      files: build.files,
      publicFiles: build.publicFiles,
    },
    selection,
  );
  const managedPaths = new Set(browserInput.assets.map((asset) => asset.path));

  validateServerPlanReferences(serverPages, artifactPaths, managedPaths);

  return Object.freeze({
    browserInput,
    serverPages,
    serverArtifacts,
    serverFiles,
  });
}

/**
 * Verify the exact private artifact inventory and return copied, digest-checked bytes.
 *
 * @throws {TypeError} If the private map differs from the inventory, an artifact is missing, or
 * its captured bytes do not match the recorded SHA-256 digest.
 */
export async function validateServerFiles(
  snapshot: CapturedServerSnapshot,
): Promise<ReadonlyMap<string, Blob>> {
  const files = new Map(snapshot.serverFiles);

  if (
    files.size !== snapshot.serverArtifacts.length ||
    snapshot.serverArtifacts.some((artifact) => !files.has(artifact.path))
  )
    throw new TypeError("server artifact inventory and file map do not match");

  const verified = new Map<string, Blob>();

  for (const artifact of snapshot.serverArtifacts) {
    const blob = files.get(artifact.path);

    if (!(blob instanceof Blob))
      throw new TypeError(`server artifact is missing or is not a Blob: ${artifact.path}`);

    const bytes = await blob.arrayBuffer();
    const digest = await digestHex(bytes);

    if (digest !== artifact.sha256)
      throw new TypeError(`server artifact digest mismatch: ${artifact.path}`);

    verified.set(artifact.path, new Blob([bytes]));
  }

  return verified;
}

export function resolveMountPath(snapshot: CapturedSnapshot): string {
  if (snapshot.version !== 1 && snapshot.version !== 2)
    throw new TypeError("unsupported hosting record version");

  if (snapshot.mode !== "development" && snapshot.mode !== "production")
    throw new TypeError("hosting.mode must be development or production");

  if (typeof snapshot.standaloneMountURL !== "string")
    throw new TypeError("standaloneMountURL must be a string");

  const saved = canonicalizeMountURL(snapshot.standaloneMountURL);

  if (saved !== snapshot.standaloneMountURL)
    throw new TypeError("standaloneMountURL must already be canonical");

  if (snapshot.selectedMountURL === undefined) return saved;

  if (typeof snapshot.selectedMountURL !== "string")
    throw new TypeError("mountURL must be a string");

  return canonicalizeMountURL(snapshot.selectedMountURL);
}

export async function validateAssets(
  snapshot: CapturedSnapshot,
): Promise<Map<string, VerifiedAsset>> {
  if (typeof snapshot.startupAsset !== "string")
    throw new TypeError("startupAsset must be a string");

  assertCanonicalAssetPath(snapshot.startupAsset, "startupAsset");

  const assets = new Map<string, VerifiedAsset>();

  for (const row of snapshot.assets) {
    if (typeof row.path !== "string") throw new TypeError("asset path must be a string");

    assertCanonicalAssetPath(row.path, "asset path");

    if (assets.has(row.path)) throw new TypeError(`duplicate asset path: ${row.path}`);

    if (typeof row.sha256 !== "string" || !sha256Pattern.test(row.sha256))
      throw new TypeError(`asset digest must be lowercase SHA-256 hex: ${row.path}`);

    const contentType = validateContentType(row.contentType, row.path);

    if (!(row.blob instanceof Blob))
      throw new TypeError(`asset file is missing or is not a Blob: ${row.path}`);

    const bytes = await row.blob.arrayBuffer();
    const digest = await digestHex(bytes);

    if (digest !== row.sha256) throw new TypeError(`asset digest mismatch: ${row.path}`);

    assets.set(row.path, { blob: new Blob([bytes], { type: contentType }), contentType });
  }

  if (assets.size === 0) throw new TypeError("asset inventory cannot be empty");

  if (snapshot.assets.some((asset) => !(asset.blob instanceof Blob)))
    throw new TypeError("asset inventory and file map do not match");

  return assets;
}

export async function validatePublicFiles(
  snapshot: CapturedSnapshot,
): Promise<Map<string, VerifiedAsset>> {
  if (snapshot.version === 1) return new Map();

  if (snapshot.version !== 2) throw new TypeError("unsupported hosting record version");

  const files = new Map<string, VerifiedAsset>();

  for (const row of snapshot.publicFiles) {
    if (typeof row.relativePath !== "string" || typeof row.urlPath !== "string")
      throw new TypeError("public file paths must be strings");

    if (typeof row.sha256 !== "string" || !sha256Pattern.test(row.sha256))
      throw new TypeError(`public file digest must be lowercase SHA-256 hex: ${row.urlPath}`);

    const contentType = validateContentType(row.contentType, row.urlPath, "public file");

    if (!(row.blob instanceof Blob))
      throw new TypeError(`public file is missing or is not a Blob: ${row.urlPath}`);

    const bytes = await row.blob.arrayBuffer();
    const digest = await digestHex(bytes);

    if (digest !== row.sha256) throw new TypeError(`public file digest mismatch: ${row.urlPath}`);

    files.set(row.urlPath, { blob: new Blob([bytes], { type: contentType }), contentType });
  }

  if (snapshot.publicFiles.some((file) => !(file.blob instanceof Blob)))
    throw new TypeError("public file inventory and file map do not match");

  return files;
}

export function assertCanonicalAssetPath(path: string, label: string): void {
  if (!path.startsWith("/assets/")) throw new TypeError(`${label} must begin with /assets/`);

  let canonical: string;

  try {
    if (
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      containsControlCharacters(path)
    )
      throw new TypeError();

    const segments = path
      .slice(1)
      .split("/")
      .map((segment) => {
        const decoded = decodeURIComponent(segment);

        if (
          !decoded ||
          decoded === "." ||
          decoded === ".." ||
          decoded.includes("/") ||
          decoded.includes("\\") ||
          containsControlCharacters(decoded)
        )
          throw new TypeError();

        encodeURIComponent(decoded);

        return decoded.replaceAll("%", "%25");
      });
    const url = new URL("https://hesperia.invalid");
    url.pathname = `/${segments.join("/")}`;
    canonical = url.pathname;
  } catch {
    throw new TypeError(`${label} is not a safe canonical path`);
  }

  if (canonical !== path) throw new TypeError(`${label} must already be canonical`);
}

export function snapshotPublicFileMetadata(value: unknown): HostingPublicFileMetadataSnapshot[] {
  if (!Array.isArray(value)) throw new TypeError("hosting.publicFiles must be an array");

  const files = value.map((file, index): HostingPublicFileMetadataSnapshot => {
    if (!isRecord(file)) throw new TypeError(`hosting.publicFiles[${index}] must be a record`);

    assertExactKeys(
      file,
      ["relativePath", "urlPath", "sha256", "contentType"],
      `hosting.publicFiles[${index}]`,
    );

    return {
      relativePath: file.relativePath as string,
      urlPath: file.urlPath as string,
      sha256: file.sha256,
      contentType: file.contentType,
    };
  });

  if (
    files.some((file) => typeof file.relativePath !== "string" || typeof file.urlPath !== "string")
  )
    throw new TypeError("public file paths must be strings");

  validatePublicFileRecords(files);

  return files;
}

function snapshotServerPages(value: unknown): readonly HostingServerPagePlan[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError("hosting.serverPages must be a non-empty array");

  return Object.freeze(value.map((page, index) => snapshotServerPage(page, index)));
}

function snapshotServerPage(value: unknown, index: number): HostingServerPagePlan {
  if (!isRecord(value)) throw new TypeError(`hosting.serverPages[${index}] must be a record`);

  if (value.version !== 1 || value.format !== "document")
    throw new TypeError(`hosting.serverPages[${index}] has an unsupported plan`);

  if (typeof value.routeId !== "string" || value.routeId.length === 0)
    throw new TypeError(`hosting.serverPages[${index}].routeId must be a non-empty string`);

  if (typeof value.buildIdentity !== "string" || value.buildIdentity.length === 0)
    throw new TypeError(`hosting.serverPages[${index}].buildIdentity must be a non-empty string`);

  if (!isRecord(value.serverEntry))
    throw new TypeError(`hosting.serverPages[${index}].serverEntry must be a record`);

  assertExactKeys(
    value.serverEntry,
    ["path", "exportName"],
    `hosting.serverPages[${index}].serverEntry`,
  );

  const entryPath = value.serverEntry.path;
  const exportName = value.serverEntry.exportName;

  assertSafeServerArtifactPath(entryPath, `hosting.serverPages[${index}].serverEntry.path`);

  if (typeof exportName !== "string" || exportName.length === 0)
    throw new TypeError(`hosting.serverPages[${index}].serverEntry.exportName must be non-empty`);

  if (!isRecord(value.projection))
    throw new TypeError(`hosting.serverPages[${index}].projection must be a record`);

  assertExactKeys(
    value.projection,
    ["producer", "activation", "delivery", "hydrationMismatch"],
    `hosting.serverPages[${index}].projection`,
  );

  if (value.projection.producer !== "ssr" || value.projection.delivery !== "complete")
    throw new TypeError(`hosting.serverPages[${index}] has an unsupported route projection`);

  if (value.projection.activation !== "hydrate" && value.projection.activation !== "none")
    throw new TypeError(`hosting.serverPages[${index}] has an unsupported activation mode`);

  if (
    value.projection.hydrationMismatch !== "client-remount" &&
    value.projection.hydrationMismatch !== "fatal"
  )
    throw new TypeError(
      `hosting.serverPages[${index}] has an unsupported hydration mismatch policy`,
    );

  const base = {
    version: 1 as const,
    routeId: value.routeId,
    buildIdentity: value.buildIdentity,
    format: "document" as const,
    serverEntry: Object.freeze({ path: entryPath, exportName }),
  };

  if (value.projection.activation === "hydrate") {
    assertExactKeys(
      value,
      ["version", "routeId", "buildIdentity", "format", "serverEntry", "projection", "resumeAsset"],
      `hosting.serverPages[${index}]`,
    );

    if (typeof value.resumeAsset !== "string")
      throw new TypeError(`hosting.serverPages[${index}].resumeAsset must be a string`);

    const projection = Object.freeze({
      producer: "ssr" as const,
      activation: "hydrate" as const,
      delivery: "complete" as const,
      hydrationMismatch: value.projection.hydrationMismatch,
    });

    return Object.freeze({ ...base, projection, resumeAsset: value.resumeAsset });
  }

  assertExactKeys(
    value,
    ["version", "routeId", "buildIdentity", "format", "serverEntry", "projection"],
    `hosting.serverPages[${index}]`,
  );

  const projection = Object.freeze({
    producer: "ssr" as const,
    activation: "none" as const,
    delivery: "complete" as const,
    hydrationMismatch: value.projection.hydrationMismatch,
  });

  return Object.freeze({ ...base, projection });
}

function snapshotServerArtifacts(value: unknown): readonly HostingServerArtifactSnapshot[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError("hosting.serverArtifacts must be a non-empty array");

  const artifacts = value.map((artifact, index): HostingServerArtifactSnapshot => {
    if (!isRecord(artifact))
      throw new TypeError(`hosting.serverArtifacts[${index}] must be a record`);

    assertExactKeys(artifact, ["path", "sha256"], `hosting.serverArtifacts[${index}]`);

    assertSafeServerArtifactPath(artifact.path, `hosting.serverArtifacts[${index}].path`);

    if (typeof artifact.sha256 !== "string" || !sha256Pattern.test(artifact.sha256))
      throw new TypeError(`hosting.serverArtifacts[${index}].sha256 must be lowercase SHA-256 hex`);

    return Object.freeze({ path: artifact.path, sha256: artifact.sha256 });
  });
  const paths = new Set(artifacts.map((artifact) => artifact.path));

  if (paths.size !== artifacts.length) throw new TypeError("duplicate server artifact path");

  for (const path of paths) {
    const segments = path.split("/");
    let ancestor = "";

    for (const segment of segments.slice(0, -1)) {
      ancestor = ancestor === "" ? segment : `${ancestor}/${segment}`;

      if (paths.has(ancestor))
        throw new TypeError(`server artifact paths conflict as a file and directory: ${path}`);
    }
  }

  return Object.freeze(artifacts);
}

export function assertSafeServerArtifactPath(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);

  try {
    canonicalizePublicFilePath(value);
  } catch {
    throw new TypeError(`${label} must be a safe slash-separated relative path`);
  }

  for (const segment of value.split("/")) {
    if (/[<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment))
      throw new TypeError(`${label} contains a path segment unsafe on Windows`);

    const deviceName = segment.split(".", 1)[0]!.replace(/[ .]+$/u, "");

    if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(deviceName))
      throw new TypeError(`${label} contains a reserved Windows device name`);
  }
}

function validatePublicFileRecords(files: readonly HostingPublicFileMetadataSnapshot[]): void {
  const storagePaths = new Set<string>();
  const urlPaths = new Set<string>();

  for (const file of files) {
    const canonicalURL = canonicalizePublicFilePath(file.relativePath);

    assertCanonicalPublicFilePath(file.urlPath);

    if (canonicalURL !== file.urlPath)
      throw new TypeError(
        `public file URL path does not match its storage path: ${file.relativePath}`,
      );

    if (storagePaths.has(file.relativePath))
      throw new TypeError(`duplicate public file storage path: ${file.relativePath}`);

    if (urlPaths.has(file.urlPath))
      throw new TypeError(`duplicate public file URL path: ${file.urlPath}`);

    storagePaths.add(file.relativePath);
    urlPaths.add(file.urlPath);
  }

  for (const path of storagePaths) {
    const segments = path.split("/");
    let ancestor = "";

    for (const segment of segments.slice(0, -1)) {
      ancestor = ancestor === "" ? segment : `${ancestor}/${segment}`;

      if (storagePaths.has(ancestor))
        throw new TypeError(`public file storage paths conflict as a file and directory: ${path}`);
    }
  }
}

function validateContentType(value: unknown, path: string, label = "asset"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    containsControlCharacters(value)
  )
    throw new TypeError(`${label} contentType is invalid: ${path}`);

  try {
    const headers = new Headers([["content-type", value]]);

    if (!headers.get("content-type")) throw new TypeError();
  } catch {
    throw new TypeError(`${label} contentType is invalid: ${path}`);
  }

  return value;
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;

    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }

  return false;
}

async function digestHex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  record: Record<PropertyKey, unknown>,
  keys: string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(record);

  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new TypeError(`${label} has unexpected fields`);
}

function snapshotTargetedHosting(
  value: unknown,
): (HostingRecordV1 | HostingRecordV2 | HostingRecordV3) & { readonly mode: "production" } {
  const hosting = jsonRecord(value, "hosting");
  const version = hosting.version;

  if (version !== 1 && version !== 2 && version !== 3)
    throw new TypeError("unsupported hosting record version");

  const keys = ["version", "mode", "standaloneMountURL", "startupAsset", "assets"];

  if (version !== 1) keys.push("publicFiles");

  if (version === 3) keys.push("serverPages", "serverArtifacts");

  assertExactKeys(hosting, keys, "hosting record");

  if (hosting.mode !== "production")
    throw new TypeError("targeted hosting must use production mode");

  assertString(hosting.standaloneMountURL, "standaloneMountURL");

  if (canonicalizeMountURL(hosting.standaloneMountURL) !== hosting.standaloneMountURL)
    throw new TypeError("standaloneMountURL must already be canonical");

  assertString(hosting.startupAsset, "startupAsset");
  assertCanonicalAssetPath(hosting.startupAsset, "startupAsset");

  const assets = Object.freeze(
    dataArray(hosting.assets, "hosting.assets").map((item, index) => {
      const asset = jsonRecord(item, `hosting.assets[${index}]`);

      assertExactKeys(asset, ["path", "sha256", "contentType"], `hosting.assets[${index}]`);
      assertString(asset.path, "asset path");
      assertCanonicalAssetPath(asset.path, "asset path");
      assertDigest(asset.sha256, `asset digest: ${asset.path}`);

      return Object.freeze({
        path: asset.path,
        sha256: asset.sha256,
        contentType: validateContentType(asset.contentType, asset.path),
      });
    }),
  );
  const managedPaths = new Set(assets.map((asset) => asset.path));

  if (!assets.length || managedPaths.size !== assets.length)
    throw new TypeError("asset inventory must be non-empty and contain unique paths");

  if (!managedPaths.has(hosting.startupAsset))
    throw new TypeError("startupAsset is missing from the captured asset inventory");

  const base = {
    mode: "production" as const,
    standaloneMountURL: hosting.standaloneMountURL,
    startupAsset: hosting.startupAsset,
    assets,
  };

  if (version === 1) return Object.freeze({ version, ...base });

  const publicFiles = Object.freeze(
    snapshotPublicFileMetadata(hosting.publicFiles).map((file) => {
      assertDigest(file.sha256, `public file digest: ${file.urlPath}`);

      return Object.freeze({
        relativePath: file.relativePath,
        urlPath: file.urlPath,
        sha256: file.sha256,
        contentType: validateContentType(file.contentType, file.urlPath, "public file"),
      });
    }),
  );

  if (version === 2) return Object.freeze({ version, ...base, publicFiles });

  const serverPages = snapshotServerPages(hosting.serverPages);
  const serverArtifacts = snapshotServerArtifacts(hosting.serverArtifacts);

  validateServerPlanReferences(
    serverPages,
    new Set(serverArtifacts.map((artifact) => artifact.path)),
    managedPaths,
  );

  return Object.freeze({ version, ...base, publicFiles, serverPages, serverArtifacts });
}

function validateServerPlanReferences(
  serverPages: readonly HostingServerPagePlan[],
  artifactPaths: ReadonlySet<string>,
  managedPaths: ReadonlySet<unknown>,
): void {
  const routeIds = new Set<string>();
  const firstPage = serverPages[0];

  for (const page of serverPages) {
    if (routeIds.has(page.routeId))
      throw new TypeError(`duplicate server route plan: ${page.routeId}`);

    routeIds.add(page.routeId);

    if (
      firstPage &&
      (page.buildIdentity !== firstPage.buildIdentity ||
        page.serverEntry.path !== firstPage.serverEntry.path ||
        page.serverEntry.exportName !== firstPage.serverEntry.exportName)
    )
      throw new TypeError("server pages must share one build identity and dispatcher entry");

    if (page.projection.activation === "hydrate") {
      const resumeAsset = page.resumeAsset;

      if (typeof resumeAsset !== "string")
        throw new TypeError(`resumeAsset for route ${page.routeId} must be a string`);

      assertCanonicalAssetPath(resumeAsset, `resumeAsset for route ${page.routeId}`);

      if (!managedPaths.has(resumeAsset))
        throw new TypeError(`resumeAsset is missing from the managed inventory: ${resumeAsset}`);
    }
  }

  if (firstPage && !artifactPaths.has(firstPage.serverEntry.path))
    throw new TypeError("server dispatcher entry is missing from the artifact inventory");
}

function validateBrowserProvenance(control: Record<PropertyKey, unknown>): void {
  if (control.target !== "browser")
    throw new TypeError("browser control must retain its browser compilation marker");

  const resolution = jsonRecord(control.resolution, "resolution");

  assertExactKeys(
    resolution,
    [
      "mode",
      "activeConditions",
      "overrides",
      "runtimeKeyRegistry",
      "capturedSources",
      "capturedManifests",
      "edges",
      "generatedSources",
    ],
    "resolution",
  );

  if (resolution.mode !== "development" && resolution.mode !== "production")
    throw new TypeError("unsupported browser resolution mode");

  stringArray(resolution.activeConditions, "resolution.activeConditions");

  const overrides = jsonRecord(resolution.overrides, "resolution.overrides");

  assertExactKeys(overrides, ["browser"], "resolution.overrides");
  stringDictionary(overrides.browser, "resolution.overrides.browser");
  stringRow(
    resolution.runtimeKeyRegistry,
    ["source", "revision", "digest"],
    [],
    "runtimeKeyRegistry",
  );

  for (const key of ["capturedSources", "capturedManifests"]) {
    for (const row of dataArray(resolution[key], `resolution.${key}`))
      stringRow(row, ["filename", "digest"], [], `resolution.${key}`);
  }

  const failureCodes = [
    "HOST_IMPORT",
    "PACKAGE_IMPORT_UNSUPPORTED",
    "MODULE_NOT_FOUND",
    "PACKAGE_NOT_FOUND",
    "INVALID_PACKAGE",
    "INVALID_PACKAGE_TARGET",
    "EXPORTS_NO_MATCH",
    "EXPORTS_BLOCKED",
  ];

  for (const item of dataArray(resolution.edges, "resolution.edges")) {
    const edge = stringRow(
      item,
      ["from", "specifier", "outcome"],
      ["resolvedFilename", "failureCode"],
      "resolution edge",
      ["conditionPath"],
    );

    if (edge.outcome !== "resolved" && edge.outcome !== "failed")
      throw new TypeError("unsupported resolution edge outcome");

    if (Object.hasOwn(edge, "failureCode") && !failureCodes.includes(edge.failureCode as string))
      throw new TypeError("unsupported resolution failure code");

    if (Object.hasOwn(edge, "conditionPath")) stringArray(edge.conditionPath, "conditionPath");
  }

  for (const row of dataArray(resolution.generatedSources, "resolution.generatedSources"))
    stringRow(
      row,
      ["filename", "semantic", "semanticHash"],
      ["authoredFilename", "digest", "sourceMapDigest"],
      "generated source",
    );

  for (const key of ["checkingInputs", "modules"]) {
    for (const row of dataArray(control[key], key)) stringRow(row, ["filename", "digest"], [], key);
  }

  jsonRecord(control.configuration, "configuration");
  stringDictionary(control.routeGuards, "routeGuards");
  assertString(control.routeTable, "routeTable");
}

function stringRow(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  otherOptional: readonly string[] = [],
): Record<PropertyKey, unknown> {
  const record = jsonRecord(value, label);
  const allowed = [...required, ...optional, ...otherOptional];

  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.includes(key))
  )
    throw new TypeError(`${label} has unexpected or missing fields`);

  for (const key of [...required, ...optional]) {
    if (Object.hasOwn(record, key)) assertString(record[key], `${label}.${key}`);
  }

  return record;
}

function stringArray(value: unknown, label: string): void {
  for (const item of dataArray(value, label)) assertString(item, label);
}

function stringDictionary(value: unknown, label: string): void {
  for (const item of Object.values(jsonRecord(value, label))) assertString(item, label);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value))
    throw new TypeError(`${label} must be lowercase SHA-256 hex`);
}

function jsonRecord(value: unknown, label: string): Record<PropertyKey, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a record`);

  return value;
}

function dataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);

  return value;
}

function ownDataFields(value: unknown, label: string): Record<PropertyKey, unknown> {
  const record = jsonRecord(value, label);

  return dataProperties(record, label);
}

function dataProperties(value: object, label: string): Record<PropertyKey, unknown> {
  const entries: [string, unknown][] = [];

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} cannot contain symbol keys`);

    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor))
      throw new TypeError(`${label}.${key} must be an own data property`);

    entries.push([key, descriptor.value]);
  }

  return Object.fromEntries(entries);
}

function snapshotJsonData(value: unknown, label: string, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value !== "object" || value === null)
    throw new TypeError(`${label} must contain only JSON data`);

  if (ancestors.has(value)) throw new TypeError(`${label} cannot contain cycles`);

  ancestors.add(value);

  try {
    const fields = dataProperties(value, label);

    if (Array.isArray(value)) {
      const length = fields.length;

      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        Reflect.ownKeys(fields).length !== length + 1 ||
        Array.from({ length }, (_, index) => String(index)).some(
          (key) => !Object.hasOwn(fields, key),
        )
      )
        throw new TypeError(`${label} must be a dense data array without extra fields`);

      return Object.freeze(
        Array.from({ length }, (_, index) =>
          snapshotJsonData(fields[index], `${label}[${index}]`, ancestors),
        ),
      );
    }

    return Object.freeze(
      Object.fromEntries(
        Object.entries(fields).map(([key, item]) => [
          key,
          snapshotJsonData(item, `${label}.${key}`, ancestors),
        ]),
      ),
    );
  } finally {
    ancestors.delete(value);
  }
}

function snapshotBlobMap(value: unknown, label: string): Map<string, Blob> {
  if (typeof value !== "object" || value === null)
    throw new TypeError(`${label} must be a ReadonlyMap`);

  const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];

  if (typeof iterator !== "function") throw new TypeError(`${label} must be a ReadonlyMap`);

  const iterable: Iterable<unknown> = {
    [Symbol.iterator]: () => Reflect.apply(iterator, value, []),
  };
  const files = new Map<string, Blob>();

  for (const entry of iterable) {
    if (!Array.isArray(entry)) throw new TypeError(`${label} entries must be pairs`);

    const fields = dataProperties(entry, `${label} entry`);

    assertExactKeys(fields, ["0", "1", "length"], `${label} entry`);

    if (fields.length !== 2 || typeof fields[0] !== "string" || !(fields[1] instanceof Blob))
      throw new TypeError(`${label} entries must contain a path and Blob`);

    if (files.has(fields[0])) throw new TypeError(`${label} must not repeat artifact keys`);

    files.set(fields[0], fields[1]);
  }

  return files;
}

function immutableBlobMap(files: Map<string, Blob>): ReadonlyMap<string, Blob> {
  const view: ReadonlyMap<string, Blob> = Object.freeze({
    size: files.size,
    get: (key: string) => files.get(key),
    has: (key: string) => files.has(key),
    entries: () => files.entries(),
    keys: () => files.keys(),
    values: () => files.values(),
    [Symbol.iterator]: () => files[Symbol.iterator](),
    forEach(
      callback: (value: Blob, key: string, map: ReadonlyMap<string, Blob>) => void,
      thisArg?: unknown,
    ) {
      files.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
  });

  return view;
}
