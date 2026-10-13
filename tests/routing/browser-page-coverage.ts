import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { threadId } from "node:worker_threads";
import type { Page } from "playwright";
import {
  coverageVariable,
  createCoverageArtifact,
  inventoryCoverageSources,
  writeCoverageFragment,
  type CoverageFile,
  type CoveragePopulation,
} from "../../scripts/ci/coverage-collector.ts";
import {
  withCoverageWorkerFixtureBuild,
  type WorkerCoverageBuildRecord,
  type WorkerCoverageOutput,
} from "../../scripts/ci/coverage-worker-build.ts";

const environmentKeys = [
  "HESPERIA_COVERAGE_BROWSER_PAGE_TEMPLATE",
  "HESPERIA_COVERAGE_BROWSER_PAGE_OUTPUT_MAP",
  "HESPERIA_COVERAGE_BROWSER_PAGE_BUILD_DIRECTORY",
  "HESPERIA_COVERAGE_BROWSER_PAGE_POPULATION",
  "HESPERIA_COVERAGE_RUN_ID",
  "HESPERIA_COVERAGE_OWNER_ID",
  "HESPERIA_COVERAGE_OUTPUT_DIR",
] as const;

const fixturePackages = ["tooling", "compiler", "hosting", "hesperia"] as const;

export interface BrowserPageCoverageExpectation {
  readonly engine: string;
  readonly caseId: string;
  readonly mode: string;
  readonly documents: number;
}

interface BrowserPageCapture extends BrowserPageCoverageExpectation {
  readonly format: "hesperia-browser-page-coverage";
  readonly runId: string;
  readonly ownerId: string;
  readonly platform: string;
  readonly ownerTestPath: string;
  readonly populationFingerprint: string;
  readonly captureId: string;
  readonly pageRole: "main";
  readonly documentOrdinal: number;
  readonly capturePhase: "pagehide" | "final";
  readonly browserVersion: string;
  readonly runtimeMode: "native" | "legacy";
  readonly captureProcessId: number;
  readonly href: string;
  readonly timeOrigin: number;
  readonly coverage: Record<string, CoverageFile>;
}

