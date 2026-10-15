import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  bindCoverageOwnerRun,
  coverageOwnerProfile,
  projectWorkerOwnerTestPaths,
  snapshotCoverageOwnerHits,
} from "./coverage-owner-launcher.ts";
import {
  createCoverageArtifact,
  createPlatformCoverageCapture,
  coverageProvenancePath,
  inventoryCoverageSources,
  mergeCoverageRuns,
  relocateCoverageArtifact,
  seedCoverageSources,
  writeCoverageFragment,
  writeLcovReport,
  type CoverageArtifact,
  type CoverageFamilyId,
  type CoveragePlatform,
  type CoverageRunArtifacts,
  type PlatformCoverageFamilyRun,
} from "./coverage-collector.ts";
import {
  coverageExecution,
  coverageFamilies,
  readCoverageGroups,
  writeCoverageGroup,
} from "./coverage-group-artifacts.ts";
import { browserCssCoverageReceiptNames } from "./browser-css-coverage-contract.ts";
import { checkCoverage } from "./check-coverage.ts";

const repoPath = resolve(import.meta.dir, "../..");
const launcherPath = resolve(repoPath, "scripts/ci/coverage-owner-launcher.ts");
const outputRoot = resolve(repoPath, ".hesperia/coverage/final-runs");
const ordinaryTestRoots = [
  "tests/compiler",
  "tests/runtime",
  "tests/data",
  "tests/tooling",
  "tests/routing",
  "tests/editor",
  "tests/hosting",
  "tests/ci",
] as const;
const installedCliCoverageTest = "tests/package/check-installed.test.ts" as const;
const bunTestFile = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;
const runIdentity = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

type FamilyId = "bun-tests-ordinary" | "project-worker-owner" | "browser-css" | "native-editor";

interface FamilySummary {
  readonly status: "completed" | "failed";
  readonly runId?: string;
  readonly outputDirectory?: string;
  readonly lcovPath?: string;
  readonly seedArtifacts?: number;
  readonly hitArtifacts?: number;
  readonly mergedSources?: number;
  readonly sourceCount?: number;
  readonly workerInvocations?: number;
  readonly error?: string;
  readonly [key: string]: unknown;
}

interface FamilyRun {
  readonly family: FamilyId;
  readonly summary: FamilySummary;
  readonly outputDirectory: string;
  readonly lcovPath: string;
  readonly artifacts: CoverageRunArtifacts;
  readonly workerEvidence?: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly nativeProof?: {
    readonly path: string;
    readonly sha256: string;
    readonly summaryPath: string;
    readonly summarySha256: string;
    readonly runSummary: Record<string, unknown>;
  };
}

