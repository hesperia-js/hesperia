import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sortedSections = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
  "peerDependencies",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareKeys([left]: [string, unknown], [right]: [string, unknown]): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function writePackageManifest<T extends object>(
  filename: string,
  manifest: T,
): Promise<void> {
  const output = Object.fromEntries(
    Object.entries(manifest).map(([key, value]) => [
      key,
      sortedSections.has(key) && isRecord(value)
        ? Object.fromEntries(Object.entries(value).sort(compareKeys))
        : value,
    ]),
  );

  await writeFile(filename, `${JSON.stringify(output, null, 2)}\n`);
}

export async function readPinnedAeoliaVersion(workspaceRoot: string): Promise<string> {
  const source = await readFile(resolve(workspaceRoot, "package.json"), "utf8");
  const manifest = JSON.parse(source) as {
    readonly devDependencies?: Record<string, unknown>;
    readonly dependencies?: Record<string, unknown>;
  };
  const version = manifest.devDependencies?.aeolia ?? manifest.dependencies?.aeolia;

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error(`Expected an exact Aeolia version in ${workspaceRoot}/package.json`);

  return version;
}
