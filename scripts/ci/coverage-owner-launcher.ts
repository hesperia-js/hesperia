import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
import {
  createCoverageArtifact,
  inventoryCoverageSources,
  prepareCoverageSource,
  writeCoverageFragment,
  type CoverageFile,
  type CoveragePopulation,
  type PreparedCoverageSource,
} from "./coverage-collector.ts";

const repoPath = resolve(import.meta.dir, "../..");
const captureSymbol = Symbol.for("hesperia.coverage.owner-capture.v1");
const launchRoot = resolve(repoPath, ".hesperia/coverage/owner-launches");

export const projectWorkerOwnerTestPaths = [
  "tests/tooling/project-worker.test.ts",
  "tests/tooling/analyze-project.test.ts",
  "tests/compiler/imported-api.test.ts",
] as const;

export const elysiaWorkerOwnerTestPaths = [
  "tests/tooling/analyze-project.test.ts",
  "tests/compiler/imported-api.test.ts",
] as const;

export function classifyProjectWorkerOwnerSelection(
  paths: readonly string[],
): "project-worker" | "elysia" | undefined {
  const allowed = new Set(
    projectWorkerOwnerTestPaths.map((path) => canonicalPath(resolve(repoPath, path))),
  );
  const elysiaAllowed = new Set(
    elysiaWorkerOwnerTestPaths.map((path) => canonicalPath(resolve(repoPath, path))),
  );
  const selected = paths.map((path) => canonicalPath(resolve(repoPath, path)));
  const touchesOwner = paths.some((path, index) => {
    if (allowed.has(selected[index]!)) return true;

    let directory: boolean;

    try {
      directory = statSync(resolve(repoPath, path)).isDirectory();
    } catch {
      return false;
    }

    return (
      directory &&
      projectWorkerOwnerTestPaths.some((ownerPath) => {
        const owner = resolve(repoPath, ownerPath);
        const child = relative(resolve(repoPath, path), owner);
        return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
      })
    );
  });

  if (!touchesOwner) return undefined;

  if (
    paths.length === 0 ||
    paths.some((_, index) => !allowed.has(selected[index]!)) ||
    new Set(selected).size !== selected.length
  ) {
    throw new Error(
      "Project worker coverage accepts explicit owner files only: " +
        projectWorkerOwnerTestPaths.join(", "),
    );
  }

  return selected.some((path) => elysiaAllowed.has(path)) ? "elysia" : "project-worker";
}

export interface CoverageOwnerProfile {
  readonly key: "driver" | "extension-host" | "language-server";
  readonly ownerId: string;
  readonly contextId: string;
  readonly sources: readonly string[];
  readonly requiredHitSources: readonly string[];
}

interface LaunchManifest {
  readonly format: "hesperia-coverage-owner-launch";
  readonly version: 1;
  readonly driverPath: string;
  readonly launchDirectory: string;
  readonly preparedSources: readonly PreparedCoverageSource[];
  readonly profiles: readonly CoverageOwnerProfile[];
}

interface BoundCoverageOwnerRun {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly population: CoveragePopulation;
}

interface CaptureState {
  readonly format: "hesperia-coverage-owner-capture-state";
  readonly version: 1;
  readonly manifest: LaunchManifest;
  readonly preparedByPath: ReadonlyMap<string, PreparedCoverageSource>;
  context?: BoundCoverageOwnerRun;
  readonly snapshots: Set<string>;
}

const sourceProcess = "scripts/ci/coverage-editor-process.ts";
const sourcePreload = "scripts/ci/coverage-editor-preload.ts";
const sourceCollector = "scripts/ci/coverage-collector.ts";
const sourceInventory = "scripts/ci/coverage-inventory.ts";
const sourceChecker = "scripts/ci/check-coverage.ts";
const sourceCoverageClassifier = "scripts/ci/coverage-source-classifier.ts";
const sourceWorkerBuild = "scripts/ci/coverage-worker-build.ts";
const sourceLauncher = "scripts/ci/coverage-owner-launcher.ts";

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function exactPathFilter(paths: readonly string[]): RegExp {
  const escaped = paths.map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`^(?:${escaped.join("|")})$`, process.platform === "win32" ? "iu" : "u");
}

function hasHits(coverage: CoverageFile | undefined): boolean {
  return (
    coverage !== undefined &&
    (Object.values(coverage.s).some((count) => count > 0) ||
      Object.values(coverage.f).some((count) => count > 0) ||
      Object.values(coverage.b).some((counts) => counts.some((count) => count > 0)))
  );
}

