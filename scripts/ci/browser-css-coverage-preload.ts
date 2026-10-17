import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { threadId } from "node:worker_threads";
import {
  coverageVariable,
  createCoverageArtifact,
  installCoverageInstrumentation,
  writeCoverageFragment,
  type CoverageFile,
  type CoveragePopulation,
  type PreparedCoverageSource,
} from "./coverage-collector.ts";
import {
  withCoverageWorkerFixtureBuild,
  type WorkerCoverageOutput,
} from "./coverage-worker-build.ts";
import {
  browserCssCoverageOwnerIds,
  browserCssCoveragePageOwnerIds,
  browserCssCoverageReceiptNames,
  browserCssCoverageRequiredSources,
  browserCssCoverageScenariosByOwnerId,
  isBrowserCssCoveragePageOwnerId,
  type BrowserCssCoverageOwnerId,
  type BrowserCssCoveragePageOwnerId,
  type BrowserCssCoverageScenario,
  type CaptureReceipt,
} from "./browser-css-coverage-contract.ts";

const repoPath = resolve(import.meta.dir, "../..");
const packageNames = ["compiler", "tooling", "hosting", "hesperia"] as const;
const preparedToolingSourcePaths = [
  "packages/tooling/src/project.ts",
  "packages/tooling/src/builtin-assets.ts",
  "packages/tooling/src/plugin-pipeline.ts",
] as const;

interface BrowserCoverageTemplate {
  readonly seedCoverage: Record<string, CoverageFile>;
  readonly sourcePopulation: CoveragePopulation;
  readonly preparedCoverageSources?: readonly PreparedCoverageSource[];
}

interface BrowserCoverageConfig {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly buildDirectory: string;
  readonly template: BrowserCoverageTemplate;
  readonly outputs: readonly WorkerCoverageOutput[];
  readonly omitFragment?: "server" | "page";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function packagePath(path: string): string | undefined {
  let absolute: string;

  try {
    absolute = realpathSync(path);
  } catch {
    return undefined;
  }

  const relativePath = relative(repoPath, absolute).split(sep).join("/");
  return packageNames.find((name) => relativePath.startsWith(`packages/${name}/dist/`));
}

function childPath(path: string, root: string, label: string): string {
  const absolute = resolve(path);
  const relativePath = relative(root, absolute);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(root, relativePath) !== absolute
  ) {
    throw new Error(`${label} must be a child of ${root}: ${path}`);
  }

  return absolute;
}

