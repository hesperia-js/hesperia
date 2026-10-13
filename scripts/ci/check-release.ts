import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { discoverPackageBuildPlan } from "../build-packages.ts";
import { readReleaseCandidate, type ReleaseCandidate } from "./release-candidate.ts";

export function releaseVersion(value: unknown) {
  assert.ok(typeof value === "string", "package.json must contain a version");

  const match =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(alpha|beta|rc)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/.exec(
      value,
    );

  assert.ok(
    match,
    `Expected a stable, alpha, beta, or rc version without build metadata: ${value}`,
  );

  return { version: value, channel: match[1] ?? "latest" };
}

type Manifest = { name: string; version: string; private?: boolean } & Record<string, unknown>;

const sections = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/** Validate the authored shared version and dependency boundary before packing or publication. */
export function validateReleaseManifests(
  root: Manifest,
  packages: readonly Manifest[],
  branch?: string,
) {
  assert.equal(root.private, true, "The workspace root must remain private");

  const release = releaseVersion(root.version);
  const repository = root.repository as { url?: unknown } | undefined;

  assert.ok(
    typeof repository?.url === "string",
    "The workspace must identify its publishing repository",
  );

  if (branch !== undefined)
    assert.equal(
      branch,
      `release/${release.version}`,
      "Release branch must match the shared package version",
    );

  assert.ok(packages.length > 0, "No publishable packages found");

  const names = new Set(packages.map((package_) => package_.name));

  assert.equal(names.size, packages.length, "Duplicate public package name");

  const aeolia = (root.devDependencies as Record<string, string> | undefined)?.aeolia;

  assert.ok(typeof aeolia === "string", "The workspace must pin Aeolia");

  releaseVersion(aeolia);

  for (const package_ of packages) {
    assert.notEqual(package_.private, true, `${package_.name} must be public`);

    assert.equal(
      (package_.repository as { url?: unknown } | undefined)?.url,
      repository.url,
      `${package_.name} must identify the workspace publishing repository`,
    );

    assert.equal(
      package_.version,
      release.version,
      `${package_.name} must use the shared release version`,
    );

    for (const section of sections) {
      const dependencies = package_[section] as Record<string, string> | undefined;

      for (const [name, value] of Object.entries(dependencies ?? {})) {
        assert.equal(typeof value, "string", `${package_.name} has an invalid ${section} entry`);

        assert.ok(
          !/^(file:|link:|\.\.?[/\\])/.test(value),
          `${package_.name} has a local ${section} dependency on ${name}`,
        );

        if (names.has(name))
          assert.ok(
            value === "workspace:*" || value === release.version,
            `${package_.name} must pin internal ${name} to the shared version`,
          );
        else
          assert.ok(
            !value.startsWith("workspace:"),
            `${package_.name} depends on absent workspace package ${name}`,
          );

        if (name === "aeolia")
          assert.equal(
            value,
            aeolia,
            `${package_.name} must use the exact workspace Aeolia version`,
          );
      }
    }
  }

  return { ...release, aeolia };
}

export async function releaseWorkspace(workspaceRoot: string, branch?: string) {
  const root = JSON.parse(
    await readFile(resolve(workspaceRoot, "package.json"), "utf8"),
  ) as Manifest;
  const plan = await discoverPackageBuildPlan(workspaceRoot);
  const packages = await Promise.all(
    plan.map(
      async (target) =>
        JSON.parse(await readFile(resolve(target.packageRoot, "package.json"), "utf8")) as Manifest,
    ),
  );
  return { ...validateReleaseManifests(root, packages, branch), plan, packages };
}

/** Refuse a registry version whose identity or bytes differ from this tested candidate. */
export function verifyPublishedPackage(
  metadata: unknown,
  package_: ReleaseCandidate["packages"][number],
) {
  const value = metadata as {
    name?: string;
    version?: string;
    dist?: { integrity?: string };
  } | null;

  assert.ok(
    value?.name === package_.name && value.version === package_.version,
    "Published package identity differs",
  );

  assert.equal(
    value.dist?.integrity,
    package_.integrity,
    `Published archive differs from the tested archive for ${package_.name}`,
  );
}