function profileSources(profiles: readonly CoverageOwnerProfile[]): string[] {
  return [...new Set(profiles.flatMap((profile) => profile.sources))];
}

function sourceKey(path: string): string {
  const relativePath = relative(repoPath, resolve(path)).split(sep).join("/");
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
}

function ownerProfiles(
  driver: string,
  driverArguments: readonly string[] = [],
): CoverageOwnerProfile[] {
  const common = [sourceLauncher, sourceCollector, sourceInventory, sourceWorkerBuild];

  if (driver === "scripts/ci/run-final-coverage.ts") {
    return [
      {
        key: "driver",
        ownerId: "final-coverage-driver",
        contextId: "final-coverage-driver",
        sources: [
          driver,
          "scripts/ci/coverage-group-artifacts.ts",
          sourceChecker,
          sourceCoverageClassifier,
          sourceLauncher,
          sourceCollector,
          sourceInventory,
        ],
        requiredHitSources: [
          driver,
          "scripts/ci/coverage-group-artifacts.ts",
          sourceChecker,
          sourceCoverageClassifier,
          sourceLauncher,
          sourceCollector,
          sourceInventory,
        ],
      },
    ];
  }

  if (driver === "scripts/ci/run-coverage.ts") {
    const targets = driverArguments[0] === "--" ? driverArguments.slice(1) : driverArguments;
    const workerMode = classifyProjectWorkerOwnerSelection(targets) !== undefined;
    return [
      {
        key: "driver",
        ownerId: "bun-tests-driver",
        contextId: "coverage-runner-driver",
        sources: [driver, sourceLauncher, sourceCollector, sourceInventory, sourceWorkerBuild],
        requiredHitSources: [
          driver,
          sourceLauncher,
          sourceCollector,
          sourceInventory,
          ...(workerMode ? [sourceWorkerBuild] : []),
        ],
      },
    ];
  }

  if (driver === "scripts/ci/run-browser-css-coverage.ts") {
    return [
      {
        key: "driver",
        ownerId: "browser-css-driver",
        contextId: "browser-css-driver",
        sources: [driver, ...common, "scripts/ci/browser-css-coverage-contract.ts"],
        requiredHitSources: [driver, ...common, "scripts/ci/browser-css-coverage-contract.ts"],
      },
    ];
  }

  if (driver === "scripts/ci/run-editor-coverage.ts") {
    return [
      {
        key: "driver",
        ownerId: "vscode-editor-driver",
        contextId: "editor-driver",
        sources: [driver, ...common, sourceProcess],
        requiredHitSources: [driver, ...common, sourceProcess],
      },
      {
        key: "extension-host",
        ownerId: "vscode-editor-host-support",
        contextId: "editor-host-support",
        sources: [sourceProcess],
        requiredHitSources: [sourceProcess],
      },
      {
        key: "language-server",
        ownerId: "vscode-editor-ls-support",
        contextId: "editor-ls-support",
        sources: [sourcePreload, sourceProcess],
        requiredHitSources: [sourcePreload, sourceProcess],
      },
    ];
  }

  throw new Error(`Coverage owner launcher does not support ${driver}`);
}

function runRootForDriver(driver: string): string | undefined {
  return new Map([
    ["scripts/ci/run-coverage.ts", resolve(repoPath, ".hesperia/coverage/runs")],
    [
      "scripts/ci/run-browser-css-coverage.ts",
      resolve(repoPath, ".hesperia/coverage/browser-css-runs"),
    ],
    ["scripts/ci/run-editor-coverage.ts", resolve(repoPath, ".hesperia/ec")],
    ["scripts/ci/run-final-coverage.ts", resolve(repoPath, ".hesperia/coverage/final-runs")],
  ]).get(driver);
}

function currentState(): CaptureState | undefined {
  const value = Reflect.get(globalThis, captureSymbol) as CaptureState | undefined;

  if (
    value === undefined ||
    value.format !== "hesperia-coverage-owner-capture-state" ||
    value.version !== 1 ||
    !(value.preparedByPath instanceof Map) ||
    !(value.snapshots instanceof Set)
  ) {
    if (process.env.HESPERIA_COVERAGE_OWNER_LAUNCHED === "1") {
      throw new Error("Coverage owner launcher preload did not initialize the original driver");
    }

    return undefined;
  }

  if (!value.context) validateLaunchState(value);

  return value;
}

