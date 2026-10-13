import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  inventoryCoverageSources,
  type CoverageArtifact,
} from "../../scripts/ci/coverage-collector.ts";

interface CoverageRunSummary {
  readonly status: "completed" | "failed";
  readonly runId?: string;
  readonly outputDirectory?: string;
  readonly lcovPath?: string;
  readonly seedArtifacts?: number;
  readonly hitArtifacts?: number;
  readonly mergedSources?: number;
  readonly workerInvocations?: number;
  readonly workerAbortedUncaptured?: number;
  readonly error?: string;
}

const repoPath = resolve(import.meta.dir, "../..");
const runsRoot = resolve(repoPath, ".hesperia/coverage/runs");
const launcherPath = resolve(repoPath, "scripts/ci/coverage-owner-launcher.ts");
const runnerPath = resolve(repoPath, "scripts/ci/run-coverage.ts");
const cssOwnerPath = resolve(repoPath, "tests/tooling/css-integrations.test.ts");
const projectWorkerOwnerPath = resolve(repoPath, "tests/tooling/project-worker.test.ts");
const fixtureRoot = resolve(repoPath, "scripts/ci/fixtures");
const bootstrapSources = [
  "scripts/ci/coverage-preload.ts",
  "scripts/ci/coverage-collector.ts",
  "scripts/ci/coverage-inventory.ts",
] as const;
let temporaryRoots: string[] = [];
let runDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    runDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );

  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function parseSummary(stdout: string, stderr: string): CoverageRunSummary | undefined {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/u).reverse();

  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);

      if (
        (value !== null &&
          typeof value === "object" &&
          (value as Record<string, unknown>).status === "completed") ||
        (value !== null &&
          typeof value === "object" &&
          (value as Record<string, unknown>).status === "failed")
      ) {
        return value as CoverageRunSummary;
      }
    } catch {}
  }

  return undefined;
}

function runCoverageOwner(
  ownerPath: string,
  env: Record<string, string | undefined> = {},
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly summary?: CoverageRunSummary;
} {
  const child = spawnSync(process.execPath, [launcherPath, runnerPath, "--", ownerPath], {
    cwd: repoPath,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  const summary = parseSummary(stdout, stderr);

  if (summary?.outputDirectory) {
    const outputDirectory = resolve(summary.outputDirectory);
    const relativeOutputDirectory = relative(runsRoot, outputDirectory);

    if (
      relativeOutputDirectory !== "" &&
      !isAbsolute(relativeOutputDirectory) &&
      !relativeOutputDirectory.startsWith("..") &&
      /^[a-f0-9-]{36}$/u.test(relativeOutputDirectory) &&
      resolve(runsRoot, relativeOutputDirectory) === outputDirectory
    ) {
      runDirectories.push(outputDirectory);
    }
  }

  if (child.error) throw child.error;

  return { status: child.status, stdout, stderr, ...(summary ? { summary } : {}) };
}

function artifactRecords(directory: string): CoverageArtifact[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".json") && entry.name !== "worker-invocations.json",
    )
    .map(
      (entry) => JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as CoverageArtifact,
    );
}

function lcovCount(record: string, name: "LH" | "FNH"): number {
  const match = record.match(new RegExp(`^${name}:(\\d+)$`, "mu"));
  return match ? Number(match[1]) : 0;
}

