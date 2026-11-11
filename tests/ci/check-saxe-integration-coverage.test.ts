import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkSaxeIntegrationCoverage } from "../../scripts/ci/check-saxe-integration-coverage.ts";
import {
  createCoverageArtifact,
  inventoryCoverageSources,
  mergeCoverageArtifacts,
  seedCoverageSources,
  writeCoverageFragment,
  writeLcovReport,
  type CoverageFile,
} from "../../scripts/ci/coverage-collector.ts";

const integrationTestPath = "tests/tooling/builtin-assets.test.ts";
const supportedSaxeFiles = [
  "packages/tooling/src/vendor/saxe/namespace.ts",
  "packages/tooling/src/vendor/saxe/parser.ts",
  "packages/tooling/src/vendor/saxe/chars.ts",
  "packages/tooling/src/vendor/saxe/xml_decl.ts",
  "packages/tooling/src/vendor/saxe/error.ts",
] as const;
const closureSaxeFiles = [
  ...supportedSaxeFiles,
  "packages/tooling/src/vendor/saxe/index.ts",
] as const;
const fixtureGitIdentity = [
  "-c",
  "user.name=Hesperia Coverage Fixture",
  "-c",
  "user.email=coverage-fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
] as const;

let roots: string[] = [];

interface CaptureFixture {
  readonly root: string;
  readonly runRoot: string;
  readonly inputsPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly inputs: Record<string, unknown>;
  readonly runId: string;
  readonly candidate: string;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(root: string, args: readonly string[]): string {
  const hooksPath = join(root, ".hesperia", "disabled-hooks").replaceAll("\\", "/");
  const result = Bun.spawnSync({
    cmd: ["git", "-c", `core.hooksPath=${hooksPath}`, ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`Git fixture command failed: ${new TextDecoder().decode(result.stderr)}`);
  }

  return new TextDecoder().decode(result.stdout).trim();
}

function commitFixtureChanges(root: string, message: string): string {
  git(root, [...fixtureGitIdentity, "add", "--all"]);

  git(root, [...fixtureGitIdentity, "commit", "--quiet", "-m", message]);

  return git(root, ["rev-parse", "HEAD"]);
}

async function writeFixtureFile(root: string, path: string, contents: string): Promise<void> {
  const absolutePath = join(root, ...path.split(/[\\/]/u));

  await mkdir(dirname(absolutePath), { recursive: true });

  await writeFile(absolutePath, contents);
}

function sourceFor(name: string): string {
  return [
    `export const ${name}First = 1; export const ${name}AlsoFirst = 3;`,
    `export const ${name}Second = 2;`,
    "",
  ].join("\n");
}

function createHitCoverage(
  root: string,
  seededCoverage: Record<string, CoverageFile>,
  requestedHits: number,
): Record<string, CoverageFile> {
  const result: Record<string, CoverageFile> = {};
  let remaining = requestedHits;

  for (const source of supportedSaxeFiles) {
    if (remaining === 0) break;

    const path = resolve(root, ...source.split("/"));
    const seed = seededCoverage[path];

    if (!seed) throw new Error(`Coverage fixture omitted ${source}`);

    const statementsByLine = new Map<number, string>();

    for (const [statement, location] of Object.entries(seed.statementMap).sort(
      ([, left], [, right]) => left.start.line - right.start.line,
    )) {
      if (!statementsByLine.has(location.start.line)) {
        statementsByLine.set(location.start.line, statement);
      }
    }

    const statementHits = { ...seed.s };
    let sourceHits = 0;

    for (const statement of statementsByLine.values()) {
      if (remaining === 0) break;

      statementHits[statement] = 1;
      remaining -= 1;
      sourceHits += 1;
    }

    if (sourceHits > 0) result[path] = { ...seed, s: statementHits };
  }

  if (remaining !== 0) throw new Error(`Coverage fixture could not set ${requestedHits} hit lines`);

  return result;
}

async function createCaptureFixture(
  requestedHits: number,
  indexSource = "export {};\n",
  tempRoot = tmpdir(),
): Promise<CaptureFixture> {
  const root = await mkdtemp(join(tempRoot, "hesperia-saxe-integration-coverage-"));

  roots.push(root);

  await writeFixtureFile(root, ".gitignore", ".hesperia/\n");

  await mkdir(join(root, ".hesperia", "disabled-hooks"), { recursive: true });

  await writeFixtureFile(root, "bun.lock", "fixture lock input\n");

  await writeFixtureFile(
    root,
    "scripts/ci/check-saxe-integration-coverage.ts",
    "export const gateSource = true;\n",
  );

  await writeFixtureFile(
    root,
    integrationTestPath,
    'test("typed SVG import projects checked source", () => {});\n',
  );

  for (const source of closureSaxeFiles) {
    if (source.endsWith("/index.ts")) {
      await writeFixtureFile(root, source, indexSource);

      continue;
    }

    const name = source
      .split("/")
      .at(-1)!
      .replace(/\.ts$/u, "")
      .replaceAll(/[^a-z0-9]/giu, "");

    await writeFixtureFile(root, source, sourceFor(name));
  }

  git(root, ["init", "--quiet"]);

  const candidate = commitFixtureChanges(root, "coverage fixture");
  const sources = inventoryCoverageSources(root);
  const seeded = await seedCoverageSources(sources, root);
  const runId = randomUUID();
  const runRoot = join(root, ".hesperia", "coverage", "runs", runId);
  const seedArtifact = createCoverageArtifact({
    repoPath: root,
    kind: "seed",
    runId,
    ownerId: "bun-tests",
    populationFingerprint: seeded.population.fingerprint,
    population: seeded.population,
    coverage: seeded.coverage,
  });
  const hitArtifact = createCoverageArtifact({
    repoPath: root,
    kind: "hits",
    runId,
    ownerId: "bun-tests",
    populationFingerprint: seeded.population.fingerprint,
    sourcePopulation: seeded.population,
    coverage: createHitCoverage(root, seeded.coverage, requestedHits),
  });

  await writeCoverageFragment({
    directory: runRoot,
    contextId: "coverage-runner-seed",
    pid: process.pid,
    threadId: 0,
    repoPath: root,
    artifact: seedArtifact,
    sourcePopulation: seeded.population,
  });

  await writeCoverageFragment({
    directory: runRoot,
    contextId: "coverage-runner-hits",
    pid: process.pid,
    threadId: 0,
    repoPath: root,
    artifact: hitArtifact,
    sourcePopulation: seeded.population,
  });

  const merged = await mergeCoverageArtifacts({
    repoPath: root,
    expectedSources: sources,
    seeds: [seedArtifact],
    fragments: [hitArtifact],
  });
  const lcovPath = join(runRoot, "lcov.info");

  writeLcovReport(merged, lcovPath, root);

  const stdoutPath = join(root, ".hesperia", "coverage", "capture", runId, "stdout.log");
  const stderrPath = join(root, ".hesperia", "coverage", "capture", runId, "stderr.log");
  const inputsPath = join(root, ".hesperia", "coverage", "capture", runId, "capture-inputs.json");
  const stdout =
    JSON.stringify({
      status: "completed",
      runId,
      ownerId: "bun-tests",
      outputDirectory: runRoot,
      lcovPath,
      seedArtifacts: 1,
      hitArtifacts: 1,
      mergedSources: seeded.population.files.length,
    }) + "\n";
  const stderr = "bun test fixture completed\n";

  await mkdir(dirname(inputsPath), { recursive: true });

  await writeFile(stdoutPath, stdout);

  await writeFile(stderrPath, stderr);

  const artifactEntries = await readdir(runRoot);
  const artifacts = await Promise.all(
    artifactEntries.sort().map(async (name) => ({
      name,
      sha256: sha256(await readFile(join(runRoot, name))),
    })),
  );
  const testHash = sha256(await readFile(join(root, ...integrationTestPath.split("/"))));
  const classification = {
    schema: 1,
    supportedFiles: supportedSaxeFiles,
    exclusions: [],
  };
  const inputs: Record<string, unknown> = {
    format: "hesperia-saxe-integration-capture-inputs",
    version: 1,
    candidate,
    lockSha256: sha256(await readFile(join(root, "bun.lock"))),
    testInputs: [{ path: integrationTestPath, sha256: testHash }],
    execution: {
      command: ["bun", "run", "scripts/ci/run-coverage.ts", integrationTestPath],
      testPaths: [integrationTestPath],
      exitCode: 0,
      runId,
      ownerId: "bun-tests",
      platform: process.platform,
      runtime: { name: "bun", version: process.versions.bun },
      stdout: { file: "stdout.log", sha256: sha256(stdout) },
      stderr: { file: "stderr.log", sha256: sha256(stderr) },
    },
    populationFingerprint: seeded.population.fingerprint,
    classification: {
      ...classification,
      sha256: sha256(JSON.stringify(classification)),
    },
    artifacts,
  };

  await writeFile(inputsPath, JSON.stringify(inputs));

  return { root, runRoot, inputsPath, stdoutPath, stderrPath, inputs, runId, candidate };
}

function checkerOptions(fixture: CaptureFixture) {
  return { repoPath: fixture.root, runRoot: fixture.runRoot, inputsPath: fixture.inputsPath };
}

async function writeInputs(
  fixture: CaptureFixture,
  inputs: Record<string, unknown>,
): Promise<void> {
  await writeFile(fixture.inputsPath, JSON.stringify(inputs));
}

test("counts zero-hit supported lines and keeps the full six-file closure", async () => {
  const fixture = await createCaptureFixture(7, "export const indexValue = 1;\n");

  const report = await checkSaxeIntegrationCoverage(checkerOptions(fixture));

  expect(report.status).toBe("passed");

  expect(report.supportedFive.totals.lineHit).toBe(7);

  expect(report.supportedFive.totals.lineFound).toBe(10);

  expect(report.supportedFive.totals.linePercent).toBe(70);

  const firstFileLines = report.supportedFive.files.find(
    (file) => file.path === supportedSaxeFiles[0],
  )!.lines;

  expect(firstFileLines).toStrictEqual({
    hit: 2,
    found: 2,
    percent: 100,
    uncovered: [],
  });

  expect(report.supportedFive.straightforwardAimMet).toBe(false);

  expect(report.unfilteredFiveTotals).toStrictEqual(report.supportedFive.totals);

  expect(report.supportedFive.files.map((file) => file.path)).toStrictEqual([
    ...supportedSaxeFiles,
  ]);

  const unsupportedHits = report.supportedFive.files.find((file) =>
    file.path.endsWith("/error.ts"),
  )!;

  expect(unsupportedHits.lines).toStrictEqual({
    hit: 0,
    found: 2,
    percent: 0,
    uncovered: [1, 2],
  });

  expect(report.fullSixClosure.files.map((file) => file.path)).toStrictEqual([...closureSaxeFiles]);

  expect(report.fullSixClosure.totals.lineFound).toBe(11);

  expect(report.fullSixClosure.totals.lineHit).toBe(7);

  expect(report.fullSixClosure.totals.linePercent).toBeCloseTo(63.63636363636363);

  expect(report.fullSixClosure.files.at(-1)?.lines).toStrictEqual({
    hit: 0,
    found: 1,
    percent: 0,
    uncovered: [1],
  });

  expect(report.fullSixClosure.files.at(-1)?.functions.percent).toBeNull();

  expect(report.fullSixClosure.files.at(-1)?.branches.percent).toBeNull();

  expect(report.sourcePopulation.sources.map((file) => file.source)).toContain(
    "scripts/ci/check-saxe-integration-coverage.ts",
  );
});

test("enforces the 70 percent floor and leaves the 90 percent aim diagnostic", async () => {
  const fixture = await createCaptureFixture(6);

  const report = await checkSaxeIntegrationCoverage(checkerOptions(fixture));

  expect(report.supportedFive.totals.lineHit).toBe(6);

  expect(report.supportedFive.totals.lineFound).toBe(10);

  expect(report.supportedFive.floorPassed).toBe(false);

  expect(report.supportedFive.straightforwardAimMet).toBe(false);

  expect(report.status).toBe("below-floor");

  expect(report.fullSixClosure.files.at(-1)?.lines).toStrictEqual({
    hit: 0,
    found: 0,
    percent: null,
    uncovered: [],
  });
});

test("accepts a capture under an alternate path to its repository parent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hesperia-saxe-parent-"));