interface FinalSummary {
  readonly format: "hesperia-final-coverage-run";
  readonly version: 2;
  readonly status: "completed" | "failed";
  readonly acceptance?: "deferred-combined";
  readonly runId: string;
  readonly platform: string;
  readonly outputDirectory: string;
  readonly lcovPath?: string;
  readonly populationFingerprint?: string;
  readonly sourceCount?: number;
  readonly lineFound?: number;
  readonly lineHit?: number;
  readonly linePercent?: number;
  readonly functionFound?: number;
  readonly functionHit?: number;
  readonly functionPercent?: number;
  readonly runs: readonly Record<string, unknown>[];
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Malformed coverage evidence ${path}`, { cause: error });
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ordinaryTestPaths(): readonly string[] {
  const tests = new Set<string>();
  const foundWorkerOwners = new Set<string>();
  const countByRoot = new Map<string, number>();

  for (const root of ordinaryTestRoots) {
    const absoluteRoot = resolve(repoPath, root);

    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
      throw new Error(`Required ordinary coverage test owner is missing: ${root}`);
    }

    let rootCount = 0;

    const visit = (directory: string): void => {
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );

      for (const entry of entries) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
          visit(path);

          continue;
        }

        if (!entry.isFile() || !bunTestFile.test(entry.name)) continue;

        const relativePath = relative(repoPath, path).split("\\").join("/");

        if ((projectWorkerOwnerTestPaths as readonly string[]).includes(relativePath)) {
          foundWorkerOwners.add(relativePath);

          continue;
        }

        tests.add(relativePath);

        rootCount += 1;
      }
    };

    visit(absoluteRoot);

    if (rootCount === 0) throw new Error(`Ordinary coverage test owner is empty: ${root}`);

    countByRoot.set(root, rootCount);
  }

  const installedCliTestPath = resolve(repoPath, installedCliCoverageTest);

  if (!existsSync(installedCliTestPath) || !statSync(installedCliTestPath).isFile()) {
    throw new Error(
      `Required ordinary coverage test owner is missing: ${installedCliCoverageTest}`,
    );
  }

  if (tests.has(installedCliCoverageTest)) {
    throw new Error(
      `Installed CLI coverage owner was already selected: ${installedCliCoverageTest}`,
    );
  }

  tests.add(installedCliCoverageTest);

  if (
    projectWorkerOwnerTestPaths.some((path) => !foundWorkerOwners.has(path)) ||
    projectWorkerOwnerTestPaths.some((path) => tests.has(path))
  ) {
    throw new Error("Ordinary coverage selection did not isolate every project-worker owner");
  }

  if (countByRoot.size !== ordinaryTestRoots.length || tests.size === 0) {
    throw new Error("Ordinary coverage test selection is incomplete");
  }

  return [...tests].sort();
}

function nativeEditorArguments(args: readonly string[]): readonly string[] {
  if (process.platform === "linux") {
    return [
      args[0] ?? process.env.VSCODE_CODE_PATH ?? "code",
      ...(args[1] === undefined ? [] : [args[1]]),
      "--verify=artifacts-and-native",
    ];
  }

  if (process.platform !== "win32") {
    throw new Error("Final native editor coverage supports only Windows and Linux");
  }

  const codePath = resolve(
    args[0] ??
      process.env.VSCODE_CODE_PATH ??
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
  );
  return [codePath, ...(args[1] === undefined ? [] : [args[1]]), "--verify=artifacts-and-native"];
}

function completedSummary(stdout: string, stderr: string, family: FamilyId): FamilySummary {
  const completed: FamilySummary[] = [];
  const failures: FamilySummary[] = [];

  for (const line of stdout.split(/\r?\n/u)) {
    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(value)) continue;

    if (value.status === "completed") completed.push(value as unknown as FamilySummary);

    if (value.status === "failed") failures.push(value as unknown as FamilySummary);
  }

  for (const line of stderr.split(/\r?\n/u)) {
    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }

    if (isRecord(value) && value.status === "failed") {
      failures.push(value as unknown as FamilySummary);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${family} coverage child reported failure: ${String(failures[0]!.error ?? "unknown error")}`,
    );
  }

  if (completed.length !== 1) {
    throw new Error(
      `${family} coverage child emitted ${completed.length} completed stdout summaries`,
    );
  }

  return completed[0]!;
}

function readArtifacts(
  family: FamilyId,
  runId: string,
  outputDirectory: string,
): CoverageArtifact[] {
  const requiredNames = new Set<string>(["lcov.info"]);
  const fixedNames = new Set<string>(requiredNames);

  if (family === "project-worker-owner") {
    fixedNames.add("worker-invocations.json");

    requiredNames.add("worker-invocations.json");
  }

  if (family === "browser-css") {
    for (const name of Object.values(browserCssCoverageReceiptNames)) {
      fixedNames.add(name);

      requiredNames.add(name);
    }
  }

  if (family === "native-editor") {
    for (const name of [
      "editor-capture-summary.json",
      "editor-coverage-config.json",
      "editor-result.json",
      "native-process-observation.json",
      "extension-host-start.json",
      "extension-host-exit.json",
      "extension-host-coverage.json",
      "language-server-start.json",
      "language-server-exit.json",
      "language-server-coverage.json",
      "extension-host-deactivate-start.json",
      "extension-host-deactivate.json",
      "language-server-native-exit-ack.json",
      "extension-host-support-coverage.json",
      "language-server-support-coverage.json",
      "editor-coverage-support.json",
    ]) {
      fixedNames.add(name);

      requiredNames.add(name);
    }

    if (process.platform === "win32") {
      fixedNames.add("owner-native-admission.json");

      requiredNames.add("owner-native-admission.json");
    }
  }

  const entries = readdirSync(outputDirectory, { withFileTypes: true });

  if (entries.length === 0 || entries.some((entry) => !entry.isFile())) {
    throw new Error(`${family} coverage output is empty or contains a non-file entry`);
  }

  const names = new Set(entries.map((entry) => entry.name));

  for (const name of requiredNames) {
    if (!names.has(name)) throw new Error(`${family} coverage output is missing ${name}`);
  }

  const artifacts: CoverageArtifact[] = [];

  for (const entry of entries) {
    if (
      family === "native-editor" &&
      process.platform === "linux" &&
      /^native-process-trace\.\d+$/u.test(entry.name)
    ) {
      fixedNames.add(entry.name);

      continue;
    }

    if (fixedNames.has(entry.name)) continue;

    if (!entry.name.startsWith(`${runId}-`) || !entry.name.endsWith(".json")) {
      throw new Error(`${family} coverage output contains foreign evidence: ${entry.name}`);
    }

    const value = parseJson(join(outputDirectory, entry.name));

    if (
      !isRecord(value) ||
      value.format !== "hesperia-coverage" ||
      value.version !== 2 ||
      value.runId !== runId ||
      value.platform !== process.platform ||
      (value.kind !== "seed" && value.kind !== "hits") ||
      typeof value.ownerId !== "string" ||
      !value.ownerId
    ) {
      throw new Error(`${family} coverage artifact is malformed or foreign: ${entry.name}`);
    }

    artifacts.push(value as unknown as CoverageArtifact);
  }

  if (artifacts.length === 0)
    throw new Error(`${family} coverage output has no admitted artifacts`);

  return artifacts;
}

