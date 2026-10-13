import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { threadId } from "node:worker_threads";
import {
  createCoverageArtifact,
  writeCoverageFragment,
  type CoverageFile,
  type CoveragePopulation,
} from "./coverage-collector.ts";

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface InstalledCliAdapterInput {
  readonly cwd: string;
  readonly execPath: string;
  readonly args: readonly string[];
}

interface ConfiguredPluginBuildAdapterInput {
  readonly cwd: string;
  readonly execPath: string;
  readonly entryPath: string;
  readonly args: readonly string[];
}

interface CreatorCliAdapterInput {
  readonly cwd: string;
  readonly execPath: string;
  readonly entryPath: string;
  readonly args: readonly string[];
  readonly preload?: string;
  readonly env: Record<string, string | undefined>;
}

interface CreatorCaptureProfileSource {
  readonly source: string;
  readonly path: string;
  readonly runtimeHash: string;
  readonly runtimeSchema: string;
  readonly seed: CoverageFile;
}

interface CreatorCaptureProfile {
  readonly format: "hesperia-creator-cli-profile";
  readonly version: 1;
  readonly runId: string;
  readonly ownerId: string;
  readonly populationFingerprint: string;
  readonly outputDirectory: string;
  readonly sourcePopulation: CoveragePopulation;
  readonly childPreloadPath: string;
  readonly sources: readonly CreatorCaptureProfileSource[];
}

interface CreatorChildConfiguration {
  readonly format: "hesperia-creator-cli-invocation";
  readonly version: 1;
  readonly runId: string;
  readonly ownerId: string;
  readonly populationFingerprint: string;
  readonly outputDirectory: string;
  readonly profilePath: string;
  readonly receiptPath: string;
  readonly contextId: string;
  readonly invocationId: string;
  readonly parentPid: number;
  readonly expectedExecPath: string;
  readonly expectedCwd: string;
  readonly expectedEntryPath: string;
  readonly expectedEntryRealPath: string;
  readonly expectedArgs: readonly string[];
}

interface CreatorChildReceipt {
  readonly format: "hesperia-creator-cli-capture";
  readonly version: 1;
  readonly runId: string;
  readonly ownerId: string;
  readonly populationFingerprint: string;
  readonly contextId: string;
  readonly invocationId: string;
  readonly parentPid: number;
  readonly pid: number;
  readonly execPath: string;
  readonly cwd: string;
  readonly processArgv: readonly string[];
  readonly bunArgv: readonly string[];
  readonly naturalExitCode: number;
  readonly capturedSources: readonly string[];
  readonly captureErrors: readonly string[];
  readonly hitArtifactPath?: string;
  readonly hitArtifactSha256?: string;
}

interface CreatorCaptureState {
  readonly configuration?: CreatorChildConfiguration;
  readonly errors: string[];
  readonly capturedSources: string[];
  profile?: CreatorCaptureProfile;
}

interface WorkerOutput {
  readonly originalPath: string;
  readonly compiledPath: string;
}

interface WorkerTemplate {
  readonly seedCoverage: Record<string, CoverageFile>;
  readonly sourcePopulation: CoveragePopulation;
}

interface ChildCaptureConfiguration {
  readonly mode: "installed-cli" | "configured-plugin-build";
  readonly runId: string;
  readonly ownerId: string;
  readonly populationFingerprint: string;
  readonly outputDirectory: string;
  readonly workerTemplatePath: string;
  readonly entryPath: string;
  readonly entryRealPath: string;
  readonly entrySha256: string;
  readonly relativeImports: readonly string[];
  readonly graphEntryPath: string;
  readonly graphEntrySha256: string;
  readonly runtimeHash: string;
  readonly runtimeSchema: string;
  readonly helperRuntimeHash: string;
  readonly helperRuntimeSchema: string;
  readonly childPreloadPath: string;
  readonly contextId: string;
  readonly invocationId: string;
  readonly receiptPath: string;
  readonly parentPid: number;
  readonly expectedExecPath: string;
  readonly expectedCwd: string;
  readonly expectedArgs: readonly string[];
}

interface ChildCaptureReceipt {
  readonly format: "hesperia-installed-cli-capture" | "hesperia-configured-plugin-build-capture";
  readonly version: 1;
  readonly mode: "installed-cli" | "configured-plugin-build";
  readonly runId: string;
  readonly ownerId: string;
  readonly populationFingerprint: string;
  readonly contextId: string;
  readonly invocationId: string;
  readonly parentPid: number;
  readonly pid: number;
  readonly execPath: string;
  readonly cwd: string;
  readonly processArgv: readonly string[];
  readonly bunArgv: readonly string[];
  readonly naturalExitCode: number;
  readonly entryLoadCount: number;
  readonly substitutedEntryPath?: string;
  readonly substitutedEntryRealPath?: string;
  readonly entrySha256?: string;
  readonly graphEntryPath: string;
  readonly graphEntrySha256: string;
  readonly onResolveRequests: readonly {
    readonly importer: string;
    readonly specifier: string;
    readonly returnedUndefined: true;
  }[];
  readonly captureErrors: readonly string[];
  readonly hitArtifactPath?: string;
  readonly hitArtifactSha256?: string;
}

interface CaptureState {
  readonly configuration?: ChildCaptureConfiguration;
  readonly errors: string[];
  readonly onResolveRequests: ChildCaptureReceipt["onResolveRequests"][number][];
  sourcePopulation?: CoveragePopulation;
  helperSeed?: CoverageFile;
  entryLoadCount: number;
  substitutedEntryPath?: string;
  substitutedEntryRealPath?: string;
  entrySha256?: string;
  hitArtifactPath?: string;
  hitArtifactSha256?: string;
}