test("coverage runner captures each compiled project worker process under its own source identity", () => {
  const result = runCoverageOwner(projectWorkerOwnerPath);

  expect(result.status, result.stdout + result.stderr).toBe(0);

  const summary = result.summary;

  if (
    !summary ||
    summary.status !== "completed" ||
    !summary.outputDirectory ||
    !summary.lcovPath ||
    summary.workerInvocations === undefined ||
    summary.workerAbortedUncaptured === undefined
  ) {
    throw new Error(`Project worker coverage did not complete: ${result.stdout}\n${result.stderr}`);
  }

  const receipt = JSON.parse(
    readFileSync(join(summary.outputDirectory, "worker-invocations.json"), "utf8"),
  ) as {
    untrackedSpawnCount: number;
    invocations: {
      invocationId: string;
      ownerId: string;
      childPid: number;
      seedArtifact: string;
      exitCode: number;
      terminationObserved: boolean;
      preTerminationKillCount: number;
      postTerminationKillCount: number;
      abortErrorObserved: boolean;
    }[];
  };

  expect(receipt.untrackedSpawnCount).toBe(0);

  expect(receipt.invocations).toHaveLength(8);

  expect(receipt.invocations.filter((item) => item.exitCode === 0)).toHaveLength(6);

  expect(
    receipt.invocations.filter(
      (item) =>
        item.exitCode === 1 && !item.abortErrorObserved && item.preTerminationKillCount === 0,
    ),
  ).toHaveLength(1);

  const abortedInvocations = receipt.invocations.filter((item) => item.abortErrorObserved);

  expect(abortedInvocations).toHaveLength(1);

  expect(abortedInvocations[0]!.exitCode).toBe(143);

  expect(abortedInvocations[0]!.preTerminationKillCount).toBe(1);

  expect(abortedInvocations[0]!.postTerminationKillCount).toBe(1);

  expect(abortedInvocations[0]!.terminationObserved).toBe(true);

  expect(receipt.invocations.length).toBe(summary.workerInvocations);

  expect(new Set(receipt.invocations.map((item) => item.ownerId)).size).toBe(
    receipt.invocations.length,
  );

  expect(receipt.invocations.every((item) => item.childPid > 0)).toBe(true);

  expect(receipt.invocations.some((item) => item.preTerminationKillCount > 0)).toBe(true);

  const artifacts = artifactRecords(summary.outputDirectory);
  const population = artifacts.find((artifact) => artifact.kind === "seed" && artifact.population);

  if (!population)
    throw new Error("Project worker run omitted the canonical Bun source population");

  const driverSupportHits = artifacts.filter(
    (artifact) => artifact.ownerId === "bun-tests-driver" && artifact.kind === "hits",
  );

  expect(driverSupportHits).toHaveLength(1);

  const workerBuildSupport = Object.values(driverSupportHits[0]!.coverage).find((file) =>
    file.path.replaceAll("\\", "/").endsWith("/scripts/ci/coverage-worker-build.ts"),
  );

  expect(workerBuildSupport).toBeDefined();

  expect(Object.values(workerBuildSupport!.f).some((count) => count > 0)).toBe(true);

  const workerInvocations = receipt.invocations;
  let uncapturedAborts = 0;
  const completedCoverage: CoverageArtifact["coverage"][] = [];

  for (const invocation of workerInvocations) {
    const seed = artifacts.find(
      (artifact) => artifact.ownerId === invocation.ownerId && artifact.kind === "seed",
    );

    expect(seed).toBeDefined();

    expect(seed!.populationFingerprint).toBe(population.populationFingerprint);

    expect(readFileSync(join(summary.outputDirectory, invocation.seedArtifact), "utf8")).toContain(
      invocation.ownerId,
    );

    const hits = artifacts.filter(
      (artifact) => artifact.ownerId === invocation.ownerId && artifact.kind === "hits",
    );
    const aborted =
      invocation.preTerminationKillCount > 0 &&
      invocation.abortErrorObserved &&
      invocation.exitCode !== 0 &&
      invocation.exitCode !== 1;

    if (!aborted) expect(hits).toHaveLength(1);
    else expect(hits.length).toBeLessThanOrEqual(1);

    if (hits.length === 0) {
      uncapturedAborts++;
      continue;
    }

    expect(hits[0]!.populationFingerprint).toBe(population.populationFingerprint);

    if (!aborted) {
      const workerEntry = Object.entries(hits[0]!.coverage).find(([path]) =>
        path.replaceAll("\\", "/").endsWith("/packages/tooling/src/project-worker.ts"),
      )?.[1];

      expect(workerEntry).toBeDefined();

      expect(Object.values(workerEntry!.s).some((count) => count > 0)).toBe(true);

      expect(Object.values(workerEntry!.f).some((count) => count > 0)).toBe(true);

      completedCoverage.push(hits[0]!.coverage);
    }
  }

  expect(summary.workerAbortedUncaptured).toBe(uncapturedAborts);

  for (const packageName of ["tooling", "compiler", "hosting"] as const) {
    expect(
      completedCoverage.some((coverage) =>
        Object.entries(coverage).some(([path, file]) => {
          if (!path.replaceAll("\\", "/").includes(`/packages/${packageName}/src/`)) return false;

          return (
            Object.values(file.s).some((count) => count > 0) ||
            Object.values(file.f).some((count) => count > 0) ||
            Object.values(file.b).some((counts) => counts.some((count) => count > 0))
          );
        }),
      ),
    ).toBe(true);
  }

  const workerLcov = readFileSync(summary.lcovPath, "utf8")
    .replaceAll("\\", "/")
    .split("end_of_record")
    .find((record) =>
      record.split(/\r?\n/u).some((line) => line === "SF:packages/tooling/src/project-worker.ts"),
    );

  expect(workerLcov).toBeDefined();

  expect(lcovCount(workerLcov ?? "", "LH")).toBeGreaterThan(0);

  expect(lcovCount(workerLcov ?? "", "FNH")).toBeGreaterThan(0);
}, 150_000);

