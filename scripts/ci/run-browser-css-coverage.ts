import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { buildCoverageWorkerGraph } from "./coverage-worker-build.ts";
import {
  browserCssCoverageOwnerIds,
  browserCssCoveragePageOwnerIds,
  browserCssCoverageReceiptNames,
  browserCssCoverageRequiredSources,
  browserCssCoverageScenariosByOwnerId,
  isBrowserCssCoveragePageOwnerId,
  type BrowserCssCoverageOwnerId,
  type CaptureReceipt,
} from "./browser-css-coverage-contract.ts";
import {
  bindCoverageOwnerRun,
  coverageOwnerProfile,
  snapshotCoverageOwnerHits,
} from "./coverage-owner-launcher.ts";
import {
  createCoverageArtifact,
  inventoryCoverageSources,
  mergeCoverageArtifacts,
  writeCoverageFragment,
  prepareCoverageSource,
  writeLcovReport,
  type CoverageArtifact,
  type CoverageFile,
  type CoveragePopulation,
  type PreparedCoverageSource,
} from "./coverage-collector.ts";

const repoPath = resolve(import.meta.dir, "../..");
const runRoot = resolve(repoPath, ".hesperia/coverage/browser-css-runs");
const selectedCases = browserCssCoveragePageOwnerIds.map((ownerId) => ({
  ownerId,
  ...browserCssCoverageScenariosByOwnerId[ownerId],
}));
const selectedSpecs = [...new Set(selectedCases.map((scenario) => scenario.spec))];
const selectedTitlePattern = selectedCases
  .map((scenario) => scenario.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  .join("|");
const captureOwnerIds = [
  browserCssCoverageOwnerIds.server,
  ...browserCssCoveragePageOwnerIds,
] as const;
const canonicalSeedOwnerId = "browser-css-canonical-seed";
const packageSelection = ["tooling", "compiler", "hosting", "hesperia"] as const;
const preparedToolingSourcePaths = [
  "packages/tooling/src/project.ts",
  "packages/tooling/src/builtin-assets.ts",
  "packages/tooling/src/plugin-pipeline.ts",
] as const;
const receiptNames = browserCssCoverageReceiptNames;
const browserPreloadSource = "scripts/ci/browser-css-coverage-preload.ts" as const;

interface BrowserReport {
  readonly config?: {
    readonly rootDir?: unknown;
  };
  readonly suites?: unknown;
  readonly stats?: {
    readonly expected?: number;
    readonly unexpected?: number;
    readonly skipped?: number;
    readonly flaky?: number;
  };
}

interface OwnedArtifacts {
  readonly receipts: ReadonlyMap<BrowserCssCoverageOwnerId, CaptureReceipt>;
  readonly seeds: ReadonlyMap<BrowserCssCoverageOwnerId, CoverageArtifact>;
  readonly hits: ReadonlyMap<BrowserCssCoverageOwnerId, CoverageArtifact>;
  readonly supportSeed?: CoverageArtifact;
  readonly supportHits?: CoverageArtifact;
  readonly canonicalSeed: CoverageArtifact;
}

interface BrowserRunArtifacts {
  readonly receipts: ReadonlyMap<BrowserCssCoverageOwnerId, CaptureReceipt>;
  readonly seeds: ReadonlyMap<BrowserCssCoverageOwnerId, CoverageArtifact>;
  readonly hits: ReadonlyMap<BrowserCssCoverageOwnerId, CoverageArtifact>;
  readonly supportArtifacts: readonly CoverageArtifact[];
  readonly canonicalSeed: CoverageArtifact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
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
      `Browser preload preparation does not match the current source population: ${prepared.relativePath}`,
    );
  }
}