function profileByKey(state: CaptureState, key: CoverageOwnerProfile["key"]): CoverageOwnerProfile {
  const profile = state.manifest.profiles.find((candidate) => candidate.key === key);

  if (!profile) throw new Error(`Coverage owner capture has no ${key} profile`);

  return profile;
}

function preparedForProfile(
  state: CaptureState,
  profile: CoverageOwnerProfile,
): readonly PreparedCoverageSource[] {
  return profile.sources.map((path) => {
    const source = state.preparedByPath.get(canonicalPath(path));

    if (!source) throw new Error(`Coverage owner preparation omitted ${path}`);

    return source;
  });
}

function validatePopulationSourceSet(
  profile: CoverageOwnerProfile,
  prepared: readonly PreparedCoverageSource[],
  population: CoveragePopulation,
): void {
  const populationBySource = new Map(population.files.map((file) => [file.source, file] as const));

  for (const source of prepared) {
    const sourceKeyValue = source.ownerFile.sources[0];
    const populationFile = sourceKeyValue ? populationBySource.get(sourceKeyValue) : undefined;

    if (!populationFile) {
      const relativePath = relative(repoPath, source.path).split(sep).join("/");
      throw new Error(`Coverage owner population omitted prepared support source: ${relativePath}`);
    }

    const authoredSource = readFileSync(source.path, "utf8");
    const sourceSha256 = createHash("sha256").update(authoredSource, "utf8").digest("hex");

    if (
      populationFile.sourceSha256 !== sourceSha256 ||
      populationFile.canonicalUnitsSha256 !== source.ownerFile.unitLayoutSha256 ||
      JSON.stringify(source.seed.inputSourceMap) !== JSON.stringify(source.sourceMap) ||
      source.seed.__hesperiaInstrumentedSourceSha256 !== source.ownerFile.instrumentedSourceSha256
    ) {
      throw new Error(
        `Coverage owner preparation does not match the current population: ${sourceKeyValue}`,
      );
    }
  }

  if (profile.requiredHitSources.some((source) => !profile.sources.includes(source))) {
    throw new Error(`Coverage owner profile ${profile.ownerId} requires an unprepared source`);
  }
}

function assertPreparedOwnerFiles(
  ownerFiles: readonly { readonly sources: readonly string[] }[],
  prepared: readonly PreparedCoverageSource[],
  ownerId: string,
): void {
  const expected = new Map(
    prepared.map((source) => [source.ownerFile.sources[0]!, source.ownerFile] as const),
  );

  if (
    ownerFiles.length !== expected.size ||
    ownerFiles.some((ownerFile) => {
      const source = ownerFile.sources[0];
      const expectedOwnerFile = source ? expected.get(source) : undefined;
      return !expectedOwnerFile || JSON.stringify(ownerFile) !== JSON.stringify(expectedOwnerFile);
    })
  ) {
    throw new Error(`Coverage owner ${ownerId} source maps do not match its prepared sources`);
  }
}