interface BrowserPageCoverageConfig {
  readonly buildDirectory: string;
  readonly outputs: readonly WorkerCoverageOutput[];
  readonly ownerId: string;
  readonly ownerTestPath: string;
  readonly outputDirectory: string;
  readonly populationFingerprint: string;
  readonly repoPath: string;
  readonly runId: string;
  readonly sourcePopulation: CoveragePopulation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureKey(
  value: Pick<BrowserPageCoverageExpectation, "engine" | "caseId" | "mode">,
): string {
  return `${value.engine}:${value.caseId}:${value.mode}`;
}

function captureId(
  ownerTestPath: string,
  value: Pick<BrowserPageCoverageExpectation, "engine" | "caseId" | "mode">,
  documentOrdinal: number,
): string {
  return `${ownerTestPath}:${value.engine}:${value.caseId}:${value.mode}:main:${documentOrdinal}`;
}

function expectedCases(ownerTestPath: string): BrowserPageCoverageExpectation[] {
  const engines = ["chromium", "firefox", "webkit"];
  const cases: BrowserPageCoverageExpectation[] = [];

  const add = (engine: string, caseId: string, mode: string, documents: number) =>
    cases.push({ engine, caseId, mode, documents });

  if (ownerTestPath === "tests/routing/navigation-facade.browser.test.ts") {
    for (const engine of engines) {
      add(engine, "iframe-window-isolation", "default", 1);

      add(engine, "query-navigation", "default", 1);

      for (const caseId of ["authored-navigation", "exact-fragment", "direct-history"]) {
        for (const mode of engine === "webkit" ? ["legacy"] : ["native", "legacy"])
          add(engine, caseId, mode, 1);
      }
    }
  } else if (ownerTestPath === "tests/routing/navigation-state.browser.test.ts") {
    for (const engine of engines) {
      add(engine, "direct-history-navigation-state", "default", 2);

      add(engine, "direct-history-url-arguments", "history-api", 1);

      add(engine, "fallback-state-reload-traversal", "legacy", 2);

      add(engine, "fallback-after-dispose", "legacy", 2);
    }
  } else {
    throw new Error("Browser page coverage owner has no approved case contract");
  }

  return cases;
}

function hasPositiveAuthoredHits(coverage: Record<string, CoverageFile>): boolean {
  return Object.entries(coverage).some(([source, file]) => {
    const key = `${source}/${file.path}`.replaceAll("\\", "/").toLowerCase();
    return (
      key.includes("/packages/hesperia/src/") &&
      (Object.values(file.s ?? {}).some((count) => count > 0) ||
        Object.values(file.f ?? {}).some((count) => count > 0) ||
        Object.values(file.b ?? {}).some((counts) => counts.some((count) => count > 0)))
    );
  });
}

export async function loadBrowserPageCoverage(
  ownerTestPath: string,
): Promise<BrowserPageCoverageSuite | undefined> {
  const values = environmentKeys.map((key) => process.env[key]);

  if (values.every((value) => value === undefined)) return undefined;

  if (values.some((value) => value === undefined)) {
    throw new Error("Browser page coverage environment is incomplete");
  }

  if (
    ownerTestPath !== "tests/routing/navigation-facade.browser.test.ts" &&
    ownerTestPath !== "tests/routing/navigation-state.browser.test.ts"
  ) {
    throw new Error("Browser page coverage owner is not an approved navigation test");
  }

  const [
    templatePath,
    outputMapPath,
    buildDirectory,
    populationFingerprint,
    runId,
    ownerId,
    outputDirectory,
  ] = values as [string, string, string, string, string, string, string];
  const repoPath = resolve(import.meta.dir, "../..");
  const templateValue: unknown = JSON.parse(await readFile(templatePath, "utf8"));
  const outputValue: unknown = JSON.parse(await readFile(outputMapPath, "utf8"));

  if (
    !isRecord(templateValue) ||
    !isRecord(templateValue.sourcePopulation) ||
    !Array.isArray(templateValue.sourcePopulation.files) ||
    !Array.isArray(outputValue) ||
    templateValue.sourcePopulation.fingerprint !== populationFingerprint ||
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof ownerId !== "string" ||
    ownerId.length === 0
  ) {
    throw new Error("Browser page coverage run identity or population is malformed");
  }

  const sourcePopulation = templateValue.sourcePopulation as unknown as CoveragePopulation;
  const expectedSources = inventoryCoverageSources(repoPath)
    .map((source) => relative(repoPath, source).split(sep).join("/"))
    .sort();
  const capturedSources = sourcePopulation.files.map((file) => file.source).sort();

  if (
    JSON.stringify(capturedSources) !== JSON.stringify(expectedSources) ||
    new Set(capturedSources).size !== expectedSources.length
  ) {
    throw new Error(
      "Browser page coverage population does not match the complete current inventory",
    );
  }

  const outputs = outputValue as WorkerCoverageOutput[];

  if (
    outputs.some(
      (output) =>
        !isRecord(output) ||
        typeof output.originalPath !== "string" ||
        typeof output.compiledPath !== "string",
    )
  ) {
    throw new Error("Browser page coverage output map is malformed");
  }

  const requiredPaths = [
    "packages/hesperia/src/routing/navigation.ts",
    "packages/hesperia/src/routing/navigation-api.ts",
    "packages/hesperia/src/routing/history.ts",
    "packages/hesperia/src/routing/browser-history.ts",
  ].map((path) => resolve(repoPath, path));

  if (
    requiredPaths.some(
      (path) =>
        !sourcePopulation.files.some(
          (file) => file.source === relative(repoPath, path).split(sep).join("/"),
        ),
    )
  ) {
    throw new Error("Browser page coverage owner requires a source outside the population");
  }

  return new BrowserPageCoverageSuite(
    {
      buildDirectory: resolve(buildDirectory),
      outputs,
      ownerId,
      ownerTestPath,
      outputDirectory: resolve(outputDirectory),
      populationFingerprint,
      repoPath,
      runId,
      sourcePopulation,
    },
    requiredPaths,
  );
}

export class BrowserPageCoverageSuite {
  private readonly builds: WorkerCoverageBuildRecord[] = [];
  private readonly captures: BrowserPageCapture[] = [];