function readConfig(): BrowserCoverageConfig | undefined {
  const runId = process.env.HESPERIA_BROWSER_COVERAGE_RUN_ID;

  if (!runId) return undefined;

  const outputDirectory = process.env.HESPERIA_BROWSER_COVERAGE_OUTPUT_DIR;
  const templatePath = process.env.HESPERIA_BROWSER_COVERAGE_TEMPLATE;
  const outputMapPath = process.env.HESPERIA_BROWSER_COVERAGE_OUTPUT_MAP;

  if (!outputDirectory || !templatePath || !outputMapPath) {
    throw new Error("Browser CSS coverage preload is missing run inputs");
  }

  if (!/^[a-f0-9-]{36}$/u.test(runId)) throw new Error("Browser CSS coverage run ID is invalid");

  const parsedTemplate: unknown = JSON.parse(readFileSync(templatePath, "utf8"));
  const parsedOutputs: unknown = JSON.parse(readFileSync(outputMapPath, "utf8"));

  if (
    !isRecord(parsedTemplate) ||
    !isRecord(parsedTemplate.seedCoverage) ||
    !isRecord(parsedTemplate.sourcePopulation) ||
    typeof parsedTemplate.sourcePopulation.fingerprint !== "string" ||
    !Array.isArray(parsedTemplate.sourcePopulation.files) ||
    !Array.isArray(parsedOutputs) ||
    parsedOutputs.length === 0
  ) {
    throw new Error("Browser CSS coverage graph metadata is malformed");
  }

  const preparedCoverageSources = parsedTemplate.preparedCoverageSources;

  if (
    !Array.isArray(preparedCoverageSources) ||
    preparedCoverageSources.length !== preparedToolingSourcePaths.length
  ) {
    throw new Error("Browser CSS coverage graph omitted its prepared tooling source");
  }

  for (const [index, relativePath] of preparedToolingSourcePaths.entries()) {
    const toolingSourcePath = resolve(repoPath, relativePath);
    const preparedToolingSource: unknown = preparedCoverageSources[index];

    if (
      !isRecord(preparedToolingSource) ||
      preparedToolingSource.relativePath !== relativePath ||
      typeof preparedToolingSource.path !== "string" ||
      canonicalPath(preparedToolingSource.path) !== canonicalPath(toolingSourcePath) ||
      preparedToolingSource.loader !== "ts" ||
      typeof preparedToolingSource.instrumentedCode !== "string" ||
      !isRecord(preparedToolingSource.seed) ||
      !isRecord(preparedToolingSource.ownerFile) ||
      typeof preparedToolingSource.ownerFile.instrumentedSourceSha256 !== "string" ||
      typeof preparedToolingSource.ownerFile.unitLayoutSha256 !== "string" ||
      !isRecord(preparedToolingSource.sourceMap)
    ) {
      throw new Error(
        `Browser CSS coverage tooling source has an invalid prepared identity: ${relativePath}`,
      );
    }

    const seededToolingSource = Object.entries(parsedTemplate.seedCoverage).find(
      ([path]) => canonicalPath(path) === canonicalPath(toolingSourcePath),
    )?.[1];
    const populationToolingSource = parsedTemplate.sourcePopulation.files.find(
      (file) => file.source === relativePath,
    );

    if (
      !isRecord(seededToolingSource) ||
      JSON.stringify(seededToolingSource.inputSourceMap) !==
        JSON.stringify(preparedToolingSource.sourceMap) ||
      seededToolingSource.__hesperiaInstrumentedSourceSha256 !==
        preparedToolingSource.ownerFile.instrumentedSourceSha256 ||
      !isRecord(populationToolingSource) ||
      populationToolingSource.canonicalUnitsSha256 !==
        preparedToolingSource.ownerFile.unitLayoutSha256
    ) {
      throw new Error(
        `Browser CSS coverage tooling source is not tied to its canonical seed: ${relativePath}`,
      );
    }
  }

  const absoluteOutputDirectory = resolve(outputDirectory);
  const buildDirectory = dirname(resolve(outputMapPath));
  const outputs = parsedOutputs.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.originalPath !== "string" ||
      typeof value.compiledPath !== "string"
    ) {
      throw new Error("Browser CSS coverage output map contains a malformed entry");
    }

    const originalPath = childPath(value.originalPath, repoPath, "Coverage original path");
    const packageName = packagePath(originalPath);
    const compiledPath = childPath(value.compiledPath, buildDirectory, "Coverage compiled path");

    if (
      !packageName ||
      !originalPath.toLowerCase().endsWith(".js") ||
      !existsSync(compiledPath) ||
      !compiledPath.toLowerCase().endsWith(".js")
    ) {
      throw new Error(
        `Browser CSS coverage output map contains an invalid module: ${originalPath}`,
      );
    }

    return { originalPath, compiledPath };
  });
  const originals = new Set(outputs.map((output) => canonicalPath(output.originalPath)));
  const compiled = new Set(outputs.map((output) => canonicalPath(output.compiledPath)));

  if (originals.size !== outputs.length || compiled.size !== outputs.length) {
    throw new Error("Browser CSS coverage output map contains duplicate paths");
  }

  for (const packageName of packageNames) {
    if (!outputs.some((output) => packagePath(output.originalPath) === packageName)) {
      throw new Error(`Browser CSS coverage map omitted ${packageName} dist modules`);
    }
  }

  const omitFragment = process.env.HESPERIA_BROWSER_COVERAGE_OMIT_FRAGMENT;

  if (omitFragment !== undefined && omitFragment !== "server" && omitFragment !== "page") {
    throw new Error("Browser CSS coverage omission control must be server or page");
  }

  return {
    runId,
    outputDirectory: absoluteOutputDirectory,
    buildDirectory,
    template: parsedTemplate as unknown as BrowserCoverageTemplate,
    outputs,
    ...(omitFragment === undefined ? {} : { omitFragment }),
  };
}

