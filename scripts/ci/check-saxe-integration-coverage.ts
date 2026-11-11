import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  inventoryCoverageSources,
  mergeCoverageArtifacts,
  type CoverageArtifact,
  type CoverageFile,
  type CoverageOwnerFile,
  type CoveragePopulation,
} from "./coverage-collector.ts";

const integrationTestPath = "tests/tooling/builtin-assets.test.ts" as const;
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
const captureFormat = "hesperia-saxe-integration-capture-inputs" as const;
const reportFormat = "hesperia-saxe-integration-coverage" as const;
const expectedCommand = ["bun", "run", "scripts/ci/run-coverage.ts", integrationTestPath] as const;
const runIdentityPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

interface CaptureHashFile {
  readonly file: string;
  readonly sha256: string;
}

interface CaptureArtifactFile {
  readonly name: string;
  readonly sha256: string;
}

interface CaptureInputs {
  readonly format: typeof captureFormat;
  readonly version: 1;
  readonly candidate: string;
  readonly lockSha256: string;
  readonly testInputs: readonly { readonly path: string; readonly sha256: string }[];
  readonly execution: {
    readonly command: readonly string[];
    readonly testPaths: readonly string[];
    readonly exitCode: number;
    readonly runId: string;
    readonly ownerId: string;
    readonly platform: string;
    readonly runtime: { readonly name: "bun"; readonly version: string };
    readonly stdout: CaptureHashFile;
    readonly stderr: CaptureHashFile;
  };
  readonly populationFingerprint: string;
  readonly classification: {
    readonly schema: 1;
    readonly supportedFiles: readonly string[];
    readonly exclusions: readonly unknown[];
    readonly sha256: string;
  };
  readonly artifacts: readonly CaptureArtifactFile[];
}

/**
 * Per-file line coverage and source identities for one vendored Saxe module.
 * Percentages are null when a metric has no executable units; zero-hit lines remain listed.
 */
export interface SaxeFileCoverage {
  readonly path: string;
  readonly sourceSha256: string;
  readonly canonicalUnitsSha256: string;
  readonly sourceMapSha256: string;
  readonly instrumentedSourceSha256: string;
  readonly unitLayoutSha256: string;
  readonly lines: {
    readonly hit: number;
    readonly found: number;
    readonly percent: number | null;
    readonly uncovered: readonly number[];
  };
  readonly functions: {
    readonly hit: number;
    readonly found: number;
    readonly percent: number | null;
  };
  readonly branches: {
    readonly hit: number;
    readonly found: number;
    readonly percent: number | null;
  };
}

interface CoverageTotals {
  readonly lineHit: number;
  readonly lineFound: number;
  readonly linePercent: number | null;
  readonly functionHit: number;
  readonly functionFound: number;
  readonly functionPercent: number | null;
  readonly branchHit: number;
  readonly branchFound: number;
  readonly branchPercent: number | null;
}

/**
 * Machine-readable result for the first supported-mode Saxe coverage gate.
 * `supportedFive` is the fixed integration denominator; `fullSixClosure` retains index.ts.
 * Capture execution fields are checked against a trusted retained envelope, not authenticated.
 */
export interface SaxeIntegrationCoverageReport {
  readonly format: typeof reportFormat;
  readonly version: 1;
  readonly status: "passed" | "below-floor";
  readonly candidate: string;
  readonly runId: string;
  readonly captureInputs: {
    readonly sha256: string;
    readonly lockSha256: string;
    readonly platform: string;
    readonly runtime: { readonly name: "bun"; readonly version: string };
  };
  readonly captureScope: "direct-bun-tests-default-run-root";
  readonly captureTrust: "trusted-retained-input-envelope";
  readonly captureTrustLimit: string;
  readonly execution: {
    readonly command: readonly string[];
    readonly testPaths: readonly string[];
    readonly exitCode: 0;
    readonly ownerId: "bun-tests";
    readonly platform: string;
    readonly runtime: { readonly name: "bun"; readonly version: string };
    readonly stdout: CaptureHashFile;
    readonly stderr: CaptureHashFile;
  };
  readonly artifactFiles: readonly CaptureArtifactFile[];
  readonly sourcePopulation: {
    readonly fingerprint: string;
    readonly sourceCount: number;
    readonly sources: readonly {
      readonly source: string;
      readonly sourceSha256: string;
      readonly canonicalUnitsSha256: string;
    }[];
  };
  readonly classification: {
    readonly sha256: string;
    readonly supportedFiles: readonly string[];
    readonly exclusions: readonly [];
  };
  readonly contributor: {
    readonly testPath: typeof integrationTestPath;
    readonly testSha256: string;
    readonly ownerId: "bun-tests";
    readonly stdoutSha256: string;
    readonly stderrSha256: string;
  };
  readonly supportedFive: {
    readonly floorPercent: 70;
    readonly floorPassed: boolean;
    readonly straightforwardAimPercent: 90;
    readonly straightforwardAimMet: boolean;
    readonly totals: CoverageTotals;
    readonly files: readonly SaxeFileCoverage[];
  };
  readonly unfilteredFiveTotals: CoverageTotals;
  readonly fullSixClosure: {
    readonly totals: CoverageTotals;
    readonly files: readonly SaxeFileCoverage[];
  };
}