function validateLaunchState(state: CaptureState): void {
  const manifest = state.manifest;
  const argvEntry = Bun.argv[1];
  const processEntry = process.argv[1];

  if (
    Object.keys(manifest).sort().join("|") !==
      ["format", "version", "driverPath", "launchDirectory", "preparedSources", "profiles"]
        .sort()
        .join("|") ||
    manifest.format !== "hesperia-coverage-owner-launch" ||
    manifest.version !== 1 ||
    typeof manifest.driverPath !== "string" ||
    typeof manifest.launchDirectory !== "string" ||
    !Array.isArray(manifest.profiles) ||
    !Array.isArray(manifest.preparedSources) ||
    !argvEntry ||
    !processEntry ||
    canonicalPath(argvEntry) !== canonicalPath(processEntry) ||
    canonicalPath(manifest.driverPath) !== canonicalPath(argvEntry)
  ) {
    throw new Error("Coverage owner capture does not match the actual original driver entry");
  }

  const driver = normalizeDriverPath(argvEntry);

  if (!runRootForDriver(driver)) {
    throw new Error("Coverage owner current-run context is not bound to a supported driver");
  }

  const expectedProfiles = ownerProfiles(driver, Bun.argv.slice(2));
  const sameProfiles =
    manifest.profiles.length === expectedProfiles.length &&
    manifest.profiles.every((profile, index) => {
      const expected = expectedProfiles[index];
      return (
        expected !== undefined &&
        profile.key === expected.key &&
        profile.ownerId === expected.ownerId &&
        profile.contextId === expected.contextId &&
        JSON.stringify(profile.sources) === JSON.stringify(expected.sources) &&
        JSON.stringify(profile.requiredHitSources) === JSON.stringify(expected.requiredHitSources)
      );
    });
  const expectedSources = profileSources(expectedProfiles);
  const preparedPaths = new Set<string>();

  for (const source of manifest.preparedSources) {
    const seedMaps = source?.seed
      ? [source.seed.statementMap, source.seed.fnMap, source.seed.branchMap]
      : [];
    const validSeedMaps =
      seedMaps.length === 3 &&
      seedMaps.every((map) => map !== null && typeof map === "object" && !Array.isArray(map));
    const hasExecutableUnits = validSeedMaps && seedMaps.some((map) => Object.keys(map).length > 0);

    if (
      !source ||
      Object.keys(source).sort().join("|") !==
        [
          "path",
          "relativePath",
          "instrumentedCode",
          "loader",
          "seed",
          "sourceMap",
          "ownerFile",
          ...(Object.hasOwn(source, "bootstrapHash") ? ["bootstrapHash"] : []),
        ]
          .sort()
          .join("|") ||
      typeof source.path !== "string" ||
      typeof source.relativePath !== "string" ||
      typeof source.instrumentedCode !== "string" ||
      (source.loader !== "ts" && source.loader !== "tsx") ||
      !source.seed ||
      !source.ownerFile ||
      !Array.isArray(source.ownerFile.sources) ||
      source.ownerFile.sources.length !== 1 ||
      sourceKey(source.path) !==
        sourceKey(resolve(repoPath, source.relativePath.replaceAll("/", sep))) ||
      source.relativePath !== sourceKey(source.path) ||
      source.ownerFile.sources[0] !== sourceKey(source.path) ||
      typeof source.seed.path !== "string" ||
      canonicalPath(source.seed.path) !== canonicalPath(source.path) ||
      !validSeedMaps ||
      (hasExecutableUnits
        ? typeof source.bootstrapHash !== "string" || !/^[a-f0-9]{40}$/u.test(source.bootstrapHash)
        : source.bootstrapHash !== undefined)
    ) {
      throw new Error("Coverage owner preparation contains an invalid source identity");
    }

    const key = canonicalPath(source.path);

    if (preparedPaths.has(key)) throw new Error("Coverage owner preparation repeats a source path");

    preparedPaths.add(key);

    if (state.preparedByPath.get(key) !== source) {
      throw new Error("Coverage owner prepared source map does not match its manifest");
    }
  }

  if (
    !sameProfiles ||
    state.preparedByPath.size !== preparedPaths.size ||
    expectedSources.length !== preparedPaths.size ||
    expectedSources.some((source) => !preparedPaths.has(canonicalPath(resolve(repoPath, source))))
  ) {
    throw new Error("Coverage owner capture profiles do not match the actual driver");
  }

  const launchRelative = relative(launchRoot, state.manifest.launchDirectory);

  if (
    launchRelative === "" ||
    launchRelative === ".." ||
    launchRelative.startsWith(`..${sep}`) ||
    resolve(launchRoot, launchRelative) !== resolve(state.manifest.launchDirectory) ||
    !existsSync(join(state.manifest.launchDirectory, "coverage-owner-launch.json"))
  ) {
    throw new Error("Coverage owner launch manifest directory is outside the trusted launch root");
  }
}

function writeProfileSeed(
  state: CaptureState,
  profile: CoverageOwnerProfile,
  context: BoundCoverageOwnerRun,
): void {
  const prepared = preparedForProfile(state, profile);

  validatePopulationSourceSet(profile, prepared, context.population);

  const coverage = Object.fromEntries(prepared.map((source) => [source.path, source.seed]));
  const artifact = createCoverageArtifact({
    repoPath,
    kind: "seed",
    runId: context.runId,
    ownerId: profile.ownerId,
    populationFingerprint: context.population.fingerprint,
    sourcePopulation: context.population,
    coverage,
  });

  assertPreparedOwnerFiles(artifact.ownerFiles, prepared, profile.ownerId);

  writeCoverageFragment({
    directory: context.outputDirectory,
    contextId: `${profile.contextId}-seed`,
    pid: process.pid,
    threadId,
    repoPath,
    artifact,
    sourcePopulation: context.population,
  });
}