test("a fresh launcher Bun run captures CSS and driver sources into the full current inventory", async () => {
  const inheritedOutput = await mkdtemp(join(tmpdir(), "hesperia-coverage-stale-output-"));

  temporaryRoots.push(inheritedOutput);

  const staleMarker = join(inheritedOutput, "previous-run.json");

  await writeFile(staleMarker, JSON.stringify({ runId: "previous-run" }));

  const inheritedRunId = "inherited-stale-run";
  const result = runCoverageOwner(cssOwnerPath, {
    HESPERIA_COVERAGE_RUN_ID: inheritedRunId,
    HESPERIA_COVERAGE_OUTPUT_DIR: inheritedOutput,
  });

  expect(result.status, result.stdout + result.stderr).toBe(0);

  expect(result.summary?.status).toBe("completed");

  const summary = result.summary;

  if (
    !summary ||
    summary.status !== "completed" ||
    !summary.runId ||
    !summary.outputDirectory ||
    !summary.lcovPath ||
    summary.seedArtifacts === undefined ||
    summary.hitArtifacts === undefined ||
    summary.mergedSources === undefined
  ) {
    throw new Error("Coverage runner did not return a complete success summary");
  }

  expect(summary.runId).toMatch(/^[a-f0-9-]{36}$/u);

  expect(summary.runId).not.toBe(inheritedRunId);

  expect(resolve(summary.outputDirectory!)).not.toBe(resolve(inheritedOutput));

  expect(resolve(summary.outputDirectory!).startsWith(runsRoot)).toBe(true);

  expect(await readFile(staleMarker, "utf8")).toBe(JSON.stringify({ runId: "previous-run" }));

  const expectedSources = inventoryCoverageSources(repoPath);

  expect(summary.mergedSources).toBe(expectedSources.length);

  expect(summary.seedArtifacts).toBeGreaterThan(0);

  expect(summary.hitArtifacts).toBeGreaterThan(0);

  const artifacts = artifactRecords(summary.outputDirectory!);
  const seeds = artifacts.filter((artifact) => artifact.kind === "seed");
  const hits = artifacts.filter((artifact) => artifact.kind === "hits");

  expect(seeds.length).toBe(summary.seedArtifacts);

  expect(hits.length).toBe(summary.hitArtifacts);

  const canonicalSeed = seeds.find((artifact) => artifact.population !== undefined);

  if (!canonicalSeed) throw new Error("Bun owner omitted its full-inventory seed");

  expect(canonicalSeed.population!.files.map((file) => file.source)).toStrictEqual([
    ...expectedSources,
  ]);

  expect(Object.keys(canonicalSeed.coverage)).toHaveLength(expectedSources.length);

  for (const source of Object.values(canonicalSeed.coverage)) {
    expect(Object.values(source.s).every((count) => count === 0)).toBe(true);

    expect(Object.values(source.f).every((count) => count === 0)).toBe(true);

    expect(
      Object.values(source.b)
        .flat()
        .every((count) => count === 0),
    ).toBe(true);
  }

  for (const artifact of artifacts) {
    expect(artifact.runId).toBe(summary.runId);

    expect(["bun-tests", "bun-tests-driver"]).toContain(artifact.ownerId);
  }

  const driverSupport = hits.filter((artifact) => artifact.ownerId === "bun-tests-driver");

  expect(driverSupport).toHaveLength(1);

  const requiredDriverSources = [
    "scripts/ci/run-coverage.ts",
    "scripts/ci/coverage-owner-launcher.ts",
    "scripts/ci/coverage-collector.ts",
    "scripts/ci/coverage-inventory.ts",
  ];
  const preparedDriverSources = [...requiredDriverSources, "scripts/ci/coverage-worker-build.ts"];

  for (const source of preparedDriverSources) {
    const authoredPath = resolve(repoPath, source.replaceAll("/", sep));
    const file = Object.values(driverSupport[0]!.coverage).find(
      (entry) => resolve(entry.path) === authoredPath,
    );

    expect(file, `driver support omitted ${source}`).toBeDefined();

    const map = file!.inputSourceMap;

    expect(map?.sources).toHaveLength(1);

    expect(resolve(dirname(file!.path), map!.sourceRoot ?? "", map!.sources[0]!)).toBe(
      authoredPath,
    );

    if (requiredDriverSources.includes(source)) {
      expect(
        Object.values(file!.s).some((count) => count > 0) ||
          Object.values(file!.f).some((count) => count > 0) ||
          Object.values(file!.b).some((counts) => counts.some((count) => count > 0)),
      ).toBe(true);
    }
  }

  const bootstrapHitArtifact = hits.find(
    (artifact) =>
      artifact.ownerId === "bun-tests" &&
      bootstrapSources.every((source) => {
        const authoredPath = resolve(repoPath, source.replaceAll("/", sep));
        return Object.values(artifact.coverage).some((file) => {
          if (resolve(file.path) !== authoredPath || !file.inputSourceMap) return false;

          const mappedSource = file.inputSourceMap.sources[0];

          if (typeof mappedSource !== "string") return false;

          return (
            resolve(dirname(file.path), file.inputSourceMap.sourceRoot ?? "", mappedSource) ===
              authoredPath &&
            (Object.values(file.s).some((count) => count > 0) ||
              Object.values(file.f).some((count) => count > 0) ||
              Object.values(file.b).some((counts) => counts.some((count) => count > 0)))
          );
        });
      }),
  );

  expect(bootstrapHitArtifact).toBeDefined();

  if (!bootstrapHitArtifact) throw new Error("Bun owner omitted bootstrap source hits");

  for (const source of bootstrapSources) {
    const authoredPath = resolve(repoPath, source.replaceAll("/", sep));
    const file = Object.values(bootstrapHitArtifact.coverage).find(
      (entry) => resolve(entry.path) === authoredPath,
    );

    expect(file).toBeDefined();

    const map = file!.inputSourceMap;

    expect(map?.sources).toHaveLength(1);

    expect(resolve(dirname(file!.path), map!.sourceRoot ?? "", map!.sources[0]!)).toBe(
      authoredPath,
    );

    expect(
      Object.values(file!.s).some((count) => count > 0) ||
        Object.values(file!.f).some((count) => count > 0) ||
        Object.values(file!.b).some((counts) => counts.some((count) => count > 0)),
    ).toBe(true);
  }

  const outputNames = readdirSync(summary.outputDirectory!);

  expect(outputNames).toContain("lcov.info");

  expect(
    outputNames.every(
      (name) =>
        name === "lcov.info" || (name.startsWith(`${summary.runId}-`) && name.endsWith(".json")),
    ),
  ).toBe(true);

  const bootstrapReceipt = outputNames.find((name) =>
    new RegExp(
      `^${summary.runId}-bun-tests-coverage-runner-hits-(\\d+)-(\\d+)-[a-f0-9-]{36}\\.json$`,
      "u",
    ).test(name),
  );

  expect(bootstrapReceipt).toBeDefined();

  const receiptIdentity = bootstrapReceipt?.match(/-(\d+)-(\d+)-[a-f0-9-]{36}\.json$/u);

  expect(receiptIdentity).toBeDefined();

  expect(Number(receiptIdentity?.[1])).toBeGreaterThan(0);

  expect(Number(receiptIdentity?.[1])).not.toBe(process.pid);

  expect(Number(receiptIdentity?.[2])).toBeGreaterThanOrEqual(0);

  const lcov = await readFile(summary.lcovPath!, "utf8");

  for (const source of bootstrapSources) {
    const record = lcov
      .replaceAll("\\", "/")
      .split("end_of_record")
      .find((entry) => entry.split(/\r?\n/u).some((line) => line === `SF:${source}`));

    expect(record).toBeDefined();

    expect(lcovCount(record ?? "", "LH")).toBeGreaterThan(0);

    expect(lcovCount(record ?? "", "FNH")).toBeGreaterThan(0);
  }

  const cssRecord = lcov.split("end_of_record").find((record) =>
    record.split(/\r?\n/u).some((line) => {
      if (!line.startsWith("SF:")) return false;

      const source = line.slice(3).replaceAll("\\", "/");
      return (
        source === "packages/tooling/src/css-bundling.ts" ||
        source.endsWith("/packages/tooling/src/css-bundling.ts")
      );
    }),
  );

  expect(cssRecord).toBeDefined();

  expect(lcovCount(cssRecord!, "LH")).toBeGreaterThan(0);

  expect(lcovCount(cssRecord!, "FNH")).toBeGreaterThan(0);
}, 150_000);

