import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readReleaseCandidate } from "../../scripts/ci/release-candidate.ts";

/** Use the supplied archive in candidate runs; an invalid candidate never falls back to packing. */
export async function suppliedReleaseArchive(packageRoot: string): Promise<string | undefined> {
  const directory = process.env.HESPERIA_RELEASE_CANDIDATE_DIR;

  if (!directory) return undefined;

  const source = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const candidate = await readReleaseCandidate(directory);
  const package_ = candidate.packages.find((entry) => entry.name === source.name);

  assert.ok(package_, `Candidate is missing ${source.name}`);

  assert.equal(
    package_.version,
    source.version,
    "Candidate archive version differs from the package fixture",
  );

  return resolve(directory, package_.file).replaceAll("\\", "/");
}