function readAggregateArtifacts(runId: string, outputDirectory: string): CoverageArtifact[] {
  const entries = readdirSync(outputDirectory, { withFileTypes: true });

  if (entries.length === 0 || entries.some((entry) => !entry.isFile())) {
    throw new Error("Final coverage output is empty or contains a non-file entry");
  }

  const artifacts = entries.map((entry) => {
    if (!entry.name.startsWith(`${runId}-`) || !entry.name.endsWith(".json")) {
      throw new Error(`Final coverage output contains foreign evidence: ${entry.name}`);
    }

    const value = parseJson(join(outputDirectory, entry.name));

    if (
      !isRecord(value) ||
      value.format !== "hesperia-coverage" ||
      value.version !== 2 ||
      value.runId !== runId ||
      value.platform !== process.platform ||
      (value.kind !== "seed" && value.kind !== "hits") ||
      typeof value.ownerId !== "string" ||
      !value.ownerId
    ) {
      throw new Error(`Final coverage artifact is malformed or foreign: ${entry.name}`);
    }

    return value as unknown as CoverageArtifact;
  });

  if (
    artifacts.filter((artifact) => artifact.kind === "seed").length === 0 ||
    artifacts.filter((artifact) => artifact.kind === "hits").length === 0
  ) {
    throw new Error("Final coverage driver omitted its original seed or hit evidence");
  }

  return artifacts;
}

function workerReceiptProvenance(run: FamilyRun): {
  readonly path: string;
  readonly sha256: string;
} {
  const path = join(run.outputDirectory, "worker-invocations.json");
  return { path, sha256: sha256File(path) };
}

