import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { readEditorCandidate } from "./editor-package.ts";
import { verifyReleaseCandidate } from "./verify-release-candidate.ts";

/** Install the candidate packages and run the real editor against the exact candidate VSIX. */
async function testEditorPackage() {
  assert.equal(process.platform, "win32", "The installed VSIX gate requires Windows VS Code");

  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "candidate-dir": { type: "string", default: ".hesperia/release-candidate" },
      "editor-candidate-dir": { type: "string", default: ".hesperia/editor-candidate" },
      "evidence-dir": { type: "string", default: ".hesperia/editor-package-evidence" },
      "code-path": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const workspaceRoot = resolve(import.meta.dir, "../..");
  const packageDirectory = resolve(values["candidate-dir"]!);
  const editorDirectory = resolve(values["editor-candidate-dir"]!);
  const evidenceDirectory = resolve(values["evidence-dir"]!);
  const candidate = await verifyReleaseCandidate(workspaceRoot, packageDirectory);
  const editor = await readEditorCandidate(editorDirectory);

  assert.equal(
    editor.commit,
    candidate.commit,
    "Editor and npm candidates use different revisions",
  );

  const archives = Object.fromEntries(
    candidate.packages.map((entry) => [
      entry.name,
      resolve(packageDirectory, entry.file).replaceAll("\\", "/"),
    ]),
  );
  const rootManifest = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
  const project = await realpath(
    await mkdtemp(join(tmpdir(), "hesperia-installed-editor-packages-")),
  );
  let passed = false;

  try {
    await mkdir(evidenceDirectory, { recursive: true });

    for (const file of ["editor-result.json", "candidate.json"]) {
      await rm(join(evidenceDirectory, file), { force: true });
    }

    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify(
        {
          name: "hesperia-installed-editor-consumer",
          private: true,
          type: "module",
          dependencies: {
            hesperia: archives.hesperia,
            "@hesperia/language-server": archives["@hesperia/language-server"],
            aeolia: rootManifest.devDependencies.aeolia,
          },
          overrides: archives,
        },
        null,
        2,
      )}\n`,
    );

    const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
      cwd: project,
      stdout: "inherit",
      stderr: "inherit",
    });

    assert.equal(await install.exited, 0, "Candidate npm installation failed");

    for (const name of [
      "hesperia",
      "@hesperia/language-server",
      "@hesperia/compiler",
      "@hesperia/tooling",
    ]) {
      const installedRoot = await realpath(join(project, "node_modules", name));
      const local = relative(project, installedRoot);

      assert.ok(
        local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local),
        `${name} escaped the installed fixture`,
      );

      const installed = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));

      assert.equal(installed.name, name);

      assert.equal(installed.version, candidate.version);
    }

    const arguments_ = [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(workspaceRoot, "editors/vscode/test.ps1"),
      "-VsixPath",
      join(editorDirectory, editor.file),
      "-InstalledProjectPath",
      project,
      "-ReceiptPath",
      join(evidenceDirectory, "editor-result.json"),
    ];
    const codePath = values["code-path"] ?? process.env.VSCODE_CODE_PATH;

    if (codePath) arguments_.push("-CodePath", codePath);

    const test = Bun.spawn(arguments_, {
      cwd: workspaceRoot,
      stdout: "inherit",
      stderr: "inherit",
    });

    assert.equal(await test.exited, 0, "Installed VSIX acceptance failed");

    const receipt = JSON.parse(
      await readFile(join(evidenceDirectory, "editor-result.json"), "utf8"),
    );

    assert.equal(receipt.passed, true);

    assert.equal(receipt.installedArtifact?.id, `${editor.publisher}.${editor.name}`);

    assert.equal(receipt.installedArtifact?.version, editor.version);

    assert.equal(receipt.installedArtifact?.vsixSha256, editor.sha256);

    assert.equal(receipt.checks?.length, 19);

    await writeFile(
      join(evidenceDirectory, "candidate.json"),
      `${JSON.stringify({ editor, packages: candidate, verifiedAt: new Date().toISOString() }, null, 2)}\n`,
    );

    passed = true;

    console.log(
      `Installed VSIX accepted: ${editor.publisher}.${editor.name}@${editor.version} (${editor.sha256})`,
    );
  } finally {
    if (passed) await rm(project, { recursive: true, force: true });
    else console.error(`Installed npm fixture retained at ${project}`);
  }
}

if (import.meta.main) await testEditorPackage();