  try {
    const target = join(parent, "target");
    const alias = join(parent, "alias");

    await mkdir(target);
    await symlink(target, alias, "junction");

    const fixture = await createCaptureFixture(7, "export {};\n", alias);
    const report = await checkSaxeIntegrationCoverage(checkerOptions(fixture));

    expect(report.status).toBe("passed");
    expect(report.supportedFive.totals.lineHit).toBe(7);
    expect(report.supportedFive.totals.lineFound).toBe(10);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a run root redirected outside its expected directory", async () => {
  const fixture = await createCaptureFixture(7);
  const runs = dirname(fixture.runRoot);
  const relocated = join(dirname(runs), "relocated-runs");

  await rename(runs, relocated);
  await symlink(relocated, runs, "junction");

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "run root resolves through a reparse point or symlink",
  );
});

test("rejects stale candidates and non-integration evidence", async () => {
  const fixture = await createCaptureFixture(7);
  const staleCandidate = JSON.parse(JSON.stringify(fixture.inputs)) as Record<string, unknown>;

  staleCandidate.candidate = "f".repeat(40);

  await writeInputs(fixture, staleCandidate);

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "capture candidate does not match the current Git HEAD",
  );

  const changedClassification = JSON.parse(JSON.stringify(fixture.inputs)) as Record<
    string,
    unknown
  >;
  const classification = changedClassification.classification as Record<string, unknown>;

  classification.exclusions = [{ path: supportedSaxeFiles[0], lines: [1] }];

  await writeInputs(fixture, changedClassification);

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "this first checkpoint does not approve manual exclusions",
  );

  const parserContributor = JSON.parse(JSON.stringify(fixture.inputs)) as Record<string, unknown>;
  const execution = parserContributor.execution as Record<string, unknown>;

  execution.testPaths = ["tests/tooling/saxe-parser.test.ts"];

  await writeInputs(fixture, parserContributor);

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "execution must select only tests/tooling/builtin-assets.test.ts",
  );
});

