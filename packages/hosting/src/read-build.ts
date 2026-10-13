import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  captureInput,
  resolveMountPath,
  validateAssets,
  assertCanonicalAssetPath,
  isRecord,
} from "./captured-build.ts";
import type { CapturedBrowserBuild, HostingRecordV1 } from "./index.ts";

export async function readBuildDirectory(buildDirectory: string): Promise<CapturedBrowserBuild> {
  const output = resolve(buildDirectory);

  for (const directory of [dirname(output), output]) {
    const stats = await lstatBuildPath(directory);

    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new TypeError("The completed build directory must be a real directory");
  }

  const recordPath = join(output, "hesperia-build.json");
  let recordSource = await readBuildRecord(recordPath);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readCapture(output, recordSource);
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

async function readBuildRecord(recordPath: string): Promise<string> {
  const recordStat = await lstatBuildPath(recordPath);

  if (!recordStat.isFile() || recordStat.isSymbolicLink())
    throw new TypeError("The completed build record must be a regular file");

  return readFile(recordPath, "utf8");
}

async function readCapture(output: string, recordSource: string): Promise<CapturedBrowserBuild> {
  const record = JSON.parse(recordSource) as {
    hosting?: unknown;
    assetDirectory?: unknown;
  };

  if (!isRecord(record) || !isRecord(record.hosting))
    throw new TypeError("The completed build record has no hosting metadata");

  const hosting = record.hosting as unknown as HostingRecordV1;

  if (hosting.mode !== "production")
    throw new TypeError(`Cannot serve a ${hosting.mode} build as production`);

  if (!Array.isArray(hosting.assets))
    throw new TypeError("The completed build record has no asset inventory");

  const assetDirectory = record.assetDirectory ?? "assets";

  if (
    typeof assetDirectory !== "string" ||
    !/^(?:assets|\.captures\/[0-9a-f-]{36}\/assets)$/u.test(assetDirectory)
  )
    throw new TypeError("The completed build asset directory is invalid");

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

  const build = { hosting, files };
  const snapshot = captureInput(build);

  resolveMountPath(snapshot);

  const assets = await validateAssets(snapshot);

  if (!assets.has(hosting.startupAsset))
    throw new TypeError("startupAsset is missing from the captured asset inventory");

  return { hosting, files: new Map([...assets].map(([path, item]) => [path, item.blob])) };
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