function exactPathFilter(paths: readonly string[]): RegExp {
  const escaped = paths.map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`^(?:${escaped.join("|")})$`, process.platform === "win32" ? "iu" : "u");
}

const packageDistJavaScriptFilter =
  /[\\/]packages[\\/](?:compiler|tooling|hosting|hesperia)[\\/]dist[\\/].+\.js$/iu;
const config = readConfig();

if (config) {
  installCoverageInstrumentation({
    repoPath,
    eligibleSources: preparedToolingSourcePaths.map((relativePath) =>
      resolve(repoPath, relativePath),
    ),
    preparedSources: config.template.preparedCoverageSources!,
  });
}

const outputsByOriginalPath = new Map(
  config?.outputs.map((output) => [canonicalPath(output.originalPath), output] as const),
);
const seededSourcePaths = new Set(
  Object.keys(config?.template.seedCoverage ?? {}).map(canonicalPath),
);
let buildSubstitutionCount = 0;
const buildSubstitutionPaths: Array<{ path: string; realPath: string }> = [];
const runtimeSubstitutionPaths = new Map<string, { path: string; realPath: string }>();
// These POST IDs gate timing only; final admission still requires every persisted page receipt.
const validatedPageCaptureRequests = new Set<BrowserCssCoveragePageOwnerId>();
let serverCaptureScheduled = false;

function mappedOutput(path: string): WorkerCoverageOutput | undefined {
  const exact = outputsByOriginalPath?.get(canonicalPath(path));

  if (exact) return exact;

  try {
    return outputsByOriginalPath?.get(canonicalPath(realpathSync(path)));
  } catch {
    return undefined;
  }
}

function instrumentedContents(path: string): string {
  const output = mappedOutput(path);

  if (!output) throw new Error(`Unmapped Hesperia dist JavaScript module: ${path}`);

  return readFileSync(output.compiledPath, "utf8");
}

function instrumentedRuntimeContents(path: string): string {
  runtimeSubstitutionPaths.set(canonicalPath(path), {
    path,
    realPath: realpathSync(path),
  });

  return instrumentedContents(path);
}

if (config) {
  const originalPaths = config.outputs.map((output) => output.originalPath);

  Bun.plugin({
    name: "hesperia-browser-css-coverage-runtime",

    setup(build) {
      build.onLoad({ filter: exactPathFilter(originalPaths) }, ({ path }) => ({
        contents: instrumentedRuntimeContents(path),
        loader: "js",
      }));

      build.onLoad({ filter: packageDistJavaScriptFilter }, ({ path }) => {
        return { contents: instrumentedRuntimeContents(path), loader: "js" };
      });
    },
  });
}

export const browserCssCoverageEnabled = config !== undefined;

export function createBrowserCssCoverageBuildPlugin(): Bun.BunPlugin | undefined {
  if (!config) return undefined;

  return {
    name: "hesperia-browser-css-coverage-build",

    setup(build) {
      const loadMappedModule = ({ path }: { path: string }) => {
        const output = mappedOutput(path);

        if (!output)
          throw new Error(`Unmapped Hesperia dist JavaScript module in Bun.build: ${path}`);

        buildSubstitutionCount++;

        buildSubstitutionPaths.push({
          path,
          realPath: realpathSync(path),
        });

        return { contents: readFileSync(output.compiledPath, "utf8"), loader: "js" as const };
      };

      const originalPaths = config.outputs.map((output) => output.originalPath);

      build.onLoad({ filter: exactPathFilter(originalPaths) }, loadMappedModule);

      build.onLoad({ filter: packageDistJavaScriptFilter }, loadMappedModule);
    },
  };
}

function snapshotCoverage(value: unknown, label: string): Record<string, CoverageFile> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error(`${label} contains no raw Istanbul coverage records`);
  }

  const coverage: Record<string, CoverageFile> = {};

  for (const [path, record] of Object.entries(value)) {
    if (
      !isRecord(record) ||
      typeof record.path !== "string" ||
      canonicalPath(record.path) !== canonicalPath(path) ||
      !seededSourcePaths.has(canonicalPath(record.path)) ||
      !isRecord(record.inputSourceMap) ||
      typeof record.__hesperiaInstrumentedSourceSha256 !== "string"
    ) {
      throw new Error(
        `${label} has a raw record with missing or unexpected transform identity: ${path}`,
      );
    }

    coverage[path] = record as unknown as CoverageFile;
  }

  return coverage;
}