export function bindCoverageOwnerRun(context: BoundCoverageOwnerRun): boolean {
  const state = currentState();

  if (!state) return false;

  if (state.context) throw new Error("Coverage owner run context was already bound");

  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(context.runId)) {
    throw new Error("Coverage owner run context has an invalid run identity");
  }

  const expectedSources = inventoryCoverageSources(repoPath);
  const populationSources = context.population.files.map((file) => file.source);
  const expectedKeys = expectedSources.map((source) => sourceKey(resolve(repoPath, source)));
  const populationKeys = populationSources.map((source) =>
    process.platform === "win32" ? source.toLowerCase() : source,
  );

  if (
    context.population.schema !== 1 ||
    populationKeys.length !== expectedKeys.length ||
    new Set(populationKeys).size !== populationKeys.length ||
    expectedKeys.some((source) => !populationKeys.includes(source))
  ) {
    throw new Error(
      "Coverage owner run context does not contain the full current source population",
    );
  }

  const runRoot = runRootForDriver(normalizeDriverPath(Bun.argv[1]!));

  if (
    !runRoot ||
    canonicalPath(context.outputDirectory) !== canonicalPath(resolve(runRoot, context.runId))
  ) {
    throw new Error(
      "Coverage owner output directory does not belong to its generated run identity",
    );
  }

  for (const file of context.population.files) {
    const authoredPath = resolve(repoPath, file.source.replaceAll("/", sep));
    const authoredSource = readFileSync(authoredPath, "utf8");
    const sourceSha256 = createHash("sha256").update(authoredSource, "utf8").digest("hex");

    if (sourceSha256 !== file.sourceSha256) {
      throw new Error(`Coverage owner population is stale for the current source: ${file.source}`);
    }
  }

  state.context = context;

  for (const profile of state.manifest.profiles) writeProfileSeed(state, profile, context);

  return true;
}

export function snapshotCoverageOwnerHits(key: CoverageOwnerProfile["key"] = "driver"): boolean {
  const state = currentState();

  if (!state) return false;

  const context = state.context;

  if (!context) throw new Error("Coverage owner hits cannot be captured before run binding");

  const profile = profileByKey(state, key);

  if (state.snapshots.has(key)) throw new Error(`Coverage owner ${key} hits were already captured`);

  state.snapshots.add(key);

  const prepared = preparedForProfile(state, profile);
  const raw =
    (Reflect.get(globalThis, "__hesperiaCoverage__") as Record<string, CoverageFile> | undefined) ??
    {};
  const allowed = new Map(prepared.map((source) => [canonicalPath(source.path), source] as const));
  const coverage: Record<string, CoverageFile> = {};

  for (const [path, record] of Object.entries(raw)) {
    const source = allowed.get(canonicalPath(path));

    if (!source || canonicalPath(record.path) !== canonicalPath(path)) {
      throw new Error(`Coverage owner captured an unprepared support source: ${path}`);
    }

    coverage[source.path] = record;
  }

  for (const source of profile.requiredHitSources) {
    if (!hasHits(coverage[resolve(repoPath, source.replaceAll("/", sep))])) {
      throw new Error(`Coverage owner support hit is missing: ${source}`);
    }
  }

  const artifact = createCoverageArtifact({
    repoPath,
    kind: "hits",
    runId: context.runId,
    ownerId: profile.ownerId,
    populationFingerprint: context.population.fingerprint,
    sourcePopulation: context.population,
    coverage,
  });

  assertPreparedOwnerFiles(artifact.ownerFiles, prepared, profile.ownerId);

  writeCoverageFragment({
    directory: context.outputDirectory,
    contextId: `${profile.contextId}-hits`,
    pid: process.pid,
    threadId,
    repoPath,
    artifact,
    sourcePopulation: context.population,
  });

  return true;
}

export function coverageOwnerSources(key: CoverageOwnerProfile["key"]): readonly string[] {
  const state = currentState();
  return state ? profileByKey(state, key).sources : [];
}

export function coverageOwnerProfile(
  key: CoverageOwnerProfile["key"],
): CoverageOwnerProfile | undefined {
  const state = currentState();
  return state?.manifest.profiles.find((profile) => profile.key === key);
}