function validateNativeEditorEvidence(
  run: FamilyRun,
  expectedSources: readonly string[],
): FamilyRun["nativeProof"] {
  const summaryPath = join(run.outputDirectory, "editor-capture-summary.json");
  const proofPath = join(run.outputDirectory, "native-process-observation.json");
  const summary = parseJson(summaryPath);
  const proof = parseJson(proofPath);

  if (
    !isRecord(summary) ||
    summary.format !== "hesperia-editor-capture-summary" ||
    summary.version !== 1 ||
    summary.runId !== run.summary.runId ||
    summary.lcovPath !== run.lcovPath ||
    summary.sourceCount !== expectedSources.length ||
    !Number.isSafeInteger(summary.hostPid) ||
    Number(summary.hostPid) <= 0 ||
    !Number.isSafeInteger(summary.hostParentPid) ||
    Number(summary.hostParentPid) <= 0 ||
    !Number.isSafeInteger(summary.languageServerPid) ||
    Number(summary.languageServerPid) <= 0 ||
    !Number.isSafeInteger(summary.languageServerParentPid) ||
    Number(summary.languageServerParentPid) <= 0 ||
    summary.shutdownMethod !== "loaded-staged-extension-deactivate" ||
    summary.processGraph !== "extension-host -> Bun language-server"
  ) {
    throw new Error("The native editor coverage run is missing its original native-process proof");
  }

  if (process.platform === "linux") {
    const host = summary.extensionHostNativeGeneration;
    const server = summary.languageServerNativeGeneration;
    const gui = summary.codeGuiNativeGeneration;
    const populationFingerprint = run.artifacts.seeds.find(
      (artifact) => artifact.population !== undefined,
    )?.population?.fingerprint;

    if (
      !isRecord(proof) ||
      proof.format !== "hesperia-editor-linux-native-process-observation" ||
      proof.version !== 1 ||
      proof.platform !== "linux" ||
      proof.runId !== run.summary.runId ||
      proof.populationFingerprint !== populationFingerprint ||
      !isRecord(host) ||
      !isRecord(host.outcome) ||
      !isRecord(server) ||
      !isRecord(server.outcome) ||
      !isRecord(gui) ||
      !isRecord(gui.outcome) ||
      host.pid !== summary.hostPid ||
      server.pid !== summary.languageServerPid ||
      !isRecord(proof.codeGui) ||
      proof.codeGui.pid !== gui.pid ||
      proof.codeGui.procStarttimeTicks !== gui.procStarttimeTicks
    ) {
      throw new Error(
        "The native editor coverage run is missing its original Linux process observation",
      );
    }
  } else if (
    !isRecord(proof) ||
    proof.format !== "hesperia-editor-native-process-observation" ||
    proof.version !== 1 ||
    proof.runId !== run.summary.runId ||
    !Array.isArray(proof.events) ||
    typeof summary.hostNativeCreationTime !== "string" ||
    typeof summary.languageServerNativeCreationTime !== "string" ||
    summary.hostExitCode !== 0 ||
    summary.languageServerExitCode !== 0 ||
    !proof.events.some(
      (event) =>
        isRecord(event) &&
        event.pid === summary.hostPid &&
        event.exitObserved === true &&
        event.exitCode === 0,
    ) ||
    !proof.events.some(
      (event) =>
        isRecord(event) &&
        event.pid === summary.languageServerPid &&
        event.exitObserved === true &&
        event.exitCode === 0,
    )
  ) {
    throw new Error("The native editor coverage run is missing its original native-process proof");
  }

  return {
    path: proofPath,
    sha256: sha256File(proofPath),
    summaryPath,
    summarySha256: sha256File(summaryPath),
    runSummary: summary,
  };
}

function expectedRunDirectory(root: string, runId: string, outputDirectory: unknown): string {
  if (typeof outputDirectory !== "string" || !runIdentity.test(runId)) {
    throw new Error(
      "Coverage child summary has no valid original run identity or output directory",
    );
  }

  const expected = resolve(root, runId);
  const actual = resolve(outputDirectory);

  if (canonicalPath(expected) !== canonicalPath(actual) || basename(actual) !== runId) {
    throw new Error("Coverage child summary points outside its original run directory");
  }

  return actual;
}