function createBrowserPreloadBootstrap(
  directory: string,
  prepared: PreparedCoverageSource,
): string {
  if (
    prepared.relativePath !== browserPreloadSource ||
    canonicalPath(prepared.path) !== canonicalPath(resolve(repoPath, browserPreloadSource))
  ) {
    throw new Error("Browser preload bootstrap received an unexpected authored source");
  }

  const instrumentedPath = join(directory, "browser-css-coverage-preload.instrumented.ts");
  const preloadPath = join(directory, "browser-css-coverage-preload-bootstrap.ts");
  const escapedPath = prepared.path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const filterSource = `^${escapedPath}$`;

  writeFileSync(instrumentedPath, prepared.instrumentedCode, { flag: "wx" });

  writeFileSync(
    preloadPath,
    `
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const originalPath = ${JSON.stringify(prepared.path)};
const preparedPath = ${JSON.stringify(instrumentedPath)};
const canonicalPath = (path) => {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};
const authoredSourceFilter = new RegExp(
  ${JSON.stringify(filterSource)},
  process.platform === "win32" ? "iu" : "u",
);
Bun.plugin({
  name: "hesperia-browser-preload-source-first",
  setup(build) {
    build.onLoad({ filter: authoredSourceFilter }, ({ path }) => {
      if (canonicalPath(path) !== canonicalPath(originalPath)) {
        throw new Error("Browser preload matched an unknown authored source: " + path);
      }
      return {
        contents: readFileSync(preparedPath, "utf8"),
        loader: ${JSON.stringify(prepared.loader)},
      };
    });
  },
});
await import(pathToFileURL(originalPath).href);
`,
    { flag: "wx" },
  );

  return preloadPath;
}

function sourcePath(path: string): string {
  const absolute = resolve(path);
  const relativePath = relative(repoPath, absolute);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(repoPath, relativePath) !== absolute
  ) {
    throw new Error(`Coverage source escaped the repository: ${path}`);
  }

  return relativePath.split(sep).join("/");
}

function hasHits(file: CoverageFile): boolean {
  return (
    Object.values(file.s).some((count) => count > 0) ||
    Object.values(file.f).some((count) => count > 0) ||
    Object.values(file.b).some((counts) => counts.some((count) => count > 0))
  );
}

function positiveSources(artifact: CoverageArtifact): readonly string[] {
  return Object.values(artifact.coverage)
    .filter(hasHits)
    .map((file) => sourcePath(file.path))
    .sort();
}

async function chooseBrowserPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);

    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Unable to choose a browser port");

  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

function writeCanonicalSeed(options: {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly sourcePopulation: CoveragePopulation;
  readonly coverage: Record<string, CoverageFile>;
}): string {
  const artifact = createCoverageArtifact({
    repoPath,
    kind: "seed",
    runId: options.runId,
    ownerId: canonicalSeedOwnerId,
    populationFingerprint: options.sourcePopulation.fingerprint,
    population: options.sourcePopulation,
    coverage: options.coverage,
  });
  return writeCoverageFragment({
    directory: options.outputDirectory,
    contextId: "browser-css-canonical-seed",
    pid: process.pid,
    threadId: 0,
    repoPath,
    artifact,
    sourcePopulation: options.sourcePopulation,
  });
}