function hasHits(file: CoverageFile): boolean {
  return (
    Object.values(file.s).some((count) => count > 0) ||
    Object.values(file.f).some((count) => count > 0) ||
    Object.values(file.b).some((counts) => counts.some((count) => count > 0))
  );
}

function importedMarkupExpectedEntrypoints(fixtureRoot: string): readonly (readonly string[])[] {
  const root = resolve(fixtureRoot);
  const markupFilename = resolve(root, "src/panel.html");
  const generatedStyleIndices = [0, 1, 2, 3, 4, 7, 8, 9] as const;
  const generatedStyles = generatedStyleIndices.map((index) => {
    const token = createHash("sha256")
      .update(markupFilename)
      .update("\0")
      .update(String(index))
      .digest("hex")
      .slice(0, 16);
    return [resolve(dirname(markupFilename), `.hesperia-inline-${token}.css`)];
  });
  const nativeStyles = ["src/native.css", "src/native-nested.css"].map((path) => [
    resolve(root, path),
  ]);
  return [
    ...generatedStyles,
    ...nativeStyles,
    [resolve(root, ".hesperia/main.ts"), resolve(root, ".hesperia/route-table.ts")],
  ];
}

export async function withBrowserCssCoverageFixtureBuild<T>(
  fixtureRoot: string,
  build: () => Promise<T>,
): Promise<T> {
  if (!config) return build();

  const { result } = await withCoverageWorkerFixtureBuild({
    buildDirectory: config.buildDirectory,
    repoPath,
    packageNames,
    outputs: config.outputs,
    expectedEntrypoints: importedMarkupExpectedEntrypoints(fixtureRoot),
    requiredSourcePaths: [],
    build,
  });
  return result;
}

function captureOwner(options: {
  readonly ownerId: BrowserCssCoverageOwnerId;
  readonly scenario?: BrowserCssCoverageScenario;
  readonly contextId: string;
  readonly pid: number;
  readonly coverage: unknown;
  readonly buildSubstitutions?: number;
  readonly buildSubstitutionPaths?: readonly { readonly path: string; readonly realPath: string }[];
  readonly runtimeSubstitutionPaths?: readonly {
    readonly path: string;
    readonly realPath: string;
  }[];
}): CaptureReceipt | undefined {
  if (!config) throw new Error("Browser CSS coverage capture has no active run");

  const receiptPath = resolve(
    config.outputDirectory,
    browserCssCoverageReceiptNames[options.ownerId],
  );

  if (existsSync(receiptPath)) {
    throw new Error(`Browser coverage already captured owner ${options.ownerId}`);
  }

  const expectedScenario = isBrowserCssCoveragePageOwnerId(options.ownerId)
    ? browserCssCoverageScenariosByOwnerId[options.ownerId]
    : undefined;

  if (
    expectedScenario
      ? options.scenario?.spec !== expectedScenario.spec ||
        options.scenario?.title !== expectedScenario.title
      : options.scenario !== undefined
  ) {
    throw new Error(`Browser coverage scenario mismatch for ${options.ownerId}`);
  }

  const rawCoverage = snapshotCoverage(options.coverage, options.ownerId);
  const hits = createCoverageArtifact({
    repoPath,
    kind: "hits",
    runId: config.runId,
    ownerId: options.ownerId,
    populationFingerprint: config.template.sourcePopulation.fingerprint,
    sourcePopulation: config.template.sourcePopulation,
    coverage: rawCoverage,
  });
  const positiveSources = Object.values(hits.coverage).flatMap((file) =>
    hasHits(file) ? [relative(repoPath, resolve(file.path)).split(sep).join("/")] : [],
  );
  const requiredSources = browserCssCoverageRequiredSources[options.ownerId];

  for (const requiredSource of requiredSources) {
    if (!positiveSources.includes(requiredSource)) {
      throw new Error(`${options.ownerId} has no positive authored hit for ${requiredSource}`);
    }
  }

  const seed = createCoverageArtifact({
    repoPath,
    kind: "seed",
    runId: config.runId,
    ownerId: options.ownerId,
    populationFingerprint: config.template.sourcePopulation.fingerprint,
    sourcePopulation: config.template.sourcePopulation,
    coverage: config.template.seedCoverage,
  });
  const kind = options.ownerId === browserCssCoverageOwnerIds.server ? "server" : "page";

  if (config.omitFragment === kind) return undefined;

  const seedPath = writeCoverageFragment({
    directory: config.outputDirectory,
    contextId: `${options.contextId}-seed`,
    pid: options.pid,
    threadId,
    repoPath,
    artifact: seed,
    sourcePopulation: config.template.sourcePopulation,
  });
  const hitPath = writeCoverageFragment({
    directory: config.outputDirectory,
    contextId: `${options.contextId}-hits`,
    pid: options.pid,
    threadId,
    repoPath,
    artifact: hits,
    sourcePopulation: config.template.sourcePopulation,
  });
  const receipt: CaptureReceipt = {
    format: "hesperia-browser-css-coverage-capture",
    version: 2,
    runId: config.runId,
    populationFingerprint: config.template.sourcePopulation.fingerprint,
    ownerId: options.ownerId,
    ...(expectedScenario ? { scenario: expectedScenario } : {}),
    seedArtifact: basename(seedPath),
    hitArtifact: basename(hitPath),
    positiveSources,
    ...(options.buildSubstitutions === undefined
      ? {}
      : { buildSubstitutions: options.buildSubstitutions }),
    ...(options.buildSubstitutionPaths === undefined
      ? {}
      : { buildSubstitutionPaths: options.buildSubstitutionPaths }),
    ...(options.runtimeSubstitutionPaths === undefined
      ? {}
      : { runtimeSubstitutionPaths: options.runtimeSubstitutionPaths }),
  };

  writeFileSync(receiptPath, JSON.stringify(receipt), { flag: "wx" });

  return receipt;
}

