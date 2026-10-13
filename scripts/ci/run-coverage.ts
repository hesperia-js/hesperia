import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { buildCoverageWorkerGraph } from "./coverage-worker-build.ts";
import {
  bindCoverageOwnerRun,
  classifyProjectWorkerOwnerSelection,
  coverageOwnerProfile,
  elysiaWorkerOwnerTestPaths,
  snapshotCoverageOwnerHits,
} from "./coverage-owner-launcher.ts";
import type { WorkerCoverageOutput, WorkerCoverageSourceOutput } from "./coverage-worker-build.ts";
import {
  inventoryCoverageSources,
  mergeCoverageArtifacts,
  prepareCoverageSource,
  seedCoverageSources,
  writeLcovReport,
  type CoverageArtifact,
  type CoverageFile,
  type CoveragePopulation,
  type PreparedCoverageSource,
} from "./coverage-collector.ts";

const repoPath = resolve(import.meta.dir, "../..");
const outputRoot = resolve(repoPath, ".hesperia/coverage/runs");
const ownerId = "bun-tests";
const driverOwnerId = "bun-tests-driver";
const workerOwnerPrefix = "tooling-project-worker:";
const installedCliCoverageTest = "tests/package/check-installed.test.ts" as const;
const installedCliSource = "packages/tooling/src/cli.ts" as const;
const installedCliChildSource = "scripts/ci/coverage-installed-cli.ts" as const;
const configuredPluginCoverageTest = "tests/tooling/configured-plugin.test.ts" as const;
const creatorCliCoverageTest = "tests/tooling/create-hesperia.test.ts" as const;
const creatorCliSources = [
  "packages/create-hesperia/src/cli.ts",
  "packages/create-hesperia/src/templates/elysia.ts",
  "packages/create-hesperia/src/templates/frontend.ts",
] as const;
const bootstrapSources = [
  "scripts/ci/coverage-preload.ts",
  "scripts/ci/coverage-collector.ts",
  "scripts/ci/coverage-inventory.ts",
] as const;
const workerPreloadSource = "scripts/ci/coverage-worker-preload.ts" as const;
const browserPageCoverageTests = new Set([
  "tests/tooling/routing-public-flows.test.ts",
  "tests/routing/navigation-facade.browser.test.ts",
  "tests/routing/navigation-state.browser.test.ts",
]);
const defaultBootstrapImport = "scripts/ci/coverage-preload.ts" as const;

interface BootstrapPreload {
  readonly directory: string;
  readonly preloadPath: string;
}

interface WorkerInvocationReceipt {
  readonly invocationId: string;
  readonly ownerId: string;
  readonly parentPid: number;
  readonly childPid?: number;
  readonly target: string;
  readonly seedArtifact: string;
  readonly spawnSucceeded: boolean;
  readonly terminationObserved: boolean;
  readonly exitCode?: number;
  readonly preTerminationKillCount: number;
  readonly postTerminationKillCount: number;
  readonly abortErrorObserved: boolean;
  readonly abortErrorName?: string;
  readonly packageCaptureReceipt?: { readonly fileName: string; readonly sha256: string };
}

interface SupportInvocationReceipt {
  readonly invocationId: string;
  readonly parentPid: number;
  readonly executablePath: string;
  readonly executableRealPath: string;
  readonly argv: readonly string[];
  readonly processWorkingDirectory: string | null;
  readonly environmentSha256: string | null;
  readonly stdio: readonly ["pipe", "pipe", "inherit"];
  readonly signalProvided: false;
  readonly childPid: number;
  readonly spawnSucceeded: true;
  readonly terminationObserved: true;
  readonly exitCode: 0;
  readonly signalCode: null;
}

interface WorkerInvocationManifest {
  readonly format: "hesperia-coverage-worker-invocations";
  readonly version: 1;
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly invocations: readonly WorkerInvocationReceipt[];
  readonly supportInvocations?: readonly SupportInvocationReceipt[];
  readonly uncorrelatedAbortErrors: number;
  readonly untrackedSpawnCount: number;
  readonly writeError?: string;
}

interface RunArtifacts {
  readonly seeds: readonly CoverageArtifact[];
  readonly hits: readonly CoverageArtifact[];
  readonly namedArtifacts: readonly {
    readonly name: string;
    readonly artifact: CoverageArtifact;
  }[];
  readonly workerManifest?: WorkerInvocationManifest;
  readonly workerAbortedUncaptured: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function preparedRuntimeSchema(prepared: PreparedCoverageSource): string {
  const parsed = parseSync(prepared.path, prepared.instrumentedCode, {
    lang: prepared.loader === "tsx" ? "tsx" : "ts",
    sourceType: "module",
  });

  if (parsed.errors.length > 0) {
    throw new Error(`Unable to parse prepared coverage source: ${prepared.relativePath}`);
  }

  const matches: string[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);

      return;
    }

    if (!isRecord(value)) return;

    if (
      value.type === "VariableDeclarator" &&
      isRecord(value.id) &&
      value.id.type === "Identifier" &&
      value.id.name === "coverageData" &&
      isRecord(value.init) &&
      value.init.type === "ObjectExpression" &&
      Array.isArray(value.init.properties)
    ) {
      for (const property of value.init.properties) {
        if (
          !isRecord(property) ||
          (property.type !== "Property" && property.type !== "ObjectProperty") ||
          !isRecord(property.key) ||
          (property.key.name !== "_coverageSchema" && property.key.value !== "_coverageSchema") ||
          !isRecord(property.value) ||
          (property.value.type !== "Literal" && property.value.type !== "StringLiteral") ||
          typeof property.value.value !== "string"
        ) {
          continue;
        }

        matches.push(property.value.value);
      }
    }

    for (const child of Object.values(value)) visit(child);
  };

  visit(parsed.program);

  if (matches.length !== 1 || !/^[a-f0-9]{40}$/u.test(matches[0]!)) {
    throw new Error(
      `Prepared coverage source has no unique runtime schema: ${prepared.relativePath}`,
    );
  }

  return matches[0]!;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function expectedTypeScriptApiExecutablePath(): string {
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
  const typescriptPackageJsonPath = fileURLToPath(import.meta.resolve("typescript/package.json"));
  const require = createRequire(typescriptPackageJsonPath);
  const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
  const executableName = process.platform === "win32" ? "tsc.exe" : "tsc";
  return realpathSync(join(dirname(packageJsonPath), "lib", executableName));
}

function escapeRegularExpression(value: string): string {
  const specialCharacters = new Set([
    "\\",
    ".",
    "*",
    "+",
    "?",
    "^",
    "$",
    "{",
    "}",
    "(",
    ")",
    "|",
    "[",
    "]",
  ]);
  return [...value]
    .map((character) => (specialCharacters.has(character) ? `\\${character}` : character))
    .join("");
}

function createBootstrapPreload(
  runId: string,
  preparedSources: readonly PreparedCoverageSource[],
  importAfterSetup:
    | typeof defaultBootstrapImport
    | typeof workerPreloadSource
    | typeof installedCliChildSource = defaultBootstrapImport,
  childProfile: "installed-cli" | "creator-cli" | "configured-plugin-build" = "installed-cli",
): BootstrapPreload {
  const runDirectory = resolve(repoPath, ".hesperia/coverage/bootstrap-builds", runId);
  const directory =
    importAfterSetup === installedCliChildSource
      ? join(runDirectory, `${childProfile}-child`)
      : runDirectory;

  if (existsSync(directory)) throw new Error("Coverage bootstrap build directory already exists");

  const preparedDirectory = join(directory, "prepared");

  mkdirSync(preparedDirectory, { recursive: true });

  const preparedByRelativePath = new Map(
    preparedSources.map((item) => [item.relativePath, item] as const),
  );

  if (preparedByRelativePath.size !== preparedSources.length) {
    throw new Error("Coverage bootstrap preparation contains duplicate paths");
  }

  if (
    importAfterSetup !== defaultBootstrapImport &&
    importAfterSetup !== workerPreloadSource &&
    importAfterSetup !== installedCliChildSource
  ) {
    throw new Error("Coverage bootstrap requested an unsupported import target");
  }

  if (childProfile === "creator-cli" && importAfterSetup !== installedCliChildSource) {
    throw new Error("Creator CLI bootstrap requires its closed child adapter");
  }

  const expectedSources: readonly string[] =
    importAfterSetup === defaultBootstrapImport
      ? bootstrapSources
      : importAfterSetup === workerPreloadSource
        ? [workerPreloadSource]
        : childProfile === "creator-cli"
          ? [installedCliChildSource, ...creatorCliSources]
          : [installedCliChildSource];

  if (preparedSources.some((item) => !expectedSources.includes(item.relativePath))) {
    throw new Error("Coverage bootstrap preparation does not match its known import target");
  }

  const bindings = expectedSources.map((source) => {
    const item = preparedByRelativePath.get(source);

    if (!item) throw new Error(`Coverage bootstrap preparation omitted ${source}`);

    const preparedPath = join(preparedDirectory, basename(item.path));

    writeFileSync(preparedPath, item.instrumentedCode, { flag: "wx" });

    return [item.path, preparedPath] as const;
  });
  const pathsPattern = `^(?:${bindings.map(([source]) => escapeRegularExpression(source)).join("|")})$`;
  const preloadPath = join(directory, "bootstrap-preload.ts");
  const preloadSource = `
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const preparedByPath = new Map(
  ${JSON.stringify(bindings)}.map(([source, prepared]) => [
    process.platform === "win32" ? resolve(source).toLowerCase() : resolve(source),
    prepared,
  ]),
);
const authoredSourceFilter = new RegExp(
  ${JSON.stringify(pathsPattern)},
  process.platform === "win32" ? "iu" : "u",
);

Bun.plugin({
  name: "hesperia-coverage-bootstrap-source-first",
  setup(build) {
    build.onLoad({ filter: authoredSourceFilter }, ({ path }) => {
      const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
      const preparedPath = preparedByPath.get(key);
      if (!preparedPath) {
        throw new Error("Coverage bootstrap matched an unknown authored source: " + path);
      }
      return { contents: readFileSync(preparedPath, "utf8"), loader: "ts" };
    });
  },
});

await import(pathToFileURL(${JSON.stringify(resolve(repoPath, importAfterSetup))}).href);
`;

  writeFileSync(preloadPath, preloadSource, { flag: "wx" });

  return { directory, preloadPath };
}

