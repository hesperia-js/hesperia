import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPlatformCoverageCapture,
  seedCoverageSources,
} from "../../scripts/ci/coverage-collector.ts";
import type {
  CoverageFile,
  CoverageMap,
  CoveragePlatform,
  PlatformCoverageCapture,
} from "../../scripts/ci/coverage-collector.ts";
import { runCombinedCoverage } from "../../scripts/ci/run-combined-coverage.ts";

const temporaryRoots: string[] = [];
const require = createRequire(import.meta.url);
const { createCoverageMap } = require("istanbul-lib-coverage") as {
  createCoverageMap(data?: Record<string, CoverageFile>): CoverageMap;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function applyHits(
  coverage: CoverageMap,
  lineHits: ReadonlySet<number>,
  functionHits: ReadonlySet<number>,
): void {
  const records = coverage.toJSON();

  for (const file of Object.values(records)) {
    for (const [id, location] of Object.entries(file.statementMap)) {
      file.s[id] = Number(lineHits.has(location.start.line));
    }

    for (const [id, fn] of Object.entries(file.fnMap)) {
      file.f[id] = Number(functionHits.has(fn.loc.start.line));
    }
  }

  coverage.merge(records);
}

function writeCapture(options: {
  readonly platform: CoveragePlatform;
  readonly repoPath: string;
  readonly artifactRoot: string;
  readonly population: PlatformCoverageCapture["population"];
  readonly coverage: CoverageMap;
}): string {
  const runIds = {
    aggregate: randomUUID(),
    ordinary: randomUUID(),
    worker: randomUUID(),
    browser: randomUUID(),
    native: randomUUID(),
  };
  const workerRelativePath = `.hesperia/coverage/runs/${runIds.worker}/worker-invocations.json`;
  const workerPath = join(
    options.artifactRoot,
    "coverage",
    "runs",
    runIds.worker,
    "worker-invocations.json",
  );

  mkdirSync(join(workerPath, ".."), { recursive: true });

  const workerBytes = JSON.stringify({ invocations: 3 });

  writeFileSync(workerPath, workerBytes);

  const nativeDirectory = join(options.artifactRoot, "ec", runIds.native);

  mkdirSync(nativeDirectory, { recursive: true });

  const nativeSummary = {
    format: "hesperia-editor-capture-summary",
    version: 1,
    runId: runIds.native,
    sourceCount: options.population.files.length,
  };
  const nativeSummaryBytes = JSON.stringify(nativeSummary);
  const nativeSummaryPath = join(nativeDirectory, "editor-capture-summary.json");

  writeFileSync(nativeSummaryPath, nativeSummaryBytes);

  const nativeObservation =
    options.platform === "linux"
      ? {
          format: "hesperia-editor-linux-native-process-observation",
          version: 1,
          platform: "linux",
          runId: runIds.native,
          populationFingerprint: options.population.fingerprint,
        }
      : {
          format: "hesperia-editor-native-process-observation",
          version: 1,
          runId: runIds.native,
          events: [],
        };
  const nativeObservationBytes = JSON.stringify(nativeObservation);
  const nativeObservationPath = join(nativeDirectory, "native-process-observation.json");

  writeFileSync(nativeObservationPath, nativeObservationBytes);

  const familyRuns: PlatformCoverageCapture["runs"] = [
    { family: "bun-tests-ordinary", runId: runIds.ordinary, platform: options.platform },
    {
      family: "project-worker-owner",
      runId: runIds.worker,
      platform: options.platform,
      workerEvidence: {
        invocations: 3,
        path: workerRelativePath,
        sha256: sha256(workerBytes),
      },
    },
    { family: "browser-css", runId: runIds.browser, platform: options.platform },
    {
      family: "native-editor",
      runId: runIds.native,
      platform: options.platform,
      nativeEvidence: {
        summaryPath: `.hesperia/ec/${runIds.native}/editor-capture-summary.json`,
        summarySha256: sha256(nativeSummaryBytes),
        observationPath: `.hesperia/ec/${runIds.native}/native-process-observation.json`,
        observationSha256: sha256(nativeObservationBytes),
        summary: nativeSummary,
      },
    },
  ];
  const capture = createPlatformCoverageCapture({
    repoPath: options.repoPath,
    platform: options.platform,
    runId: runIds.aggregate,
    population: options.population,
    runs: familyRuns,
    coverage: options.coverage,
  });
  const receiptPath = join(
    options.artifactRoot,
    "coverage",
    "final-runs",
    runIds.aggregate,
    "platform-coverage-capture.json",
  );

  mkdirSync(join(receiptPath, ".."), { recursive: true });

  writeFileSync(receiptPath, JSON.stringify(capture));

  return receiptPath;
}

interface Fixture {
  readonly root: string;
  readonly repoPath: string;
  readonly windowsRoot: string;
  readonly linuxRoot: string;
  readonly source: string;
  readonly windowsReceiptRoot: string;
  readonly linuxReceiptRoot: string;
}

async function makeFixture(options: {
  readonly windowsLines: readonly number[];
  readonly windowsFunctions: readonly number[];
  readonly linuxLines: readonly number[];
  readonly linuxFunctions: readonly number[];
}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hesperia-combined-coverage-test-"));

  temporaryRoots.push(root);

  const repoPath = join(root, "repo");
  const source = "packages/sample/src/feature.ts";
  const authoredSource = [
    ...Array.from(
      { length: 10 },
      (_, index) =>
        `export function feature${index}(value: boolean) { if (value) return ${index}; return 0; }`,
    ),
    ...Array.from({ length: 10 }, (_, index) => `const value${index} = ${index};`),
  ].join("\n");
  const sourcePath = join(repoPath, source);

  mkdirSync(join(sourcePath, ".."), { recursive: true });

  writeFileSync(sourcePath, authoredSource);

  const windowsRoot = join(root, "windows-artifact");
  const linuxRoot = join(root, "linux-artifact");
  const windowsSeeded = await seedCoverageSources([source], repoPath);
  const linuxSeeded = await seedCoverageSources([source], repoPath);

  expect(linuxSeeded.population).toStrictEqual(windowsSeeded.population);

  const windowsCoverage = createCoverageMap(windowsSeeded.coverage);
  const linuxCoverage = createCoverageMap(linuxSeeded.coverage);

  applyHits(windowsCoverage, new Set(options.windowsLines), new Set(options.windowsFunctions));

  applyHits(linuxCoverage, new Set(options.linuxLines), new Set(options.linuxFunctions));

  writeCapture({
    platform: "win32",
    repoPath,
    artifactRoot: windowsRoot,
    population: windowsSeeded.population,
    coverage: windowsCoverage,
  });

  writeCapture({
    platform: "linux",
    repoPath,
    artifactRoot: linuxRoot,
    population: linuxSeeded.population,
    coverage: linuxCoverage,
  });

  return {
    root,
    repoPath,
    windowsRoot,
    linuxRoot,
    source,
    windowsReceiptRoot: join(windowsRoot, "coverage", "final-runs"),
    linuxReceiptRoot: join(linuxRoot, "coverage", "final-runs"),
  };
}

function receiptPath(finalRunsRoot: string): string {
  const runDirectory = join(finalRunsRoot, readdirSync(finalRunsRoot)[0]!);
  return join(runDirectory, "platform-coverage-capture.json");
}

function writeReceipt(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function portableUnitLayoutHash(coverage: CoverageFile): string {
  return sha256(
    stableJson({
      statements: coverage.statementMap,
      functions: coverage.fnMap,
      branches: coverage.branchMap,
    }),
  );
}

test("combined coverage unions both platforms once and applies strict line and inclusive function floors", async () => {
  const exactBoundary = await makeFixture({
    windowsLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    windowsFunctions: [1, 2, 3, 4, 5],
    linuxLines: [1, 11, 12, 13, 14, 15, 16, 17],
    linuxFunctions: [1, 6, 7, 8, 9],
  });
  const boundaryOutput = join(exactBoundary.root, "output-boundary");
  const boundary = runCombinedCoverage({
    windowsRoot: exactBoundary.windowsRoot,
    linuxRoot: exactBoundary.linuxRoot,
    output: boundaryOutput,
    repoPath: exactBoundary.repoPath,
  });

  expect(boundary.accepted).toBe(false);

  expect(boundary.lineFound).toBe(20);

  expect(boundary.lineHit).toBe(17);

  expect(boundary.functionFound).toBe(10);

  expect(boundary.functionHit).toBe(9);

  expect(boundary.branchRecordsPresent).toBe(true);

  expect(existsSync(join(boundaryOutput, "combined-coverage-summary.json"))).toBe(true);

  expect(existsSync(join(boundaryOutput, "lcov.info"))).toBe(true);

  expect(existsSync(join(boundaryOutput, "coverage-final.json"))).toBe(true);

  expect(existsSync(join(boundaryOutput, "html", "index.html"))).toBe(true);

  const aboveBoundary = await makeFixture({
    windowsLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    windowsFunctions: [1, 2, 3, 4, 5],
    linuxLines: [1, 11, 12, 13, 14, 15, 16, 17, 18],
    linuxFunctions: [1, 6, 7, 8, 9],
  });
  const accepted = runCombinedCoverage({
    windowsRoot: aboveBoundary.windowsRoot,
    linuxRoot: aboveBoundary.linuxRoot,
    output: join(aboveBoundary.root, "output-accepted"),
    repoPath: aboveBoundary.repoPath,
  });

  expect(accepted.accepted).toBe(true);

  expect(accepted.lineHit).toBe(18);

  expect(accepted.functionHit).toBe(9);

  const functionShortfall = await makeFixture({
    windowsLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    windowsFunctions: [1, 2, 3, 4, 5],
    linuxLines: [1, 11, 12, 13, 14, 15, 16, 17, 18],
    linuxFunctions: [6, 7, 8],
  });
  const functionFailure = runCombinedCoverage({
    windowsRoot: functionShortfall.windowsRoot,
    linuxRoot: functionShortfall.linuxRoot,
    output: join(functionShortfall.root, "output-function-shortfall"),
    repoPath: functionShortfall.repoPath,
  });

  expect(functionFailure.accepted).toBe(false);

  expect(functionFailure.lineHit).toBe(18);

  expect(functionFailure.functionHit).toBe(8);
});

test("combined coverage rejects failed captures and source, population, or unit-map mismatches", async () => {
  const fixture = await makeFixture({
    windowsLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    windowsFunctions: [1, 2, 3, 4, 5],
    linuxLines: [11, 12, 13, 14, 15, 16, 17, 18],
    linuxFunctions: [6, 7, 8, 9],
  });
  const linuxReceipt = receiptPath(fixture.linuxReceiptRoot);
  const original = JSON.parse(readFileSync(linuxReceipt, "utf8")) as PlatformCoverageCapture;
  const admissionOutput = join(fixture.root, "output-valid-admission");
  const admission = runCombinedCoverage({
    windowsRoot: fixture.windowsRoot,
    linuxRoot: fixture.linuxRoot,
    output: admissionOutput,
    repoPath: fixture.repoPath,
  });

  expect(admission.accepted).toBe(true);

  expect(existsSync(join(admissionOutput, "combined-coverage-summary.json"))).toBe(true);

  const incompleteOutput = join(fixture.root, "output-incomplete");

  writeReceipt(linuxReceipt, { ...original, status: "failed" });

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: incompleteOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/incomplete|unsupported/u);

  expect(existsSync(incompleteOutput)).toBe(false);

  const mapOutput = join(fixture.root, "output-map-mismatch");
  const alteredMap = structuredClone(original) as unknown as {
    coverage: Record<string, { statementMap: Record<string, { start: { line: number } }> }>;
  };
  alteredMap.coverage[fixture.source]!.statementMap["0"]!.start.line = 2;

  writeReceipt(linuxReceipt, alteredMap);

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: mapOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/unit map differs/u);

  expect(existsSync(mapOutput)).toBe(false);

  const sourceOutput = join(fixture.root, "output-source-mismatch");

  writeFileSync(join(fixture.repoPath, fixture.source), "const changedAfterCapture = true;\n");

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: sourceOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/source bytes differ/u);

  expect(existsSync(sourceOutput)).toBe(false);

  const authoredSource = [
    ...Array.from(
      { length: 10 },
      (_, index) =>
        `export function feature${index}(value: boolean) { if (value) return ${index}; return 0; }`,
    ),
    ...Array.from({ length: 10 }, (_, index) => `const value${index} = ${index};`),
  ].join("\n");

  writeFileSync(join(fixture.repoPath, fixture.source), authoredSource);

  const populationOutput = join(fixture.root, "output-population-mismatch");
  const alteredPopulation = structuredClone(original) as unknown as {
    population: {
      schema: 1;
      fingerprint: string;
      files: Array<{ source: string; sourceSha256: string; canonicalUnitsSha256: string }>;
    };
    coverage: Record<
      string,
      {
        path: string;
        statementMap: Record<string, { start: { line: number; column: number } }>;
        fnMap: CoverageFile["fnMap"];
        branchMap: CoverageFile["branchMap"];
        s: Record<string, number>;
        f: Record<string, number>;
        b: Record<string, number[]>;
      }
    >;
    runs: Array<{
      family: string;
      nativeEvidence?: { observationPath: string; observationSha256: string };
    }>;
  };
  const linuxRecord = alteredPopulation.coverage[fixture.source]!;
  linuxRecord.statementMap["0"]!.start.line = 2;
  alteredPopulation.population.files[0]!.canonicalUnitsSha256 = portableUnitLayoutHash(
    linuxRecord as unknown as CoverageFile,
  );
  alteredPopulation.population.fingerprint = sha256(
    stableJson({ schema: 1, files: alteredPopulation.population.files }),
  );
  const nativeRun = alteredPopulation.runs.find((run) => run.family === "native-editor")!;
  const observationPath = join(
    fixture.linuxRoot,
    ...nativeRun.nativeEvidence!.observationPath.slice(".hesperia/".length).split("/"),
  );
  const observation = JSON.parse(readFileSync(observationPath, "utf8")) as Record<string, unknown>;
  observation.populationFingerprint = alteredPopulation.population.fingerprint;
  const observationBytes = JSON.stringify(observation);

  writeFileSync(observationPath, observationBytes);

  nativeRun.nativeEvidence!.observationSha256 = sha256(observationBytes);

  writeReceipt(linuxReceipt, alteredPopulation);

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: populationOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/different source populations/u);

  expect(existsSync(populationOutput)).toBe(false);
});