function parseCaptureReceipt(
  value: unknown,
  ownerId: BrowserCssCoverageOwnerId,
  runId: string,
  population: CoveragePopulation,
): CaptureReceipt {
  const validPathRecords = (
    records: unknown,
  ): records is readonly { readonly path: string; readonly realPath: string }[] =>
    Array.isArray(records) &&
    records.length > 0 &&
    records.every(
      (record) =>
        isRecord(record) && typeof record.path === "string" && typeof record.realPath === "string",
    );

  if (
    !isRecord(value) ||
    value.format !== "hesperia-browser-css-coverage-capture" ||
    value.version !== 2 ||
    value.runId !== runId ||
    value.populationFingerprint !== population.fingerprint ||
    value.ownerId !== ownerId ||
    typeof value.seedArtifact !== "string" ||
    typeof value.hitArtifact !== "string" ||
    !Array.isArray(value.positiveSources) ||
    value.positiveSources.some((source) => typeof source !== "string") ||
    (ownerId === browserCssCoverageOwnerIds.server &&
      (typeof value.buildSubstitutions !== "number" ||
        !Number.isSafeInteger(value.buildSubstitutions) ||
        value.buildSubstitutions <= 0 ||
        !validPathRecords(value.buildSubstitutionPaths) ||
        value.buildSubstitutionPaths.length !== value.buildSubstitutions ||
        !validPathRecords(value.runtimeSubstitutionPaths))) ||
    (isBrowserCssCoveragePageOwnerId(ownerId) &&
      (value.buildSubstitutions !== undefined ||
        value.buildSubstitutionPaths !== undefined ||
        value.runtimeSubstitutionPaths !== undefined))
  ) {
    throw new Error(`Malformed or stale browser CSS receipt for ${ownerId}`);
  }

  if (isBrowserCssCoveragePageOwnerId(ownerId)) {
    const scenario = browserCssCoverageScenariosByOwnerId[ownerId];

    if (
      !isRecord(value.scenario) ||
      value.scenario.spec !== scenario.spec ||
      value.scenario.title !== scenario.title
    ) {
      throw new Error(`Browser coverage receipt scenario mismatch for ${ownerId}`);
    }
  } else if (value.scenario !== undefined) {
    throw new Error("Browser coverage server receipt contains a page scenario");
  }

  for (const filename of [value.seedArtifact, value.hitArtifact]) {
    if (
      basename(filename) !== filename ||
      !filename.startsWith(`${runId}-${ownerId}-`) ||
      !filename.endsWith(".json")
    ) {
      throw new Error(`Browser CSS receipt contains an invalid artifact name for ${ownerId}`);
    }
  }

  if (new Set(value.positiveSources).size !== value.positiveSources.length) {
    throw new Error(`Browser CSS receipt repeats a positive source for ${ownerId}`);
  }

  return value as unknown as CaptureReceipt;
}

