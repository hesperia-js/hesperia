import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { readEditorCandidate } from "./editor-package.ts";

/** Verify the clean CI candidate and its installed acceptance receipt before publication. */
async function verifyEditorRelease() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "candidate-dir": { type: "string", default: ".hesperia/editor-candidate" },
      "evidence-dir": { type: "string", default: ".hesperia/editor-package-evidence" },
    },
    strict: true,
    allowPositionals: false,
  });
  const workspaceRoot = resolve(import.meta.dir, "../..");
  const directory = resolve(values["candidate-dir"]!);
  const candidate = await readEditorCandidate(directory);
  const evidence = resolve(values["evidence-dir"]!);
  const accepted = JSON.parse(await readFile(join(evidence, "candidate.json"), "utf8"));
  const receipt = JSON.parse(await readFile(join(evidence, "editor-result.json"), "utf8"));
  const manifest = JSON.parse(
    await readFile(join(workspaceRoot, "editors/vscode/package.json"), "utf8"),
  );

  assert.equal(
    candidate.sourceDirty,
    false,
    "Publish only a candidate built from a clean CI checkout",
  );

  assert.equal(
    candidate.commit,
    (await $`git rev-parse HEAD`.cwd(workspaceRoot).quiet().text()).trim(),
  );

  assert.equal(candidate.publisher, manifest.publisher);

  assert.equal(candidate.name, manifest.name);

  assert.equal(candidate.version, manifest.version);

  assert.deepEqual(
    accepted.editor,
    candidate,
    "Installed acceptance used a different VSIX candidate",
  );

  assert.equal(
    accepted.packages.commit,
    candidate.commit,
    "Installed npm candidate revision differs",
  );

  assert.equal(
    accepted.packages.version,
    (await Bun.file(join(workspaceRoot, "package.json")).json()).version,
    "Installed npm candidate version differs",
  );

  assert.equal(receipt.passed, true, "Installed extension acceptance did not pass");

  assert.equal(receipt.checks?.length, 19, "Installed extension acceptance is incomplete");

  assert.equal(receipt.installedArtifact?.id, `${candidate.publisher}.${candidate.name}`);

  assert.equal(receipt.installedArtifact?.version, candidate.version);

  assert.equal(receipt.installedArtifact?.vsixSha256, candidate.sha256);

  console.log(
    `Verified ${candidate.publisher}.${candidate.name}@${candidate.version} (${candidate.sha256})`,
  );
  console.log(`Publication input: ${join(directory, candidate.file)}`);
}

if (import.meta.main) await verifyEditorRelease();
