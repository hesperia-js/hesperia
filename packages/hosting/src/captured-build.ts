import {
  assertCanonicalPublicFilePath,
  canonicalizeMountURL,
  canonicalizePublicFilePath,
} from "./internal/mount.ts";
import type { CapturedBuild, HostSelection } from "./index.ts";

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

interface VerifiedAsset {
  readonly blob: Blob;
  readonly contentType: string;
}

const sha256Pattern = /^[0-9a-f]{64}$/u;

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

    if (file.urlPath === "/_hesperia" || file.urlPath.startsWith("/_hesperia/"))
      throw new TypeError(`public file path is reserved: ${file.urlPath}`);

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