function fail(message: string): never {
  throw new Error(`Invalid Saxe coverage evidence: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);

  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();

  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(`${label} has missing or unsupported fields`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);

  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }

  return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be an array of strings`);
  }

  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value).replaceAll("\\", "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  return normalize(left) === normalize(right);
}

function isWithin(base: string, target: string): boolean {
  const path = relative(base, target);

  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function classificationSha256(): string {
  return sha256(
    JSON.stringify({
      schema: 1,
      supportedFiles: supportedSaxeFiles,
      exclusions: [],
    }),
  );
}

function parseHashFile(value: unknown, label: string, expectedFile: string): CaptureHashFile {
  const record = requireRecord(value, label);

  requireExactKeys(record, ["file", "sha256"], label);

  if (record.file !== expectedFile) fail(`${label} must refer to ${expectedFile}`);

  return {
    file: expectedFile,
    sha256: requireSha256(record.sha256, `${label} digest`),
  };
}

function parseCaptureInputs(value: unknown): CaptureInputs {
  const record = requireRecord(value, "capture input envelope");

  requireExactKeys(
    record,
    [
      "format",
      "version",
      "candidate",
      "lockSha256",
      "testInputs",
      "execution",
      "populationFingerprint",
      "classification",
      "artifacts",
    ],
    "capture input envelope",
  );

  if (record.format !== captureFormat || record.version !== 1) {
    fail("capture input envelope has an unsupported format or version");
  }

  const candidate = requireString(record.candidate, "candidate");

  if (!/^[a-f0-9]{40}$/u.test(candidate)) fail("candidate must be a full lowercase Git commit SHA");

  const rawTests = record.testInputs;

  if (!Array.isArray(rawTests) || rawTests.length !== 1) {
    fail("capture must name exactly one integration test input");
  }

  const testRecord = requireRecord(rawTests[0], "integration test input");

  requireExactKeys(testRecord, ["path", "sha256"], "integration test input");

  if (testRecord.path !== integrationTestPath) {
    fail(`the only supported contributor is ${integrationTestPath}`);
  }

  const executionRecord = requireRecord(record.execution, "execution receipt");

  requireExactKeys(
    executionRecord,
    [
      "command",
      "testPaths",
      "exitCode",
      "runId",
      "ownerId",
      "platform",
      "runtime",
      "stdout",
      "stderr",
    ],
    "execution receipt",
  );

  const command = requireStringArray(executionRecord.command, "execution command");
  const testPaths = requireStringArray(executionRecord.testPaths, "execution test paths");

  if (
    command.length !== expectedCommand.length ||
    command.some((argument, index) => argument !== expectedCommand[index])
  ) {
    fail("execution command must be the direct, bounded Saxe integration capture");
  }

  if (testPaths.length !== 1 || testPaths[0] !== integrationTestPath) {
    fail(`execution must select only ${integrationTestPath}`);
  }

  if (executionRecord.exitCode !== 0) fail("the coverage runner did not complete successfully");

  const runId = requireString(executionRecord.runId, "run ID");

  if (!runIdentityPattern.test(runId)) fail("run ID is not a UUID");

  if (executionRecord.ownerId !== "bun-tests") {
    fail("the direct integration run must use the bun-tests owner");
  }

  if (
    executionRecord.platform !== process.platform ||
    !["win32", "linux"].includes(process.platform)
  ) {
    fail("capture platform does not match the supported checker platform");
  }

  const runtimeRecord = requireRecord(executionRecord.runtime, "capture runtime");

  requireExactKeys(runtimeRecord, ["name", "version"], "capture runtime");

  const bunVersion = requireString(process.versions.bun, "checker Bun runtime version");

  if (runtimeRecord.name !== "bun" || runtimeRecord.version !== bunVersion) {
    fail("capture Bun runtime does not match the checker runtime");
  }

  const classificationRecord = requireRecord(record.classification, "classification");

  requireExactKeys(
    classificationRecord,
    ["schema", "supportedFiles", "exclusions", "sha256"],
    "classification",
  );

  if (classificationRecord.schema !== 1) fail("classification schema is unsupported");

  const classificationFiles = requireStringArray(
    classificationRecord.supportedFiles,
    "classification supported files",
  );

  if (
    classificationFiles.length !== supportedSaxeFiles.length ||
    classificationFiles.some((path, index) => path !== supportedSaxeFiles[index])
  ) {
    fail("classification does not match the fixed five-module population");
  }

  if (
    !Array.isArray(classificationRecord.exclusions) ||
    classificationRecord.exclusions.length !== 0
  ) {
    fail("this first checkpoint does not approve manual exclusions");
  }

  const classificationDigest = requireSha256(classificationRecord.sha256, "classification SHA-256");

  if (classificationDigest !== classificationSha256()) {
    fail("classification hash does not match the fixed no-exclusion classification");
  }

  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    fail("artifact manifest is empty");
  }

  const artifacts = record.artifacts.map((item, index): CaptureArtifactFile => {
    const artifact = requireRecord(item, `artifact manifest entry ${index}`);

    requireExactKeys(artifact, ["name", "sha256"], `artifact manifest entry ${index}`);

    return {
      name: requireString(artifact.name, `artifact name ${index}`),
      sha256: requireSha256(artifact.sha256, `artifact hash ${index}`),
    };
  });
  const sortedArtifacts = [...artifacts].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  if (
    artifacts.some((artifact, index) => artifact.name !== sortedArtifacts[index]!.name) ||
    new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length
  ) {
    fail("artifact manifest entries must be unique and sorted by name");
  }

  return {
    format: captureFormat,
    version: 1,
    candidate,
    lockSha256: requireSha256(record.lockSha256, "bun.lock hash"),
    testInputs: [
      {
        path: integrationTestPath,
        sha256: requireSha256(testRecord.sha256, "integration test hash"),
      },
    ],
    execution: {
      command,
      testPaths,
      exitCode: 0,
      runId,
      ownerId: "bun-tests",
      platform: process.platform,
      runtime: { name: "bun", version: bunVersion },
      stdout: parseHashFile(executionRecord.stdout, "stdout receipt", "stdout.log"),
      stderr: parseHashFile(executionRecord.stderr, "stderr receipt", "stderr.log"),
    },
    populationFingerprint: requireSha256(
      record.populationFingerprint,
      "coverage population fingerprint",
    ),
    classification: {
      schema: 1,
      supportedFiles: supportedSaxeFiles,
      exclusions: [],
      sha256: classificationDigest,
    },
    artifacts,
  };
}