export function captureBrowserCssServerBuild(): CaptureReceipt | undefined {
  if (!config) return undefined;

  if (buildSubstitutionCount <= 0) {
    throw new Error("Browser CSS coverage Bun.build substituted no Hesperia dist modules");
  }

  return captureOwner({
    ownerId: browserCssCoverageOwnerIds.server,
    contextId: "browser-css-server",
    pid: process.pid,
    coverage: Reflect.get(globalThis, coverageVariable),
    buildSubstitutions: buildSubstitutionCount,
    buildSubstitutionPaths,
    runtimeSubstitutionPaths: [...runtimeSubstitutionPaths.values()],
  });
}

export async function captureBrowserCssPageRequest(request: Request): Promise<Response> {
  if (!config) return new Response("Not found", { status: 404 });

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let value: unknown;

  try {
    value = await request.json();
  } catch {
    return new Response("Malformed page coverage request", { status: 400 });
  }

  if (
    !isRecord(value) ||
    value.runId !== config.runId ||
    value.populationFingerprint !== config.template.sourcePopulation.fingerprint ||
    !isBrowserCssCoveragePageOwnerId(value.ownerId) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    return new Response("Page coverage request identity mismatch", { status: 400 });
  }

  const scenario = browserCssCoverageScenariosByOwnerId[value.ownerId];

  if (
    !isRecord(value.scenario) ||
    value.scenario.spec !== scenario.spec ||
    value.scenario.title !== scenario.title
  ) {
    return new Response("Page coverage scenario mismatch", { status: 400 });
  }

  try {
    captureOwner({
      ownerId: value.ownerId,
      scenario,
      contextId: value.ownerId,
      pid: value.pid,
      coverage: value.coverage,
    });

    const response = new Response(null, { status: 204 });

    validatedPageCaptureRequests.add(value.ownerId);

    if (
      !serverCaptureScheduled &&
      browserCssCoveragePageOwnerIds.every((ownerId) => validatedPageCaptureRequests.has(ownerId))
    ) {
      serverCaptureScheduled = true;

      // Capture after the final real page request handler returns its response.
      queueMicrotask(() => {
        captureBrowserCssServerBuild();
      });
    }

    return response;
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
  }
}