const repoPath = resolve(import.meta.dir, "../..");
const cliSource = "packages/tooling/src/cli.ts";
const cliDist = "packages/tooling/dist/cli.js";
const installedCliChildSource = "scripts/ci/coverage-installed-cli.ts";
const coverageVariable = "__hesperiaCoverage__";
const installedCliChildMarker = "HESPERIA_COVERAGE_INSTALLED_CLI_CHILD";
const installedCliChildConfig = "HESPERIA_COVERAGE_INSTALLED_CLI_CONFIG";
const parentInvocationLimit = 4;
let parentInvocationCount = 0;
const creatorCliChildMarker = "HESPERIA_COVERAGE_CREATOR_CLI_CHILD";
const creatorCliChildConfig = "HESPERIA_COVERAGE_CREATOR_CLI_CONFIG";
const creatorCliProfileEnvironment = "HESPERIA_COVERAGE_CREATOR_CLI_PROFILE";
const creatorCliSource = "packages/create-hesperia/src/cli.ts";
const creatorCliSources = [
  installedCliChildSource,
  creatorCliSource,
  "packages/create-hesperia/src/templates/elysia.ts",
  "packages/create-hesperia/src/templates/frontend.ts",
] as const;
const creatorParentInvocationLimit = 8;
let creatorParentInvocationCount = 0;
const configuredPluginBuildChildMarker = "HESPERIA_COVERAGE_CONFIGURED_PLUGIN_BUILD_CHILD";
const configuredPluginBuildChildConfig = "HESPERIA_COVERAGE_CONFIGURED_PLUGIN_BUILD_CONFIG";
const configuredPluginBuildRuntimeEnvironment = "HESPERIA_COVERAGE_CONFIGURED_PLUGIN_RUNTIME";
const configuredPluginBuildAdapterEnvironment = "HESPERIA_CONFIGURED_PLUGIN_BUILD_ADAPTER";
const configuredPluginBuildParentInvocationLimit = 2;
let configuredPluginBuildParentInvocationCount = 0;
let configuredPluginBuildCwd: string | undefined;

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativeCliImports(bytes: Buffer): readonly string[] {
  const source = bytes.toString("utf8").replace(/^#![^\r\n]*/u, "");
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(source);

  return imports
    .filter((item) => item.kind === "import-statement" && /^\.\.?\//u.test(item.path))
    .map((item) => item.path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasCoverageHits(coverage: CoverageFile): boolean {
  return (
    Object.values(coverage.s).some((count) => count > 0) ||
    Object.values(coverage.f).some((count) => count > 0) ||
    Object.values(coverage.b).some((counts) => counts.some((count) => count > 0))
  );
}

function matchesPreparedHelperMaps(actual: CoverageFile, prepared: CoverageFile): boolean {
  return (
    canonicalPath(actual.path) === canonicalPath(prepared.path) &&
    JSON.stringify(actual.statementMap) === JSON.stringify(prepared.statementMap) &&
    JSON.stringify(actual.fnMap) === JSON.stringify(prepared.fnMap) &&
    JSON.stringify(actual.branchMap) === JSON.stringify(prepared.branchMap) &&
    JSON.stringify(actual.inputSourceMap) === JSON.stringify(prepared.inputSourceMap) &&
    actual.__hesperiaInstrumentedSourceSha256 === prepared.__hesperiaInstrumentedSourceSha256
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Installed CLI coverage is missing ${name}`);

  return value;
}

function readWorkerInputs(mode: ChildCaptureConfiguration["mode"] = "installed-cli"): {
  readonly runId: string;
  readonly ownerId: string;
  readonly outputDirectory: string;
  readonly workerTemplatePath: string;
  readonly workerOutputMapPath: string;
  readonly template: WorkerTemplate;
  readonly graphEntryPath: string;
  readonly graphEntrySha256: string;
  readonly runtimeHash: string;
  readonly runtimeSchema: string;
  readonly helperRuntimeHash: string;
  readonly helperRuntimeSchema: string;
  readonly childPreloadPath: string;
} {
  const runId = requiredEnvironment("HESPERIA_COVERAGE_RUN_ID");
  const ownerId = requiredEnvironment("HESPERIA_COVERAGE_OWNER_ID");

  if (ownerId !== "bun-tests")
    throw new Error("Installed CLI coverage requires the bun-tests owner");

  const outputDirectory = resolve(requiredEnvironment("HESPERIA_COVERAGE_OUTPUT_DIR"));
  const workerTemplatePath = resolve(requiredEnvironment("HESPERIA_COVERAGE_WORKER_TEMPLATE"));
  const workerOutputMapPath = resolve(requiredEnvironment("HESPERIA_COVERAGE_WORKER_OUTPUT_MAP"));
  const runtimeMetadata = JSON.parse(
    requiredEnvironment(
      mode === "installed-cli"
        ? "HESPERIA_COVERAGE_INSTALLED_CLI_RUNTIME"
        : configuredPluginBuildRuntimeEnvironment,
    ),
  ) as unknown;

  if (
    !isRecord(runtimeMetadata) ||
    typeof runtimeMetadata.hash !== "string" ||
    !/^[a-f0-9]{40}$/u.test(runtimeMetadata.hash) ||
    typeof runtimeMetadata.schema !== "string" ||
    !/^[a-f0-9]{40}$/u.test(runtimeMetadata.schema) ||
    typeof runtimeMetadata.helperHash !== "string" ||
    !/^[a-f0-9]{40}$/u.test(runtimeMetadata.helperHash) ||
    typeof runtimeMetadata.helperSchema !== "string" ||
    !/^[a-f0-9]{40}$/u.test(runtimeMetadata.helperSchema) ||
    typeof runtimeMetadata.childPreloadPath !== "string"
  ) {
    throw new Error("Installed CLI coverage runtime identity is malformed");
  }

  const childPreloadPath = resolve(runtimeMetadata.childPreloadPath);
  const expectedChildPreloadPath = resolve(
    repoPath,
    ".hesperia",
    "coverage",
    "bootstrap-builds",
    runId,
    `${mode}-child`,
    "bootstrap-preload.ts",
  );

  if (
    canonicalPath(childPreloadPath) !== canonicalPath(expectedChildPreloadPath) ||
    !existsSync(childPreloadPath)
  ) {
    throw new Error("Installed CLI child bootstrap is missing or stale");
  }

  const template = JSON.parse(readFileSync(workerTemplatePath, "utf8")) as WorkerTemplate;

  if (
    !isRecord(template) ||
    !isRecord(template.seedCoverage) ||
    !isRecord(template.sourcePopulation) ||
    typeof template.sourcePopulation.fingerprint !== "string" ||
    !Array.isArray(template.sourcePopulation.files)
  ) {
    throw new Error("Installed CLI coverage graph template is malformed");
  }

  const authoredPath = resolve(repoPath, cliSource.replaceAll("/", sep));
  const seedRecords = Object.values(template.seedCoverage).filter(
    (coverage) => canonicalPath(coverage.path) === canonicalPath(authoredPath),
  );

  if (seedRecords.length !== 1) {
    throw new Error("Installed CLI coverage graph has no unique authored CLI seed");
  }

  const helperSourcePath = resolve(repoPath, installedCliChildSource.replaceAll("/", sep));
  const helperSeedRecords = Object.values(template.seedCoverage).filter(
    (coverage) => canonicalPath(coverage.path) === canonicalPath(helperSourcePath),
  );
  const helperPopulationRecords = template.sourcePopulation.files.filter(
    (file) => file.source === installedCliChildSource,
  );

  if (helperSeedRecords.length !== 1 || helperPopulationRecords.length !== 1) {
    throw new Error("Installed CLI coverage graph has no unique authored child-helper seed");
  }

  const normalCliPath = resolve(repoPath, cliDist.replaceAll("/", sep));
  const outputs = JSON.parse(readFileSync(workerOutputMapPath, "utf8")) as WorkerOutput[];

  if (!Array.isArray(outputs)) throw new Error("Installed CLI worker output map is malformed");

  const cliOutputs = outputs.filter(
    (output) => canonicalPath(output.originalPath) === canonicalPath(normalCliPath),
  );

  if (cliOutputs.length !== 1) {
    throw new Error("Installed CLI worker output map has no unique CLI entry");
  }

  const graphEntryPath = resolve(cliOutputs[0]!.compiledPath);

  if (!isWithin(dirname(workerTemplatePath), graphEntryPath) || !existsSync(graphEntryPath)) {
    throw new Error("Installed CLI worker output is missing or outside its fresh graph");
  }

  return {
    runId,
    ownerId,
    outputDirectory,
    workerTemplatePath,
    workerOutputMapPath,
    template,
    graphEntryPath,
    graphEntrySha256: sha256(readFileSync(graphEntryPath)),
    runtimeHash: runtimeMetadata.hash,
    runtimeSchema: runtimeMetadata.schema,
    helperRuntimeHash: runtimeMetadata.helperHash,
    helperRuntimeSchema: runtimeMetadata.helperSchema,
    childPreloadPath,
  };
}

function validateChildReceipt(
  value: unknown,
  configuration: ChildCaptureConfiguration,
  childPid: number,
  status: number,
): asserts value is ChildCaptureReceipt {
  if (isRecord(value) && isStringArray(value.captureErrors) && value.captureErrors.length > 0) {
    throw new Error(`Installed CLI child capture failed: ${value.captureErrors.join("; ")}`);
  }

  if (
    !isRecord(value) ||
    value.format !==
      (configuration.mode === "installed-cli"
        ? "hesperia-installed-cli-capture"
        : "hesperia-configured-plugin-build-capture") ||
    value.version !== 1 ||
    value.mode !== configuration.mode ||
    value.runId !== configuration.runId ||
    value.ownerId !== configuration.ownerId ||
    value.populationFingerprint !== configuration.populationFingerprint ||
    value.contextId !== configuration.contextId ||
    value.invocationId !== configuration.invocationId ||
    value.parentPid !== configuration.parentPid ||
    value.pid !== childPid ||
    value.execPath !== configuration.expectedExecPath ||
    canonicalPath(String(value.cwd)) !== canonicalPath(configuration.expectedCwd) ||
    value.naturalExitCode !== status ||
    value.entryLoadCount !== 1 ||
    typeof value.substitutedEntryPath !== "string" ||
    canonicalPath(value.substitutedEntryPath) !== canonicalPath(configuration.entryPath) ||
    typeof value.substitutedEntryRealPath !== "string" ||
    canonicalPath(value.substitutedEntryRealPath) !== canonicalPath(configuration.entryRealPath) ||
    value.entrySha256 !== configuration.entrySha256 ||
    value.graphEntryPath !== configuration.graphEntryPath ||
    value.graphEntrySha256 !== configuration.graphEntrySha256 ||
    !isStringArray(value.processArgv) ||
    !isStringArray(value.bunArgv) ||
    !Array.isArray(value.onResolveRequests) ||
    !Array.isArray(value.captureErrors) ||
    value.captureErrors.length !== 0 ||
    typeof value.hitArtifactPath !== "string" ||
    typeof value.hitArtifactSha256 !== "string"
  ) {
    throw new Error("Installed CLI child capture receipt is missing, malformed, or stale");
  }

  const expectedArgv = [configuration.expectedExecPath, ...configuration.expectedArgs];

  const actualArgvMatches = (actual: readonly string[]) =>
    actual.length === expectedArgv.length &&
    canonicalPath(actual[0]!) === canonicalPath(expectedArgv[0]!) &&
    canonicalPath(actual[1]!) === canonicalPath(expectedArgv[1]!) &&
    actual.slice(2).every((item, index) => item === expectedArgv[index + 2]);

  if (!actualArgvMatches(value.processArgv) || !actualArgvMatches(value.bunArgv)) {
    throw new Error("Installed CLI child arguments differ from the installed owner request");
  }

  const declaredImports = new Set(configuration.relativeImports);
  const entryPaths = new Set([
    canonicalPath(configuration.entryPath),
    canonicalPath(configuration.entryRealPath),
  ]);
  const observedImports = new Set<string>();

  for (const request of value.onResolveRequests) {
    if (
      !isRecord(request) ||
      typeof request.importer !== "string" ||
      typeof request.specifier !== "string" ||
      !entryPaths.has(canonicalPath(request.importer)) ||
      !declaredImports.has(request.specifier) ||
      request.returnedUndefined !== true
    ) {
      throw new Error("Installed CLI child changed a recorded relative import resolution");
    }

    observedImports.add(request.specifier);
  }

  if (observedImports.size !== declaredImports.size) {
    throw new Error("Installed CLI child did not observe every declared sibling import");
  }

  const hitPath = resolve(value.hitArtifactPath);

  if (
    !isWithin(configuration.outputDirectory, hitPath) ||
    sha256(readFileSync(hitPath)) !== value.hitArtifactSha256
  ) {
    throw new Error("Installed CLI child hit artifact is missing or has changed");
  }
}

async function runCapturedChild(
  configuration: ChildCaptureConfiguration,
  receiptDirectory: string,
  spawnArgs: string[],
  expectedStatus?: { readonly code: 0 | 1; readonly label: string },
): Promise<CommandResult> {
  const installedMode = configuration.mode === "installed-cli";
  const childEnvironment: Record<string, string | undefined> = { ...process.env };
  delete childEnvironment.BUN_OPTIONS;
  delete childEnvironment.NODE_OPTIONS;

  for (const key of Object.keys(childEnvironment)) {
    if (
      key.startsWith("HESPERIA_COVERAGE_") ||
      key.startsWith("HESPERIA_CLI_CAPTURE_") ||
      key === configuredPluginBuildAdapterEnvironment
    ) {
      delete childEnvironment[key];
    }
  }

  childEnvironment[installedMode ? installedCliChildMarker : configuredPluginBuildChildMarker] =
    "1";
  childEnvironment[installedMode ? installedCliChildConfig : configuredPluginBuildChildConfig] =
    JSON.stringify(configuration);
  const modeLabel = installedMode ? "Installed CLI" : "Configured plugin";

  try {
    const child = Bun.spawn(spawnArgs, {
      cwd: configuration.expectedCwd,
      env: childEnvironment,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    const streamsPromise = Promise.allSettled([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const status = await child.exited;
    const [stdoutResult, stderrResult] = await streamsPromise;

    if (child.signalCode !== null) {
      throw new Error(
        `${modeLabel} child was terminated by signal ${child.signalCode}; natural exit code was ${status}`,
      );
    }

    if (stdoutResult.status === "rejected" || stderrResult.status === "rejected") {
      const reasons = [stdoutResult, stderrResult]
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason));
      throw new Error(
        `${modeLabel} child exited naturally with ${status}, but output capture failed: ${reasons.join("; ")}`,
      );
    }

    const stdout = stdoutResult.value;
    const stderr = stderrResult.value;

    try {
      const receipt = JSON.parse(readFileSync(configuration.receiptPath, "utf8")) as unknown;

      validateChildReceipt(receipt, configuration, child.pid, status);

      if (expectedStatus && status !== expectedStatus.code) {
        throw new Error(
          `${expectedStatus.label} exited ${status}; expected its existing owner result ${expectedStatus.code}`,
        );
      }

      return { status, stdout, stderr };
    } catch (error) {
      throw new Error(
        `${modeLabel} coverage failed after natural child exit ${status}: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
      );
    }
  } finally {
    rmSync(receiptDirectory, { recursive: true, force: true });
  }
}

export async function runInstalledCli(input: InstalledCliAdapterInput): Promise<CommandResult> {
  if (process.env[installedCliChildMarker] === "1") {
    throw new Error("Installed CLI adapter cannot run inside its standalone child");
  }

  if (parentInvocationCount >= parentInvocationLimit) {
    throw new Error("Installed CLI coverage received more calls than its existing owner");
  }

  parentInvocationCount += 1;

  if (input.args.length < 2 || canonicalPath(input.execPath) !== canonicalPath(process.execPath)) {
    throw new Error("Installed CLI owner supplied an invalid executable or entry");
  }

  const workerInputs = readWorkerInputs("installed-cli");
  const expectedCwd = resolve(input.cwd);
  const entryPath = resolve(input.args[0]!);
  const expectedEntryPath = resolve(
    expectedCwd,
    "node_modules",
    "@hesperia",
    "tooling",
    "dist",
    "cli.js",
  );

  if (canonicalPath(entryPath) !== canonicalPath(expectedEntryPath)) {
    throw new Error("Installed CLI owner did not use its packed tooling entry");
  }

  const entryRealPath = realpathSync(entryPath);
  const normalEntryPath = resolve(repoPath, cliDist.replaceAll("/", sep));
  const installedEntryBytes = readFileSync(entryPath);
  const normalEntryBytes = readFileSync(normalEntryPath);

  if (!installedEntryBytes.equals(normalEntryBytes)) {
    throw new Error("Installed CLI bytes differ from the current package dist entry");
  }

  const entrySha256 = sha256(installedEntryBytes);
  const invocationId = `installed-cli-${parentInvocationCount}-${randomUUID()}`;
  const contextId = invocationId;
  const receiptDirectory = mkdtempSync(join(tmpdir(), "hesperia-installed-cli-"));
  const receiptPath = join(receiptDirectory, "child-receipt.json");
  const configuration: ChildCaptureConfiguration = {
    mode: "installed-cli",
    runId: workerInputs.runId,
    ownerId: workerInputs.ownerId,
    populationFingerprint: workerInputs.template.sourcePopulation.fingerprint,
    outputDirectory: workerInputs.outputDirectory,
    workerTemplatePath: workerInputs.workerTemplatePath,
    entryPath,
    entryRealPath,
    entrySha256,
    relativeImports: relativeCliImports(installedEntryBytes),
    graphEntryPath: workerInputs.graphEntryPath,
    graphEntrySha256: workerInputs.graphEntrySha256,
    runtimeHash: workerInputs.runtimeHash,
    runtimeSchema: workerInputs.runtimeSchema,
    helperRuntimeHash: workerInputs.helperRuntimeHash,
    helperRuntimeSchema: workerInputs.helperRuntimeSchema,
    childPreloadPath: workerInputs.childPreloadPath,
    contextId,
    invocationId,
    receiptPath,
    parentPid: process.pid,
    expectedExecPath: resolve(input.execPath),
    expectedCwd,
    expectedArgs: input.args,
  };
  const spawnArgs = [input.execPath, "--preload", configuration.childPreloadPath, ...input.args];
  return runCapturedChild(configuration, receiptDirectory, spawnArgs);
}

export async function runConfiguredPluginBuildCli(
  input: ConfiguredPluginBuildAdapterInput,
): Promise<CommandResult> {
  if (process.env[configuredPluginBuildChildMarker] === "1") {
    throw new Error("Configured plugin build adapter cannot run inside its standalone child");
  }

  if (configuredPluginBuildParentInvocationCount >= configuredPluginBuildParentInvocationLimit) {
    throw new Error("Configured plugin coverage received more calls than its existing owner");
  }

  const ordinal = ++configuredPluginBuildParentInvocationCount;

  if (
    canonicalPath(input.execPath) !== canonicalPath(process.execPath) ||
    input.args.length !== 1 ||
    input.args[0] !== "build"
  ) {
    throw new Error("Configured plugin owner supplied an invalid executable or build command");
  }

  const workerInputs = readWorkerInputs("configured-plugin-build");
  const expectedCwd = resolve(input.cwd);

  if (
    (configuredPluginBuildCwd &&
      canonicalPath(configuredPluginBuildCwd) !== canonicalPath(expectedCwd)) ||
    !isWithin(tmpdir(), expectedCwd) ||
    !existsSync(join(expectedCwd, "hesperia.config.ts"))
  ) {
    throw new Error("Configured plugin owner did not reuse its temporary project root");
  }

  configuredPluginBuildCwd = expectedCwd;

  const entryPath = resolve(input.entryPath);
  const expectedEntryPath = resolve(repoPath, cliDist.replaceAll("/", sep));

  if (canonicalPath(entryPath) !== canonicalPath(expectedEntryPath)) {
    throw new Error("Configured plugin owner did not use the current tooling CLI entry");
  }

  const entryRealPath = realpathSync(entryPath);
  const entryBytes = readFileSync(entryPath);
  const entrySha256 = sha256(entryBytes);
  const invocationId = `configured-plugin-build-${ordinal}-${randomUUID()}`;
  const contextId = `configured-plugin-build-${ordinal}`;
  const receiptDirectory = mkdtempSync(join(tmpdir(), "hesperia-configured-plugin-build-"));
  const receiptPath = join(receiptDirectory, "child-receipt.json");
  const configuration: ChildCaptureConfiguration = {
    mode: "configured-plugin-build",
    runId: workerInputs.runId,
    ownerId: workerInputs.ownerId,
    populationFingerprint: workerInputs.template.sourcePopulation.fingerprint,
    outputDirectory: workerInputs.outputDirectory,
    workerTemplatePath: workerInputs.workerTemplatePath,
    entryPath,
    entryRealPath,
    entrySha256,
    relativeImports: relativeCliImports(entryBytes),
    graphEntryPath: workerInputs.graphEntryPath,
    graphEntrySha256: workerInputs.graphEntrySha256,
    runtimeHash: workerInputs.runtimeHash,
    runtimeSchema: workerInputs.runtimeSchema,
    helperRuntimeHash: workerInputs.helperRuntimeHash,
    helperRuntimeSchema: workerInputs.helperRuntimeSchema,
    childPreloadPath: workerInputs.childPreloadPath,
    contextId,
    invocationId,
    receiptPath,
    parentPid: process.pid,
    expectedExecPath: resolve(input.execPath),
    expectedCwd,
    expectedArgs: [entryPath, ...input.args],
  };
  const spawnArgs = [
    input.execPath,
    "--preload",
    configuration.childPreloadPath,
    ...configuration.expectedArgs,
  ];
  const expectedStatus = ordinal === 1 ? 0 : 1;
  return runCapturedChild(configuration, receiptDirectory, spawnArgs, {
    code: expectedStatus,
    label: `Configured plugin build ${ordinal}`,
  });
}

function creatorProfileFromValue(
  value: unknown,
  profilePath: string,
  runId: string,
  ownerId: string,
  outputDirectory: string,
): CreatorCaptureProfile {
  const expectedProfilePath = resolve(
    repoPath,
    ".hesperia",
    "coverage",
    "bootstrap-builds",
    runId,
    "creator-cli-child",
    "creator-cli-profile.json",
  );

  if (
    canonicalPath(profilePath) !== canonicalPath(expectedProfilePath) ||
    !existsSync(profilePath) ||
    !isWithin(resolve(repoPath, ".hesperia", "coverage", "runs"), outputDirectory)
  ) {
    throw new Error("Creator CLI coverage profile is missing or outside its current run");
  }

  if (
    !isRecord(value) ||
    value.format !== "hesperia-creator-cli-profile" ||
    value.version !== 1 ||
    value.runId !== runId ||
    value.ownerId !== ownerId ||
    ownerId !== "bun-tests" ||
    value.outputDirectory !== outputDirectory ||
    typeof value.populationFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.populationFingerprint) ||
    !isRecord(value.sourcePopulation) ||
    value.sourcePopulation.schema !== 1 ||
    value.sourcePopulation.fingerprint !== value.populationFingerprint ||
    !Array.isArray(value.sourcePopulation.files) ||
    !Array.isArray(value.sources)
  ) {
    throw new Error("Creator CLI coverage profile is malformed or stale");
  }

  const expectedPreloadPath = resolve(
    repoPath,
    ".hesperia",
    "coverage",
    "bootstrap-builds",
    runId,
    "creator-cli-child",
    "bootstrap-preload.ts",
  );

  if (
    typeof value.childPreloadPath !== "string" ||
    canonicalPath(value.childPreloadPath) !== canonicalPath(expectedPreloadPath) ||
    !existsSync(value.childPreloadPath) ||
    value.sources.length !== creatorCliSources.length
  ) {
    throw new Error("Creator CLI child preload or source profile is incomplete");
  }

  const sourcePopulation = value.sourcePopulation as unknown as CoveragePopulation;

  for (let index = 0; index < creatorCliSources.length; index += 1) {
    const expectedSource = creatorCliSources[index]!;
    const source = value.sources[index];

    if (
      !isRecord(source) ||
      source.source !== expectedSource ||
      typeof source.path !== "string" ||
      canonicalPath(source.path) !==
        canonicalPath(resolve(repoPath, expectedSource.replaceAll("/", sep))) ||
      typeof source.runtimeHash !== "string" ||
      !/^[a-f0-9]{40}$/u.test(source.runtimeHash) ||
      typeof source.runtimeSchema !== "string" ||
      !/^[a-f0-9]{40}$/u.test(source.runtimeSchema) ||
      !isRecord(source.seed) ||
      typeof source.seed.path !== "string" ||
      canonicalPath(source.seed.path) !== canonicalPath(source.path) ||
      !isRecord(source.seed.statementMap) ||
      !isRecord(source.seed.fnMap) ||
      !isRecord(source.seed.branchMap)
    ) {
      throw new Error(`Creator CLI profile has an invalid prepared source: ${expectedSource}`);
    }

    const populationRecords = sourcePopulation.files.filter(
      (file) => isRecord(file) && file.source === expectedSource,
    );

    if (populationRecords.length !== 1) {
      throw new Error(`Creator CLI profile population omitted ${expectedSource}`);
    }
  }

  return value as unknown as CreatorCaptureProfile;
}

function creatorProfileFromEnvironment(): CreatorCaptureProfile {
  const runId = requiredEnvironment("HESPERIA_COVERAGE_RUN_ID");
  const ownerId = requiredEnvironment("HESPERIA_COVERAGE_OWNER_ID");
  const outputDirectory = resolve(requiredEnvironment("HESPERIA_COVERAGE_OUTPUT_DIR"));
  const profilePath = resolve(requiredEnvironment(creatorCliProfileEnvironment));
  return creatorProfileFromValue(
    JSON.parse(readFileSync(profilePath, "utf8")) as unknown,
    profilePath,
    runId,
    ownerId,
    outputDirectory,
  );
}

function validateCreatorChildReceipt(
  value: unknown,
  configuration: CreatorChildConfiguration,
  profile: CreatorCaptureProfile,
  childPid: number,
  status: number,
): asserts value is CreatorChildReceipt {
  if (
    !isRecord(value) ||
    value.format !== "hesperia-creator-cli-capture" ||
    value.version !== 1 ||
    value.runId !== configuration.runId ||
    value.ownerId !== configuration.ownerId ||
    value.populationFingerprint !== configuration.populationFingerprint ||
    value.contextId !== configuration.contextId ||
    value.invocationId !== configuration.invocationId ||
    value.parentPid !== configuration.parentPid ||
    value.pid !== childPid ||
    value.execPath !== configuration.expectedExecPath ||
    canonicalPath(String(value.cwd)) !== canonicalPath(configuration.expectedCwd) ||
    value.naturalExitCode !== status ||
    !isStringArray(value.processArgv) ||
    !isStringArray(value.bunArgv) ||
    !isStringArray(value.capturedSources) ||
    !Array.isArray(value.captureErrors) ||
    value.captureErrors.length !== 0 ||
    typeof value.hitArtifactPath !== "string" ||
    typeof value.hitArtifactSha256 !== "string"
  ) {
    throw new Error("Creator CLI child capture receipt is missing, malformed, or stale");
  }

  const expectedArgv = [
    configuration.expectedExecPath,
    configuration.expectedEntryPath,
    ...configuration.expectedArgs,
  ];

  const actualArgvMatches = (actual: readonly string[]) =>
    actual.length === expectedArgv.length &&
    canonicalPath(actual[0]!) === canonicalPath(expectedArgv[0]!) &&
    canonicalPath(actual[1]!) === canonicalPath(expectedArgv[1]!) &&
    actual.slice(2).every((item, index) => item === expectedArgv[index + 2]);

  const expectedSources = profile.sources.map((source) => source.source).sort();

  if (
    !actualArgvMatches(value.processArgv) ||
    !actualArgvMatches(value.bunArgv) ||
    canonicalPath(configuration.expectedEntryPath) !==
      canonicalPath(resolve(repoPath, creatorCliSource.replaceAll("/", sep))) ||
    canonicalPath(configuration.expectedEntryRealPath) !==
      canonicalPath(realpathSync(configuration.expectedEntryPath)) ||
    JSON.stringify([...value.capturedSources].sort()) !== JSON.stringify(expectedSources)
  ) {
    throw new Error("Creator CLI child identity or captured source set differs from its profile");
  }

  const hitPath = resolve(value.hitArtifactPath);

  if (
    !isWithin(configuration.outputDirectory, hitPath) ||
    sha256(readFileSync(hitPath)) !== value.hitArtifactSha256
  ) {
    throw new Error("Creator CLI child hit artifact is missing or has changed");
  }
}

export async function runCreatorCli(input: CreatorCliAdapterInput): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  if (process.env[creatorCliChildMarker] === "1") {
    throw new Error("Creator CLI adapter cannot run inside its standalone child");
  }

  if (creatorParentInvocationCount >= creatorParentInvocationLimit) {
    throw new Error("Creator CLI coverage received more calls than its existing owner");
  }

  creatorParentInvocationCount += 1;

  if (canonicalPath(input.execPath) !== canonicalPath(process.execPath)) {
    throw new Error("Creator CLI owner supplied an unexpected executable");
  }

  const profile = creatorProfileFromEnvironment();
  const expectedEntryPath = resolve(input.entryPath);

  if (
    canonicalPath(expectedEntryPath) !==
    canonicalPath(resolve(repoPath, creatorCliSource.replaceAll("/", sep)))
  ) {
    throw new Error("Creator CLI owner supplied an unexpected authored entry");
  }

  const expectedEntryRealPath = realpathSync(expectedEntryPath);
  const expectedCwd = resolve(input.cwd);
  const invocationId = `creator-cli-${creatorParentInvocationCount}-${randomUUID()}`;
  const contextId = invocationId;
  const receiptDirectory = mkdtempSync(join(tmpdir(), "hesperia-creator-cli-"));
  const receiptPath = join(receiptDirectory, "child-receipt.json");
  const configuration: CreatorChildConfiguration = {
    format: "hesperia-creator-cli-invocation",
    version: 1,
    runId: profile.runId,
    ownerId: profile.ownerId,
    populationFingerprint: profile.populationFingerprint,
    outputDirectory: profile.outputDirectory,
    profilePath: resolve(requiredEnvironment(creatorCliProfileEnvironment)),
    receiptPath,
    contextId,
    invocationId,
    parentPid: process.pid,
    expectedExecPath: resolve(input.execPath),
    expectedCwd,
    expectedEntryPath,
    expectedEntryRealPath,
    expectedArgs: input.args,
  };
  const configPath = join(receiptDirectory, "child-config.json");

  writeFileSync(configPath, JSON.stringify(configuration), { flag: "wx" });

  const childEnvironment: Record<string, string | undefined> = { ...input.env };
  delete childEnvironment.BUN_OPTIONS;
  delete childEnvironment.NODE_OPTIONS;

  for (const key of Object.keys(childEnvironment)) {
    if (
      key.startsWith("HESPERIA_COVERAGE_") ||
      key.startsWith("HESPERIA_CLI_CAPTURE_") ||
      key.startsWith("HESPERIA_CREATOR_CLI_CAPTURE_")
    ) {
      delete childEnvironment[key];
    }
  }

  childEnvironment[creatorCliChildMarker] = "1";
  childEnvironment[creatorCliChildConfig] = configPath;
  const spawnArgs = [input.execPath, "--preload", profile.childPreloadPath];

  if (input.preload) spawnArgs.push("--preload", input.preload);

  spawnArgs.push(input.entryPath, ...input.args);

  try {
    const child = Bun.spawn(spawnArgs, {
      cwd: expectedCwd,
      env: childEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const streamsPromise = Promise.allSettled([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const status = await child.exited;
    const [stdoutResult, stderrResult] = await streamsPromise;

    if (child.signalCode !== null) {
      throw new Error(
        `Creator CLI child was terminated by signal ${child.signalCode}; natural exit code was ${status}`,
      );
    }

    if (stdoutResult.status === "rejected" || stderrResult.status === "rejected") {
      const reasons = [stdoutResult, stderrResult]
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason));
      throw new Error(
        `Creator CLI child exited naturally with ${status}, but output capture failed: ${reasons.join("; ")}`,
      );
    }

    const stdout = stdoutResult.value;
    const stderr = stderrResult.value;

    try {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;

      validateCreatorChildReceipt(receipt, configuration, profile, child.pid, status);

      return { exitCode: status, stdout, stderr };
    } catch (error) {
      throw new Error(
        `Creator CLI coverage failed after natural child exit ${status}: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
      );
    }
  } finally {
    rmSync(receiptDirectory, { recursive: true, force: true });
  }
}

function childConfiguration(): ChildCaptureConfiguration | undefined {
  const installedMode = process.env[installedCliChildMarker] === "1";
  const configuredMode = process.env[configuredPluginBuildChildMarker] === "1";

  if (installedMode === configuredMode) return undefined;

  const mode = installedMode ? "installed-cli" : "configured-plugin-build";
  const raw =
    process.env[installedMode ? installedCliChildConfig : configuredPluginBuildChildConfig];

  if (!raw) return undefined;

  try {
    const configuration = JSON.parse(raw) as ChildCaptureConfiguration;
    return configuration.mode === mode && isStringArray(configuration.relativeImports)
      ? configuration
      : undefined;
  } catch {
    return undefined;
  }
}

function installChildCapture(): void {
  const configuration = childConfiguration();
  const state: CaptureState = {
    ...(configuration ? { configuration } : {}),
    errors: [],
    onResolveRequests: [],
    entryLoadCount: 0,
  };

  if (!configuration) state.errors.push("Standalone child configuration is missing or malformed");

  if (configuration) {
    try {
      const template = JSON.parse(
        readFileSync(configuration.workerTemplatePath, "utf8"),
      ) as WorkerTemplate;
      const population = template.sourcePopulation;

      if (population.fingerprint !== configuration.populationFingerprint) {
        throw new Error("Standalone child graph seed does not match its run population");
      }

      state.sourcePopulation = population;
      const helperSourcePath = resolve(repoPath, installedCliChildSource.replaceAll("/", sep));
      const helperSeedRecords = Object.values(template.seedCoverage).filter(
        (coverage) => canonicalPath(coverage.path) === canonicalPath(helperSourcePath),
      );
      const helperPopulationRecords = population.files.filter(
        (file) => file.source === installedCliChildSource,
      );

      if (helperSeedRecords.length !== 1 || helperPopulationRecords.length !== 1) {
        throw new Error("Standalone child graph has no unique authored helper seed");
      }

      state.helperSeed = helperSeedRecords[0];
      const expectedChildPreloadPath = resolve(
        repoPath,
        ".hesperia",
        "coverage",
        "bootstrap-builds",
        configuration.runId,
        `${configuration.mode}-child`,
        "bootstrap-preload.ts",
      );

      if (
        canonicalPath(configuration.childPreloadPath) !== canonicalPath(expectedChildPreloadPath) ||
        !existsSync(configuration.childPreloadPath) ||
        !/^[a-f0-9]{40}$/u.test(configuration.helperRuntimeHash) ||
        !/^[a-f0-9]{40}$/u.test(configuration.helperRuntimeSchema)
      ) {
        throw new Error("Standalone child helper runtime identity or bootstrap is stale");
      }

      const graphBytes = readFileSync(configuration.graphEntryPath);

      if (sha256(graphBytes) !== configuration.graphEntrySha256) {
        throw new Error("Standalone child graph entry changed after parent validation");
      }

      const entryPaths = new Set([
        canonicalPath(configuration.entryPath),
        canonicalPath(configuration.entryRealPath),
      ]);
      const expectedImports = new Set(configuration.relativeImports);
      const entryFilter = new RegExp(
        `^(?:${escapeRegex(configuration.entryPath)}|${escapeRegex(configuration.entryRealPath)})$`,
        process.platform === "win32" ? "iu" : "u",
      );

      Bun.plugin({
        name: "hesperia-installed-cli-coverage",

        setup(build) {
          build.onResolve({ filter: /^\.\.?\//u }, (args) => {
            if (entryPaths.has(canonicalPath(args.importer))) {
              state.onResolveRequests.push({
                importer: args.importer,
                specifier: args.path,
                returnedUndefined: true,
              });

              if (!expectedImports.has(args.path)) {
                state.errors.push(`Unexpected installed CLI relative import: ${args.path}`);
              }
            }

            return undefined;
          });

          build.onLoad({ filter: entryFilter }, (args) => {
            state.entryLoadCount += 1;
            let installedBytes: Buffer | undefined;

            try {
              if (state.entryLoadCount !== 1) {
                throw new Error("Installed CLI entry loaded more than once");
              }

              installedBytes = readFileSync(args.path);
              const originalSha256 = sha256(installedBytes);
              state.substitutedEntryPath = args.path;
              state.entrySha256 = originalSha256;
              const realPath = realpathSync(args.path);

              if (!entryPaths.has(canonicalPath(realPath))) {
                throw new Error("Installed CLI loader resolved an unexpected entry path");
              }

              if (originalSha256 !== configuration.entrySha256) {
                throw new Error("Installed CLI entry changed after parent validation");
              }

              const compiledBytes = readFileSync(configuration.graphEntryPath);

              if (sha256(compiledBytes) !== configuration.graphEntrySha256) {
                throw new Error("Installed CLI worker output changed during capture");
              }

              state.substitutedEntryRealPath = realPath;
              return { contents: compiledBytes.toString("utf8"), loader: "js" };
            } catch (error) {
              state.errors.push(error instanceof Error ? error.message : String(error));

              if (installedBytes)
                return { contents: installedBytes.toString("utf8"), loader: "js" };

              return undefined;
            }
          });
        },
      });
    } catch (error) {
      state.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  process.once("exit", (naturalExitCode) => {
    const configuration = state.configuration;

    if (!configuration) return;

    const declaredImports = new Set(configuration.relativeImports);
    const observedImports = new Set(state.onResolveRequests.map((request) => request.specifier));

    if (state.entryLoadCount !== 1 || !state.substitutedEntryPath) {
      state.errors.push("Installed CLI entry was not substituted exactly once");
    }

    if ([...declaredImports].some((specifier) => !observedImports.has(specifier))) {
      state.errors.push("Installed CLI sibling import resolution was incomplete");
    }

    let hitArtifactPath: string | undefined;
    let hitArtifactSha256: string | undefined;

    if (state.errors.length === 0) {
      try {
        const raw = Reflect.get(globalThis, coverageVariable) as
          | Record<string, CoverageFile>
          | undefined;
        const expectedRecords = [
          {
            source: cliSource,
            hash: configuration.runtimeHash,
            schema: configuration.runtimeSchema,
          },
          {
            source: installedCliChildSource,
            hash: configuration.helperRuntimeHash,
            schema: configuration.helperRuntimeSchema,
          },
        ].map((expected) => ({
          ...expected,
          path: resolve(repoPath, expected.source.replaceAll("/", sep)),
        }));
        const records = new Map<string, CoverageFile>();

        for (const [path, coverage] of Object.entries(raw ?? {})) {
          const expected = expectedRecords.find(
            (item) => canonicalPath(path) === canonicalPath(item.path),
          );

          if (!expected) continue;

          const key = canonicalPath(expected.path);

          if (canonicalPath(coverage.path) !== key || records.has(key)) {
            throw new Error(
              `Standalone child produced an ambiguous authored record: ${expected.source}`,
            );
          }

          if (coverage.hash !== expected.hash || coverage._coverageSchema !== expected.schema) {
            throw new Error(
              `Standalone child runtime hash or coverage schema differs for ${expected.source}`,
            );
          }

          if (!hasCoverageHits(coverage)) {
            throw new Error(`Standalone child produced no genuine hits for ${expected.source}`);
          }

          if (
            expected.source === installedCliChildSource &&
            (!state.helperSeed || !matchesPreparedHelperMaps(coverage, state.helperSeed))
          ) {
            throw new Error(
              "Standalone child helper maps differ from its prepared authored source",
            );
          }

          records.set(key, coverage);
        }

        if (records.size !== expectedRecords.length) {
          throw new Error("Standalone child did not produce exactly its CLI and helper records");
        }

        const sourcePopulation = state.sourcePopulation;

        if (!sourcePopulation)
          throw new Error("Standalone child has no validated source population");

        const coverage = Object.fromEntries(
          expectedRecords.map((expected) => {
            const record = records.get(canonicalPath(expected.path));

            if (!record) throw new Error(`Standalone child record is missing: ${expected.source}`);

            return [record.path, record] as const;
          }),
        );
        const artifact = createCoverageArtifact({
          repoPath,
          kind: "hits",
          runId: configuration.runId,
          ownerId: configuration.ownerId,
          populationFingerprint: configuration.populationFingerprint,
          sourcePopulation,
          coverage,
        });
        hitArtifactPath = writeCoverageFragment({
          directory: configuration.outputDirectory,
          contextId: `${configuration.contextId}-hits`,
          pid: process.pid,
          threadId,
          repoPath,
          artifact,
          sourcePopulation,
        });
        hitArtifactSha256 = sha256(readFileSync(hitArtifactPath));
        state.hitArtifactPath = hitArtifactPath;
        state.hitArtifactSha256 = hitArtifactSha256;
      } catch (error) {
        state.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const receipt: ChildCaptureReceipt = {
      format:
        configuration.mode === "installed-cli"
          ? "hesperia-installed-cli-capture"
          : "hesperia-configured-plugin-build-capture",
      version: 1,
      mode: configuration.mode,
      runId: configuration.runId,
      ownerId: configuration.ownerId,
      populationFingerprint: configuration.populationFingerprint,
      contextId: configuration.contextId,
      invocationId: configuration.invocationId,
      parentPid: process.ppid,
      pid: process.pid,
      execPath: process.execPath,
      cwd: process.cwd(),
      processArgv: [...process.argv],
      bunArgv: [...Bun.argv],
      naturalExitCode,
      entryLoadCount: state.entryLoadCount,
      ...(state.substitutedEntryPath ? { substitutedEntryPath: state.substitutedEntryPath } : {}),
      ...(state.substitutedEntryRealPath
        ? { substitutedEntryRealPath: state.substitutedEntryRealPath }
        : {}),
      ...(state.entrySha256 ? { entrySha256: state.entrySha256 } : {}),
      graphEntryPath: configuration.graphEntryPath,
      graphEntrySha256: configuration.graphEntrySha256,
      onResolveRequests: state.onResolveRequests,
      captureErrors: state.errors,
      ...(hitArtifactPath ? { hitArtifactPath } : {}),
      ...(hitArtifactSha256 ? { hitArtifactSha256 } : {}),
    };

    try {
      writeFileSync(configuration.receiptPath, JSON.stringify(receipt), { flag: "wx" });
    } catch {}
  });
}

function creatorChildConfiguration(): CreatorChildConfiguration | undefined {
  if (process.env[creatorCliChildMarker] !== "1") return undefined;

  const configPath = process.env[creatorCliChildConfig];

  if (!configPath) return undefined;

  try {
    const value = JSON.parse(readFileSync(configPath, "utf8")) as unknown;

    if (
      !isRecord(value) ||
      value.format !== "hesperia-creator-cli-invocation" ||
      value.version !== 1 ||
      typeof value.runId !== "string" ||
      typeof value.ownerId !== "string" ||
      typeof value.populationFingerprint !== "string" ||
      typeof value.outputDirectory !== "string" ||
      typeof value.profilePath !== "string" ||
      typeof value.receiptPath !== "string" ||
      typeof value.contextId !== "string" ||
      typeof value.invocationId !== "string" ||
      !Number.isSafeInteger(value.parentPid) ||
      typeof value.expectedExecPath !== "string" ||
      typeof value.expectedCwd !== "string" ||
      typeof value.expectedEntryPath !== "string" ||
      typeof value.expectedEntryRealPath !== "string" ||
      !isStringArray(value.expectedArgs)
    ) {
      return undefined;
    }

    return value as unknown as CreatorChildConfiguration;
  } catch {
    return undefined;
  }
}

function installCreatorChildCapture(): void {
  const configuration = creatorChildConfiguration();
  const state: CreatorCaptureState = {
    ...(configuration ? { configuration } : {}),
    errors: [],
    capturedSources: [],
  };

  if (!configuration) state.errors.push("Creator CLI child configuration is missing or malformed");

  if (configuration) {
    try {
      state.profile = creatorProfileFromValue(
        JSON.parse(readFileSync(configuration.profilePath, "utf8")) as unknown,
        configuration.profilePath,
        configuration.runId,
        configuration.ownerId,
        configuration.outputDirectory,
      );

      if (
        state.profile.populationFingerprint !== configuration.populationFingerprint ||
        canonicalPath(configuration.expectedExecPath) !== canonicalPath(process.execPath) ||
        canonicalPath(configuration.expectedEntryPath) !==
          canonicalPath(resolve(repoPath, creatorCliSource.replaceAll("/", sep))) ||
        canonicalPath(configuration.expectedEntryRealPath) !==
          canonicalPath(realpathSync(configuration.expectedEntryPath))
      ) {
        throw new Error(
          "Creator CLI child configuration does not match its prepared owner profile",
        );
      }
    } catch (error) {
      state.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  process.once("exit", (naturalExitCode) => {
    const configuration = state.configuration;

    if (!configuration) return;

    let hitArtifactPath: string | undefined;
    let hitArtifactSha256: string | undefined;

    if (state.errors.length === 0 && state.profile) {
      try {
        const raw = Reflect.get(globalThis, coverageVariable) as
          | Record<string, CoverageFile>
          | undefined;

        if (!raw || !isRecord(raw)) {
          throw new Error("Creator CLI child has no ordinary coverage runtime counters");
        }

        const captured = new Map<string, CoverageFile>();

        for (const prepared of state.profile.sources) {
          const expectedPath = canonicalPath(prepared.path);
          const records = Object.entries(raw).filter(
            ([path, coverage]) =>
              canonicalPath(path) === expectedPath && canonicalPath(coverage.path) === expectedPath,
          );

          if (records.length !== 1) {
            throw new Error(`Creator CLI child omitted or duplicated ${prepared.source}`);
          }

          const coverage = records[0]![1];

          if (!matchesCreatorPreparedSource(coverage, prepared) || !hasCoverageHits(coverage)) {
            throw new Error(
              `Creator CLI child runtime maps, source identity, or genuine hits differ for ${prepared.source}`,
            );
          }

          captured.set(expectedPath, coverage);

          state.capturedSources.push(prepared.source);
        }

        const coverage = Object.fromEntries(
          state.profile.sources.map((prepared) => {
            const record = captured.get(canonicalPath(prepared.path));

            if (!record) throw new Error(`Creator CLI child record is missing: ${prepared.source}`);

            return [record.path, record] as const;
          }),
        );
        const artifact = createCoverageArtifact({
          repoPath,
          kind: "hits",
          runId: state.profile.runId,
          ownerId: state.profile.ownerId,
          populationFingerprint: state.profile.populationFingerprint,
          sourcePopulation: state.profile.sourcePopulation,
          coverage,
        });
        hitArtifactPath = writeCoverageFragment({
          directory: state.profile.outputDirectory,
          contextId: `${configuration.contextId}-hits`,
          pid: process.pid,
          threadId,
          repoPath,
          artifact,
          sourcePopulation: state.profile.sourcePopulation,
        });
        hitArtifactSha256 = sha256(readFileSync(hitArtifactPath));
      } catch (error) {
        state.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const receipt: CreatorChildReceipt = {
      format: "hesperia-creator-cli-capture",
      version: 1,
      runId: configuration.runId,
      ownerId: configuration.ownerId,
      populationFingerprint: configuration.populationFingerprint,
      contextId: configuration.contextId,
      invocationId: configuration.invocationId,
      parentPid: process.ppid,
      pid: process.pid,
      execPath: process.execPath,
      cwd: process.cwd(),
      processArgv: [...process.argv],
      bunArgv: [...Bun.argv],
      naturalExitCode,
      capturedSources: [...state.capturedSources].sort(),
      captureErrors: [...state.errors],
      ...(hitArtifactPath ? { hitArtifactPath } : {}),
      ...(hitArtifactSha256 ? { hitArtifactSha256 } : {}),
    };

    try {
      writeFileSync(configuration.receiptPath, JSON.stringify(receipt), { flag: "wx" });
    } catch {}
  });
}

function matchesCreatorPreparedSource(
  actual: CoverageFile,
  prepared: CreatorCaptureProfileSource,
): boolean {
  return (
    actual.hash === prepared.runtimeHash &&
    actual._coverageSchema === prepared.runtimeSchema &&
    matchesPreparedHelperMaps(actual, prepared.seed)
  );
}

if (
  process.env[installedCliChildMarker] === "1" ||
  process.env[configuredPluginBuildChildMarker] === "1"
) {
  installChildCapture();
}

if (process.env[creatorCliChildMarker] === "1") installCreatorChildCapture();