function hasCoverageHits(coverage: CoverageFile | undefined): boolean {
  if (!coverage) return false;

  return (
    Object.values(coverage.s).some((count) => count > 0) ||
    Object.values(coverage.f).some((count) => count > 0) ||
    Object.values(coverage.b).some((counts) => counts.some((count) => count > 0))
  );
}

function sourceHasHits(coverage: CoverageArtifact["coverage"], source: string): boolean {
  const authoredPath = resolve(repoPath, source.replaceAll("/", sep));
  return Object.entries(coverage).some(
    ([path, file]) => canonicalPath(path) === canonicalPath(authoredPath) && hasCoverageHits(file),
  );
}

function assertPreparedSourceMatchesPopulation(
  prepared: PreparedCoverageSource,
  population: CoveragePopulation,
  canonicalSeedCoverage: Record<string, CoverageFile>,
): void {
  const populationFile = population.files.find(
    (file) =>
      canonicalPath(resolve(repoPath, file.source.replaceAll("/", sep))) ===
      canonicalPath(prepared.path),
  );
  const canonicalSeed = Object.entries(canonicalSeedCoverage).find(
    ([path]) => canonicalPath(path) === canonicalPath(prepared.path),
  )?.[1];
  const sourceSha256 = createHash("sha256")
    .update(readFileSync(prepared.path, "utf8"), "utf8")
    .digest("hex");

  if (
    !populationFile ||
    populationFile.sourceSha256 !== sourceSha256 ||
    populationFile.canonicalUnitsSha256 !== prepared.ownerFile.unitLayoutSha256 ||
    !canonicalSeed ||
    JSON.stringify(canonicalSeed.inputSourceMap) !== JSON.stringify(prepared.sourceMap) ||
    canonicalSeed.__hesperiaInstrumentedSourceSha256 !== prepared.ownerFile.instrumentedSourceSha256
  ) {
    throw new Error(
      "Coverage bootstrap preparation does not match the current source population: " +
        prepared.relativePath,
    );
  }
}

function supportArtifactSourcesMatch(
  artifact: CoverageArtifact,
  sources: readonly string[],
): boolean {
  const actual = Object.keys(artifact.coverage)
    .map((path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)))
    .sort();
  const expected = sources
    .map((source) => {
      const path = resolve(repoPath, source.replaceAll("/", sep));
      return process.platform === "win32" ? path.toLowerCase() : path;
    })
    .sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertBootstrapCapture(hits: readonly CoverageArtifact[]): void {
  const ownerHits = hits.filter((artifact) => artifact.ownerId === ownerId);

  for (const source of bootstrapSources) {
    const authoredPath = resolve(repoPath, source.replaceAll("/", sep));
    const captured = ownerHits.some((artifact) =>
      Object.values(artifact.coverage).some(
        (coverage) => resolve(coverage.path) === authoredPath && hasCoverageHits(coverage),
      ),
    );

    if (!captured) {
      throw new Error(`Coverage bootstrap authored-source hit is missing: ${source}`);
    }
  }
}

function assertInstalledCliCapture(hits: readonly CoverageArtifact[]): void {
  const authoredPaths = [installedCliSource, installedCliChildSource].map((source) =>
    canonicalPath(resolve(repoPath, source.replaceAll("/", sep))),
  );
  const captures = hits.filter((artifact) => {
    if (artifact.ownerId !== ownerId) return false;

    const entries = Object.entries(artifact.coverage);
    const entryPaths = entries.map(([path]) => canonicalPath(path));
    return (
      entries.length === authoredPaths.length &&
      new Set(entryPaths).size === authoredPaths.length &&
      authoredPaths.every((path) => entryPaths.includes(path)) &&
      entries.every(
        ([path, coverage]) =>
          canonicalPath(coverage.path) === canonicalPath(path) && hasCoverageHits(coverage),
      )
    );
  });

  if (captures.length !== 4) {
    throw new Error(
      `Installed CLI coverage expected four genuine child fragments with CLI and helper hits; found ${captures.length}`,
    );
  }
}