  constructor(
    private readonly config: BrowserPageCoverageConfig,
    private readonly requiredSourcePaths: readonly string[],
  ) {}

  async buildFixtures<T>(options: {
    readonly expectedEntrypoints: readonly (readonly string[])[];
    readonly build: () => Promise<T>;
  }): Promise<T> {
    const result = await withCoverageWorkerFixtureBuild({
      buildDirectory: this.config.buildDirectory,
      repoPath: this.config.repoPath,
      packageNames: fixturePackages,
      outputs: this.config.outputs,
      expectedEntrypoints: options.expectedEntrypoints,
      requiredSourcePaths: this.requiredSourcePaths,
      build: options.build,
    });

    this.builds.push(...result.builds);

    return result.result;
  }

  async preparePage(
    page: Page,
    browserVersion: string,
    expectation: BrowserPageCoverageExpectation,
  ): Promise<() => Promise<void>> {
    if (!browserVersion.trim()) throw new Error("Browser page coverage has no browser version");

    if (!Number.isSafeInteger(expectation.documents) || expectation.documents < 1) {
      throw new Error("Browser page coverage document expectation is invalid");
    }

    const baseKey = [
      "hesperia-browser-page-coverage",
      this.config.runId,
      this.config.ownerTestPath.replaceAll("/", "_"),
      expectation.engine,
      expectation.caseId,
      expectation.mode,
    ].join(":");
    const contextGlobal = "__hesperiaPageCoverageContext__";

    await page.addInitScript(
      ({
        baseKey,
        contextGlobal,
        coverageVariable,
        expectation,
        ownerTestPath,
        runId,
        ownerId,
        platform,
        populationFingerprint,
        browserVersion,
        captureProcessId,
      }) => {
        if (window !== window.top) return;

        const nextKey = `${baseKey}:next`;
        const next = Number(sessionStorage.getItem(nextKey) ?? "0");

        if (!Number.isSafeInteger(next) || next < 0)
          throw new Error("Browser page coverage document ordinal is invalid");

        sessionStorage.setItem(nextKey, String(next + 1));

        const context = {
          format: "hesperia-browser-page-coverage",
          runId,
          ownerId,
          platform,
          ownerTestPath,
          populationFingerprint,
          engine: expectation.engine,
          caseId: expectation.caseId,
          mode: expectation.mode,
          documents: expectation.documents,
          captureId: `${ownerTestPath}:${expectation.engine}:${expectation.caseId}:${expectation.mode}:main:${next}`,
          pageRole: "main",
          documentOrdinal: next,
          browserVersion,
          captureProcessId,
        };
        const pageGlobal = globalThis as Record<string, unknown>;
        pageGlobal[coverageVariable] = {};
        pageGlobal[contextGlobal] = context;

        window.addEventListener(
          "pagehide",
          () => {
            const coverage = pageGlobal[coverageVariable];

            if (!coverage || typeof coverage !== "object")
              throw new Error("Pagehide has no browser coverage map");

            const record = {
              ...context,
              capturePhase: "pagehide",
              runtimeMode:
                typeof (window as Window & { navigation?: unknown }).navigation === "undefined"
                  ? "legacy"
                  : "native",
              href: location.href,
              timeOrigin: performance.timeOrigin,
              coverage: JSON.parse(JSON.stringify(coverage)),
            };
            const recordKey = `${baseKey}:document:${next}`;

            if (sessionStorage.getItem(recordKey) !== null)
              throw new Error("Browser page coverage duplicated a pagehide record");

            sessionStorage.setItem(recordKey, JSON.stringify(record));
          },
          { once: true },
        );
      },
      {
        baseKey,
        contextGlobal,
        coverageVariable,
        expectation,
        ownerTestPath: this.config.ownerTestPath,
        runId: this.config.runId,
        ownerId: this.config.ownerId,
        platform: process.platform,
        populationFingerprint: this.config.populationFingerprint,
        browserVersion,
        captureProcessId: process.pid,
      },
    );

    return async () => {
      const bundle = (await page.evaluate(
        ({ baseKey, contextGlobal, coverageVariable }) => {
          if (window !== window.top)
            throw new Error("Coverage capture must use the runtime's top document");

          const pageGlobal = globalThis as Record<string, unknown>;
          const context = pageGlobal[contextGlobal] as Record<string, unknown> | undefined;

          if (!context || typeof context !== "object")
            throw new Error("Browser page coverage context was not installed");

          const documentOrdinal = context.documentOrdinal as number;

          if (!Number.isSafeInteger(documentOrdinal) || documentOrdinal < 0)
            throw new Error("Browser page coverage context has an invalid document ordinal");

          const pagehide: unknown[] = [];

          for (let ordinal = 0; ordinal < documentOrdinal; ordinal++) {
            const key = `${baseKey}:document:${ordinal}`;
            const serialized = sessionStorage.getItem(key);

            if (serialized === null)
              throw new Error(`Browser page coverage omitted pagehide document ${ordinal}`);

            pagehide.push(JSON.parse(serialized));

            sessionStorage.removeItem(key);
          }

          const coverage = pageGlobal[coverageVariable];

          if (!coverage || typeof coverage !== "object")
            throw new Error("Final browser document has no coverage map");

          return {
            pagehide,
            final: {
              ...context,
              capturePhase: "final",
              runtimeMode:
                typeof (window as Window & { navigation?: unknown }).navigation === "undefined"
                  ? "legacy"
                  : "native",
              href: location.href,
              timeOrigin: performance.timeOrigin,
              coverage: JSON.parse(JSON.stringify(coverage)),
            },
          };
        },
        { baseKey, contextGlobal, coverageVariable },
      )) as { pagehide: unknown[]; final: unknown };
      const records = [...bundle.pagehide, bundle.final].map((record) => {
        if (!isRecord(record) || !isRecord(record.coverage)) {
          throw new Error(`${captureKey(expectation)} produced a malformed browser capture`);
        }

        return record as unknown as BrowserPageCapture;
      });

      if (records.length !== expectation.documents) {
        throw new Error(
          `${captureKey(expectation)} expected ${expectation.documents} documents but captured ${records.length}`,
        );
      }

      const sorted = [...records].sort(
        (left, right) => left.documentOrdinal - right.documentOrdinal,
      );

      if (
        new Set(sorted.map((record) => record.captureId)).size !== expectation.documents ||
        sorted.some((record, index) => record.documentOrdinal !== index) ||
        sorted.map((record) => record.captureId).join("\n") !==
          Array.from({ length: expectation.documents }, (_, index) =>
            captureId(this.config.ownerTestPath, expectation, index),
          ).join("\n")
      ) {
        throw new Error(
          `${captureKey(expectation)} has a missing, duplicate, or foreign document identity`,
        );
      }

      const timeOrigins = new Set<number>();

      for (const [index, record] of sorted.entries()) {
        if (
          record.format !== "hesperia-browser-page-coverage" ||
          record.runId !== this.config.runId ||
          record.ownerId !== this.config.ownerId ||
          record.platform !== process.platform ||
          record.ownerTestPath !== this.config.ownerTestPath ||
          record.populationFingerprint !== this.config.populationFingerprint ||
          record.engine !== expectation.engine ||
          record.caseId !== expectation.caseId ||
          record.mode !== expectation.mode ||
          record.pageRole !== "main" ||
          record.capturePhase !== (index === expectation.documents - 1 ? "final" : "pagehide") ||
          record.browserVersion !== browserVersion ||
          record.captureProcessId !== process.pid ||
          !["native", "legacy"].includes(record.runtimeMode) ||
          typeof record.href !== "string" ||
          !Number.isFinite(record.timeOrigin) ||
          record.href.length === 0 ||
          !hasPositiveAuthoredHits(record.coverage)
        ) {
          throw new Error(
            `${record.captureId} has malformed provenance or no authored runtime hits`,
          );
        }

        if (record.mode === "native" && record.runtimeMode !== "native")
          throw new Error(
            `${record.captureId} expected native navigation but the runtime used fallback`,
          );

        if (record.mode === "legacy" && record.runtimeMode !== "legacy")
          throw new Error(
            `${record.captureId} expected legacy navigation but native API was present`,
          );

        if (timeOrigins.has(record.timeOrigin))
          throw new Error(`${record.captureId} reused a browser document identity`);

        timeOrigins.add(record.timeOrigin);

        this.captures.push(record);
      }
    };
  }