export function writeCoverageOwnerSupportPreload(
  key: CoverageOwnerProfile["key"],
  directory: string,
  importAfterSetup?: string,
): string {
  const state = currentState();

  if (!state) throw new Error("Coverage owner support preload requires the trusted launcher");

  const profile = profileByKey(state, key);
  const sources = preparedForProfile(state, profile);
  const manifestPath = join(directory, `coverage-owner-${key}-preload.json`);
  const preloadPath = join(directory, `coverage-owner-${key}-preload.ts`);
  const filterSource = exactPathFilter(sources.map(({ path }) => path)).source;

  mkdirSync(directory, { recursive: true });

  const importStatement = importAfterSetup
    ? `\nawait import(${JSON.stringify(pathToFileURL(resolve(importAfterSetup)).href)});\n`
    : "";

  writeFileSync(
    manifestPath,
    JSON.stringify({
      format: "hesperia-coverage-owner-preload",
      version: 1,
      sources: sources.map(({ path, instrumentedCode, loader }) => ({
        path,
        instrumentedCode,
        loader,
      })),
    }),
    { flag: "wx" },
  );

  writeFileSync(
    preloadPath,
    `
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(${JSON.stringify(manifestPath)}, "utf8"));
if (
  manifest.format !== "hesperia-coverage-owner-preload" ||
  manifest.version !== 1 ||
  !Array.isArray(manifest.sources)
) throw new Error("Malformed coverage owner support preload manifest");
const canonicalPath = (path) => {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};
const sources = new Map(manifest.sources.map((source) => [canonicalPath(source.path), source]));
const filter = new RegExp(${JSON.stringify(filterSource)}, process.platform === "win32" ? "iu" : "u");
Bun.plugin({
  name: "hesperia-coverage-owner-support",
  setup(build) {
    build.onLoad({ filter }, ({ path }) => {
      const source = sources.get(canonicalPath(path));
      if (!source) throw new Error("Coverage owner preload matched an unknown source: " + path);
      return { contents: source.instrumentedCode, loader: source.loader };
    });
  },
});
${importStatement}`,
    { flag: "wx" },
  );

  return preloadPath;
}

export async function buildEditorHostSupportBundle(options: {
  readonly entrypoint: string;
  readonly outfile: string;
}): Promise<void> {
  const state = currentState();

  if (!state) throw new Error("Editor Host support build requires the trusted launcher");

  const profile = profileByKey(state, "extension-host");
  const prepared = preparedForProfile(state, profile);

  if (prepared.length !== 1)
    throw new Error("Editor Host support requires one exact helper source");

  const helper = prepared[0]!;
  const outfile = resolve(options.outfile);
  let helperLoads = 0;
  const result = await Bun.build({
    entrypoints: [options.entrypoint],
    outdir: dirname(outfile),
    naming: { entry: basename(outfile) },
    target: "node",
    format: "cjs",
    external: ["vscode"],
    plugins: [
      {
        name: "hesperia-editor-host-support-source-first",

        setup(build) {
          build.onLoad({ filter: exactPathFilter([helper.path]) }, ({ path }) => {
            if (canonicalPath(path) !== canonicalPath(helper.path)) {
              throw new Error(`Editor Host support matched an unknown helper source: ${path}`);
            }

            helperLoads++;

            if (helperLoads !== 1) {
              throw new Error(`Editor Host support loaded its helper more than once: ${path}`);
            }

            return { contents: helper.instrumentedCode, loader: helper.loader };
          });
        },
      },
    ],
  });

  if (!result.success) {
    throw new Error(
      `Editor Host support build failed: ${result.logs.map((log) => log.message).join("\n")}`,
    );
  }

  if (
    helperLoads !== 1 ||
    !result.outputs.some((artifact) => canonicalPath(artifact.path) === canonicalPath(outfile)) ||
    !existsSync(outfile) ||
    !statSync(outfile).isFile()
  ) {
    throw new Error(`Editor Host support build did not write the expected bundle: ${outfile}`);
  }
}

function normalizeDriverPath(value: string): string {
  const path = resolve(repoPath, value);
  const relativePath = relative(repoPath, path);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(repoPath, relativePath) !== path
  ) {
    throw new Error("Coverage owner driver must be inside the repository");
  }

  return relativePath.split(sep).join("/");
}