function readBrowserRunArtifacts(options: {
  readonly directory: string;
  readonly runId: string;
  readonly sourcePopulation: CoveragePopulation;
  readonly expectedSources: readonly string[];
  readonly mappedModules: readonly { readonly originalPath: string }[];
}): BrowserRunArtifacts {
  const entries = readdirSync(options.directory, { withFileTypes: true });

  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("Browser CSS coverage output contains a non-file entry");
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry] as const));
  const receiptEntries = new Map<BrowserCssCoverageOwnerId, CaptureReceipt>();

  for (const ownerId of captureOwnerIds) {
    const filename = receiptNames[ownerId];
    const entry = byName.get(filename);

    if (!entry) throw new Error(`Browser CSS coverage is missing ${ownerId} receipt`);

    receiptEntries.set(
      ownerId,
      parseCaptureReceipt(
        JSON.parse(readFileSync(join(options.directory, filename), "utf8")),
        ownerId,
        options.runId,
        options.sourcePopulation,
      ),
    );
  }

  const referencedArtifacts = new Set(
    [...receiptEntries.values()].flatMap((receipt) => [receipt.seedArtifact, receipt.hitArtifact]),
  );
  const supportProfile = coverageOwnerProfile("driver");
  const receiptFiles = new Set<string>(Object.values(receiptNames));
  const artifactNames = entries
    .filter((entry) => !receiptFiles.has(entry.name))
    .map((entry) => entry.name);

  if (referencedArtifacts.size !== captureOwnerIds.length * 2) {
    throw new Error("Browser coverage receipts do not identify distinct owner artifacts");
  }

  const artifacts = new Map<string, CoverageArtifact>();

  for (const filename of artifactNames) {
    if (!filename.endsWith(".json") || !filename.startsWith(`${options.runId}-`)) {
      throw new Error(`Unexpected browser CSS coverage output: ${filename}`);
    }

    let value: unknown;

    try {
      value = JSON.parse(readFileSync(join(options.directory, filename), "utf8"));
    } catch (error) {
      throw new Error(`Malformed browser CSS artifact ${filename}`, { cause: error });
    }

    if (
      !isRecord(value) ||
      value.format !== "hesperia-coverage" ||
      value.version !== 2 ||
      value.runId !== options.runId ||
      value.populationFingerprint !== options.sourcePopulation.fingerprint ||
      value.platform !== process.platform ||
      (value.kind !== "seed" && value.kind !== "hits") ||
      typeof value.ownerId !== "string"
    ) {
      throw new Error(`Malformed or stale browser CSS artifact ${filename}`);
    }

    if (artifacts.has(filename))
      throw new Error(`Duplicate browser CSS artifact name: ${filename}`);

    artifacts.set(filename, value as unknown as CoverageArtifact);
  }

  const supportArtifacts = supportProfile
    ? [...artifacts.values()].filter((artifact) => artifact.ownerId === supportProfile.ownerId)
    : [];

  if (
    supportArtifacts.length > 2 ||
    artifactNames.length !== referencedArtifacts.size + 1 + supportArtifacts.length ||
    [...referencedArtifacts].some((name) => !artifacts.has(name))
  ) {
    throw new Error("Browser CSS coverage artifacts contain missing or orphan files");
  }

  const seeds = new Map<BrowserCssCoverageOwnerId, CoverageArtifact>();
  const hits = new Map<BrowserCssCoverageOwnerId, CoverageArtifact>();
  const mappedRealPaths = new Set(
    options.mappedModules.map((module) => canonicalPath(realpathSync(module.originalPath))),
  );

  for (const [ownerId, receipt] of receiptEntries) {
    const seed = artifacts.get(receipt.seedArtifact)!;
    const hit = artifacts.get(receipt.hitArtifact)!;

    if (
      seed.ownerId !== ownerId ||
      seed.kind !== "seed" ||
      seed.population !== undefined ||
      hit.ownerId !== ownerId ||
      hit.kind !== "hits" ||
      hit.population !== undefined
    ) {
      throw new Error(`Browser CSS owner artifacts do not match receipt ${ownerId}`);
    }

    const positive = positiveSources(hit);
    const requiredPositiveSource = browserCssCoverageRequiredSources[ownerId];

    if (
      JSON.stringify(positive) !== JSON.stringify([...receipt.positiveSources].sort()) ||
      requiredPositiveSource.some((source) => !positive.includes(source))
    ) {
      throw new Error(
        `Browser CSS owner is missing required hits: ${requiredPositiveSource.join(", ")}`,
      );
    }

    if (ownerId === browserCssCoverageOwnerIds.server && !positive.includes(browserPreloadSource)) {
      throw new Error("Browser CSS server did not execute its authored coverage preload");
    }

    if (ownerId === browserCssCoverageOwnerIds.server && (receipt.buildSubstitutions ?? 0) <= 0) {
      throw new Error("Browser CSS server receipt has no Bun.build substitutions");
    }

    if (ownerId === browserCssCoverageOwnerIds.server) {
      const buildPaths = receipt.buildSubstitutionPaths ?? [];
      const runtimePaths = receipt.runtimeSubstitutionPaths ?? [];

      for (const record of [...buildPaths, ...runtimePaths]) {
        let resolved: string;

        try {
          resolved = realpathSync(record.path);
        } catch (error) {
          throw new Error(`Browser CSS substitution path is no longer resolvable: ${record.path}`, {
            cause: error,
          });
        }

        if (
          canonicalPath(resolved) !== canonicalPath(record.realPath) ||
          !mappedRealPaths.has(canonicalPath(resolved))
        ) {
          throw new Error(`Browser CSS substitution path is not in the output map: ${record.path}`);
        }
      }

      const expectedCompilerPath = canonicalPath(
        realpathSync(resolve(repoPath, "packages/compiler/dist/project-compilation.js")),
      );

      if (!runtimePaths.some((record) => canonicalPath(record.realPath) === expectedCompilerPath)) {
        throw new Error("Browser CSS server did not preload the original compiler entry path");
      }

      const expectedStylePath = canonicalPath(
        realpathSync(resolve(repoPath, "packages/hesperia/dist/runtime/style.js")),
      );

      if (!buildPaths.some((record) => canonicalPath(record.realPath) === expectedStylePath)) {
        throw new Error("Browser CSS build did not substitute the original style runtime module");
      }
    }

    seeds.set(ownerId, seed);

    hits.set(ownerId, hit);
  }

  const canonical = [...artifacts.values()].filter(
    (artifact) => artifact.ownerId === canonicalSeedOwnerId && artifact.kind === "seed",
  );

  if (
    canonical.length !== 1 ||
    canonical[0]!.population === undefined ||
    canonical[0]!.populationFingerprint !== options.sourcePopulation.fingerprint ||
    JSON.stringify(canonical[0]!.population) !== JSON.stringify(options.sourcePopulation) ||
    Object.keys(canonical[0]!.coverage).length !== options.expectedSources.length
  ) {
    throw new Error("Browser CSS run is missing one full-inventory canonical seed");
  }

  return {
    receipts: receiptEntries,
    seeds,
    hits,
    supportArtifacts,
    canonicalSeed: canonical[0]!,
  };
}