function readInputs(inputsPath: string): {
  readonly inputs: CaptureInputs;
  readonly directory: string;
  readonly sha256: string;
} {
  const absolutePath = resolve(inputsPath);
  const stat = lstatSync(absolutePath);

  if (stat.isSymbolicLink() || !stat.isFile()) fail("capture input envelope is not a regular file");

  const content = readFileSync(absolutePath);
  let parsed: unknown;

  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    fail("capture input envelope is not valid JSON");
  }

  return {
    inputs: parseCaptureInputs(parsed),
    directory: realpathSync.native(dirname(absolutePath)),
    sha256: sha256(content),
  };
}

function readLog(
  directory: string,
  runRoot: string,
  receipt: CaptureHashFile,
  label: string,
): string {
  const path = resolve(directory, receipt.file);
  const stat = lstatSync(path);

  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} capture log is not a regular file`);

  const realPath = realpathSync.native(path);

  if (!isWithin(directory, realPath) || isWithin(runRoot, realPath)) {
    fail(`${label} capture log is outside the retained input directory or inside the run root`);
  }

  const bytes = readFileSync(path);

  if (sha256(bytes) !== receipt.sha256) {
    fail(`${label} capture log hash does not match its receipt`);
  }

  return bytes.toString("utf8");
}

function gitOutput(repoPath: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`read-only Git identity check failed: ${detail}`);
  }
}

function validateCandidate(repoPath: string, candidate: string): string {
  const root = realpathSync.native(repoPath);
  const gitRoot = realpathSync.native(gitOutput(root, ["rev-parse", "--show-toplevel"]));

  if (!samePath(root, gitRoot)) fail("checker repository path is not the Git worktree root");

  const head = gitOutput(root, ["rev-parse", "HEAD"]);

  if (head !== candidate) fail("capture candidate does not match the current Git HEAD");

  if (gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    fail("candidate worktree is not clean");
  }

  return root;
}

function validateRunRoot(repoPath: string, runRoot: string, runId: string): string {
  const expected = resolve(repoPath, ".hesperia", "coverage", "runs", runId);
  const requested = resolve(runRoot);

  if (!samePath(requested, expected)) {
    fail("run root must use the runner's default .hesperia/coverage/runs/<runId> location");
  }

  const stat = lstatSync(requested);

  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("run root is not a real directory");

  const realPath = realpathSync.native(requested);

  if (!samePath(realPath, expected)) fail("run root resolves through a reparse point or symlink");

  return realPath;
}

function validateExecutionLogs(
  inputs: CaptureInputs,
  inputDirectory: string,
  runRoot: string,
  repoPath: string,
): Record<string, unknown> {
  const stdout = readLog(inputDirectory, runRoot, inputs.execution.stdout, "stdout");
  readLog(inputDirectory, runRoot, inputs.execution.stderr, "stderr");
  const summaries: Record<string, unknown>[] = [];

  for (const line of stdout.split(/\r?\n/u)) {
    try {
      const value: unknown = JSON.parse(line);

      if (
        isRecord(value) &&
        value.status === "completed" &&
        value.runId === inputs.execution.runId
      ) {
        summaries.push(value);
      }
    } catch {}
  }

  if (summaries.length !== 1) fail("stdout must contain one completed summary for this run ID");

  const summary = summaries[0]!;
  const expectedOutput = resolve(repoPath, ".hesperia", "coverage", "runs", inputs.execution.runId);

  if (
    summary.ownerId !== inputs.execution.ownerId ||
    typeof summary.outputDirectory !== "string" ||
    !samePath(summary.outputDirectory, expectedOutput) ||
    typeof summary.lcovPath !== "string" ||
    !samePath(summary.lcovPath, resolve(expectedOutput, "lcov.info"))
  ) {
    fail("completed stdout summary does not match the declared run owner and output paths");
  }

  return summary;
}

function validateArtifactName(name: string, runId: string): "seed" | "hits" | "lcov" {
  if (name === "lcov.info") return "lcov";

  if (name === "worker-invocations.json") {
    fail("worker-mode coverage is outside this direct integration capture");
  }

  const pattern = new RegExp(
    `^${runId}-bun-tests-coverage-runner-(seed|hits)-\\d+-\\d+-` +
      "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$",
    "u",
  );
  const match = pattern.exec(name);

  if (!match) fail(`unexpected file in direct run root: ${name}`);

  return match[1] as "seed" | "hits";
}

function readArtifacts(
  runRoot: string,
  inputs: CaptureInputs,
): {
  readonly seeds: readonly CoverageArtifact[];
  readonly hits: readonly CoverageArtifact[];
  readonly seedCount: number;
  readonly hitCount: number;
} {
  const entries = readdirSync(runRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const expectedNames = inputs.artifacts.map((artifact) => artifact.name);

  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    fail("capture artifact manifest does not enumerate the complete run-root file set");
  }

  if (!names.includes("lcov.info")) fail("run root is missing the collector's LCOV output");

  const manifest = new Map(inputs.artifacts.map((artifact) => [artifact.name, artifact.sha256]));
  const seeds: CoverageArtifact[] = [];
  const hits: CoverageArtifact[] = [];

  for (const entry of entries) {
    const name = entry.name;
    const kind = validateArtifactName(name, inputs.execution.runId);
    const path = resolve(runRoot, name);
    const stat = lstatSync(path);

    if (entry.isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile()) {
      fail(`run-root entry is not a regular file: ${name}`);
    }

    const bytes = readFileSync(path);

    if (sha256(bytes) !== manifest.get(name)) fail(`run-root file hash does not match: ${name}`);

    if (kind === "lcov") continue;

    let value: unknown;

    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`coverage artifact is not valid JSON: ${name}`);
    }

    if (!isRecord(value)) fail(`coverage artifact is not an object: ${name}`);

    const filenameKind = kind;

    if (
      value.format !== "hesperia-coverage" ||
      value.version !== 2 ||
      value.runId !== inputs.execution.runId ||
      value.ownerId !== "bun-tests" ||
      value.platform !== inputs.execution.platform ||
      value.kind !== filenameKind ||
      value.populationFingerprint !== inputs.populationFingerprint
    ) {
      fail(`coverage artifact identity does not match its run filename: ${name}`);
    }

    (kind === "seed" ? seeds : hits).push(value as unknown as CoverageArtifact);
  }

  if (seeds.length === 0 || hits.length === 0) {
    fail("run root must contain both seed and hit artifacts");
  }

  return { seeds, hits, seedCount: seeds.length, hitCount: hits.length };
}

function validateRunSummaryCounts(
  summary: Record<string, unknown>,
  seedCount: number,
  hitCount: number,
  sourceCount: number,
): void {
  if (
    summary?.seedArtifacts !== seedCount ||
    summary?.hitArtifacts !== hitCount ||
    summary?.mergedSources !== sourceCount
  ) {
    fail("runner summary artifact counts do not match the complete raw evidence");
  }
}

function countMetric(values: readonly number[]): { readonly hit: number; readonly found: number } {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("coverage counters contain an invalid value");
  }

  return {
    hit: values.filter((value) => value > 0).length,
    found: values.length,
  };
}

function percent(hit: number, found: number): number | null {
  return found === 0 ? null : (hit / found) * 100;
}

function sourceCoverage(
  source: string,
  coverage: CoverageFile,
  lineCoverage: Record<string, number>,
  populationFile: CoveragePopulation["files"][number],
  ownerFile: CoverageOwnerFile,
): SaxeFileCoverage {
  const lineValues = Object.values(lineCoverage);
  const lineMetrics = countMetric(lineValues);
  const functionMetrics = countMetric(Object.values(coverage.f));
  const branchMetrics = countMetric(Object.values(coverage.b).flat());
  const uncovered = Object.entries(lineCoverage)
    .filter(([, hits]) => hits === 0)
    .map(([line]) => Number(line))
    .sort((left, right) => left - right);

  if (uncovered.some((line) => !Number.isSafeInteger(line) || line < 1)) {
    fail(`coverage line map contains an invalid original-source line: ${source}`);
  }

  return {
    path: source,
    sourceSha256: populationFile.sourceSha256,
    canonicalUnitsSha256: populationFile.canonicalUnitsSha256,
    sourceMapSha256: ownerFile.sourceMapSha256,
    instrumentedSourceSha256: ownerFile.instrumentedSourceSha256,
    unitLayoutSha256: ownerFile.unitLayoutSha256,
    lines: {
      ...lineMetrics,
      percent: percent(lineMetrics.hit, lineMetrics.found),
      uncovered,
    },
    functions: {
      ...functionMetrics,
      percent: percent(functionMetrics.hit, functionMetrics.found),
    },
    branches: {
      ...branchMetrics,
      percent: percent(branchMetrics.hit, branchMetrics.found),
    },
  };
}

function totals(files: readonly SaxeFileCoverage[]): CoverageTotals {
  const lineHit = files.reduce((total, file) => total + file.lines.hit, 0);
  const lineFound = files.reduce((total, file) => total + file.lines.found, 0);
  const functionHit = files.reduce((total, file) => total + file.functions.hit, 0);
  const functionFound = files.reduce((total, file) => total + file.functions.found, 0);
  const branchHit = files.reduce((total, file) => total + file.branches.hit, 0);
  const branchFound = files.reduce((total, file) => total + file.branches.found, 0);

  return {
    lineHit,
    lineFound,
    linePercent: percent(lineHit, lineFound),
    functionHit,
    functionFound,
    functionPercent: percent(functionHit, functionFound),
    branchHit,
    branchFound,
    branchPercent: percent(branchHit, branchFound),
  };
}

function ownerFilesBySource(
  seeds: readonly CoverageArtifact[],
): ReadonlyMap<string, CoverageOwnerFile> {
  const result = new Map<string, CoverageOwnerFile>();

  for (const seed of seeds) {
    for (const ownerFile of seed.ownerFiles) {
      const source = ownerFile.sources[0];

      if (!source) fail(`coverage seed ${seed.ownerId} has an owner record without a source`);

      const prior = result.get(source);

      if (prior && JSON.stringify(prior) !== JSON.stringify(ownerFile)) {
        fail(`coverage owner transform identities conflict for ${source}`);
      }

      result.set(source, ownerFile);
    }
  }

  return result;
}

/**
 * Validates one retained direct Bun integration capture and reports the complete
 * supported-five line denominator plus the six-module closure. The input
 * envelope is trusted capture evidence; this function checks its hashes and
 * consistency but does not authenticate who created it.
 *
 * @param options Repository root, default coverage run root, and retained capture envelope.
 * @returns The validated supported-five result and six-module closure.
 * @throws {Error} If capture identity, population, artifact set, or maps are invalid. A valid
 * capture below 70% returns a report with `status: "below-floor"`.
 */
export async function checkSaxeIntegrationCoverage(options: {
  readonly repoPath: string;
  readonly runRoot: string;
  readonly inputsPath: string;
}): Promise<SaxeIntegrationCoverageReport> {
  const {
    inputs,
    directory: inputsDirectory,
    sha256: inputsSha256,
  } = readInputs(options.inputsPath);
  const repoPath = validateCandidate(options.repoPath, inputs.candidate);
  const runRoot = validateRunRoot(repoPath, options.runRoot, inputs.execution.runId);
  const inputsRealPath = realpathSync.native(resolve(options.inputsPath));

  if (isWithin(runRoot, inputsRealPath)) {
    fail("capture input envelope must stay outside the run root");
  }

  const runnerSummary = validateExecutionLogs(inputs, inputsDirectory, runRoot, repoPath);

  const lockHash = sha256(readFileSync(resolve(repoPath, "bun.lock")));

  if (lockHash !== inputs.lockSha256) fail("bun.lock changed after the capture");

  const testHash = sha256(readFileSync(resolve(repoPath, integrationTestPath)));

  if (testHash !== inputs.testInputs[0]!.sha256) {
    fail("integration test source changed after the capture");
  }

  const artifactSet = readArtifacts(runRoot, inputs);
  const expectedSources = inventoryCoverageSources(repoPath);
  const merged = await mergeCoverageArtifacts({
    repoPath,
    expectedSources,
    seeds: artifactSet.seeds,
    fragments: artifactSet.hits,
  });
  const population = artifactSet.seeds.find((artifact) => artifact.population)?.population;

  if (!population || population.fingerprint !== inputs.populationFingerprint) {
    fail("coverage population does not match the capture envelope");
  }

  if (merged.files().length !== expectedSources.length) {
    fail("merged coverage does not retain the complete source inventory");
  }

  validateRunSummaryCounts(
    runnerSummary,
    artifactSet.seedCount,
    artifactSet.hitCount,
    population.files.length,
  );

  const ownerFiles = ownerFilesBySource(artifactSet.seeds);
  const populationBySource = new Map(population.files.map((file) => [file.source, file]));
  const coverageBySource = new Map(
    merged.files().map((path) => {
      const source = relative(repoPath, path).split(sep).join("/");
      return [source, merged.fileCoverageFor(path).toJSON()] as const;
    }),
  );
  const closureFiles = closureSaxeFiles.map((source) => {
    const populationFile = populationBySource.get(source);
    const ownerFile = ownerFiles.get(source);
    const sourcePath = resolve(repoPath, source.replaceAll("/", sep));
    const coverage = coverageBySource.get(source);

    if (!populationFile || !ownerFile || !coverage) {
      fail(`complete six-module Saxe closure is missing ${source}`);
    }

    if (!samePath(coverage.path, sourcePath)) fail(`merged coverage path changed for ${source}`);

    const mappedCoverage = merged.fileCoverageFor(sourcePath);

    return sourceCoverage(
      source,
      coverage,
      mappedCoverage.getLineCoverage(),
      populationFile,
      ownerFile,
    );
  });
  const supportedFiles = closureFiles.slice(0, supportedSaxeFiles.length);
  const supportedTotals = totals(supportedFiles);

  if (supportedTotals.lineFound === 0) fail("supported Saxe line denominator is empty");

  const floorPassed = supportedTotals.lineHit * 100 >= supportedTotals.lineFound * 70;

  return {
    format: reportFormat,
    version: 1,
    status: floorPassed ? "passed" : "below-floor",
    candidate: inputs.candidate,
    runId: inputs.execution.runId,
    captureInputs: {
      sha256: inputsSha256,
      lockSha256: inputs.lockSha256,
      platform: inputs.execution.platform,
      runtime: inputs.execution.runtime,
    },
    captureScope: "direct-bun-tests-default-run-root",
    captureTrust: "trusted-retained-input-envelope",
    captureTrustLimit:
      "Hashes and consistency checks do not independently authenticate the capture origin " +
      "or prove the declared command ran.",
    execution: {
      command: inputs.execution.command,
      testPaths: inputs.execution.testPaths,
      exitCode: 0,
      ownerId: "bun-tests",
      platform: inputs.execution.platform,
      runtime: inputs.execution.runtime,
      stdout: inputs.execution.stdout,
      stderr: inputs.execution.stderr,
    },
    artifactFiles: inputs.artifacts,
    sourcePopulation: {
      fingerprint: population.fingerprint,
      sourceCount: population.files.length,
      sources: population.files,
    },
    classification: {
      sha256: inputs.classification.sha256,
      supportedFiles: supportedSaxeFiles,
      exclusions: [],
    },
    contributor: {
      testPath: integrationTestPath,
      testSha256: inputs.testInputs[0]!.sha256,
      ownerId: "bun-tests",
      stdoutSha256: inputs.execution.stdout.sha256,
      stderrSha256: inputs.execution.stderr.sha256,
    },
    supportedFive: {
      floorPercent: 70,
      floorPassed,
      straightforwardAimPercent: 90,
      straightforwardAimMet: supportedTotals.lineHit * 100 >= supportedTotals.lineFound * 90,
      totals: supportedTotals,
      files: supportedFiles,
    },
    unfilteredFiveTotals: supportedTotals,
    fullSixClosure: {
      totals: totals(closureFiles),
      files: closureFiles,
    },
  };
}

function parseArguments(
  args: readonly string[],
):
  | { readonly help: true }
  | { readonly help: false; readonly runRoot: string; readonly inputsPath: string } {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };

  if (args.length !== 3 || args[1] !== "--inputs") {
    throw new Error(
      "Usage: bun run scripts/ci/check-saxe-integration-coverage.ts " +
        "<run-root> --inputs <capture-inputs.json>",
    );
  }

  return { help: false, runRoot: args[0]!, inputsPath: args[2]! };
}

if (import.meta.main) {
  try {
    const args = parseArguments(Bun.argv.slice(2));

    if (args.help) {
      console.log(
        "Usage: bun run scripts/ci/check-saxe-integration-coverage.ts " +
          "<run-root> --inputs <capture-inputs.json>\n" +
          "Checks the direct, non-worker tests/tooling/builtin-assets.test.ts capture in " +
          ".hesperia/coverage/runs/<runId>. The retained envelope and adjacent logs bind " +
          "the command and capture inputs.",
      );
    } else {
      const repoPath = resolve(import.meta.dir, "../..");
      const report = await checkSaxeIntegrationCoverage({
        repoPath,
        runRoot: args.runRoot,
        inputsPath: args.inputsPath,
      });

      console.log(JSON.stringify(report));

      if (!report.supportedFive.floorPassed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        format: reportFormat,
        version: 1,
        status: "invalid-evidence",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 2;
  }
}
