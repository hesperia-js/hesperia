import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { releaseVersion, releaseWorkspace } from "./check-release.ts";
import {
  packedFile,
  packedManifest,
  readReleaseCandidate,
  releaseNotices,
} from "./release-candidate.ts";

/** Check the exact archives, their merge commit, inventory, exports, and registry dependency pins. */
export async function verifyReleaseCandidate(workspaceRoot: string, directory: string) {
  const candidate = await readReleaseCandidate(directory);
  const release = await releaseWorkspace(workspaceRoot);

  assert.deepEqual(
    releaseVersion(candidate.version),
    { version: candidate.version, channel: candidate.channel },
    "Candidate channel differs from its version",
  );

  assert.equal(candidate.version, release.version, "Candidate version differs from checkout");

  assert.equal(
    candidate.commit,
    (await $`git rev-parse HEAD`.cwd(workspaceRoot).quiet().text()).trim(),
    "Candidate commit differs from checkout",
  );

  assert.deepEqual(
    candidate.packages.map((package_) => package_.name),
    release.plan.map((target) => target.name),
    "Candidate package inventory or dependency order differs",
  );

  const names = new Set(candidate.packages.map((package_) => package_.name));

  for (const [index, package_] of candidate.packages.entries()) {
    const archive = resolve(directory, package_.file);
    const manifest = await packedManifest(archive);

    assert.ok(
      manifest.name === package_.name &&
        manifest.version === candidate.version &&
        manifest.private !== true,
      `Packed identity differs for ${package_.name}`,
    );

    assert.equal(
      manifest.license,
      "MPL-2.0",
      `Packed license metadata differs for ${package_.name}`,
    );

    assert.deepEqual(
      manifest.repository,
      release.packages[index]!.repository,
      `Packed repository metadata differs for ${package_.name}`,
    );

    for (const notice of releaseNotices)
      assert.deepEqual(
        Buffer.from(await packedFile(archive, notice)),
        await readFile(resolve(workspaceRoot, notice)),
        `${package_.name} archive notice differs: ${notice}`,
      );

    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const [name, value] of Object.entries(
        (manifest[section] ?? {}) as Record<string, unknown>,
      )) {
        assert.ok(
          typeof value === "string" && !/^(workspace:|file:|link:|\.\.?[/\\])/.test(value),
          `${package_.name} packed a local ${section} dependency on ${name}`,
        );

        if (names.has(name))
          assert.equal(
            value,
            candidate.version,
            `${package_.name} packed an incorrect internal version for ${name}`,
          );

        if (name === "aeolia")
          assert.equal(
            value,
            release.aeolia,
            `${package_.name} packed an incorrect Aeolia version`,
          );
      }
    }

    const files = new Set((await $`tar -tf ${archive}`.quiet().text()).trim().split(/\r?\n/));
    const target = release.plan[index]!;

    for (const file of [...target.exportTargets, ...target.binTargets])
      assert.ok(files.has(`package/${file.slice(2)}`), `${package_.name} archive omits ${file}`);
  }

  console.log(`Verified ${candidate.packages.length} supplied archives for ${candidate.commit}`);

  return candidate;
}

if (import.meta.main) {
  assert.equal(process.argv[2], "--candidate-dir", "Supply --candidate-dir <directory>");

  assert.ok(process.argv[3], "Supply a candidate directory");

  await verifyReleaseCandidate(resolve(import.meta.dir, "../.."), resolve(process.argv[3]));
}