async function launch(driverArgument: string, driverArguments: readonly string[]): Promise<number> {
  const driver = normalizeDriverPath(driverArgument);
  const profiles = ownerProfiles(driver, driverArguments);
  const sources = profileSources(profiles);
  const preparedSources = await Promise.all(
    sources.map((source) => prepareCoverageSource(source, repoPath)),
  );
  const launchDirectory = join(launchRoot, randomUUID());

  mkdirSync(launchDirectory, { recursive: true });

  try {
    const manifest: LaunchManifest = {
      format: "hesperia-coverage-owner-launch",
      version: 1,
      driverPath: resolve(repoPath, driver.replaceAll("/", sep)),
      launchDirectory,
      preparedSources,
      profiles,
    };
    const manifestPath = join(launchDirectory, "coverage-owner-launch.json");
    const preloadPath = join(launchDirectory, "coverage-owner-launch-preload.ts");
    const filterSource = exactPathFilter(preparedSources.map(({ path }) => path)).source;

    writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx" });

    const preloadSource = `
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(${JSON.stringify(manifestPath)}, "utf8"));
const canonicalPath = (path) => {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};
if (
  manifest.format !== "hesperia-coverage-owner-launch" ||
  manifest.version !== 1 ||
  !Array.isArray(manifest.preparedSources) ||
  !Array.isArray(manifest.profiles) ||
  !manifest.profiles.every((profile) => profile && Array.isArray(profile.sources)) ||
  typeof manifest.driverPath !== "string" ||
  !Bun.argv[1] ||
  !process.argv[1] ||
  canonicalPath(Bun.argv[1]) !== canonicalPath(process.argv[1]) ||
  canonicalPath(manifest.driverPath) !== canonicalPath(Bun.argv[1])
) throw new Error("Malformed coverage owner launch manifest");
const preparedByPath = new Map(
  manifest.preparedSources.map((source) => [canonicalPath(source.path), source]),
);
const activeProfileSources = new Set(
  manifest.profiles.flatMap((profile) => profile.sources).map(canonicalPath),
);
if (
  !manifest.profiles.some(
    (profile) =>
      profile.key === "driver" &&
      profile.sources.some((sourcePath) => canonicalPath(sourcePath) === canonicalPath(manifest.driverPath)),
  ) ||
  preparedByPath.size !== manifest.preparedSources.length ||
  preparedByPath.size !== activeProfileSources.size ||
  [...activeProfileSources].some((sourcePath) => !preparedByPath.has(sourcePath))
) throw new Error("Coverage owner launcher preparation does not match its active profiles");
const filter = new RegExp(${JSON.stringify(filterSource)}, process.platform === "win32" ? "iu" : "u");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (left, right) =>
  isRecord(left) && isRecord(right) &&
  JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort());
function prepareCoverageRecord(source) {
  const seed = source.seed;
  const ownerFile = source.ownerFile;
  const sourceKey = process.platform === "win32" ? source.relativePath.toLowerCase() : source.relativePath;
  if (
    !isRecord(seed) ||
    !isRecord(ownerFile) ||
    seed.path !== source.path ||
    ownerFile.sources?.length !== 1 ||
    ownerFile.sources[0] !== sourceKey ||
    !/^[a-f0-9]{64}$/u.test(ownerFile.sourceMapSha256) ||
    !/^[a-f0-9]{64}$/u.test(ownerFile.instrumentedSourceSha256) ||
    !/^[a-f0-9]{64}$/u.test(ownerFile.unitLayoutSha256) ||
    seed.__hesperiaInstrumentedSourceSha256 !== ownerFile.instrumentedSourceSha256 ||
    !Array.isArray(source.sourceMap?.sources) ||
    source.sourceMap.version !== 3 ||
    source.sourceMap.sources.length !== 1 ||
    JSON.stringify(seed.inputSourceMap) !== JSON.stringify(source.sourceMap) ||
    !isRecord(seed.statementMap) ||
    !isRecord(seed.fnMap) ||
    !isRecord(seed.branchMap) ||
    !isRecord(seed.s) ||
    !isRecord(seed.f) ||
    !isRecord(seed.b)
  ) throw new Error("Coverage owner loader received an invalid prepared source");
  const hasUnits =
    Object.keys(seed.statementMap).length > 0 ||
    Object.keys(seed.fnMap).length > 0 ||
    Object.keys(seed.branchMap).length > 0;
  if (!hasUnits) {
    if (source.bootstrapHash !== undefined) {
      throw new Error("Coverage owner loader received a runtime hash without executable units");
    }
    return;
  }
  if (
    typeof source.bootstrapHash !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.bootstrapHash) ||
    Object.hasOwn(seed, "hash") ||
    JSON.stringify(Object.keys(seed.s).sort()) !== JSON.stringify(Object.keys(seed.statementMap).sort()) ||
    JSON.stringify(Object.keys(seed.f).sort()) !== JSON.stringify(Object.keys(seed.fnMap).sort()) ||
    JSON.stringify(Object.keys(seed.b).sort()) !== JSON.stringify(Object.keys(seed.branchMap).sort()) ||
    Object.values(seed.s).some((count) => count !== 0) ||
    Object.values(seed.f).some((count) => count !== 0) ||
    Object.values(seed.b).some((counts) => !Array.isArray(counts) || counts.some((count) => count !== 0))
  ) throw new Error("Coverage owner loader received a noncanonical zero seed");

  let coverage = Reflect.get(globalThis, "__hesperiaCoverage__");
  if (coverage === undefined) {
    coverage = {};
    Reflect.set(globalThis, "__hesperiaCoverage__", coverage);
  }
  if (!isRecord(coverage)) throw new Error("Coverage owner runtime map is not an object");
  const matchingPaths = Object.keys(coverage).filter(
    (path) => canonicalPath(path) === canonicalPath(source.path),
  );
  if (matchingPaths.length > 1) throw new Error("Coverage owner runtime map repeats a prepared path");
  const existingPath = matchingPaths[0];
  if (existingPath !== undefined) {
    const current = coverage[existingPath];
    if (
      existingPath !== source.path ||
      !isRecord(current) ||
      current.path !== source.path ||
      current.hash !== source.bootstrapHash ||
      current.__hesperiaInstrumentedSourceSha256 !== ownerFile.instrumentedSourceSha256 ||
      JSON.stringify(current.inputSourceMap) !== JSON.stringify(source.sourceMap) ||
      JSON.stringify(current.statementMap) !== JSON.stringify(seed.statementMap) ||
      JSON.stringify(current.fnMap) !== JSON.stringify(seed.fnMap) ||
      JSON.stringify(current.branchMap) !== JSON.stringify(seed.branchMap) ||
      !sameKeys(current.s, seed.s) ||
      !sameKeys(current.f, seed.f) ||
      !sameKeys(current.b, seed.b) ||
      Object.entries(seed.b).some(
        ([key, counts]) => !Array.isArray(current.b[key]) || current.b[key].length !== counts.length,
      )
    ) throw new Error("Coverage owner loader found a conflicting live record");
    return;
  }
  const runtimeRecord = JSON.parse(JSON.stringify(seed));
  runtimeRecord.hash = source.bootstrapHash;
  coverage[source.path] = runtimeRecord;
}
Bun.plugin({
  name: "hesperia-coverage-owner-launch",
  setup(build) {
    build.onLoad({ filter }, ({ path }) => {
      const source = preparedByPath.get(canonicalPath(path));
      if (!source) throw new Error("Coverage owner launcher matched an unknown source: " + path);
      if (canonicalPath(source.path) !== canonicalPath(path)) {
        throw new Error("Coverage owner launcher source path changed after preparation: " + path);
      }
      prepareCoverageRecord(source);
      return { contents: source.instrumentedCode, loader: source.loader };
    });
  },
});
Reflect.set(globalThis, Symbol.for("hesperia.coverage.owner-capture.v1"), {
  format: "hesperia-coverage-owner-capture-state",
  version: 1,
  manifest,
  preparedByPath,
  snapshots: new Set(),
});
`;

    writeFileSync(preloadPath, preloadSource, { flag: "wx" });

    const browserOmissionControl =
      driver === "scripts/ci/run-browser-css-coverage.ts"
        ? process.env.HESPERIA_BROWSER_COVERAGE_OMIT_FRAGMENT
        : undefined;
    const environment = { ...process.env };
    delete environment.BUN_OPTIONS;
    delete environment.NODE_OPTIONS;

    for (const key of Object.keys(environment)) {
      if (
        key.startsWith("HESPERIA_COVERAGE_") ||
        key.startsWith("HESPERIA_BROWSER_COVERAGE_") ||
        key.startsWith("HESPERIA_EDITOR_COVERAGE_")
      ) {
        delete environment[key];
      }
    }

    environment.BUN_OPTIONS = `--preload=${preloadPath}`;
    environment.HESPERIA_COVERAGE_OWNER_LAUNCHED = "1";

    if (browserOmissionControl !== undefined) {
      environment.HESPERIA_BROWSER_COVERAGE_OMIT_FRAGMENT = browserOmissionControl;
    }

    const child = Bun.spawn([process.execPath, manifest.driverPath, ...driverArguments], {
      cwd: repoPath,
      env: environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } finally {
    rmSync(launchDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const driverArgument = args[0];

  if (!driverArgument) {
    throw new Error(
      "Usage: bun run scripts/ci/coverage-owner-launcher.ts <coverage-driver> -- <driver-arguments>",
    );
  }

  const separator = args.indexOf("--", 1);
  const driverArguments = separator < 0 ? args.slice(1) : args.slice(separator + 1);
  const exitCode = await launch(driverArgument, driverArguments);
  process.exitCode = exitCode;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    process.exitCode = 1;
  }
}
