import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { releaseNotices } from "./release-candidate.ts";

export interface EditorCandidate {
  schema: 1;
  publisher: string;
  name: string;
  version: string;
  preRelease: true;
  file: string;
  sha256: string;
  bytes: number;
  commit: string;
  sourceDirty: boolean;
}

/** Check a stored candidate's identity and bytes without rebuilding it. */
export async function readEditorCandidate(directory: string): Promise<EditorCandidate> {
  const candidate = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as EditorCandidate;

  assert.equal(candidate.schema, 1, "Unknown editor candidate schema");

  assert.match(candidate.publisher, /^[a-zA-Z0-9][a-zA-Z0-9-]*$/);

  assert.match(candidate.name, /^[a-zA-Z0-9][a-zA-Z0-9-]*$/);

  assert.match(candidate.version, /^\d+\.\d+\.\d+$/);

  assert.equal(candidate.file, `${candidate.name}-${candidate.version}.vsix`);

  assert.equal(candidate.preRelease, true);

  assert.match(candidate.sha256, /^[a-f0-9]{64}$/);

  assert.match(candidate.commit, /^[a-f0-9]{40}$/);

  assert.equal(typeof candidate.sourceDirty, "boolean");

  const bytes = await readFile(join(directory, candidate.file));

  assert.equal(bytes.length, candidate.bytes, "VSIX size differs from candidate manifest");

  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    candidate.sha256,
    "VSIX hash differs from candidate manifest",
  );

  return candidate;
}

/** Build and package one preview VSIX. Installed checks and publication consume this same file. */
export async function prepareEditorCandidate(workspaceRoot: string, directory: string) {
  const extensionRoot = join(workspaceRoot, "editors/vscode");
  const manifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "VSIX versions must be numeric");

  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: extensionRoot,
    stdout: "inherit",
    stderr: "inherit",
  });

  assert.equal(await build.exited, 0, "Extension bundle failed");

  await mkdir(directory, { recursive: true });

  const staging = await mkdtemp(join(directory, "stage-"));
  const file = `${manifest.name}-${manifest.version}.vsix`;
  const archive = resolve(directory, file);

  try {
    for (const path of manifest.files as string[]) {
      if (releaseNotices.includes(path as (typeof releaseNotices)[number])) {
        await cp(join(workspaceRoot, path), join(staging, path));
      } else if (path !== "ThirdPartyNotices.txt") {
        await mkdir(dirname(join(staging, path)), { recursive: true });

        await cp(join(extensionRoot, path), join(staging, path));
      }
    }

    const notices = new Map<string, string>();

    async function collectNotices(packageRoot: string) {
      const dependency = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      const identity = `${dependency.name}@${dependency.version}`;

      if (notices.has(identity)) return;

      const license = (await readdir(packageRoot)).find((name) =>
        /^licen[cs]e(?:\..*)?$/i.test(name),
      );

      assert.ok(license, `Missing bundled dependency license: ${identity}`);

      notices.set(identity, `${identity}\n\n${await readFile(join(packageRoot, license), "utf8")}`);

      const require = createRequire(join(packageRoot, "package.json"));

      for (const name of Object.keys(dependency.dependencies ?? {})) {
        let root = dirname(require.resolve(name));

        while (true) {
          const candidate = Bun.file(join(root, "package.json"));

          if ((await candidate.exists()) && (await candidate.json()).name === name) break;

          const parent = dirname(root);

          assert.notEqual(parent, root, `Cannot find dependency package: ${name}`);

          root = parent;
        }

        await collectNotices(root);
      }
    }

    const require = createRequire(join(extensionRoot, "package.json"));
    let clientRoot = dirname(require.resolve("vscode-languageclient/node"));

    while (!(await Bun.file(join(clientRoot, "package.json")).exists())) {
      const parent = dirname(clientRoot);

      assert.notEqual(parent, clientRoot, "Cannot find language-client package");

      clientRoot = parent;
    }

    await collectNotices(clientRoot);

    await writeFile(
      join(staging, "ThirdPartyNotices.txt"),
      `${[...notices.values()].join("\n\n---\n\n")}\n`,
    );

    const packagedManifest = { ...manifest };

    delete packagedManifest.scripts;
    delete packagedManifest.dependencies;
    delete packagedManifest.devDependencies;
    delete packagedManifest.private;

    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify(packagedManifest, null, 2)}\n`,
    );

    const child = Bun.spawn(
      [
        "node",
        join(workspaceRoot, "node_modules/@vscode/vsce/vsce"),
        "package",
        "--no-dependencies",
        "--pre-release",
        "--out",
        archive,
      ],
      { cwd: staging, stdout: "inherit", stderr: "inherit" },
    );

    assert.equal(await child.exited, 0, "VSIX packaging failed");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const bytes = await readFile(archive);
  const git = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: workspaceRoot, stdout: "pipe" });
  const commit = (await new Response(git.stdout).text()).trim();

  assert.equal(await git.exited, 0, "Cannot identify candidate source commit");

  const status = Bun.spawn(["git", "status", "--porcelain", "--untracked-files=normal"], {
    cwd: workspaceRoot,
    stdout: "pipe",
  });
  const sourceDirty = (await new Response(status.stdout).text()).trim().length > 0;

  assert.equal(await status.exited, 0, "Cannot identify candidate source status");

  const candidate: EditorCandidate = {
    schema: 1,
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    preRelease: true,
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    commit,
    sourceDirty,
  };

  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(candidate, null, 2)}\n`);

  await readEditorCandidate(directory);

  console.log(`Prepared ${archive} (${candidate.sha256})`);

  return candidate;
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === "--candidate-dir"),
    "Usage: editor-package.ts [--candidate-dir <directory>]",
  );

  const workspaceRoot = resolve(import.meta.dir, "../..");

  await prepareEditorCandidate(
    workspaceRoot,
    resolve(args[1] ?? join(workspaceRoot, ".hesperia/editor-candidate")),
  );
}