test("rejects a dirty candidate before checking changed authored inputs", async () => {
  const fixture = await createCaptureFixture(7);

  await writeFile(join(fixture.root, "bun.lock"), "changed after capture\n");

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "candidate worktree is not clean",
  );
});

test("rejects a clean candidate whose bun.lock digest is stale", async () => {
  const fixture = await createCaptureFixture(7);

  await writeFile(join(fixture.root, "bun.lock"), "updated lock input\n");

  const inputs = JSON.parse(JSON.stringify(fixture.inputs)) as Record<string, unknown>;

  inputs.candidate = commitFixtureChanges(fixture.root, "change lock input");

  await writeInputs(fixture, inputs);

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "bun.lock changed after the capture",
  );
});

test("rejects a clean candidate whose integration test digest is stale", async () => {
  const fixture = await createCaptureFixture(7);

  await writeFile(
    join(fixture.root, ...integrationTestPath.split("/")),
    'test("changed integration input", () => {});\n',
  );

  const inputs = JSON.parse(JSON.stringify(fixture.inputs)) as Record<string, unknown>;

  inputs.candidate = commitFixtureChanges(fixture.root, "change integration test input");

  await writeInputs(fixture, inputs);

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "integration test source changed after the capture",
  );
});

test("rejects changed bytes for listed raw coverage and LCOV files", async () => {
  for (const target of ["raw-artifact", "lcov.info"] as const) {
    const fixture = await createCaptureFixture(7);
    const artifactNames = (fixture.inputs.artifacts as { readonly name: string }[]).map(
      (artifact) => artifact.name,
    );
    const name =
      target === "lcov.info" ? target : artifactNames.find((entry) => entry.endsWith(".json"));

    if (!name) throw new Error("Coverage fixture omitted its raw JSON artifact");

    await writeFile(join(fixture.runRoot, name), "tampered listed file\n");

    await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
      `run-root file hash does not match: ${name}`,
    );
  }
});

test("rejects unlisted run-root files and capture logs whose bytes changed", async () => {
  const fixture = await createCaptureFixture(7);
  const extraPath = join(
    fixture.runRoot,
    `${fixture.runId}-bun-tests-coverage-runner-hits-123-0-${randomUUID()}.json`,
  );

  await writeFile(extraPath, "{}");

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "capture artifact manifest does not enumerate the complete run-root file set",
  );

  await rm(extraPath, { force: true });

  await writeFile(fixture.stderrPath, "changed after capture\n");

  await expect(checkSaxeIntegrationCoverage(checkerOptions(fixture))).rejects.toThrow(
    "stderr capture log hash does not match its receipt",
  );
});