/** Publishing a missing version may advance a channel but must never move it backward. */
export function verifyChannelAdvance(version: string, current: unknown, channel: string) {
  if (current === undefined) return;

  assert.ok(
    typeof current === "string" && Bun.semver.order(version, current) > 0,
    `Refusing to move ${channel} backward from ${String(current)}`,
  );
}

/** Authored release versions must advance beyond the release PR's base. */
export function verifyVersionAdvance(version: string, previous: string) {
  releaseVersion(version);

  assert.ok(
    Bun.semver.order(version, previous) > 0,
    "Release version must advance beyond the PR base",
  );
}

async function registryJson(path: string): Promise<unknown | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${path}`, {
    signal: AbortSignal.timeout(30_000),
  });

  assert.ok(
    response.ok || response.status === 404,
    `npm registry returned HTTP ${response.status}`,
  );

  return response.status === 404 ? undefined : response.json();
}

/** Preflight every archive before the first irreversible npm operation. */
export async function preflightPublication(candidate: ReleaseCandidate) {
  assert.equal(
    releaseVersion(candidate.version).channel,
    candidate.channel,
    "Candidate channel differs from version",
  );

  const pending: ReleaseCandidate["packages"] = [];

  for (const package_ of candidate.packages) {
    const metadata = await registryJson(`${encodeURIComponent(package_.name)}/${package_.version}`);

    if (metadata !== undefined) verifyPublishedPackage(metadata, package_);
    else {
      const tags = (await registryJson(
        `-/package/${encodeURIComponent(package_.name)}/dist-tags`,
      )) as Record<string, unknown> | undefined;

      verifyChannelAdvance(candidate.version, tags?.[candidate.channel], candidate.channel);

      pending.push(package_);
    }
  }

  return pending;
}

async function checkRelease() {
  const root = resolve(import.meta.dir, "../..");
  const base = process.env.HESPERIA_RELEASE_BASE;
  const candidateDirectory = process.env.HESPERIA_RELEASE_CANDIDATE_DIR;

  assert.ok(
    Boolean(base) !== Boolean(candidateDirectory),
    "Supply a PR base or a tested candidate directory",
  );

  const release = await releaseWorkspace(root, process.env.HESPERIA_RELEASE_BRANCH);
  let published = false;
  let anyPublished = false;

  if (base) {
    assert.match(base, /^[a-f0-9]{40}$/, "Expected the release PR base commit SHA");

    const previous = await $`git show ${`${base}:package.json`}`.cwd(root).quiet().json();

    verifyVersionAdvance(release.version, previous.version);

    for (const package_ of release.packages) {
      assert.equal(
        await registryJson(`${encodeURIComponent(package_.name)}/${release.version}`),
        undefined,
        `${package_.name}@${release.version} is already published`,
      );
    }
  } else {
    const previous = await $`git show HEAD^:package.json`.cwd(root).quiet().json();

    verifyVersionAdvance(release.version, previous.version);

    const candidate = await readReleaseCandidate(candidateDirectory!);

    assert.equal(candidate.version, release.version, "Candidate release version differs");

    assert.equal(
      candidate.commit,
      (await $`git rev-parse HEAD`.cwd(root).quiet().text()).trim(),
      "Candidate commit differs from checkout",
    );

    assert.equal(candidate.channel, release.channel, "Candidate release channel differs");

    assert.deepEqual(
      candidate.packages.map((package_) => package_.name),
      release.plan.map((target) => target.name),
      "Candidate package inventory or dependency order differs",
    );

    const pending = await preflightPublication(candidate);
    published = pending.length === 0;
    anyPublished = pending.length < candidate.packages.length;
  }

  const outputs = {
    version: release.version,
    channel: release.channel,
    published: String(published),
    "any-published": String(anyPublished),
  };

  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );

  console.log(outputs);
}

if (import.meta.main) await checkRelease();
