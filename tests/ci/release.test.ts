import { expect, spyOn, test } from "bun:test";
import {
  releaseVersion,
  validateReleaseManifests,
  verifyChannelAdvance,
  verifyPublishedPackage,
  verifyVersionAdvance,
  preflightPublication,
} from "../../scripts/ci/check-release.ts";

test.each([
  ["1.0.0", "latest"],
  ["1.0.0-alpha.1", "alpha"],
  ["1.0.0-beta.2", "beta"],
  ["1.0.0-rc.3", "rc"],
])("routes %s to the authored release channel", (version, channel) => {
  expect(releaseVersion(version)).toEqual({ version, channel });
});

test.each([
  "v1.0.0",
  "01.0.0",
  "1.0",
  "1.0.0-alpha.01",
  "1.0.0-next.1",
  "1.0.0+local",
  "1.0.0\ntag=evil",
  null,
])("rejects unsupported or unsafe release version (%#)", (value) => {
  expect(() => releaseVersion(value)).toThrow();
});

test("all published workspace packages share the authored branch version and registry dependency boundary", () => {
  const root = {
    name: "hesperia-workspace",
    repository: { type: "git", url: "https://github.com/hesperia-js/hesperia.git" },
    version: "1.0.0-alpha.1",
    private: true,
    devDependencies: { aeolia: "1.0.0-alpha.1" },
  };
  const runtime = {
    name: "hesperia",
    repository: root.repository,
    version: root.version,
    peerDependencies: { aeolia: "1.0.0-alpha.1" },
  };
  const compiler = {
    name: "@hesperia/compiler",
    repository: root.repository,
    version: root.version,
    dependencies: { hesperia: "workspace:*" },
  };

  expect(validateReleaseManifests(root, [runtime, compiler], "release/1.0.0-alpha.1")).toEqual({
    version: root.version,
    channel: "alpha",
    aeolia: "1.0.0-alpha.1",
  });

  expect(() => validateReleaseManifests(root, [runtime, compiler], "release/1.0.0")).toThrow(
    "branch must match",
  );

  expect(() =>
    validateReleaseManifests(root, [
      { ...runtime, repository: { url: "https://github.com/other/repository.git" } },
    ]),
  ).toThrow("publishing repository");

  expect(() => validateReleaseManifests({ ...root, private: false }, [runtime])).toThrow(
    "remain private",
  );

  expect(() =>
    validateReleaseManifests(root, [runtime, { ...compiler, version: "1.0.0" }]),
  ).toThrow("shared release version");

  expect(() =>
    validateReleaseManifests(root, [
      runtime,
      { ...compiler, dependencies: { hesperia: "^1.0.0" } },
    ]),
  ).toThrow("pin internal");

  expect(() =>
    validateReleaseManifests(root, [
      { ...runtime, peerDependencies: { aeolia: "file:../aeolia" } },
    ]),
  ).toThrow("local");

  expect(() =>
    validateReleaseManifests(root, [{ ...runtime, peerDependencies: { aeolia: "1.0.0-alpha.2" } }]),
  ).toThrow("exact workspace Aeolia");

  expect(() =>
    validateReleaseManifests(root, [
      runtime,
      { ...compiler, dependencies: { missing: "workspace:*" } },
    ]),
  ).toThrow("absent workspace");
});

test("authored releases advance from the PR base and never downgrade a publication channel", () => {
  expect(() => verifyVersionAdvance("1.0.0-beta.1", "1.0.0-alpha.1")).not.toThrow();

  expect(() => verifyVersionAdvance("1.0.0-alpha.1", "1.0.0-alpha.1")).toThrow("advance");

  expect(() => verifyVersionAdvance("1.0.0-alpha.1", "1.0.0-beta.1")).toThrow("advance");

  expect(() => verifyChannelAdvance("1.0.0-alpha.2", "1.0.0-alpha.1", "alpha")).not.toThrow();

  expect(() => verifyChannelAdvance("1.0.0", undefined, "latest")).not.toThrow();

  expect(() => verifyChannelAdvance("1.0.0", "1.0.0", "latest")).toThrow("backward");

  expect(() => verifyChannelAdvance("1.0.0-alpha.1", "2.0.0-alpha.1", "alpha")).toThrow("backward");
});

test("partial publication retries require the same package identity and exact archive bytes", () => {
  const package_ = {
    name: "@hesperia/tooling",
    version: "1.0.0-alpha.1",
    file: "archives/tooling.tgz",
    integrity: "sha512-tested",
  };
  const metadata = {
    name: package_.name,
    version: package_.version,
    dist: { integrity: package_.integrity },
  };

  expect(() => verifyPublishedPackage(metadata, package_)).not.toThrow();

  expect(() => verifyPublishedPackage({ ...metadata, name: "hesperia" }, package_)).toThrow(
    "identity differs",
  );

  expect(() => verifyPublishedPackage({ ...metadata, version: "1.0.0-alpha.2" }, package_)).toThrow(
    "identity differs",
  );

  expect(() =>
    verifyPublishedPackage({ ...metadata, dist: { integrity: "sha512-rebuilt" } }, package_),
  ).toThrow("archive differs");
});

test("the whole candidate is preflighted before a partial retry can publish any missing package", async () => {
  const candidate = {
    schema: 1 as const,
    version: "1.0.0-alpha.1",
    channel: "alpha",
    commit: "a".repeat(40),
    packages: [
      {
        name: "hesperia",
        version: "1.0.0-alpha.1",
        file: "archives/runtime.tgz",
        integrity: "sha512-runtime",
      },
      {
        name: "@hesperia/compiler",
        version: "1.0.0-alpha.1",
        file: "archives/compiler.tgz",
        integrity: "sha512-compiler",
      },
    ],
  };
  let changedExisting = false;
  let registryFailure = false;
  const registry = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);

        if (registryFailure) return new Response("registry unavailable", { status: 503 });

        if (url.endsWith("/hesperia/1.0.0-alpha.1"))
          return new Response("missing", { status: 404 });

        if (url.endsWith("/dist-tags")) return Response.json({ alpha: "1.0.0-alpha.0" });

        return Response.json({
          name: "@hesperia/compiler",
          version: "1.0.0-alpha.1",
          dist: { integrity: changedExisting ? "sha512-other" : "sha512-compiler" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  try {
    expect(await preflightPublication(candidate)).toEqual([candidate.packages[0]!]);

    changedExisting = true;

    await expect(preflightPublication(candidate)).rejects.toThrow("archive differs");

    registryFailure = true;

    await expect(preflightPublication(candidate)).rejects.toThrow("HTTP 503");
  } finally {
    registry.mockRestore();
  }
});