function validateBrowserRunResultsBeforeSnapshot(options: {
  readonly directory: string;
  readonly runId: string;
  readonly sourcePopulation: CoveragePopulation;
  readonly expectedSources: readonly string[];
  readonly mappedModules: readonly { readonly originalPath: string }[];
}): void {
  const run = readBrowserRunArtifacts(options);
  const supportProfile = coverageOwnerProfile("driver");

  if (!supportProfile) return;

  const supportSeeds = run.supportArtifacts.filter((artifact) => artifact.kind === "seed");
  const supportHits = run.supportArtifacts.filter((artifact) => artifact.kind === "hits");
  const supportSeed = supportSeeds[0];

  if (
    run.supportArtifacts.length !== 1 ||
    supportSeeds.length !== 1 ||
    supportHits.length !== 0 ||
    supportSeed!.population !== undefined ||
    supportSeed!.populationFingerprint !== options.sourcePopulation.fingerprint
  ) {
    throw new Error("Browser CSS driver support artifacts are missing or duplicated");
  }

  const expectedSupportPaths = supportProfile.sources
    .map((source) => canonicalPath(resolve(repoPath, source.replaceAll("/", sep))))
    .sort();
  const actualPaths = Object.keys(supportSeed!.coverage).map(canonicalPath).sort();

  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedSupportPaths)) {
    throw new Error("Browser CSS driver support artifact has an incomplete source allowlist");
  }
}

function readOwnedArtifacts(options: {
  readonly directory: string;
  readonly runId: string;
  readonly sourcePopulation: CoveragePopulation;
  readonly expectedSources: readonly string[];
  readonly mappedModules: readonly { readonly originalPath: string }[];
}): OwnedArtifacts {
  const run = readBrowserRunArtifacts(options);
  const supportProfile = coverageOwnerProfile("driver");
  let supportSeed: CoverageArtifact | undefined;
  let supportHits: CoverageArtifact | undefined;

  if (supportProfile) {
    const support = run.supportArtifacts;
    supportSeed = support.find((artifact) => artifact.kind === "seed");
    supportHits = support.find((artifact) => artifact.kind === "hits");

    if (
      support.length !== 2 ||
      !supportSeed ||
      !supportHits ||
      supportSeed.population !== undefined ||
      supportSeed.populationFingerprint !== options.sourcePopulation.fingerprint
    ) {
      throw new Error("Browser CSS driver support artifacts are missing or duplicated");
    }

    const expectedSupportPaths = supportProfile.sources
      .map((source) => canonicalPath(resolve(repoPath, source.replaceAll("/", sep))))
      .sort();

    for (const artifact of [supportSeed, supportHits]) {
      const actualPaths = Object.keys(artifact.coverage).map(canonicalPath).sort();

      if (JSON.stringify(actualPaths) !== JSON.stringify(expectedSupportPaths)) {
        throw new Error("Browser CSS driver support artifact has an incomplete source allowlist");
      }
    }

    for (const source of supportProfile.requiredHitSources) {
      const expectedPath = resolve(repoPath, source.replaceAll("/", sep));
      const file = Object.values(supportHits.coverage).find(
        (item) => canonicalPath(item.path) === canonicalPath(expectedPath),
      );

      if (!file || !hasHits(file)) {
        throw new Error(`Browser CSS driver support hit is missing: ${source}`);
      }
    }
  }

  return {
    receipts: run.receipts,
    seeds: run.seeds,
    hits: run.hits,
    ...(supportSeed ? { supportSeed } : {}),
    ...(supportHits ? { supportHits } : {}),
    canonicalSeed: run.canonicalSeed,
  };
}

