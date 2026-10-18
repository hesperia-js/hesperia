import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

test("merged candidate preflight rejects a non-advancing first-parent version and still admits a matching partial retry", async () => {
  const root = resolve(import.meta.dir, "../..");
  const previous = await $`git show HEAD^:package.json`.cwd(root).quiet().json();
  const commit = (await $`git rev-parse HEAD`.cwd(root).quiet().text()).trim();

  await mkdir(resolve(root, ".hesperia"), { recursive: true });

  const directory = await mkdtemp(resolve(root, ".hesperia/release-merge-proof-"));

  try {
    await mkdir(resolve(directory, "scripts/ci"), { recursive: true });

    for (const script of [
      "scripts/build-packages.ts",
      "scripts/ci/check-release.ts",
      "scripts/ci/release-candidate.ts",
    ]) {
      await cp(resolve(root, script), resolve(directory, script));
    }

    const candidateDirectory = resolve(directory, "candidate");

    await mkdir(resolve(candidateDirectory, "archives"), { recursive: true });

    const registryMarker = resolve(directory, "registry-reached");
    const preload = resolve(directory, "registry.js");

    await writeFile(
      preload,
      `
      const directory = process.env.HESPERIA_RELEASE_CANDIDATE_DIR;
      const candidate = await Bun.file(directory + '/manifest.json').json();
      globalThis.fetch = Object.assign(async (input) => {
        await Bun.write(${JSON.stringify(registryMarker)}, 'reached');
        if (String(input).endsWith('/dist-tags')) return Response.json({});
        if (String(input).includes('/hesperia/')) {
          const package_ = candidate.packages[0];
          return Response.json({ name: package_.name, version: package_.version, dist: { integrity: package_.integrity } });
        }
        return new Response('missing', { status: 404 });
      }, { preconnect: globalThis.fetch.preconnect });
    `,
    );

    async function run(version: string) {
      const repository = { type: "git", url: "https://github.com/hesperia-js/hesperia.git" };

      await writeFile(
        resolve(directory, "package.json"),
        JSON.stringify({
          name: "release-proof",
          private: true,
          version,
          repository,
          devDependencies: { aeolia: "1.0.0-alpha.1" },
        }),
      );

      const packages = [];

      for (const [folder, name] of [
        ["runtime", "hesperia"],
        ["compiler", "@hesperia/compiler"],
      ] as const) {
        const packageRoot = resolve(directory, "packages", folder);

        await mkdir(packageRoot, { recursive: true });

        await writeFile(
          resolve(packageRoot, "package.json"),
          JSON.stringify({
            name,
            version,
            repository,
            scripts: { build: "bun build" },
            files: ["dist"],
            exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
            dependencies:
              name === "hesperia" ? { aeolia: "1.0.0-alpha.1" } : { hesperia: "workspace:*" },
          }),
        );

        const bytes = Buffer.from(`original ${name} archive`);
        const file = `archives/${folder}.tgz`;

        await writeFile(resolve(candidateDirectory, file), bytes);

        packages.push({
          name,
          version,
          file,
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        });
      }

      const channel = version.includes("-") ? version.split("-")[1]!.split(".")[0]! : "latest";

      await writeFile(
        resolve(candidateDirectory, "manifest.json"),
        JSON.stringify({ schema: 1, version, channel, commit, packages }),
      );

      const child = Bun.spawn(
        [process.execPath, "--preload", preload, resolve(directory, "scripts/ci/check-release.ts")],
        {
          cwd: directory,
          env: {
            ...process.env,
            GITHUB_OUTPUT: undefined,
            HESPERIA_RELEASE_BASE: undefined,
            HESPERIA_RELEASE_CANDIDATE_DIR: candidateDirectory,
            HESPERIA_RELEASE_BRANCH: `release/${version}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { status, stdout, stderr };
    }

    const rejected = await run(previous.version);

    expect(rejected.status).not.toBe(0);

    expect(rejected.stderr).toContain("Release version must advance beyond the PR base");

    expect(existsSync(registryMarker)).toBe(false);

    const next = `${Number(previous.version.split(".")[0]) + 1}.0.0-alpha.1`;
    const retry = await run(next);

    expect(retry.status).toBe(0);

    expect(existsSync(registryMarker)).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