async function runFamily(options: {
  readonly family: FamilyId;
  readonly driver: string;
  readonly outputRoot: string;
  readonly arguments: readonly string[];
  readonly expectedSources: readonly string[];
}): Promise<FamilyRun> {
  const childEnvironment: Record<string, string | undefined> = { ...process.env };

  for (const key of Object.keys(childEnvironment)) {
    if (
      key.startsWith("HESPERIA_COVERAGE_") ||
      key.startsWith("HESPERIA_BROWSER_COVERAGE_") ||
      key.startsWith("HESPERIA_EDITOR_COVERAGE_")
    ) {
      delete childEnvironment[key];
    }
  }

  delete childEnvironment.BUN_OPTIONS;
  delete childEnvironment.NODE_OPTIONS;

  const child = Bun.spawn(
    [process.execPath, launcherPath, options.driver, "--", ...options.arguments],
    {
      cwd: repoPath,
      env: childEnvironment,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (stdout) process.stderr.write(stdout);

  if (stderr) process.stderr.write(stderr);

  if (status !== 0 && Bun.argv[2] === "--group") {
    const bundlePath = resolve(repoPath, ".hesperia/coverage/group-artifact");

    mkdirSync(bundlePath);

    writeFileSync(
      join(bundlePath, "coverage-group-failure.json"),
      JSON.stringify({
        status: "failed",
        family: options.family,
        platform: process.platform,
        execution: coverageExecution(),
        exitCode: status,
      }),
      { flag: "wx" },
    );

    writeFileSync(join(bundlePath, "stdout.log"), stdout, { flag: "wx" });

    writeFileSync(join(bundlePath, "stderr.log"), stderr, { flag: "wx" });

    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
      let value: unknown;

      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }

      if (!isRecord(value) || value.status !== "failed" || typeof value.runId !== "string")
        continue;

      const directory = expectedRunDirectory(
        options.outputRoot,
        value.runId,
        value.outputDirectory,
      );

      if (existsSync(directory) && statSync(directory).isDirectory()) {
        cpSync(directory, join(bundlePath, "failed-run", value.runId), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
    }
  }

  if (status !== 0) throw new Error(`${options.family} coverage child exited with code ${status}`);

  return admitFamily({
    family: options.family,
    summary: completedSummary(stdout, stderr, options.family),
    outputRoot: options.outputRoot,
    expectedSources: options.expectedSources,
  });
}

function admitFamily(options: {
  readonly family: FamilyId;
  readonly summary: FamilySummary;
  readonly outputRoot: string;
  readonly expectedSources: readonly string[];
  readonly imported?: { readonly producerRepoPath: string; readonly outputDirectory: string };
}): FamilyRun {
  const summary = options.summary;

  if (summary.status !== "completed" || !summary.runId) {
    throw new Error(`${options.family} coverage child did not complete its original run`);
  }

  const originalDirectory = expectedRunDirectory(
    options.outputRoot,
    summary.runId,
    summary.outputDirectory,
  );
  const outputDirectory = options.imported?.outputDirectory ?? originalDirectory;
  const lcovPath = resolve(originalDirectory, "lcov.info");
  const localLcovPath = resolve(outputDirectory, "lcov.info");

  if (
    typeof summary.lcovPath !== "string" ||
    canonicalPath(summary.lcovPath) !== canonicalPath(lcovPath) ||
    !existsSync(localLcovPath) ||
    !statSync(localLcovPath).isFile()
  ) {
    throw new Error(`${options.family} coverage child omitted its original family report`);
  }

  const originals = readArtifacts(options.family, summary.runId, outputDirectory);
  const artifacts = options.imported
    ? originals.map((artifact) =>
        relocateCoverageArtifact(artifact, options.imported!.producerRepoPath, repoPath),
      )
    : originals;
  const seeds = artifacts.filter((artifact) => artifact.kind === "seed");
  const fragments = artifacts.filter((artifact) => artifact.kind === "hits");

  if (seeds.length === 0 || fragments.length === 0) {
    throw new Error(`${options.family} coverage child omitted seed or hit artifacts`);
  }

  if (
    (options.family === "bun-tests-ordinary" || options.family === "project-worker-owner") &&
    (summary.seedArtifacts !== seeds.length ||
      summary.hitArtifacts !== fragments.length ||
      summary.mergedSources !== options.expectedSources.length)
  ) {
    throw new Error("Bun coverage child summary does not match its admitted original artifacts");
  }

  if (options.family === "bun-tests-ordinary" && summary.workerInvocations !== undefined) {
    throw new Error("Ordinary Bun coverage unexpectedly includes the isolated worker owner");
  }

  if (
    options.family === "project-worker-owner" &&
    (!Number.isSafeInteger(summary.workerInvocations) || Number(summary.workerInvocations) <= 0)
  ) {
    throw new Error("Project worker coverage omitted its original invocation count");
  }

  if (options.family === "browser-css" && summary.sourceCount !== options.expectedSources.length) {
    throw new Error("Browser CSS coverage child omitted the complete original source population");
  }

  return {
    family: options.family,
    summary,
    outputDirectory,
    lcovPath,
    artifacts: {
      family: options.family,
      runId: summary.runId,
      platform: process.platform,
      seeds,
      fragments,
    },
  };
}

function runProvenance(run: FamilyRun): Record<string, unknown> {
  return {
    family: run.family,
    runId: run.artifacts.runId,
    platform: run.artifacts.platform,
    outputDirectory: run.outputDirectory,
    lcovPath: run.lcovPath,
    ...(run.family === "project-worker-owner" && run.workerEvidence
      ? {
          workerInvocations: run.summary.workerInvocations,
          workerReceiptPath: run.workerEvidence.path,
          workerReceiptSha256: run.workerEvidence.sha256,
        }
      : {}),
    ...(run.nativeProof
      ? {
          nativeProofPath: run.nativeProof.path,
          nativeProofSha256: run.nativeProof.sha256,
          nativeRunSummary: run.nativeProof.runSummary,
        }
      : {}),
  };
}

function platformRunProvenance(run: FamilyRun, repoPath: string): PlatformCoverageFamilyRun {
  const base = {
    family: run.family as CoverageFamilyId,
    runId: run.artifacts.runId,
    platform: run.artifacts.platform as CoveragePlatform,
  };

  if (run.family === "project-worker-owner") {
    if (!run.workerEvidence || !Number.isSafeInteger(run.summary.workerInvocations)) {
      throw new Error("Platform capture omitted its admitted project-worker provenance");
    }

    return {
      ...base,
      workerEvidence: {
        invocations: Number(run.summary.workerInvocations),
        path: coverageProvenancePath(run.workerEvidence.path, repoPath),
        sha256: run.workerEvidence.sha256,
      },
    };
  }

  if (run.family === "native-editor") {
    if (!run.nativeProof) {
      throw new Error("Platform capture omitted its admitted native-editor provenance");
    }

    return {
      ...base,
      nativeEvidence: {
        summaryPath: coverageProvenancePath(run.nativeProof.summaryPath, repoPath),
        summarySha256: run.nativeProof.summarySha256,
        observationPath: coverageProvenancePath(run.nativeProof.path, repoPath),
        observationSha256: run.nativeProof.sha256,
        summary: Object.fromEntries(
          Object.entries(run.nativeProof.runSummary).filter(
            ([key]) => key !== "codePath" && key !== "lcovPath",
          ),
        ),
      },
    };
  }

  return base;
}

async function main(): Promise<void> {
  let runId: string | undefined;
  let outputDirectory: string | undefined;
  let outputDirectoryCreated = false;
  let familyRuns: FamilyRun[] = [];

  try {
    if (!coverageOwnerProfile("driver")) {
      throw new Error("Final coverage must run through the coverage owner launcher");
    }

    const args = Bun.argv.slice(2);
    const group = args[0] === "--group" ? args[1] : undefined;
    const aggregateRoot = args[0] === "--aggregate" ? args[1] : undefined;

    if (
      (args[0] === "--group" && !coverageFamilies.includes(group as FamilyId)) ||
      (args[0] === "--aggregate" && (!aggregateRoot || args.length !== 2))
    ) {
      throw new Error(
        "Usage: run-final-coverage.ts --group <coverage-family> [Code launcher] [version] | --aggregate <group-bundle-root>",
      );
    }

    const editorArguments = group ? args.slice(2) : aggregateRoot ? [] : args;

    if (editorArguments.length > 2) {
      throw new Error(
        "Usage: bun run scripts/ci/run-final-coverage.ts [Code launcher] [expected-version-prefix]",
      );
    }

    const editorDriverArguments =
      !aggregateRoot && (!group || group === "native-editor")
        ? nativeEditorArguments(editorArguments)
        : [];
    const ordinaryTests = ordinaryTestPaths();
    const expectedSources = inventoryCoverageSources(repoPath);
    const execution = group || aggregateRoot ? coverageExecution() : undefined;
    if (!group) {
      runId = randomUUID();
      outputDirectory = resolve(outputRoot, runId);

      mkdirSync(outputRoot, { recursive: true });

      mkdirSync(outputDirectory);

      outputDirectoryCreated = true;

      if (readdirSync(outputDirectory).length !== 0) {
        throw new Error("New final coverage run directory was not empty");
      }
    }

    const familyDefinitions = [
      {
        family: "bun-tests-ordinary" as const,
        driver: "scripts/ci/run-coverage.ts",
        outputRoot: resolve(repoPath, ".hesperia/coverage/runs"),
        arguments: ordinaryTests,
        expectedSources,
      },
      {
        family: "project-worker-owner" as const,
        driver: "scripts/ci/run-coverage.ts",
        outputRoot: resolve(repoPath, ".hesperia/coverage/runs"),
        arguments: [...projectWorkerOwnerTestPaths],
        expectedSources,
      },
      {
        family: "browser-css" as const,
        driver: "scripts/ci/run-browser-css-coverage.ts",
        outputRoot: resolve(repoPath, ".hesperia/coverage/browser-css-runs"),
        arguments: [],
        expectedSources,
      },
      {
        family: "native-editor" as const,
        driver: "scripts/ci/run-editor-coverage.ts",
        outputRoot: resolve(repoPath, ".hesperia/ec"),
        arguments: editorDriverArguments,
        expectedSources,
      },
    ];

    const importedGroups = aggregateRoot
      ? readCoverageGroups({
          repoPath,
          bundleRoot: resolve(repoPath, aggregateRoot),
          execution: execution!,
        })
      : undefined;

    for (const definition of familyDefinitions.filter(
      (definition) => !group || definition.family === group,
    )) {
      const imported = importedGroups?.find((candidate) => candidate.family === definition.family);
      let run = imported
        ? admitFamily({
            family: definition.family,
            summary: imported.summary as FamilySummary,
            outputRoot: resolve(
              imported.producerRepoPath,
              relative(repoPath, definition.outputRoot),
            ),
            expectedSources,
            imported,
          })
        : await runFamily(definition);

      if (familyRuns.some((previous) => previous.artifacts.runId === run.artifacts.runId)) {
        throw new Error(
          `Coverage families reused an original run identity: ${run.artifacts.runId}`,
        );
      }

      if (imported) {
        const originalSupport = readAggregateArtifacts(
          run.artifacts.runId,
          imported.supportDirectory,
        );
        const profile = coverageOwnerProfile("driver")!;
        const expectedSupportSources = profile.sources
          .map((source) => (process.platform === "win32" ? source.toLowerCase() : source))
          .sort();
        const population = run.artifacts.seeds.find((artifact) => artifact.population)?.population;

        if (
          !population ||
          originalSupport.length !== 2 ||
          originalSupport.some(
            (artifact) =>
              artifact.ownerId !== profile.ownerId ||
              artifact.populationFingerprint !== population.fingerprint ||
              JSON.stringify(artifact.ownerFiles.map((file) => file.sources[0]).sort()) !==
                JSON.stringify(expectedSupportSources),
          )
        ) {
          throw new Error("Imported coverage group omitted its original wrapper support ownership");
        }

        const support = originalSupport.map((artifact) =>
          relocateCoverageArtifact(artifact, imported.producerRepoPath, repoPath),
        );
        run = {
          ...run,
          artifacts: {
            ...run.artifacts,
            seeds: [
              ...run.artifacts.seeds,
              ...support.filter((artifact) => artifact.kind === "seed"),
            ],
            fragments: [
              ...run.artifacts.fragments,
              ...support.filter((artifact) => artifact.kind === "hits"),
            ],
          },
        };
      }

      if (run.family === "project-worker-owner") {
        run = { ...run, workerEvidence: workerReceiptProvenance(run) };
      }

      if (run.family === "native-editor") {
        run = { ...run, nativeProof: validateNativeEditorEvidence(run, expectedSources) };
      }

      familyRuns.push(run);

      process.stderr.write(
        `${run.family} coverage completed with original run ${run.artifacts.runId}\n`,
      );
    }

    if (group) {
      const run = familyRuns[0]!;
      const bundlePath = resolve(repoPath, ".hesperia/coverage/group-artifact");

      writeCoverageGroup({
        repoPath,
        bundlePath,
        family: run.family,
        runId: run.artifacts.runId,
        outputDirectory: run.outputDirectory,
        summary: run.summary,
        execution: execution!,
        captureSupport: (directory) => {
          const population = run.artifacts.seeds.find(
            (artifact) => artifact.population,
          )?.population;

          if (!population)
            throw new Error("Coverage group omitted its original full population seed");

          mkdirSync(outputRoot, { recursive: true });

          mkdirSync(directory);

          bindCoverageOwnerRun({
            runId: run.artifacts.runId,
            outputDirectory: directory,
            population,
          });

          snapshotCoverageOwnerHits("driver");
        },
      });

      console.log(
        JSON.stringify({
          status: "completed",
          family: group,
          runId: run.artifacts.runId,
          bundlePath,
        }),
      );

      return;
    }

    if (familyRuns.length !== 4) {
      throw new Error("Final coverage did not complete all four source owners");
    }

    const finalRun = await mergeCoverageRuns({
      repoPath,
      expectedSources,
      runs: familyRuns.map((run) => run.artifacts),
      capture: async ({ population: admittedPopulation, coverage: preSupportCoverage }) => {
        if (preSupportCoverage.files().length !== admittedPopulation.files.length) {
          throw new Error("Pre-support coverage does not match the complete admitted population");
        }

        const preSupportLcovPath = join(outputDirectory!, `.coverage-pre-support-${runId}.lcov`);

        try {
          writeLcovReport(preSupportCoverage, preSupportLcovPath);

          const preSupportReport = checkCoverage({ lcovPath: preSupportLcovPath, repoPath });

          if (preSupportReport.unmeasuredSources.length > 0) {
            throw new Error("Pre-support coverage report omitted executable population sources");
          }
        } finally {
          if (existsSync(preSupportLcovPath) && statSync(preSupportLcovPath).isFile()) {
            rmSync(preSupportLcovPath);
          }
        }

        const canonical = await seedCoverageSources(expectedSources, repoPath);

        if (JSON.stringify(canonical.population) !== JSON.stringify(admittedPopulation)) {
          throw new Error(
            "Final coverage capture population differs from the admitted family runs",
          );
        }

        const canonicalSeed = createCoverageArtifact({
          repoPath,
          kind: "seed",
          runId: runId!,
          ownerId: "final-coverage-canonical",
          populationFingerprint: admittedPopulation.fingerprint,
          population: admittedPopulation,
          coverage: canonical.coverage,
        });

        writeCoverageFragment({
          directory: outputDirectory!,
          contextId: "final-coverage-canonical-seed",
          pid: process.pid,
          threadId: 0,
          repoPath,
          artifact: canonicalSeed,
          sourcePopulation: admittedPopulation,
        });

        bindCoverageOwnerRun({
          runId: runId!,
          outputDirectory: outputDirectory!,
          population: admittedPopulation,
        });

        snapshotCoverageOwnerHits("driver");

        const artifacts = readAggregateArtifacts(runId!, outputDirectory!);
        return {
          family: "final-aggregate",
          runId: runId!,
          platform: process.platform,
          seeds: artifacts.filter((artifact) => artifact.kind === "seed"),
          fragments: artifacts.filter((artifact) => artifact.kind === "hits"),
        };
      },
    });

    const finalLcovPath = join(outputDirectory!, "lcov.info");
    const candidateLcovPath = join(outputDirectory!, `.coverage-candidate-${runId}.lcov`);

    writeLcovReport(finalRun.coverage, candidateLcovPath);

    const coverage = checkCoverage({ lcovPath: candidateLcovPath, repoPath, threshold: 0 });

    if (coverage.unmeasuredSources.length > 0) {
      throw new Error("Final coverage report omitted executable population sources");
    }

    renameSync(candidateLcovPath, finalLcovPath);

    if (process.platform !== "win32" && process.platform !== "linux") {
      throw new Error(`Final platform coverage capture is unsupported on ${process.platform}`);
    }

    const platform = process.platform as CoveragePlatform;
    const platformCapture = createPlatformCoverageCapture({
      repoPath,
      platform,
      runId: runId!,
      population: finalRun.population,
      runs: familyRuns.map((run) => platformRunProvenance(run, repoPath)),
      coverage: finalRun.coverage,
    });
    const summary: FinalSummary = {
      format: "hesperia-final-coverage-run",
      version: 2,
      status: "completed",
      acceptance: "deferred-combined",
      runId: runId!,
      platform,
      outputDirectory: outputDirectory!,
      lcovPath: finalLcovPath,
      populationFingerprint: finalRun.population.fingerprint,
      sourceCount: finalRun.coverage.files().length,
      lineFound: coverage.lineFound,
      lineHit: coverage.lineHit,
      linePercent: coverage.linePercent,
      functionFound: coverage.functionFound,
      functionHit: coverage.functionHit,
      functionPercent: coverage.functionPercent,
      runs: [
        ...familyRuns.map(runProvenance),
        {
          family: "final-aggregate",
          runId,
          platform: finalRun.platform,
          outputDirectory,
          lcovPath: finalLcovPath,
        },
      ],
    };

    writeFileSync(
      join(outputDirectory!, "platform-coverage-capture.json"),
      JSON.stringify(platformCapture),
      { flag: "wx" },
    );

    writeFileSync(join(outputDirectory!, "final-coverage-summary.json"), JSON.stringify(summary), {
      flag: "wx",
    });

    console.log(JSON.stringify(summary));
  } catch (error) {
    if (outputDirectoryCreated && outputDirectory) {
      for (const name of [
        "lcov.info",
        ...(runId ? [`.coverage-candidate-${runId}.lcov`] : []),
        ...(runId ? [`.coverage-pre-support-${runId}.lcov`] : []),
        "final-coverage-summary.json",
        "platform-coverage-capture.json",
      ]) {
        const path = join(outputDirectory, name);

        if (existsSync(path) && statSync(path).isFile()) rmSync(path);
      }

      const failure: FinalSummary = {
        format: "hesperia-final-coverage-run",
        version: 2,
        status: "failed",
        runId: runId!,
        platform: process.platform,
        outputDirectory,
        runs: familyRuns.map(runProvenance),
        error: error instanceof Error ? error.message : String(error),
      };

      try {
        writeFileSync(
          join(outputDirectory!, "final-coverage-summary.json"),
          JSON.stringify(failure),
          {
            flag: "wx",
          },
        );
      } catch {}
    }

    console.error(
      JSON.stringify({
        status: "failed",
        ...(runId === undefined ? {} : { runId }),
        ...(outputDirectory === undefined ? {} : { outputDirectory }),
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