test("a launched Bun run refuses LCOV when bootstrap source hits are missing", () => {
  const result = runCoverageOwner(join(fixtureRoot, "coverage-owner-bootstrap-missing.test.ts"));

  expect(result.status).not.toBe(0);

  expect(result.summary?.status).toBe("failed");

  expect(result.summary?.error).toBe(
    "Coverage bootstrap authored-source hit is missing: scripts/ci/coverage-preload.ts",
  );

  expect(existsSync(join(result.summary!.outputDirectory!, "lcov.info"))).toBe(false);
}, 150_000);

test("a failing Bun owner does not produce a merged coverage report", () => {
  const result = runCoverageOwner(join(fixtureRoot, "coverage-owner-failure.test.ts"));

  expect(result.status).not.toBe(0);

  expect(result.summary?.status).toBe("failed");

  expect(result.summary?.error).toContain("Bun test owner failed");

  expect(existsSync(join(result.summary!.outputDirectory!, "lcov.info"))).toBe(false);

  const runId = result.summary?.runId;

  expect(runId).toBeDefined();

  expect(existsSync(resolve(repoPath, ".hesperia/coverage/bootstrap-builds", runId!))).toBe(false);
}, 150_000);

test("a passing Bun process that skips finalization is rejected for missing artifacts", () => {
  const result = runCoverageOwner(join(fixtureRoot, "coverage-owner-no-artifacts.test.ts"));

  expect(result.status).not.toBe(0);

  expect(result.summary?.status).toBe("failed");

  expect(result.summary?.error).toContain("no coverage artifacts");

  expect(existsSync(join(result.summary!.outputDirectory!, "lcov.info"))).toBe(false);
}, 150_000);

test("malformed artifacts from the current Bun owner are rejected", () => {
  const result = runCoverageOwner(join(fixtureRoot, "coverage-owner-malformed-artifact.test.ts"));

  expect(result.status).not.toBe(0);

  expect(result.summary?.status).toBe("failed");

  expect(result.summary?.error).toContain("Malformed coverage artifact");

  expect(existsSync(join(result.summary!.outputDirectory!, "lcov.info"))).toBe(false);
}, 150_000);

test("artifacts from another run cannot enter the current Bun owner merge", () => {
  const result = runCoverageOwner(join(fixtureRoot, "coverage-owner-stale-artifact.test.ts"));

  expect(result.status).not.toBe(0);

  expect(result.summary?.status).toBe("failed");

  expect(result.summary?.error).toContain("Stale coverage artifact");

  expect(existsSync(join(result.summary!.outputDirectory!, "lcov.info"))).toBe(false);
}, 150_000);
