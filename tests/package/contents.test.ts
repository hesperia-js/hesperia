import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverPackageBuildPlan } from "../../scripts/build-packages.ts";
import { prepareReleaseCandidate } from "../../scripts/ci/prepare-release-candidate.ts";
import { packedFile, readReleaseCandidate } from "../../scripts/ci/release-candidate.ts";

test("every published package includes its README, package guides, and unchanged license files", async () => {
  const workspaceRoot = resolve(import.meta.dir, "../..");
  const supplied = process.env.HESPERIA_RELEASE_CANDIDATE_DIR;
  const directory = supplied ?? (await mkdtemp(join(tmpdir(), "hesperia-package-contents-")));

  try {
    if (!supplied) await prepareReleaseCandidate(workspaceRoot, directory);

    const candidate = await readReleaseCandidate(directory);
    const plan = await discoverPackageBuildPlan(workspaceRoot);

    for (const target of plan) {
      const entry = candidate.packages.find((package_) => package_.name === target.name);

      expect(entry, `Missing package archive for ${target.name}`).toBeDefined();

      const archive = resolve(directory, entry!.file);
      const readme = Buffer.from(await packedFile(archive, "README.md"));

      expect(readme.toString("utf8").trim().length).toBeGreaterThan(0);

      expect(readme).toEqual(await readFile(join(target.packageRoot, "README.md")));

      for (const notice of ["LICENSE", "COPYING", "LICENSE-COMMERCIAL.md"]) {
        expect(Buffer.from(await packedFile(archive, notice))).toEqual(
          await readFile(join(workspaceRoot, notice)),
        );
      }

      const packageEntries = await readdir(target.packageRoot, { withFileTypes: true });

      if (packageEntries.some((entry) => entry.name === "docs" && entry.isDirectory())) {
        const docsRoot = join(target.packageRoot, "docs");

        for (const file of await readdir(docsRoot, { recursive: true, withFileTypes: true })) {
          if (!file.isFile()) continue;

          const filename = join(file.parentPath, file.name);
          const packagePath = filename.slice(target.packageRoot.length + 1).replaceAll("\\", "/");

          expect(Buffer.from(await packedFile(archive, packagePath))).toEqual(
            await readFile(filename),
          );
        }
      }
    }
  } finally {
    if (!supplied) await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