function assertConfiguredPluginBuildCapture(
  artifacts: RunArtifacts,
  runId: string,
  preparedSources: readonly PreparedCoverageSource[],
  installedCliMode: boolean,
): void {
  const authoredSources = [installedCliSource, installedCliChildSource] as const;
  const authoredPaths = authoredSources.map((source) =>
    canonicalPath(resolve(repoPath, source.replaceAll("/", sep))),
  );
  const preparedByPath = new Map(
    preparedSources.map((prepared) => [canonicalPath(prepared.path), prepared] as const),
  );

  if (
    preparedByPath.size !== authoredPaths.length ||
    authoredPaths.some((path) => !preparedByPath.has(path))
  ) {
    throw new Error("Configured plugin CLI prepared source identity is incomplete");
  }

  const ordinarySeeds = artifacts.seeds.filter((artifact) => artifact.ownerId === ownerId);

  if (ordinarySeeds.length !== 1) {
    throw new Error("Configured plugin CLI has no unique ordinary source seed");
  }

  if (ordinarySeeds[0]!.runId !== runId) {
    throw new Error("Configured plugin CLI source seed belongs to a different run");
  }

  const expectedSeeds = new Map<string, CoverageFile>();

  for (const path of authoredPaths) {
    const records = Object.entries(ordinarySeeds[0]!.coverage).filter(
      ([recordPath, coverage]) =>
        canonicalPath(recordPath) === path && canonicalPath(coverage.path) === path,
    );

    if (records.length !== 1) {
      throw new Error("Configured plugin CLI ordinary source seed is missing or ambiguous");
    }

    const seed = records[0]![1];
    const preparedSeed = preparedByPath.get(path)?.seed;

    if (
      !preparedSeed ||
      canonicalPath(preparedSeed.path) !== path ||
      JSON.stringify(seed.statementMap) !== JSON.stringify(preparedSeed.statementMap) ||
      JSON.stringify(seed.fnMap) !== JSON.stringify(preparedSeed.fnMap) ||
      JSON.stringify(seed.branchMap) !== JSON.stringify(preparedSeed.branchMap) ||
      JSON.stringify(seed.inputSourceMap) !== JSON.stringify(preparedSeed.inputSourceMap)
    ) {
      throw new Error("Configured plugin CLI seed differs from its fresh prepared graph");
    }

    expectedSeeds.set(path, seed);
  }

  const escapedRunId = escapeRegularExpression(runId);
  const configuredGroupPattern = new RegExp(
    `^${escapedRunId}-bun-tests-configured-plugin-build-(1|2)-hits-\\d+-\\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`,
    "u",
  );
  const configuredArtifactPrefix = `${runId}-bun-tests-configured-plugin-build-`;
  const configuredCandidates = artifacts.namedArtifacts.filter((entry) =>
    entry.name.startsWith(configuredArtifactPrefix),
  );
  const configuredGroups = configuredCandidates
    .flatMap((entry) => {
      const match = configuredGroupPattern.exec(entry.name);
      return match ? [{ ...entry, ordinal: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.ordinal - right.ordinal);

  if (
    configuredCandidates.length !== 2 ||
    configuredGroups.length !== 2 ||
    configuredGroups[0]!.ordinal !== 1 ||
    configuredGroups[1]!.ordinal !== 2
  ) {
    throw new Error("Configured plugin CLI expected two distinct ordered child groups");
  }

  const configuredArtifacts = new Set(configuredGroups.map(({ artifact }) => artifact));
  const sourcePairArtifacts = artifacts.hits.filter((artifact) => {
    if (artifact.ownerId !== ownerId) return false;

    const paths = Object.keys(artifact.coverage).map(canonicalPath);
    return (
      paths.length === authoredPaths.length &&
      new Set(paths).size === authoredPaths.length &&
      authoredPaths.every((path) => paths.includes(path))
    );
  });

  if (sourcePairArtifacts.length !== 2 + (installedCliMode ? 4 : 0)) {
    throw new Error("Configured plugin CLI found missing or foreign CLI/helper hit groups");
  }

  if (configuredGroups.some(({ artifact }) => !sourcePairArtifacts.includes(artifact))) {
    throw new Error("Configured plugin CLI group has an unexpected authored-source set");
  }

  const installedArtifacts = sourcePairArtifacts.filter(
    (artifact) => !configuredArtifacts.has(artifact),
  );

  if (installedCliMode) assertInstalledCliCapture(installedArtifacts);

  for (const { artifact } of configuredGroups) {
    if (
      artifact.kind !== "hits" ||
      artifact.runId !== runId ||
      artifact.ownerId !== ownerId ||
      artifact.populationFingerprint !== ordinarySeeds[0]!.populationFingerprint
    ) {
      throw new Error("Configured plugin CLI child group is not bound to its ordinary run seed");
    }

    for (const [path, coverage] of Object.entries(artifact.coverage)) {
      const key = canonicalPath(path);
      const prepared = preparedByPath.get(key);
      const seed = expectedSeeds.get(key);

      if (
        !prepared?.bootstrapHash ||
        !seed ||
        canonicalPath(coverage.path) !== key ||
        !hasCoverageHits(coverage) ||
        coverage.hash !== prepared.bootstrapHash ||
        coverage._coverageSchema !== preparedRuntimeSchema(prepared) ||
        JSON.stringify(coverage.statementMap) !== JSON.stringify(seed.statementMap) ||
        JSON.stringify(coverage.fnMap) !== JSON.stringify(seed.fnMap) ||
        JSON.stringify(coverage.branchMap) !== JSON.stringify(seed.branchMap) ||
        JSON.stringify(coverage.inputSourceMap) !== JSON.stringify(seed.inputSourceMap) ||
        coverage.__hesperiaInstrumentedSourceSha256 !== prepared.ownerFile.instrumentedSourceSha256
      ) {
        throw new Error("Configured plugin CLI child maps or source identity differ from its seed");
      }
    }
  }
}

function assertCreatorCliCapture(
  seeds: readonly CoverageArtifact[],
  hits: readonly CoverageArtifact[],
  preparedSources: readonly PreparedCoverageSource[],
): void {
  const authoredSources = [...creatorCliSources, installedCliChildSource];
  const authoredPaths = authoredSources.map((source) =>
    canonicalPath(resolve(repoPath, source.replaceAll("/", sep))),
  );
  const seedArtifacts = seeds.filter((artifact) => artifact.ownerId === ownerId);

  if (seedArtifacts.length !== 1) {
    throw new Error("Creator CLI coverage has no unique ordinary source seed");
  }

  const seedCoverage = seedArtifacts[0]!.coverage;
  const expectedSeeds = new Map<string, CoverageFile>();

  for (const path of authoredPaths) {
    const records = Object.entries(seedCoverage).filter(
      ([recordPath, coverage]) =>
        canonicalPath(recordPath) === path && canonicalPath(coverage.path) === path,
    );

    if (records.length !== 1) {
      throw new Error("Creator CLI ordinary source seed is missing or ambiguous");
    }

    expectedSeeds.set(path, records[0]![1]);
  }

  const preparedByPath = new Map(
    preparedSources.map((prepared) => [canonicalPath(prepared.path), prepared] as const),
  );

  if (
    preparedByPath.size !== authoredPaths.length ||
    authoredPaths.some((path) => !preparedByPath.has(path))
  ) {
    throw new Error("Creator CLI prepared source identity is incomplete");
  }

  const expectedRuntimeSchemas = new Map(
    preparedSources.map((prepared) => [
      canonicalPath(prepared.path),
      preparedRuntimeSchema(prepared),
    ]),
  );

  const creatorPaths = creatorCliSources.map((source) =>
    canonicalPath(resolve(repoPath, source.replaceAll("/", sep))),
  );
  const creatorHits = hits.filter(
    (artifact) =>
      artifact.ownerId === ownerId &&
      Object.keys(artifact.coverage).some((path) => creatorPaths.includes(canonicalPath(path))),
  );

  if (creatorHits.length !== 8) {
    throw new Error(
      `Creator CLI coverage expected eight genuine child fragments; found ${creatorHits.length}`,
    );
  }

  for (const artifact of creatorHits) {
    const entries = Object.entries(artifact.coverage);
    const entryPaths = entries.map(([path]) => canonicalPath(path));

    if (
      entries.length !== authoredPaths.length ||
      new Set(entryPaths).size !== authoredPaths.length ||
      !authoredPaths.every((path) => entryPaths.includes(path))
    ) {
      throw new Error("Creator CLI child fragment has an unexpected authored-source set");
    }

    for (const [path, coverage] of entries) {
      const key = canonicalPath(path);
      const seed = expectedSeeds.get(key);
      const prepared = preparedByPath.get(key);

      if (
        !seed ||
        !prepared?.bootstrapHash ||
        canonicalPath(coverage.path) !== key ||
        !hasCoverageHits(coverage) ||
        coverage.hash !== prepared.bootstrapHash ||
        coverage._coverageSchema !== expectedRuntimeSchemas.get(key) ||
        JSON.stringify(coverage.statementMap) !== JSON.stringify(seed.statementMap) ||
        JSON.stringify(coverage.fnMap) !== JSON.stringify(seed.fnMap) ||
        JSON.stringify(coverage.branchMap) !== JSON.stringify(seed.branchMap) ||
        JSON.stringify(coverage.inputSourceMap) !== JSON.stringify(seed.inputSourceMap) ||
        coverage.__hesperiaInstrumentedSourceSha256 !== prepared.ownerFile.instrumentedSourceSha256
      ) {
        throw new Error("Creator CLI child maps or source identity differ from its ordinary seed");
      }
    }
  }
}

function testPathsFromArguments(args: readonly string[]): readonly string[] {
  const targets = args[0] === "--" ? args.slice(1) : args;

  if (targets.length === 0) {
    throw new Error("Usage: bun run scripts/ci/run-coverage.ts <test-path>...");
  }

  return targets.map((target) => {
    if (target.startsWith("-"))
      throw new Error(`Coverage runner accepts test paths only: ${target}`);

    const absolutePath = resolve(repoPath, target);
    const relativePath = relative(repoPath, absolutePath);

    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      resolve(repoPath, relativePath) !== absolutePath
    ) {
      throw new Error(`Coverage test path must be inside the repository: ${target}`);
    }

    const stat = statSync(absolutePath);

    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Coverage test path is not a file or directory: ${target}`);
    }

    return relativePath.split(sep).join("/");
  });
}

function validateWorkerManifest(
  value: unknown,
  runId: string,
  population: CoveragePopulation,
  supportRequired: boolean,
): WorkerInvocationManifest {
  if (
    !isRecord(value) ||
    value.format !== "hesperia-coverage-worker-invocations" ||
    value.version !== 1 ||
    value.runId !== runId ||
    value.populationFingerprint !== population.fingerprint ||
    !Array.isArray(value.invocations) ||
    (value.supportInvocations !== undefined && !Array.isArray(value.supportInvocations)) ||
    !Number.isSafeInteger(value.uncorrelatedAbortErrors) ||
    value.uncorrelatedAbortErrors !== 0 ||
    !Number.isSafeInteger(value.untrackedSpawnCount) ||
    value.untrackedSpawnCount !== 0 ||
    value.writeError !== undefined
  ) {
    throw new Error("Malformed or stale project worker invocation receipt");
  }

  const seen = new Set<string>();
  const invocations = value.invocations.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.invocationId !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(item.invocationId) ||
      item.ownerId !== `${workerOwnerPrefix}${item.invocationId}` ||
      seen.has(item.ownerId) ||
      typeof item.parentPid !== "number" ||
      !Number.isSafeInteger(item.parentPid) ||
      typeof item.childPid !== "number" ||
      !Number.isSafeInteger(item.childPid) ||
      Number(item.parentPid) <= 0 ||
      Number(item.childPid) <= 0 ||
      item.spawnSucceeded !== true ||
      item.terminationObserved !== true ||
      typeof item.exitCode !== "number" ||
      !Number.isSafeInteger(item.exitCode) ||
      typeof item.target !== "string" ||
      item.target !== "packages/tooling/dist/project-worker.js" ||
      typeof item.seedArtifact !== "string" ||
      !item.seedArtifact.startsWith(`${runId}-`) ||
      !item.seedArtifact.endsWith(".json") ||
      basename(item.seedArtifact) !== item.seedArtifact ||
      typeof item.preTerminationKillCount !== "number" ||
      !Number.isSafeInteger(item.preTerminationKillCount) ||
      Number(item.preTerminationKillCount) < 0 ||
      typeof item.postTerminationKillCount !== "number" ||
      !Number.isSafeInteger(item.postTerminationKillCount) ||
      Number(item.postTerminationKillCount) < 0 ||
      typeof item.abortErrorObserved !== "boolean" ||
      (item.abortErrorName !== undefined && typeof item.abortErrorName !== "string") ||
      (item.packageCaptureReceipt !== undefined &&
        (!isRecord(item.packageCaptureReceipt) ||
          typeof item.packageCaptureReceipt.fileName !== "string" ||
          basename(item.packageCaptureReceipt.fileName) !== item.packageCaptureReceipt.fileName ||
          typeof item.packageCaptureReceipt.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(item.packageCaptureReceipt.sha256)))
    ) {
      throw new Error("Project worker receipt contains an invalid invocation");
    }

    if (
      (item.preTerminationKillCount > 0 &&
        (item.abortErrorObserved !== true || item.abortErrorName !== "AbortError")) ||
      (item.abortErrorObserved && item.preTerminationKillCount === 0)
    ) {
      throw new Error(`Project worker cancellation is not correlated for ${item.ownerId}`);
    }

    if (item.exitCode !== 0 && item.exitCode !== 1 && !item.abortErrorObserved) {
      throw new Error(`Project worker exited unexpectedly for ${item.ownerId}: ${item.exitCode}`);
    }

    seen.add(item.ownerId);

    return item as unknown as WorkerInvocationReceipt;
  });

  if (invocations.length === 0) throw new Error("Project worker receipt has no invocations");

  const supportIds = new Set<string>();
  const supportPids = new Set<number>();
  const expectedExecutablePath =
    Array.isArray(value.supportInvocations) && value.supportInvocations.length > 0
      ? expectedTypeScriptApiExecutablePath()
      : undefined;
  const supportParentPid = invocations[0]!.parentPid;
  const supportValues = Array.isArray(value.supportInvocations) ? value.supportInvocations : [];
  const supportInvocations = supportValues.map((item) => {
    const validArgv =
      isRecord(item) &&
      Array.isArray(item.argv) &&
      item.argv.every((argument) => typeof argument === "string") &&
      item.argv.length === 5 &&
      item.argv[0] === "--api" &&
      item.argv[1] === "--async" &&
      item.argv[2] === "--cwd" &&
      isAbsolute(String(item.argv[3])) &&
      (item.argv[4] === "--callbacks=readFile,fileExists" ||
        item.argv[4] === "--callbacks=readFile,fileExists,directoryExists");
    const validExecutable =
      isRecord(item) &&
      expectedExecutablePath !== undefined &&
      typeof item.executablePath === "string" &&
      isAbsolute(item.executablePath) &&
      typeof item.executableRealPath === "string" &&
      (() => {
        try {
          return (
            canonicalPath(realpathSync(item.executablePath)) ===
              canonicalPath(expectedExecutablePath) &&
            canonicalPath(item.executableRealPath) === canonicalPath(expectedExecutablePath)
          );
        } catch {
          return false;
        }
      })();

    if (
      !isRecord(item) ||
      typeof item.invocationId !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(item.invocationId) ||
      supportIds.has(item.invocationId) ||
      item.parentPid !== supportParentPid ||
      !Number.isSafeInteger(item.parentPid) ||
      typeof item.childPid !== "number" ||
      !Number.isSafeInteger(item.childPid) ||
      Number(item.childPid) <= 0 ||
      supportPids.has(item.childPid) ||
      !validExecutable ||
      !validArgv ||
      (item.processWorkingDirectory !== null &&
        (typeof item.processWorkingDirectory !== "string" ||
          !isAbsolute(item.processWorkingDirectory) ||
          canonicalPath(item.processWorkingDirectory) !== canonicalPath(repoPath))) ||
      (item.environmentSha256 !== null &&
        (typeof item.environmentSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(item.environmentSha256))) ||
      !Array.isArray(item.stdio) ||
      item.stdio.length !== 3 ||
      item.stdio[0] !== "pipe" ||
      item.stdio[1] !== "pipe" ||
      item.stdio[2] !== "inherit" ||
      item.signalProvided !== false ||
      item.spawnSucceeded !== true ||
      item.terminationObserved !== true ||
      item.exitCode !== 0 ||
      item.signalCode !== null
    ) {
      throw new Error("TypeScript API support receipt contains an invalid invocation");
    }

    supportIds.add(item.invocationId);

    supportPids.add(item.childPid as number);

    return item as unknown as SupportInvocationReceipt;
  });

  if (supportRequired !== supportInvocations.length > 0) {
    throw new Error("TypeScript API support receipt does not match the selected coverage owner");
  }

  return {
    ...(value as unknown as WorkerInvocationManifest),
    invocations,
    supportInvocations,
  };
}

interface WorkerPackageCaptureReceipt {
  readonly format: "hesperia-worker-package-capture";
  readonly version: 1;
  readonly runId: string;
  readonly ownerId: string;
  readonly processId: number;
  readonly compiledModulePaths: readonly { readonly path: string; readonly realPath: string }[];
  readonly directSourcePaths: readonly { readonly path: string; readonly realPath: string }[];
  readonly buildSubstitutionPaths: readonly { readonly path: string; readonly realPath: string }[];
}

interface WorkerCaptureContext {
  readonly directory: string;
  readonly outputs: readonly WorkerCoverageOutput[];
  readonly sourceOutputs: readonly WorkerCoverageSourceOutput[];
  readonly elysiaTestPaths: readonly string[];
}

function readPackageCaptureReceipt(
  reference: { readonly fileName: string; readonly sha256: string } | undefined,
  expectedFileName: string,
  expectedOwnerId: string,
  expectedPid: number,
  runId: string,
  directory: string,
): WorkerPackageCaptureReceipt | undefined {
  if (!reference) return undefined;

  if (reference.fileName !== expectedFileName) {
    throw new Error(`Project worker package receipt filename does not match ${expectedOwnerId}`);
  }

  const path = resolve(directory, reference.fileName);

  if (relative(directory, path).startsWith(`..${sep}`) || !existsSync(path)) {
    throw new Error(`Project worker package receipt sidecar is missing: ${reference.fileName}`);
  }

  const content = readFileSync(path, "utf8");

  if (createHash("sha256").update(content).digest("hex") !== reference.sha256) {
    throw new Error(`Project worker package receipt hash mismatch: ${reference.fileName}`);
  }

  let value: unknown;

  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Project worker package receipt is malformed: ${reference.fileName}`, {
      cause: error,
    });
  }

  if (
    !isRecord(value) ||
    value.format !== "hesperia-worker-package-capture" ||
    value.version !== 1 ||
    value.runId !== runId ||
    value.ownerId !== expectedOwnerId ||
    value.processId !== expectedPid ||
    !Array.isArray(value.compiledModulePaths) ||
    !Array.isArray(value.directSourcePaths) ||
    !Array.isArray(value.buildSubstitutionPaths)
  ) {
    throw new Error(`Project worker package receipt identity mismatch: ${reference.fileName}`);
  }

  for (const field of [
    "compiledModulePaths",
    "directSourcePaths",
    "buildSubstitutionPaths",
  ] as const) {
    for (const entry of value[field] as unknown[]) {
      if (
        !isRecord(entry) ||
        typeof entry.path !== "string" ||
        typeof entry.realPath !== "string" ||
        canonicalPath(realpathSync(entry.path)) !== canonicalPath(entry.realPath)
      ) {
        throw new Error(
          `Project worker package receipt has an invalid realpath: ${reference.fileName}`,
        );
      }
    }
  }

  return value as unknown as WorkerPackageCaptureReceipt;
}

function validateWorkerPackageCapture(
  manifest: WorkerInvocationManifest,
  runId: string,
  context: WorkerCaptureContext,
): void {
  const elysiaDist = context.outputs.filter((output) =>
    output.originalPath.replaceAll("\\", "/").includes("/packages/elysia/dist/"),
  );
  const distRealpaths = new Set(
    elysiaDist.map((output) => canonicalPath(realpathSync(output.originalPath))),
  );
  const sourceRealpaths = new Set(
    context.sourceOutputs.map((output) => canonicalPath(realpathSync(output.originalPath))),
  );

  const validatePaths = (
    records: readonly { readonly path: string; readonly realPath: string }[],
    allowedRealpaths: ReadonlySet<string>,
    pathPredicate: (path: string) => boolean,
    label: string,
  ) => {
    for (const record of records) {
      if (!pathPredicate(record.path) || !allowedRealpaths.has(canonicalPath(record.realPath))) {
        throw new Error(
          `Project worker ${label} is outside the admitted Elysia map: ${record.path}`,
        );
      }
    }
  };

  const isElysiaDistPath = (path: string) => {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    return (
      normalized.includes("/packages/elysia/dist/") ||
      normalized.includes("/node_modules/@hesperia/elysia/dist/")
    );
  };

  const sourcePaths = new Set(
    context.sourceOutputs.map((output) => canonicalPath(output.originalPath)),
  );
  const childReceipts: WorkerPackageCaptureReceipt[] = [];
  const referencedSidecars = new Set<string>();

  for (const invocation of manifest.invocations) {
    const aborted =
      invocation.preTerminationKillCount > 0 &&
      invocation.abortErrorObserved &&
      invocation.exitCode !== 0 &&
      invocation.exitCode !== 1;
    const receipt = readPackageCaptureReceipt(
      invocation.packageCaptureReceipt,
      `${invocation.invocationId}.json`,
      invocation.ownerId,
      invocation.childPid!,
      runId,
      context.directory,
    );

    if (invocation.packageCaptureReceipt) {
      const fileName = invocation.packageCaptureReceipt.fileName;

      if (referencedSidecars.has(fileName)) {
        throw new Error(
          `Project worker package receipt sidecar is referenced more than once: ${fileName}`,
        );
      }

      referencedSidecars.add(fileName);
    }

    if (!aborted && !receipt) {
      throw new Error(
        `Completed project worker omitted its Elysia capture receipt: ${invocation.ownerId}`,
      );
    }

    if (receipt) {
      validatePaths(
        receipt.compiledModulePaths,
        distRealpaths,
        isElysiaDistPath,
        "compiled module receipt",
      );

      validatePaths(
        receipt.directSourcePaths,
        sourceRealpaths,
        (path) => sourcePaths.has(canonicalPath(path)),
        "direct source receipt",
      );

      validatePaths(
        receipt.buildSubstitutionPaths,
        distRealpaths,
        isElysiaDistPath,
        "Bun.build receipt",
      );

      childReceipts.push(receipt);
    }
  }

  const sidecarEntries = readdirSync(context.directory, { withFileTypes: true });

  if (
    sidecarEntries.length !== referencedSidecars.size ||
    sidecarEntries.some((entry) => !entry.isFile() || !referencedSidecars.has(entry.name))
  ) {
    throw new Error(
      "Project worker capture directory contains an orphan, duplicate, or unknown sidecar",
    );
  }

  const importedApiSelected = context.elysiaTestPaths.includes(
    "tests/compiler/imported-api.test.ts",
  );
  const analyzeProjectSelected = context.elysiaTestPaths.includes(
    "tests/tooling/analyze-project.test.ts",
  );

  if (analyzeProjectSelected) {
    const directSources = new Set(
      childReceipts.flatMap((receipt) =>
        receipt.directSourcePaths.map((entry) =>
          relative(repoPath, entry.realPath).split(sep).join("/"),
        ),
      ),
    );

    for (const source of [
      "packages/elysia/src/project-plugin.ts",
      "packages/elysia/src/app-analysis.ts",
    ]) {
      if (!directSources.has(source))
        throw new Error(`Elysia direct-source receipt omitted ${source}`);
    }
  }

  if (importedApiSelected) {
    const buildModules = new Set(
      childReceipts.flatMap((receipt) =>
        receipt.buildSubstitutionPaths.map((entry) =>
          relative(repoPath, entry.realPath).split(sep).join("/"),
        ),
      ),
    );

    for (const module of [
      "packages/elysia/dist/client.js",
      "packages/elysia/dist/http-adapter.js",
    ]) {
      if (!buildModules.has(module)) throw new Error(`Elysia Bun.build receipt omitted ${module}`);
    }
  }
}

function readRunResultArtifacts(
  directory: string,
  runId: string,
  workerMode: boolean,
  population?: CoveragePopulation,
  captureContext?: WorkerCaptureContext,
): RunArtifacts {
  const entries = readdirSync(directory, { withFileTypes: true });

  if (entries.length === 0) throw new Error("Bun test owner produced no coverage artifacts");

  const receiptEntries = entries.filter((entry) => entry.name === "worker-invocations.json");

  if ((workerMode && receiptEntries.length !== 1) || (!workerMode && receiptEntries.length !== 0)) {
    throw new Error("Coverage output has a missing or unexpected project worker receipt");
  }

  if (receiptEntries.some((entry) => !entry.isFile())) {
    throw new Error("Project worker invocation receipt is not a file");
  }

  const workerManifest = workerMode
    ? validateWorkerManifest(
        JSON.parse(readFileSync(join(directory, "worker-invocations.json"), "utf8")),
        runId,
        population!,
        captureContext?.elysiaTestPaths.includes("tests/compiler/imported-api.test.ts") ?? false,
      )
    : undefined;

  if (workerManifest && captureContext) {
    validateWorkerPackageCapture(workerManifest, runId, captureContext);
  }

  const workerOwners = new Set(workerManifest?.invocations.map((item) => item.ownerId));

  const namedArtifacts = entries
    .filter((entry) => entry.name !== "worker-invocations.json")
    .map((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json") || !entry.name.startsWith(`${runId}-`)) {
        throw new Error(`Unexpected coverage output in the owned run directory: ${entry.name}`);
      }

      const content = readFileSync(join(directory, entry.name), "utf8");
      let value: unknown;

      try {
        value = JSON.parse(content);
      } catch (error) {
        throw new Error(`Malformed coverage artifact ${entry.name}`, { cause: error });
      }

      if (!isRecord(value)) throw new Error(`Malformed coverage artifact ${entry.name}`);

      if (value.runId !== runId) throw new Error(`Stale coverage artifact ${entry.name}`);

      if (
        value.ownerId !== ownerId &&
        value.ownerId !== driverOwnerId &&
        !workerOwners.has(String(value.ownerId))
      ) {
        throw new Error(`Unexpected coverage owner in artifact ${entry.name}`);
      }

      if (value.platform !== process.platform) {
        throw new Error(`Coverage artifact platform mismatch in ${entry.name}`);
      }

      if (value.kind !== "seed" && value.kind !== "hits") {
        throw new Error(`Coverage artifact has an invalid kind: ${entry.name}`);
      }

      return { name: entry.name, artifact: value as unknown as CoverageArtifact };
    });
  const artifacts = namedArtifacts.map(({ artifact }) => artifact);

  const seeds = artifacts.filter((artifact) => artifact.kind === "seed");
  const hits = artifacts.filter((artifact) => artifact.kind === "hits");

  if (seeds.length === 0) throw new Error("Bun test owner produced no source seed artifact");

  if (hits.length === 0) throw new Error("Bun test owner produced no hit artifact");

  let workerAbortedUncaptured = 0;

  if (workerManifest) {
    const workerSeedIds = new Set(workerManifest.invocations.map((item) => item.ownerId));
    const completedCoverage: CoverageArtifact["coverage"][] = [];

    for (const invocation of workerManifest.invocations) {
      const ownerSeeds = seeds.filter((artifact) => artifact.ownerId === invocation.ownerId);
      const ownerHits = hits.filter((artifact) => artifact.ownerId === invocation.ownerId);

      if (ownerSeeds.length !== 1 || ownerSeeds[0]!.kind !== "seed") {
        throw new Error(
          `Project worker invocation has no unique source seed: ${invocation.ownerId}`,
        );
      }

      const seedFile = basename(invocation.seedArtifact);

      if (!entries.some((entry) => entry.isFile() && entry.name === seedFile)) {
        throw new Error(`Project worker seed receipt is missing: ${invocation.ownerId}`);
      }

      const seedPayload: unknown = JSON.parse(readFileSync(join(directory, seedFile), "utf8"));

      if (
        !isRecord(seedPayload) ||
        seedPayload.kind !== "seed" ||
        seedPayload.runId !== runId ||
        seedPayload.ownerId !== invocation.ownerId
      ) {
        throw new Error(
          `Project worker seed receipt does not match its invocation: ${invocation.ownerId}`,
        );
      }

      const aborted =
        invocation.preTerminationKillCount > 0 &&
        invocation.abortErrorObserved &&
        invocation.exitCode !== 0 &&
        invocation.exitCode !== 1;

      if ((!aborted && ownerHits.length !== 1) || (aborted && ownerHits.length > 1)) {
        throw new Error(
          `Project worker invocation has missing or duplicate hit results: ${invocation.ownerId}`,
        );
      }

      if (ownerHits.length === 0) {
        workerAbortedUncaptured++;
        continue;
      }

      const hitCoverage = ownerHits[0]!.coverage;

      if (!aborted) {
        const workerEntryPath = resolve(
          repoPath,
          "packages/tooling/src/project-worker.ts".replaceAll("/", sep),
        );
        const workerEntry = Object.entries(hitCoverage).find(
          ([path]) => resolve(path) === workerEntryPath,
        )?.[1];

        if (
          !workerEntry ||
          !Object.values(workerEntry.s).some((count) => count > 0) ||
          !Object.values(workerEntry.f).some((count) => count > 0)
        ) {
          throw new Error(
            `Project worker entry emitted no authored-source hits: ${invocation.ownerId}`,
          );
        }

        completedCoverage.push(hitCoverage);
      }
    }

    const workerArtifacts = [...seeds, ...hits].filter((artifact) =>
      artifact.ownerId.startsWith(workerOwnerPrefix),
    );

    if (workerArtifacts.some((artifact) => !workerSeedIds.has(artifact.ownerId))) {
      throw new Error("Project worker output contains an orphan owner artifact");
    }

    const requiredPackages = captureContext
      ? (["tooling", "compiler", "hosting", "elysia"] as const)
      : (["tooling", "compiler", "hosting"] as const);

    for (const packageName of requiredPackages) {
      const packageHit = completedCoverage.some((coverage) =>
        Object.entries(coverage).some(([path, file]) => {
          if (!path.replaceAll("\\", "/").includes(`/packages/${packageName}/src/`)) return false;

          return (
            Object.values(file.s).some((count) => count > 0) ||
            Object.values(file.f).some((count) => count > 0) ||
            Object.values(file.b).some((counts) => counts.some((count) => count > 0))
          );
        }),
      );

      if (!packageHit) {
        throw new Error(
          `Project worker hit artifacts did not execute an authored ${packageName} source`,
        );
      }
    }

    if (captureContext) {
      for (const source of [
        "packages/elysia/src/app-analysis.ts",
        "packages/elysia/src/effect-analysis.ts",
      ]) {
        if (!completedCoverage.some((coverage) => sourceHasHits(coverage, source))) {
          throw new Error(`Elysia project-worker hit is missing: ${source}`);
        }
      }

      if (captureContext.elysiaTestPaths.includes("tests/compiler/imported-api.test.ts")) {
        const parentHit = hits.find((artifact) => artifact.ownerId === ownerId);

        if (
          !parentHit ||
          !sourceHasHits(parentHit.coverage, "packages/elysia/src/client.ts") ||
          !sourceHasHits(parentHit.coverage, "packages/elysia/src/http-adapter.ts")
        ) {
          throw new Error("Imported browser shell produced no parent-process Elysia adapter hits");
        }
      }
    }

    if (workerMode) {
      const parentHits = hits.find((artifact) => artifact.ownerId === ownerId);

      if (!parentHits || !sourceHasHits(parentHits.coverage, workerPreloadSource)) {
        throw new Error("Bun test process did not execute its authored worker coverage preload");
      }

      if (completedCoverage.some((coverage) => !sourceHasHits(coverage, workerPreloadSource))) {
        throw new Error("Completed project worker omitted its authored worker coverage preload");
      }
    }
  }

  return {
    seeds,
    hits,
    namedArtifacts,
    ...(workerManifest ? { workerManifest } : {}),
    workerAbortedUncaptured,
  };
}

function readCurrentRunArtifacts(
  directory: string,
  runId: string,
  workerMode: boolean,
  population?: CoveragePopulation,
  captureContext?: WorkerCaptureContext,
): RunArtifacts {
  const artifacts = readRunResultArtifacts(
    directory,
    runId,
    workerMode,
    population,
    captureContext,
  );
  const driverProfile = coverageOwnerProfile("driver");

  if (driverProfile) {
    const driverSeeds = artifacts.seeds.filter((artifact) => artifact.ownerId === driverOwnerId);
    const driverHits = artifacts.hits.filter((artifact) => artifact.ownerId === driverOwnerId);

    if (
      driverSeeds.length !== 1 ||
      driverHits.length !== 1 ||
      !supportArtifactSourcesMatch(driverSeeds[0]!, driverProfile.sources) ||
      !supportArtifactSourcesMatch(driverHits[0]!, driverProfile.sources)
    ) {
      throw new Error("Coverage owner driver support artifacts are missing or duplicated");
    }
  }

  return artifacts;
}

function validateRunResultsBeforeSnapshot(
  directory: string,
  runId: string,
  workerMode: boolean,
  installedCliMode: boolean,
  configuredPluginMode: boolean,
  creatorCliMode: boolean,
  population?: CoveragePopulation,
  captureContext?: WorkerCaptureContext,
  creatorPreparedSources?: readonly PreparedCoverageSource[],
  configuredPluginPreparedSources?: readonly PreparedCoverageSource[],
): void {
  const artifacts = readRunResultArtifacts(
    directory,
    runId,
    workerMode,
    population,
    captureContext,
  );
  const driverProfile = coverageOwnerProfile("driver");

  if (driverProfile) {
    const driverSeeds = artifacts.seeds.filter((artifact) => artifact.ownerId === driverOwnerId);
    const driverHits = artifacts.hits.filter((artifact) => artifact.ownerId === driverOwnerId);

    if (
      driverSeeds.length !== 1 ||
      driverHits.length !== 0 ||
      !supportArtifactSourcesMatch(driverSeeds[0]!, driverProfile.sources)
    ) {
      throw new Error("Coverage owner driver support artifacts are missing or duplicated");
    }
  }

  if (!workerMode) assertBootstrapCapture(artifacts.hits);

  if (configuredPluginMode) {
    assertConfiguredPluginBuildCapture(
      artifacts,
      runId,
      configuredPluginPreparedSources ?? [],
      installedCliMode,
    );
  } else if (installedCliMode) {
    assertInstalledCliCapture(artifacts.hits);
  }

  if (creatorCliMode) {
    assertCreatorCliCapture(artifacts.seeds, artifacts.hits, creatorPreparedSources ?? []);
  }
}

function currentRunPopulation(directory: string, runId: string): CoveragePopulation | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || !entry.name.startsWith(`${runId}-`)) {
      continue;
    }

    let value: unknown;

    try {
      value = JSON.parse(readFileSync(join(directory, entry.name), "utf8"));
    } catch {
      continue;
    }

    if (
      isRecord(value) &&
      value.kind === "seed" &&
      value.ownerId === ownerId &&
      value.runId === runId &&
      isRecord(value.population) &&
      value.population.schema === 1 &&
      typeof value.population.fingerprint === "string" &&
      Array.isArray(value.population.files)
    ) {
      return value.population as unknown as CoveragePopulation;
    }
  }

  return undefined;
}