function assertPlaywrightReport(path: string): void {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.suites) ||
    !isRecord(parsed.stats) ||
    !isRecord(parsed.config) ||
    typeof parsed.config.rootDir !== "string"
  ) {
    throw new Error("Browser CSS Playwright report is malformed");
  }

  const report = parsed as unknown as BrowserReport;
  const reportRoot = resolve(repoPath, report.config!.rootDir as string);
  const matches = new Map(
    selectedCases.map((scenario) => [scenario.ownerId, [] as Record<string, unknown>[]]),
  );

  const visit = (suites: readonly unknown[]) => {
    for (const value of suites) {
      if (!isRecord(value)) throw new Error("Browser CSS Playwright report has a malformed suite");

      if (Array.isArray(value.specs)) {
        for (const spec of value.specs) {
          if (!isRecord(spec) || typeof spec.file !== "string") continue;

          const file = canonicalPath(resolve(reportRoot, spec.file));

          for (const scenario of selectedCases) {
            if (
              spec.title === scenario.title &&
              file === canonicalPath(resolve(repoPath, scenario.spec))
            ) {
              matches.get(scenario.ownerId)!.push(spec);
            }
          }
        }
      }

      if (value.suites !== undefined) {
        if (!Array.isArray(value.suites))
          throw new Error("Browser CSS report suite list is malformed");

        visit(value.suites);
      }
    }
  };

  visit(report.suites as readonly unknown[]);

  for (const scenario of selectedCases) {
    const cases = matches.get(scenario.ownerId)!;
    const spec = cases[0];

    if (
      cases.length !== 1 ||
      spec?.ok !== true ||
      !Array.isArray(spec.tests) ||
      spec.tests.length !== 1 ||
      !isRecord(spec.tests[0]) ||
      spec.tests[0].projectName !== "chromium" ||
      spec.tests[0].status !== "expected" ||
      !Array.isArray(spec.tests[0].results) ||
      spec.tests[0].results.length !== 1 ||
      !isRecord(spec.tests[0].results[0]) ||
      spec.tests[0].results[0].status !== "passed"
    ) {
      throw new Error(`Playwright did not pass exactly the Chromium case for ${scenario.ownerId}`);
    }
  }

  if (
    report.stats?.expected !== selectedCases.length ||
    report.stats.unexpected !== 0 ||
    report.stats.skipped !== 0 ||
    report.stats.flaky !== 0
  ) {
    throw new Error("Playwright did not pass exactly the selected Chromium coverage cases");
  }
}

