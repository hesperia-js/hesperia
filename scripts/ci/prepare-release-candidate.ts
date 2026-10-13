import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { validatePackageBuildOutputs } from "../build-packages.ts";
import { releaseWorkspace } from "./check-release.ts";
import { archiveIntegrity, releaseNotices, type ReleaseCandidate } from "./release-candidate.ts";
import { verifyReleaseCandidate } from "./verify-release-candidate.ts";

/** Pack the existing build once. Subsequent jobs consume these files without repacking. */
export async function prepareReleaseCandidate(workspaceRoot: string, directory: string) {
  const release = await releaseWorkspace(workspaceRoot);
  const candidate: ReleaseCandidate = {
    schema: 1,
    version: release.version,
    channel: release.channel,
    commit: (await $`git rev-parse HEAD`.cwd(workspaceRoot).quiet().text()).trim(),
    packages: [],
  };

  await mkdir(resolve(directory, "archives"), { recursive: true });

  const scratchRoot = resolve(workspaceRoot, ".hesperia");

  await mkdir(scratchRoot, { recursive: true });

  const staging = await mkdtemp(join(scratchRoot, "release-pack-"));

  try {
    const rootManifest = JSON.parse(
      await readFile(resolve(workspaceRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;

    assert.equal(rootManifest.license, "MPL-2.0", "Expected the existing workspace license");

    await cp(resolve(workspaceRoot, "package.json"), resolve(staging, "package.json"));

    await cp(resolve(workspaceRoot, "bun.lock"), resolve(staging, "bun.lock"));

    for (const target of release.plan) {
      await validatePackageBuildOutputs(target);

      const stagedPackage = resolve(staging, target.directory);

      await mkdir(stagedPackage, { recursive: true });

      const manifest = JSON.parse(
        await readFile(resolve(target.packageRoot, "package.json"), "utf8"),
      ) as Record<string, unknown> & { files: string[] };

      for (const file of manifest.files) {
        await cp(resolve(target.packageRoot, file), resolve(stagedPackage, file), {
          recursive: true,
        });
      }

      manifest.license = rootManifest.license;
      manifest.files = [...new Set([...manifest.files, ...releaseNotices])];

      await writeFile(
        resolve(stagedPackage, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );

      for (const notice of releaseNotices)
        await cp(resolve(workspaceRoot, notice), resolve(stagedPackage, notice));

      const file = `archives/${target.name.replace(/^@/, "").replaceAll("/", "-")}-${release.version}.tgz`;
      const archive = resolve(directory, file);
      const child = Bun.spawn(
        [process.execPath, "pm", "pack", "--filename", archive, "--ignore-scripts"],
        { cwd: stagedPackage, stdout: "inherit", stderr: "inherit" },
      );

      assert.equal(await child.exited, 0, `Packing ${target.name} failed`);

      candidate.packages.push({
        name: target.name,
        version: release.version,
        file,
        integrity: archiveIntegrity(await readFile(archive)),
      });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  await writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(candidate, null, 2)}\n`);

  await verifyReleaseCandidate(workspaceRoot, directory);

  console.log(
    `Prepared ${candidate.packages.length} archives for ${candidate.version} at ${candidate.commit}`,
  );
}

if (import.meta.main) {
  assert.equal(process.argv[2], "--candidate-dir", "Supply --candidate-dir <directory>");

  assert.ok(process.argv[3], "Supply a candidate directory");

  await prepareReleaseCandidate(resolve(import.meta.dir, "../.."), resolve(process.argv[3]));
}
