import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveIntegrity, readReleaseCandidate } from "../../scripts/ci/release-candidate.ts";
import { suppliedReleaseArchive } from "../package/release-candidate.ts";
import { prepareReleaseCandidate } from "../../scripts/ci/prepare-release-candidate.ts";
import { packedFile, packedManifest } from "../../scripts/ci/release-candidate.ts";
import { verifyReleaseCandidate } from "../../scripts/ci/verify-release-candidate.ts";
import { releaseNotices } from "../../scripts/ci/release-candidate.ts";
import { $ } from "bun";

test("package consumers use the supplied bytes and reject changed, missing, or escaping archives without repacking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hesperia-candidate-"));
  const old = process.env.HESPERIA_RELEASE_CANDIDATE_DIR;

  try {
    await mkdir(join(directory, "archives"));

    const bytes = new TextEncoder().encode("provided archive bytes");
    const archive = join(directory, "archives", "hesperia.tgz");

    await writeFile(archive, bytes);

    const manifest = {
      schema: 1,
      version: "1.0.0-alpha.1",
      channel: "alpha",
      commit: "a".repeat(40),
      packages: [
        {
          name: "hesperia",
          version: "1.0.0-alpha.1",
          file: "archives/hesperia.tgz",
          integrity: archiveIntegrity(bytes),
        },
      ],
    };

    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));

    await mkdir(join(directory, "source"));

    const source = join(directory, "source", "package.json");

    await writeFile(source, JSON.stringify({ name: "hesperia", version: manifest.version }));

    process.env.HESPERIA_RELEASE_CANDIDATE_DIR = directory;
    const supplied = await suppliedReleaseArchive(join(directory, "source"));

    expect(supplied).toBe(archive.replaceAll("\\", "/"));

    expect(await readFile(supplied!)).toEqual(Buffer.from(bytes));

    await writeFile(archive, "locally rebuilt bytes");

    await expect(suppliedReleaseArchive(join(directory, "source"))).rejects.toThrow("hash differs");

    await writeFile(archive, bytes);

    await writeFile(source, JSON.stringify({ name: "missing", version: manifest.version }));

    await expect(suppliedReleaseArchive(join(directory, "source"))).rejects.toThrow(
      "missing missing",
    );

    manifest.packages[0]!.file = "../hesperia.tgz";

    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));

    await expect(readReleaseCandidate(directory)).rejects.toThrow("path must stay inside");

    delete process.env.HESPERIA_RELEASE_CANDIDATE_DIR;

    expect(await suppliedReleaseArchive(join(directory, "source"))).toBeUndefined();
  } finally {
    if (old === undefined) delete process.env.HESPERIA_RELEASE_CANDIDATE_DIR;
    else process.env.HESPERIA_RELEASE_CANDIDATE_DIR = old;

    await rm(directory, { recursive: true, force: true });
  }
});

test("one real packed workspace candidate retains package documentation and notices and rejects invalid publication inputs", async () => {
  const scratchRoot = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(scratchRoot, { recursive: true });

  const workspace = await mkdtemp(join(scratchRoot, "release pack proof "));

  try {
    const version = "1.0.0-alpha.1";

    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "release-test-workspace",
        repository: { type: "git", url: "https://github.com/hesperia-js/hesperia.git" },
        private: true,
        license: "MPL-2.0",
        version,
        workspaces: ["packages/*"],
        devDependencies: { aeolia: "1.0.0-alpha.1" },
      }),
    );

    for (const notice of releaseNotices)
      await writeFile(join(workspace, notice), `existing ${notice} notice\n`);

    for (const [directory, name, dependencies] of [
      ["runtime", "hesperia", { aeolia: "1.0.0-alpha.1" }],
      ["compiler", "@hesperia/compiler", { hesperia: "workspace:*" }],
    ] as const) {
      const packageRoot = join(workspace, "packages", directory);

      await mkdir(join(packageRoot, "dist"), { recursive: true });

      await writeFile(join(packageRoot, "README.md"), `# ${name}\n\nPackage usage instructions.\n`);

      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name,
          repository: {
            type: "git",
            url: "https://github.com/hesperia-js/hesperia.git",
            directory: `packages/${directory}`,
          },
          version,
          type: "module",
          files: ["dist"],
          scripts: { build: "bun build" },
          exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
          dependencies,
        }),
      );

      await writeFile(join(packageRoot, "dist", "index.js"), "export const proof = 'packed';\n");

      await writeFile(
        join(packageRoot, "dist", "index.d.ts"),
        "export declare const proof: 'packed';\n",
      );
    }

    const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [installStatus, installOutput, installError] = await Promise.all([
      install.exited,
      new Response(install.stdout).text(),
      new Response(install.stderr).text(),
    ]);

    if (installStatus !== 0)
      throw new Error(
        `Installing the isolated pack fixture failed\n${installOutput}\n${installError}`,
      );

    const directory = join(workspace, "candidate");

    await prepareReleaseCandidate(workspace, directory);

    const candidate = await readReleaseCandidate(directory);
    const compiler = candidate.packages.find((package_) => package_.name === "@hesperia/compiler")!;

    expect((await packedManifest(join(directory, compiler.file))).dependencies).toEqual({
      hesperia: version,
    });

    expect(Buffer.from(await packedFile(join(directory, compiler.file), "README.md"))).toEqual(
      await readFile(join(workspace, "packages/compiler/README.md")),
    );

    const manifestPath = join(directory, "manifest.json");

    await writeFile(manifestPath, JSON.stringify({ ...candidate, channel: "latest" }));

    await expect(verifyReleaseCandidate(workspace, directory)).rejects.toThrow("channel differs");

    await writeFile(manifestPath, JSON.stringify({ ...candidate, commit: "b".repeat(40) }));

    await expect(verifyReleaseCandidate(workspace, directory)).rejects.toThrow("commit differs");

    await writeFile(
      manifestPath,
      JSON.stringify({ ...candidate, packages: [...candidate.packages].reverse() }),
    );

    await expect(verifyReleaseCandidate(workspace, directory)).rejects.toThrow(
      "dependency order differs",
    );

    const archive = join(directory, compiler.file);
    const originalArchive = await readFile(archive);
    const unpacked = join(workspace, "unpacked");
    const invalidFiles = [
      { file: "README.md", content: undefined, error: "Cannot read packed file README.md" },
      { file: "README.md", content: " \n", error: "archive README is empty" },
      { file: "README.md", content: "# Another package\n", error: "archive README differs" },
      ...releaseNotices.flatMap((file) => [
        { file, content: undefined, error: `Cannot read packed file ${file}` },
        { file, content: "Changed license notice\n", error: `archive notice differs: ${file}` },
      ]),
    ];

    await mkdir(unpacked);

    for (const { file, content, error } of invalidFiles) {
      await writeFile(archive, originalArchive);

      await $`tar -xf ${`./${compiler.file}`} -C ../unpacked`.cwd(directory).quiet();

      const filename = join(unpacked, "package", file);

      if (content === undefined) await rm(filename);
      else await writeFile(filename, content);

      await $`${process.execPath} pm pack --filename ${archive} --ignore-scripts`
        .cwd(join(unpacked, "package"))
        .quiet();

      const integrity = archiveIntegrity(await readFile(archive));

      await writeFile(
        manifestPath,
        JSON.stringify({
          ...candidate,
          packages: candidate.packages.map((entry) =>
            entry === compiler ? { ...entry, integrity } : entry,
          ),
        }),
      );

      await expect(verifyReleaseCandidate(workspace, directory)).rejects.toThrow(error);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);