async function main(): Promise<void> {
  const omitted = process.env.HESPERIA_BROWSER_COVERAGE_OMIT_FRAGMENT;

  if (omitted !== undefined && omitted !== "server" && omitted !== "page") {
    throw new Error("Browser CSS coverage omission control must be server or page");
  }

  let runId: string | undefined;
  let outputDirectory: string | undefined;

  try {
    runId = randomUUID();
    outputDirectory = resolve(runRoot, runId);

    mkdirSync(runRoot, { recursive: true });

    mkdirSync(outputDirectory);

    if (readdirSync(outputDirectory).length !== 0) {
      throw new Error("New browser CSS coverage run directory is not empty");
    }

    const buildDirectory = resolve(
      repoPath,
      ".hesperia/coverage/worker-builds",
      `browser-css-${runId}`,
    );
    const expectedSources = inventoryCoverageSources(repoPath);
    const graph = await buildCoverageWorkerGraph({
      repoPath,
      directory: buildDirectory,
      sources: expectedSources,
      packages: packageSelection,
      additionalSeededSources: [browserPreloadSource],
      exposePreparedSourcePaths: preparedToolingSourcePaths,
    });

    if (
      graph.sourcePopulation.files.length !== expectedSources.length ||
      Object.keys(graph.canonicalSeedCoverage).length !== expectedSources.length
    ) {
      throw new Error("Browser CSS coverage graph does not contain the full authored inventory");
    }

    const preparedToolingSources = graph.preparedCoverageSources;

    if (
      !preparedToolingSources ||
      preparedToolingSources.length !== preparedToolingSourcePaths.length
    ) {
      throw new Error("Browser CSS coverage graph omitted its prepared tooling source");
    }

    for (const [index, relativePath] of preparedToolingSourcePaths.entries()) {
      const preparedToolingSource = preparedToolingSources[index];

      if (
        !preparedToolingSource ||
        preparedToolingSource.relativePath !== relativePath ||
        canonicalPath(preparedToolingSource.path) !== canonicalPath(resolve(repoPath, relativePath))
      ) {
        throw new Error(
          `Browser CSS coverage graph prepared an unexpected tooling source: ${relativePath}`,
        );
      }

      assertPreparedSourceMatchesPopulation(
        preparedToolingSource,
        graph.sourcePopulation,
        graph.canonicalSeedCoverage,
      );
    }

    const preparedBrowserPreload = await prepareCoverageSource(browserPreloadSource, repoPath);

    assertPreparedSourceMatchesPopulation(
      preparedBrowserPreload,
      graph.sourcePopulation,
      graph.canonicalSeedCoverage,
    );

    const browserPreloadBootstrapPath = createBrowserPreloadBootstrap(
      buildDirectory,
      preparedBrowserPreload,
    );

    bindCoverageOwnerRun({
      runId,
      outputDirectory,
      population: graph.sourcePopulation,
    });

    const outputMapPath = join(buildDirectory, "worker-output-map.json");
    const templatePath = join(buildDirectory, "browser-css-coverage-template.json");

    writeFileSync(
      templatePath,
      JSON.stringify({
        seedCoverage: graph.seedCoverage,
        sourcePopulation: graph.sourcePopulation,
        preparedCoverageSources: graph.preparedCoverageSources,
      }),
    );

    writeCanonicalSeed({
      runId,
      outputDirectory,
      sourcePopulation: graph.sourcePopulation,
      coverage: graph.canonicalSeedCoverage,
    });

    const reportPath = join(buildDirectory, "playwright-report.json");
    const port = await chooseBrowserPort();
    const childEnvironment: Record<string, string | undefined> = { ...process.env };

    for (const key of Object.keys(childEnvironment)) {
      if (key.startsWith("HESPERIA_COVERAGE_") || key.startsWith("HESPERIA_BROWSER_COVERAGE_")) {
        delete childEnvironment[key];
      }
    }

    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.BUN_OPTIONS;

    Object.assign(childEnvironment, {
      HESPERIA_BROWSER_PORT: String(port),
      HESPERIA_BROWSER_COVERAGE_RUN_ID: runId,
      HESPERIA_BROWSER_COVERAGE_POPULATION: graph.sourcePopulation.fingerprint,
      HESPERIA_BROWSER_COVERAGE_OUTPUT_DIR: outputDirectory,
      HESPERIA_BROWSER_COVERAGE_TEMPLATE: templatePath,
      HESPERIA_BROWSER_COVERAGE_OUTPUT_MAP: outputMapPath,
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    });

    if (omitted !== undefined) {
      childEnvironment.HESPERIA_BROWSER_COVERAGE_OMIT_FRAGMENT = omitted;
    }

    childEnvironment.BUN_OPTIONS = `--preload=${browserPreloadBootstrapPath}`;

    console.log(
      JSON.stringify({
        status: "running",
        runId,
        outputDirectory,
        sourceCount: expectedSources.length,
        mappedModules: graph.outputs.length,
        port,
        omittedFragment: omitted ?? null,
      }),
    );

    const child = Bun.spawn(
      [
        "node",
        "node_modules/@playwright/test/cli.js",
        "test",
        ...selectedSpecs,
        "--project=chromium",
        "--grep",
        selectedTitlePattern,
        "--reporter=json",
      ],
      {
        cwd: repoPath,
        env: childEnvironment,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exitCode = await child.exited;

    if (exitCode !== 0) {
      try {
        snapshotCoverageOwnerHits();
      } catch {}

      throw new Error(`Selected Chromium coverage cases failed with exit code ${exitCode}`);
    }

    if (!existsSync(reportPath)) throw new Error("Playwright wrote no JSON test report");

    assertPlaywrightReport(reportPath);

    const artifactOptions = {
      directory: outputDirectory,
      runId,
      sourcePopulation: graph.sourcePopulation,
      expectedSources,
      mappedModules: graph.outputs,
    };

    validateBrowserRunResultsBeforeSnapshot(artifactOptions);

    snapshotCoverageOwnerHits();

    const owned = readOwnedArtifacts(artifactOptions);
    const merged = await mergeCoverageArtifacts({
      repoPath,
      expectedSources,
      seeds: [
        owned.canonicalSeed,
        ...captureOwnerIds.map((ownerId) => owned.seeds.get(ownerId)!),
        ...(owned.supportSeed ? [owned.supportSeed] : []),
      ],
      fragments: [
        ...captureOwnerIds.map((ownerId) => owned.hits.get(ownerId)!),
        ...(owned.supportHits ? [owned.supportHits] : []),
      ],
    });

    if (merged.files().length !== expectedSources.length) {
      throw new Error("Browser CSS coverage merge omitted authored inventory entries");
    }

    const lcovPath = join(outputDirectory, "lcov.info");

    writeLcovReport(merged, lcovPath);

    console.log(
      JSON.stringify({
        status: "completed",
        runId,
        outputDirectory,
        lcovPath,
        sourceCount: merged.files().length,
        browserMappedModules: owned.receipts.get(browserCssCoverageOwnerIds.server)!
          .buildSubstitutions,
        serverCompilerHitSources: owned.receipts
          .get(browserCssCoverageOwnerIds.server)!
          .positiveSources.filter(
            (source) => source === "packages/compiler/src/project-compilation.ts",
          ).length,
        pageRuntimeHitSources: owned.receipts
          .get(browserCssCoverageOwnerIds.page)!
          .positiveSources.filter((source) => source === "packages/hesperia/src/runtime/style.ts")
          .length,
        asyncRuntimeHitPages: browserCssCoveragePageOwnerIds.filter(
          (ownerId) =>
            ownerId !== browserCssCoverageOwnerIds.page &&
            owned.receipts
              .get(ownerId)!
              .positiveSources.includes("packages/hesperia/src/runtime/async.ts"),
        ).length,
        omittedFragment: omitted ?? null,
      }),
    );
  } catch (error) {
    if (outputDirectory) {
      const lcovPath = join(outputDirectory, "lcov.info");

      if (existsSync(lcovPath)) {
        const stats = statSync(lcovPath);

        if (stats.isFile()) unlinkSync(lcovPath);
      }
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