  async finish(): Promise<void> {
    const expected = expectedCases(this.config.ownerTestPath);
    const expectedBuildCount =
      this.config.ownerTestPath === "tests/routing/navigation-state.browser.test.ts" ? 2 : 1;
    const expectedCaseKeys = expected.map(captureKey).sort();

    if (new Set(expectedCaseKeys).size !== expectedCaseKeys.length) {
      throw new Error("Browser page coverage expectation contains duplicate cases");
    }

    const actualCases = new Map<string, BrowserPageCapture[]>();

    for (const capture of this.captures) {
      const key = captureKey(capture);
      const records = actualCases.get(key) ?? [];

      records.push(capture);

      actualCases.set(key, records);
    }

    if (
      JSON.stringify([...actualCases.keys()].sort()) !== JSON.stringify(expectedCaseKeys) ||
      this.builds.length !== expectedBuildCount
    ) {
      throw new Error(
        "Browser page coverage did not complete every registered test case or fixture build",
      );
    }

    for (const expectedCase of expected) {
      const records = actualCases.get(captureKey(expectedCase))!;

      if (records.length !== expectedCase.documents) {
        throw new Error(`${captureKey(expectedCase)} has an incomplete document capture set`);
      }
    }

    const fragments: { captureId: string; contextId: string; path: string; sha256: string }[] = [];

    for (const capture of this.captures) {
      const artifact = createCoverageArtifact({
        repoPath: this.config.repoPath,
        kind: "hits",
        runId: this.config.runId,
        ownerId: this.config.ownerId,
        populationFingerprint: this.config.populationFingerprint,
        sourcePopulation: this.config.sourcePopulation,
        coverage: capture.coverage,
      });
      const contextId = `${this.config.ownerTestPath.replaceAll("/", "-")}-${capture.engine}-${capture.caseId}-${capture.mode}-document-${capture.documentOrdinal}`;
      const fragmentPath = writeCoverageFragment({
        directory: this.config.outputDirectory,
        contextId,
        pid: process.pid,
        threadId,
        repoPath: this.config.repoPath,
        artifact,
        sourcePopulation: this.config.sourcePopulation,
      });
      const relativePath = relative(this.config.outputDirectory, fragmentPath);

      if (
        isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith(".." + sep)
      ) {
        throw new Error("Browser page coverage fragment escaped its run output directory");
      }

      const bytes = await readFile(fragmentPath);

      fragments.push({
        captureId: capture.captureId,
        contextId,
        path: relativePath.split(sep).join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }

    await mkdir(this.config.buildDirectory, { recursive: true });

    const filename = this.config.ownerTestPath
      .replace("tests/routing/", "")
      .replace(".browser.test.ts", "")
      .replaceAll("/", "-");

    await writeFile(
      join(this.config.buildDirectory, `${filename}.browser-capture-evidence.json`),
      JSON.stringify({
        format: "hesperia-browser-page-capture-evidence",
        version: 1,
        runId: this.config.runId,
        ownerId: this.config.ownerId,
        platform: process.platform,
        ownerTestPath: this.config.ownerTestPath,
        populationFingerprint: this.config.populationFingerprint,
        workerSeedTemplate: "worker-seed-template.json",
        workerOutputMap: "worker-output-map.json",
        builds: this.builds,
        captures: this.captures,
        fragments,
      }),
    );
  }
}