test("combined coverage requires both platforms, unique evidence, and all required owners", async () => {
  const fixture = await makeFixture({
    windowsLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    windowsFunctions: [1, 2, 3, 4, 5],
    linuxLines: [11, 12, 13, 14, 15, 16, 17, 18],
    linuxFunctions: [6, 7, 8, 9],
  });
  const linuxPath = receiptPath(fixture.linuxReceiptRoot);
  const linuxOriginal = JSON.parse(readFileSync(linuxPath, "utf8")) as PlatformCoverageCapture;
  const valid = runCombinedCoverage({
    windowsRoot: fixture.windowsRoot,
    linuxRoot: fixture.linuxRoot,
    output: join(fixture.root, "output-valid-evidence"),
    repoPath: fixture.repoPath,
  });

  expect(valid.accepted).toBe(true);

  const sameRootOutput = join(fixture.root, "output-same-root");

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.windowsRoot,
      output: sameRootOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/separate artifact roots/u);

  expect(existsSync(sameRootOutput)).toBe(false);

  const missingFamilyOutput = join(fixture.root, "output-missing-family");

  writeReceipt(linuxPath, {
    ...linuxOriginal,
    runs: linuxOriginal.runs.filter((run) => run.family !== "browser-css"),
  });

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: missingFamilyOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/required family run/u);

  expect(existsSync(missingFamilyOutput)).toBe(false);

  writeReceipt(linuxPath, linuxOriginal);

  const missingNativeOutput = join(fixture.root, "output-missing-native");

  writeReceipt(linuxPath, {
    ...linuxOriginal,
    runs: linuxOriginal.runs.map((run) =>
      run.family === "native-editor" ? { ...run, nativeEvidence: undefined } : run,
    ),
  });

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: missingNativeOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/native-editor provenance/u);

  expect(existsSync(missingNativeOutput)).toBe(false);

  writeReceipt(linuxPath, linuxOriginal);

  const duplicatePlatformOutput = join(fixture.root, "output-duplicate-platform");

  writeReceipt(linuxPath, { ...linuxOriginal, platform: "win32" });

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: duplicatePlatformOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/does not match its unique run directory/u);

  expect(existsSync(duplicatePlatformOutput)).toBe(false);

  writeReceipt(linuxPath, linuxOriginal);

  const duplicateReceiptOutput = join(fixture.root, "output-duplicate-receipt");
  const extraReceiptDirectory = join(fixture.linuxReceiptRoot, randomUUID());

  mkdirSync(extraReceiptDirectory, { recursive: true });

  writeFileSync(
    join(extraReceiptDirectory, "platform-coverage-capture.json"),
    JSON.stringify(linuxOriginal),
  );

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: duplicateReceiptOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/found 2/u);

  expect(existsSync(duplicateReceiptOutput)).toBe(false);

  rmSync(extraReceiptDirectory, { recursive: true, force: true });

  writeReceipt(linuxPath, linuxOriginal);

  const nativeEvidence = linuxOriginal.runs.find(
    (run) => run.family === "native-editor",
  )!.nativeEvidence!;
  const observationPath = join(
    fixture.linuxRoot,
    ...nativeEvidence.observationPath.slice(".hesperia/".length).split("/"),
  );
  const originalObservation = readFileSync(observationPath);

  writeFileSync(observationPath, "tampered native proof");

  const tamperedProofOutput = join(fixture.root, "output-tampered-proof");

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: tamperedProofOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/Native process proof does not match/u);

  expect(existsSync(tamperedProofOutput)).toBe(false);

  writeFileSync(observationPath, originalObservation);

  const windowsOriginal = JSON.parse(
    readFileSync(receiptPath(fixture.windowsReceiptRoot), "utf8"),
  ) as PlatformCoverageCapture;
  const duplicateRunOutput = join(fixture.root, "output-duplicate-run");

  writeReceipt(linuxPath, {
    ...linuxOriginal,
    runs: linuxOriginal.runs.map((run, index) =>
      index === 0 ? { ...run, runId: windowsOriginal.runId } : run,
    ),
  });

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: duplicateRunOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/duplicate original run identity/u);

  expect(existsSync(duplicateRunOutput)).toBe(false);

  rmSync(fixture.linuxReceiptRoot, { recursive: true, force: true });

  const missingPlatformOutput = join(fixture.root, "output-missing-linux");

  expect(() =>
    runCombinedCoverage({
      windowsRoot: fixture.windowsRoot,
      linuxRoot: fixture.linuxRoot,
      output: missingPlatformOutput,
      repoPath: fixture.repoPath,
    }),
  ).toThrow(/no coverage\/final-runs directory/u);

  expect(existsSync(missingPlatformOutput)).toBe(false);
});

test("combined-coverage CLI rejects an incomplete argument set with exit 2", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dir, "../../scripts/ci/run-combined-coverage.ts"), "--windows-root"],
    { cwd: resolve(import.meta.dir, "../.."), encoding: "utf8" },
  );

  expect(result.error).toBeUndefined();

  expect(result.status).toBe(2);

  expect(result.stderr).toContain('"status":"invalid"');
});

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});