function assertDriverSupportCapture(hits: readonly CoverageArtifact[]): void {
  const profile = coverageOwnerProfile("driver");

  if (!profile) return;

  const artifacts = hits.filter((artifact) => artifact.ownerId === profile.ownerId);

  if (artifacts.length !== 1) {
    throw new Error("Coverage owner driver support hits are missing or duplicated");
  }

  const artifact = artifacts[0]!;

  if (!supportArtifactSourcesMatch(artifact, profile.sources)) {
    throw new Error("Coverage owner driver support hit has an incomplete source allowlist");
  }

  for (const source of profile.requiredHitSources) {
    const authoredPath = resolve(repoPath, source.replaceAll("/", sep));
    const coverage = Object.values(artifact.coverage).find(
      (item) => resolve(item.path) === authoredPath,
    );

    if (!hasCoverageHits(coverage!)) {
      throw new Error(`Coverage owner driver support hit is missing: ${source}`);
    }
  }
}

async function main(): Promise<void> {
  let runId: string | undefined;
  let outputDirectory: string | undefined;
  let bootstrapDirectory: string | undefined;
  let workerBuildDirectory: string | undefined;
  let workerGraph: Awaited<ReturnType<typeof buildCoverageWorkerGraph>> | undefined;
  let browserPageBuildDirectory: string | undefined;
  let browserPageGraph: Awaited<ReturnType<typeof buildCoverageWorkerGraph>> | undefined;
  let installedCliHelperSource: PreparedCoverageSource | undefined;
  let installedCliChildPreloadPath: string | undefined;
  let configuredPluginChildPreloadPath: string | undefined;
  let configuredPluginPreparedSources: PreparedCoverageSource[] | undefined;
  let configuredPluginCaptureValidatedBeforeSnapshot = false;
  let creatorCliProfilePath: string | undefined;
  let creatorCliChildPreloadPath: string | undefined;
  let creatorPreparedSourcesForCapture: PreparedCoverageSource[] | undefined;
  let supportBound = false;
  let installedCliCaptureValidatedBeforeSnapshot = false;
  let creatorCliCaptureValidatedBeforeSnapshot = false;

  try {
    const testPaths = testPathsFromArguments(Bun.argv.slice(2));
    const workerSelection = classifyProjectWorkerOwnerSelection(testPaths);
    const workerMode = workerSelection !== undefined;
    const installedCliSelectionCount = testPaths.filter(
      (path) => path === installedCliCoverageTest,
    ).length;

    if (installedCliSelectionCount > 1) {
      throw new Error("Installed CLI coverage owner was selected more than once");
    }

    const installedCliMode = installedCliSelectionCount === 1;
    const configuredPluginSelectionCount = testPaths.filter(
      (path) => path === configuredPluginCoverageTest,
    ).length;

    if (configuredPluginSelectionCount > 1) {
      throw new Error("Configured plugin coverage owner was selected more than once");
    }

    const configuredPluginMode = configuredPluginSelectionCount === 1;
    const creatorCliSelectionCount = testPaths.filter(
      (path) => path === creatorCliCoverageTest,
    ).length;

    if (creatorCliSelectionCount > 1) {
      throw new Error("Creator CLI coverage owner was selected more than once");
    }

    const creatorCliMode = creatorCliSelectionCount === 1;
    const workerGraphMode = workerMode || installedCliMode || configuredPluginMode;
    const elysiaMode = workerSelection === "elysia";
    const elysiaTestPaths = testPaths.filter((path) =>
      (elysiaWorkerOwnerTestPaths as readonly string[]).includes(path),
    );
    const expectedSources = inventoryCoverageSources(repoPath);
    runId = randomUUID();
    outputDirectory = resolve(outputRoot, runId);

    mkdirSync(outputRoot, { recursive: true });

    mkdirSync(outputDirectory);

    if (readdirSync(outputDirectory).length !== 0) {
      throw new Error("New coverage run directory was not empty");
    }

    let workerPopulation: CoveragePopulation | undefined;
    let workerTemplatePath: string | undefined;
    let workerOutputMapPath: string | undefined;
    let workerPreloadBootstrapPath: string | undefined;

    if (workerGraphMode) {
      workerBuildDirectory = resolve(repoPath, ".hesperia/coverage/worker-builds", runId);
      workerGraph = await buildCoverageWorkerGraph({
        repoPath,
        directory: workerBuildDirectory,
        sources: expectedSources,
        ...(installedCliMode || configuredPluginMode
          ? { exposePreparedSourcePaths: [installedCliSource] }
          : {}),
        ...(workerMode || installedCliMode || configuredPluginMode
          ? {
              additionalSeededSources: [
                ...(workerMode ? [workerPreloadSource] : []),
                ...(installedCliMode || configuredPluginMode ? [installedCliChildSource] : []),
              ],
            }
          : {}),
        ...(elysiaMode ? { packages: ["tooling", "compiler", "hosting", "elysia"] as const } : {}),
      });
      workerPopulation = workerGraph.sourcePopulation;
      workerTemplatePath = join(workerBuildDirectory, "worker-seed-template.json");
      workerOutputMapPath = join(workerBuildDirectory, "worker-output-map.json");

      if (workerMode) {
        supportBound = bindCoverageOwnerRun({
          runId,
          outputDirectory,
          population: workerPopulation,
        });
        const preparedWorkerPreload = await prepareCoverageSource(workerPreloadSource, repoPath);

        assertPreparedSourceMatchesPopulation(
          preparedWorkerPreload,
          workerPopulation,
          workerGraph.canonicalSeedCoverage,
        );

        const workerBootstrap = createBootstrapPreload(
          runId,
          [preparedWorkerPreload],
          workerPreloadSource,
        );
        bootstrapDirectory = workerBootstrap.directory;
        workerPreloadBootstrapPath = workerBootstrap.preloadPath;
      }
    }

    if (!workerMode && testPaths.some((testPath) => browserPageCoverageTests.has(testPath))) {
      browserPageBuildDirectory = resolve(
        repoPath,
        ".hesperia/coverage/browser-page-builds",
        runId,
      );
      browserPageGraph = await buildCoverageWorkerGraph({
        repoPath,
        directory: browserPageBuildDirectory,
        sources: expectedSources,
        packages: ["tooling", "compiler", "hosting", "hesperia"] as const,
      });
      const browserPopulationSources = browserPageGraph.sourcePopulation.files
        .map((file) => file.source)
        .sort();
      const expectedPopulationSources = expectedSources
        .map((source) => relative(repoPath, source).split(sep).join("/"))
        .sort();

      if (
        JSON.stringify(browserPopulationSources) !== JSON.stringify(expectedPopulationSources) ||
        new Set(browserPopulationSources).size !== expectedPopulationSources.length
      ) {
        throw new Error(
          "Browser page worker graph does not preserve the complete source population",
        );
      }
    }

    let testPreloadPath = resolve(repoPath, "scripts/ci/coverage-preload.ts");

    if (!workerMode) {
      const prepared = await Promise.all(
        bootstrapSources.map((source) => prepareCoverageSource(source, repoPath)),
      );
      const bootstrap = createBootstrapPreload(runId, prepared);
      bootstrapDirectory = bootstrap.directory;
      testPreloadPath = bootstrap.preloadPath;
    }

    if (installedCliMode || configuredPluginMode) {
      installedCliHelperSource = await prepareCoverageSource(installedCliChildSource, repoPath);

      assertPreparedSourceMatchesPopulation(
        installedCliHelperSource,
        workerGraph!.sourcePopulation,
        workerGraph!.canonicalSeedCoverage,
      );

      if (!installedCliHelperSource.bootstrapHash) {
        throw new Error("CLI graph omitted its prepared child-helper runtime identity");
      }

      if (installedCliMode) {
        const childBootstrap = createBootstrapPreload(
          runId,
          [installedCliHelperSource],
          installedCliChildSource,
        );
        installedCliChildPreloadPath = childBootstrap.preloadPath;
      }

      if (configuredPluginMode) {
        const preparedCliSource = workerGraph!.preparedCoverageSources?.find(
          (prepared) =>
            canonicalPath(prepared.path) ===
            canonicalPath(resolve(repoPath, installedCliSource.replaceAll("/", sep))),
        );

        if (!preparedCliSource?.bootstrapHash) {
          throw new Error("Configured plugin graph omitted its prepared CLI runtime identity");
        }

        assertPreparedSourceMatchesPopulation(
          preparedCliSource,
          workerGraph!.sourcePopulation,
          workerGraph!.canonicalSeedCoverage,
        );

        const childBootstrap = createBootstrapPreload(
          runId,
          [installedCliHelperSource],
          installedCliChildSource,
          "configured-plugin-build",
        );
        configuredPluginChildPreloadPath = childBootstrap.preloadPath;
        configuredPluginPreparedSources = [preparedCliSource, installedCliHelperSource];
      }

      bootstrapDirectory ??= resolve(repoPath, ".hesperia/coverage/bootstrap-builds", runId);
    }

    if (creatorCliMode) {
      let creatorPopulation = workerGraph?.sourcePopulation;
      let creatorCanonicalSeedCoverage = workerGraph?.canonicalSeedCoverage;
      let creatorPreparedSources: PreparedCoverageSource[];
      let creatorHelperSource = installedCliHelperSource;

      if (creatorPopulation && creatorCanonicalSeedCoverage) {
        creatorPreparedSources = await Promise.all(
          creatorCliSources.map((source) => prepareCoverageSource(source, repoPath)),
        );
        creatorHelperSource ??= await prepareCoverageSource(installedCliChildSource, repoPath);
      } else {
        const seeded = await seedCoverageSources(expectedSources, repoPath);
        creatorPopulation = seeded.population;
        creatorCanonicalSeedCoverage = seeded.coverage;
        const preparedBySource = new Map(
          seeded.prepared.map((prepared) => [prepared.relativePath, prepared] as const),
        );
        creatorPreparedSources = creatorCliSources.map((source) => {
          const prepared = preparedBySource.get(source);

          if (!prepared) throw new Error(`Creator CLI seed preparation omitted ${source}`);

          return prepared;
        });
        creatorHelperSource = preparedBySource.get(installedCliChildSource);
      }

      if (!creatorPopulation || !creatorCanonicalSeedCoverage || !creatorHelperSource) {
        throw new Error("Creator CLI source preparation is incomplete");
      }

      const preparedCaptureSources = [creatorHelperSource, ...creatorPreparedSources];

      for (const prepared of preparedCaptureSources) {
        assertPreparedSourceMatchesPopulation(
          prepared,
          creatorPopulation,
          creatorCanonicalSeedCoverage,
        );

        if (!prepared.bootstrapHash) {
          throw new Error(
            `Creator CLI source has no prepared runtime identity: ${prepared.relativePath}`,
          );
        }
      }

      if (!creatorHelperSource.bootstrapHash) {
        throw new Error("Creator CLI graph omitted its prepared child-helper runtime identity");
      }

      creatorPreparedSourcesForCapture = preparedCaptureSources;
      const creatorBootstrap = createBootstrapPreload(
        runId,
        preparedCaptureSources,
        installedCliChildSource,
        "creator-cli",
      );
      creatorCliChildPreloadPath = creatorBootstrap.preloadPath;
      creatorCliProfilePath = join(creatorBootstrap.directory, "creator-cli-profile.json");

      writeFileSync(
        creatorCliProfilePath,
        JSON.stringify({
          format: "hesperia-creator-cli-profile",
          version: 1,
          runId,
          ownerId,
          populationFingerprint: creatorPopulation.fingerprint,
          outputDirectory,
          sourcePopulation: creatorPopulation,
          childPreloadPath: creatorCliChildPreloadPath,
          sources: preparedCaptureSources.map((prepared) => ({
            source: prepared.relativePath,
            path: prepared.path,
            runtimeHash: prepared.bootstrapHash,
            runtimeSchema: preparedRuntimeSchema(prepared),
            seed: prepared.seed,
          })),
        }),
        { flag: "wx" },
      );

      bootstrapDirectory ??= resolve(repoPath, ".hesperia/coverage/bootstrap-builds", runId);
    }

    const childEnvironment: Record<string, string | undefined> = {
      ...process.env,
      HESPERIA_COVERAGE_RUN_ID: runId,
      HESPERIA_COVERAGE_OUTPUT_DIR: outputDirectory,
      HESPERIA_COVERAGE_CONTEXT: "coverage-runner",
      HESPERIA_COVERAGE_OWNER_ID: ownerId,
    };
    delete childEnvironment.BUN_OPTIONS;
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.HESPERIA_COVERAGE_OWNER_LAUNCHED;
    delete childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_TEMPLATE;
    delete childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_OUTPUT_MAP;
    delete childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_BUILD_DIRECTORY;
    delete childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_POPULATION;
    delete childEnvironment.HESPERIA_COVERAGE_WORKER_CAPTURE;
    delete childEnvironment.HESPERIA_COVERAGE_WORKER_TEMPLATE;
    delete childEnvironment.HESPERIA_COVERAGE_WORKER_OUTPUT_MAP;

    for (const key of Object.keys(childEnvironment)) {
      if (
        key.startsWith("HESPERIA_COVERAGE_INSTALLED_CLI_") ||
        key.startsWith("HESPERIA_COVERAGE_CONFIGURED_PLUGIN_") ||
        key.startsWith("HESPERIA_COVERAGE_CREATOR_CLI_") ||
        key.startsWith("HESPERIA_CONFIGURED_PLUGIN_BUILD_") ||
        key.startsWith("HESPERIA_CLI_CAPTURE_") ||
        key.startsWith("HESPERIA_CREATOR_CLI_CAPTURE_")
      ) {
        delete childEnvironment[key];
      }
    }

    if (workerMode) {
      childEnvironment.BUN_OPTIONS = `--preload=${workerPreloadBootstrapPath!}`;
      childEnvironment.HESPERIA_COVERAGE_WORKER_CAPTURE = "1";
      childEnvironment.HESPERIA_COVERAGE_WORKER_TEMPLATE = workerTemplatePath!;
      childEnvironment.HESPERIA_COVERAGE_WORKER_OUTPUT_MAP = workerOutputMapPath!;
    }

    if (installedCliMode) {
      if (!installedCliHelperSource?.bootstrapHash || !installedCliChildPreloadPath) {
        throw new Error("Installed CLI child-helper bootstrap is incomplete");
      }

      const preparedCliSource = workerGraph!.preparedCoverageSources?.find(
        (prepared) =>
          canonicalPath(prepared.path) ===
          canonicalPath(resolve(repoPath, installedCliSource.replaceAll("/", sep))),
      );

      if (!preparedCliSource?.bootstrapHash) {
        throw new Error("Installed CLI graph omitted its fresh prepared runtime identity");
      }

      childEnvironment.HESPERIA_COVERAGE_WORKER_TEMPLATE = workerTemplatePath!;
      childEnvironment.HESPERIA_COVERAGE_WORKER_OUTPUT_MAP = workerOutputMapPath!;
      childEnvironment.HESPERIA_COVERAGE_INSTALLED_CLI_RUNTIME = JSON.stringify({
        hash: preparedCliSource.bootstrapHash,
        schema: preparedRuntimeSchema(preparedCliSource),
        helperHash: installedCliHelperSource.bootstrapHash,
        helperSchema: preparedRuntimeSchema(installedCliHelperSource),
        childPreloadPath: installedCliChildPreloadPath,
      });
      childEnvironment.HESPERIA_CLI_CAPTURE_ADAPTER = resolve(
        repoPath,
        "scripts/ci/coverage-installed-cli.ts",
      );
    }

    if (configuredPluginMode) {
      if (!configuredPluginChildPreloadPath || !configuredPluginPreparedSources) {
        throw new Error("Configured plugin build child capture profile is incomplete");
      }

      childEnvironment.HESPERIA_COVERAGE_WORKER_TEMPLATE = workerTemplatePath!;
      childEnvironment.HESPERIA_COVERAGE_WORKER_OUTPUT_MAP = workerOutputMapPath!;
      childEnvironment.HESPERIA_COVERAGE_CONFIGURED_PLUGIN_RUNTIME = JSON.stringify({
        hash: configuredPluginPreparedSources[0]!.bootstrapHash,
        schema: preparedRuntimeSchema(configuredPluginPreparedSources[0]!),
        helperHash: configuredPluginPreparedSources[1]!.bootstrapHash,
        helperSchema: preparedRuntimeSchema(configuredPluginPreparedSources[1]!),
        childPreloadPath: configuredPluginChildPreloadPath,
      });
      childEnvironment.HESPERIA_CONFIGURED_PLUGIN_BUILD_ADAPTER = resolve(
        repoPath,
        "scripts/ci/coverage-installed-cli.ts",
      );
    }

    if (creatorCliMode) {
      if (!creatorCliProfilePath || !creatorCliChildPreloadPath) {
        throw new Error("Creator CLI child capture profile is incomplete");
      }

      childEnvironment.HESPERIA_CREATOR_CLI_CAPTURE_ADAPTER = resolve(
        repoPath,
        "scripts/ci/coverage-installed-cli.ts",
      );
      childEnvironment.HESPERIA_COVERAGE_CREATOR_CLI_PROFILE = creatorCliProfilePath;
    }

    if (browserPageGraph) {
      childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_TEMPLATE = join(
        browserPageBuildDirectory!,
        "worker-seed-template.json",
      );
      childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_OUTPUT_MAP = join(
        browserPageBuildDirectory!,
        "worker-output-map.json",
      );
      childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_BUILD_DIRECTORY = browserPageBuildDirectory!;
      childEnvironment.HESPERIA_COVERAGE_BROWSER_PAGE_POPULATION =
        browserPageGraph.sourcePopulation.fingerprint;
    }

    const child = Bun.spawn(
      [process.execPath, "test", "--preload", testPreloadPath, "--timeout=45000", ...testPaths],
      {
        cwd: repoPath,
        env: childEnvironment,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    let exitCode = 1;

    try {
      exitCode = await child.exited;
    } finally {
      if (bootstrapDirectory) {
        const directory = bootstrapDirectory;
        bootstrapDirectory = undefined;

        rmSync(directory, { recursive: true, force: true });
      }
    }

    const sourcePopulation = workerPopulation ?? currentRunPopulation(outputDirectory, runId);

    if (sourcePopulation) {
      if (!supportBound) {
        supportBound = bindCoverageOwnerRun({
          runId,
          outputDirectory,
          population: sourcePopulation,
        });
      }
    }

    if (exitCode !== 0) {
      if (sourcePopulation && supportBound) {
        try {
          snapshotCoverageOwnerHits();
        } catch {}
      }

      throw new Error(`Bun test owner failed with exit code ${exitCode}`);
    }

    const captureContext = elysiaMode
      ? {
          directory: join(workerBuildDirectory!, "captures"),
          outputs: workerGraph!.outputs,
          sourceOutputs: workerGraph!.sourceOutputs,
          elysiaTestPaths,
        }
      : undefined;

    if (sourcePopulation && supportBound) {
      validateRunResultsBeforeSnapshot(
        outputDirectory,
        runId,
        workerMode,
        installedCliMode,
        configuredPluginMode,
        creatorCliMode,
        workerPopulation,
        captureContext,
        creatorPreparedSourcesForCapture,
        configuredPluginPreparedSources,
      );

      installedCliCaptureValidatedBeforeSnapshot = installedCliMode;
      configuredPluginCaptureValidatedBeforeSnapshot = configuredPluginMode;
      creatorCliCaptureValidatedBeforeSnapshot = creatorCliMode;

      snapshotCoverageOwnerHits();
    }

    const artifacts = readCurrentRunArtifacts(
      outputDirectory,
      runId,
      workerMode,
      workerPopulation,
      captureContext,
    );

    if (configuredPluginMode && !configuredPluginCaptureValidatedBeforeSnapshot) {
      assertConfiguredPluginBuildCapture(
        artifacts,
        runId,
        configuredPluginPreparedSources ?? [],
        installedCliMode,
      );
    } else if (installedCliMode && !installedCliCaptureValidatedBeforeSnapshot) {
      assertInstalledCliCapture(artifacts.hits);
    }

    if (creatorCliMode && !creatorCliCaptureValidatedBeforeSnapshot) {
      assertCreatorCliCapture(
        artifacts.seeds,
        artifacts.hits,
        creatorPreparedSourcesForCapture ?? [],
      );
    }

    assertDriverSupportCapture(artifacts.hits);

    const merged = await mergeCoverageArtifacts({
      repoPath,
      expectedSources,
      seeds: artifacts.seeds,
      fragments: artifacts.hits,
    });

    if (merged.files().length !== expectedSources.length) {
      throw new Error("Coverage merge did not preserve the full authored-source inventory");
    }

    if (!workerMode) assertBootstrapCapture(artifacts.hits);

    const lcovPath = join(outputDirectory, "lcov.info");

    writeLcovReport(merged, lcovPath);

    console.log(
      JSON.stringify({
        status: "completed",
        runId,
        ownerId,
        outputDirectory,
        lcovPath,
        seedArtifacts: artifacts.seeds.length,
        hitArtifacts: artifacts.hits.length,
        mergedSources: merged.files().length,
        ...(artifacts.workerManifest
          ? {
              workerInvocations: artifacts.workerManifest.invocations.length,
              workerAbortedUncaptured: artifacts.workerAbortedUncaptured,
            }
          : {}),
      }),
    );
  } catch (error) {
    if (bootstrapDirectory) {
      try {
        rmSync(bootstrapDirectory, { recursive: true, force: true });
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
