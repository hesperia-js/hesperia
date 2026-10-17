import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
import { prepareBuild, ProjectError, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject } from "../../packages/tooling/src/server.ts";
import {
  coverageVariable,
  createCoverageArtifact,
  inventoryCoverageSources,
  writeCoverageFragment,
  type CoverageFile,
  type CoveragePopulation,
} from "../../scripts/ci/coverage-collector.ts";
import {
  withCoverageWorkerBuild,
  type WorkerCoverageBuildRecord,
  type WorkerCoverageOutput,
} from "../../scripts/ci/coverage-worker-build.ts";

const browserDriver = join(import.meta.dir, "fixtures/drivers/routing-public-flows-browser.mjs");

test("generated public routing flows preserve ownership, shared freshness, guard boundaries and whole-document reload", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "routing-public-flows-"));

  let server: Awaited<ReturnType<typeof previewProject>> | undefined;

  try {
    const browserPageTemplatePath = process.env.HESPERIA_COVERAGE_BROWSER_PAGE_TEMPLATE;
    const browserPageOutputMapPath = process.env.HESPERIA_COVERAGE_BROWSER_PAGE_OUTPUT_MAP;
    const browserPageBuildDirectory = process.env.HESPERIA_COVERAGE_BROWSER_PAGE_BUILD_DIRECTORY;
    const browserPagePopulationFingerprint = process.env.HESPERIA_COVERAGE_BROWSER_PAGE_POPULATION;
    const browserPageConfiguration = [
      browserPageTemplatePath,
      browserPageOutputMapPath,
      browserPageBuildDirectory,
      browserPagePopulationFingerprint,
    ];

    const browserPageCoverageEnabled = browserPageConfiguration.some(
      (value) => value !== undefined,
    );

    if (
      browserPageCoverageEnabled &&
      browserPageConfiguration.some((value) => value === undefined)
    ) {
      throw new Error("Browser page coverage environment is incomplete");
    }

    const browserPageCoverage = browserPageCoverageEnabled
      ? await (async () => {
          const template = JSON.parse(await readFile(browserPageTemplatePath!, "utf8")) as {
            readonly sourcePopulation?: CoveragePopulation;
          };

          const outputs = JSON.parse(await readFile(browserPageOutputMapPath!, "utf8")) as
            | WorkerCoverageOutput[]
            | undefined;

          const runId = process.env.HESPERIA_COVERAGE_RUN_ID;
          const ownerId = process.env.HESPERIA_COVERAGE_OWNER_ID;
          const outputDirectory = process.env.HESPERIA_COVERAGE_OUTPUT_DIR;
          const repoPath = resolve(import.meta.dir, "../..");
          const sourcePopulation = template.sourcePopulation;

          if (
            !sourcePopulation ||
            !Array.isArray(sourcePopulation.files) ||
            !Array.isArray(outputs) ||
            !runId ||
            !ownerId ||
            !outputDirectory ||
            sourcePopulation.fingerprint !== browserPagePopulationFingerprint
          ) {
            throw new Error("Browser page coverage run identity or population is malformed");
          }

          const expectedSources = inventoryCoverageSources(repoPath)
            .map((source) => relative(repoPath, source).split(sep).join("/"))
            .sort();

          const capturedSources = sourcePopulation.files.map((file) => file.source).sort();

          if (JSON.stringify(capturedSources) !== JSON.stringify(expectedSources)) {
            throw new Error(
              "Browser page coverage population does not match the complete current inventory",
            );
          }

          return {
            buildDirectory: browserPageBuildDirectory!,
            outputs,
            ownerId,
            outputDirectory,
            populationFingerprint: sourcePopulation.fingerprint,
            repoPath,
            runId,
            sourcePopulation,
          };
        })()
      : undefined;

    const fixtureRoot = new URL("./fixtures/applications/routing-public-flows/", import.meta.url);

    const sources = {
      "app.config.ts": await readFile(new URL("app.config.ts", fixtureRoot), "utf8"),
      "app.tsx": await readFile(new URL("app.tsx", fixtureRoot), "utf8"),
      "api.ts": await readFile(new URL("api.ts", fixtureRoot), "utf8"),
      "src/routes/+layout.tsx": await readFile(
        new URL("src/routes/+layout.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/+loading.tsx": await readFile(
        new URL("src/routes/+loading.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/+not-found.tsx": await readFile(
        new URL("src/routes/+not-found.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/+page.tsx": await readFile(new URL("src/routes/+page.tsx", fixtureRoot), "utf8"),
      "src/routes/startup/+page.tsx": await readFile(
        new URL("src/routes/startup/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/cached/+page.tsx": await readFile(
        new URL("src/routes/cached/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/parking/+page.tsx": await readFile(
        new URL("src/routes/parking/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/target/+page.tsx": await readFile(
        new URL("src/routes/target/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/after/+page.tsx": await readFile(
        new URL("src/routes/after/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/broken/+page.tsx": await readFile(
        new URL("src/routes/broken/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/broken/+error.tsx": await readFile(
        new URL("src/routes/broken/+error.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/users/[id]/+page.tsx": await readFile(
        new URL("src/routes/users/[id]/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/blocked/+route.ts": await readFile(
        new URL("src/routes/blocked/+route.ts", fixtureRoot),
        "utf8",
      ),
      "src/routes/blocked/+page.tsx": await readFile(
        new URL("src/routes/blocked/+page.tsx", fixtureRoot),
        "utf8",
      ),
      "src/routes/redirect/+route.ts": await readFile(
        new URL("src/routes/redirect/+route.ts", fixtureRoot),
        "utf8",
      ),
      "src/routes/redirect/+page.tsx": await readFile(
        new URL("src/routes/redirect/+page.tsx", fixtureRoot),
        "utf8",
      ),
    };

    for (const [filename, source] of Object.entries(sources)) {
      const target = join(root, filename);

      await mkdir(resolve(target, ".."), { recursive: true });

      await writeFile(target, source);
    }

    let build: Awaited<ReturnType<typeof prepareBuild>>;
    let capturedBuilds: readonly WorkerCoverageBuildRecord[] = [];

    try {
      if (browserPageCoverage) {
        const instrumentedBuild = await withCoverageWorkerBuild({
          buildDirectory: browserPageCoverage.buildDirectory,
          repoPath: browserPageCoverage.repoPath,
          projectRoot: root,
          packageNames: ["tooling", "compiler", "hosting", "hesperia"],
          outputs: browserPageCoverage.outputs,

          build: () => prepareBuild(root),
        });

        build = instrumentedBuild.result;
        capturedBuilds = instrumentedBuild.builds;
      } else {
        build = await prepareBuild(root);
      }

      await writeBuild(root, build);
    } catch (error) {
      if (error instanceof ProjectError)
        throw new Error(JSON.stringify(error.diagnostics, null, 2), { cause: error });

      throw error;
    }

    const javascript = await Promise.all(
      [...build.files.entries()]
        .filter(([filename]) => filename.endsWith(".js"))
        .map(([, file]) => file.text()),
    );

    expect(javascript.join("\n")).not.toContain("SERVER_BLOCKED_LOAD");

    expect(javascript.join("\n")).not.toContain("SERVER_REDIRECT_LOAD");

    server = await previewProject(root, 0);

    const browserCoverageScriptConfig = browserPageCoverage
      ? {
          coverageVariable,
          runId: browserPageCoverage.runId,
          ownerId: browserPageCoverage.ownerId,
          platform: process.platform,
          populationFingerprint: browserPageCoverage.populationFingerprint,
          builds: capturedBuilds,
          receiptPath: join(root, "routing-public-flows.browser-coverage.json"),
        }
      : undefined;

    const browserRuntimeConfigPath = join(root, "routing-public-flows.browser-config.json");

    await writeFile(
      browserRuntimeConfigPath,
      JSON.stringify({
        playwrightModuleUrl: pathToFileURL(
          resolve(import.meta.dir, "../../node_modules/playwright/index.mjs"),
        ).href,
        browserCoverage: browserCoverageScriptConfig ?? null,
        serverUrl: server.url.href,
      }),
    );

    const browserScript = join(root, "routing-public-flows.browser.mjs");

    await copyFile(browserDriver, browserScript);

    const child = Bun.spawn(["node", browserScript, browserRuntimeConfigPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const captureDriverPid = child.pid;

    if (browserPageCoverage && (!Number.isSafeInteger(captureDriverPid) || captureDriverPid <= 0)) {
      throw new Error("Generated browser driver has no positive process identity");
    }

    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (status !== 0) throw new Error(`Generated public routing flow failed\n${output}\n${errors}`);

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium public routing flows and authored and browser API reload verified",
      "firefox public routing flows and authored and browser API reload verified",
      "webkit public routing flows and authored and browser API reload verified",
    ]);

    if (browserPageCoverage) {
      const receiptPath = join(root, "routing-public-flows.browser-coverage.json");

      const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));

      const isRecord = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value);

      if (
        !isRecord(receipt) ||
        receipt.format !== "hesperia-browser-page-coverage-captures" ||
        receipt.version !== 1 ||
        receipt.runId !== browserPageCoverage.runId ||
        receipt.ownerId !== browserPageCoverage.ownerId ||
        receipt.platform !== process.platform ||
        receipt.populationFingerprint !== browserPageCoverage.populationFingerprint ||
        !Array.isArray(receipt.builds) ||
        JSON.stringify(receipt.builds) !== JSON.stringify(capturedBuilds) ||
        !Array.isArray(receipt.captures)
      ) {
        throw new Error("Browser page capture receipt has foreign or malformed run provenance");
      }

      const expectedCaptureIds = [];

      for (const engine of ["chromium", "firefox", "webkit"])
        expectedCaptureIds.push(
          `${engine}:main:0`,
          `${engine}:main:1`,
          `${engine}:main:2`,
          `${engine}:startup:0`,
          `${engine}:supersession:0`,
        );

      const captures = receipt.captures;

      const captureIds = captures.map((capture) =>
        isRecord(capture) ? capture.captureId : undefined,
      );

      if (
        captures.length !== expectedCaptureIds.length ||
        new Set(captureIds).size !== expectedCaptureIds.length ||
        JSON.stringify([...captureIds].sort()) !== JSON.stringify(expectedCaptureIds.sort())
      ) {
        throw new Error(
          "Browser page capture receipt is missing or duplicates an engine/document context",
        );
      }

      const validatedCaptures: {
        readonly artifact: ReturnType<typeof createCoverageArtifact>;
        readonly captureId: string;
        readonly contextId: string;
        readonly engine: string;
        readonly pageRole: string;
        readonly documentOrdinal: number;
        readonly timeOrigin: number;
      }[] = [];

      for (const value of captures) {
        if (!isRecord(value) || !isRecord(value.coverage)) {
          throw new Error("Browser page capture contains a malformed counter map");
        }

        const capture = value;

        const validEngine =
          typeof capture.engine === "string" &&
          ["chromium", "firefox", "webkit"].includes(capture.engine);

        const validPageRole =
          typeof capture.pageRole === "string" &&
          ["main", "startup", "supersession"].includes(capture.pageRole);

        if (
          capture.format !== "hesperia-browser-page-coverage" ||
          capture.runId !== browserPageCoverage.runId ||
          capture.ownerId !== browserPageCoverage.ownerId ||
          capture.platform !== process.platform ||
          capture.populationFingerprint !== browserPageCoverage.populationFingerprint ||
          !validEngine ||
          !validPageRole ||
          typeof capture.documentOrdinal !== "number" ||
          !Number.isSafeInteger(capture.documentOrdinal) ||
          (capture.pageRole === "main"
            ? ![0, 1, 2].includes(capture.documentOrdinal as number)
            : capture.documentOrdinal !== 0) ||
          typeof capture.captureId !== "string" ||
          capture.captureId !==
            String(capture.engine) +
              ":" +
              String(capture.pageRole) +
              ":" +
              String(capture.documentOrdinal) ||
          typeof capture.browserVersion !== "string" ||
          capture.browserVersion.trim().length === 0 ||
          typeof capture.href !== "string" ||
          capture.href.length === 0 ||
          !Number.isFinite(capture.timeOrigin) ||
          !Number.isSafeInteger(capture.captureProcessId) ||
          capture.captureProcessId !== captureDriverPid
        ) {
          throw new Error("Browser page capture has malformed document provenance");
        }

        const engine = capture.engine as string;

        const pageRole = capture.pageRole as string;

        const documentOrdinal = capture.documentOrdinal as number;

        const captureId = capture.captureId as string;

        const timeOrigin = capture.timeOrigin as number;

        const expectedPhase = pageRole === "main" && documentOrdinal < 2 ? "pagehide" : "final";

        if (capture.capturePhase !== expectedPhase) {
          throw new Error("Browser page capture phase is wrong for " + captureId);
        }

        if (expectedPhase === "pagehide" && capture.documentTimeOrigin !== timeOrigin) {
          throw new Error(
            "Browser pagehide did not retain its old document identity: " + captureId,
          );
        }

        const coverage = capture.coverage as Record<string, CoverageFile>;

        if (
          Object.keys(coverage).length === 0 ||
          !Object.values(coverage).some(
            (file) =>
              Object.values(file.s ?? {}).some((count) => count > 0) ||
              Object.values(file.f ?? {}).some((count) => count > 0) ||
              Object.values(file.b ?? {}).some((counts) => counts.some((count) => count > 0)),
          )
        ) {
          throw new Error("Browser page capture has no authentic instrumented hits: " + captureId);
        }

        const artifact = createCoverageArtifact({
          repoPath: browserPageCoverage.repoPath,
          kind: "hits",
          runId: browserPageCoverage.runId,
          ownerId: browserPageCoverage.ownerId,
          populationFingerprint: browserPageCoverage.populationFingerprint,
          sourcePopulation: browserPageCoverage.sourcePopulation,
          coverage,
        });

        validatedCaptures.push({
          artifact,
          captureId,
          contextId: "routing-" + engine + "-" + pageRole + "-document-" + documentOrdinal,
          engine,
          pageRole,
          documentOrdinal,
          timeOrigin,
        });
      }

      for (const engine of ["chromium", "firefox", "webkit"]) {
        const mainTimeOrigins = new Set(
          validatedCaptures
            .filter((item) => item.engine === engine && item.pageRole === "main")
            .map((item) => item.timeOrigin),
        );

        if (mainTimeOrigins.size !== 3) {
          throw new Error(
            "Browser engine did not produce three distinct main-document identities: " + engine,
          );
        }
      }

      const fragmentReferences: {
        readonly captureId: string;
        readonly contextId: string;
        readonly path: string;
        readonly sha256: string;
      }[] = [];

      for (const item of validatedCaptures) {
        const fragmentPath = writeCoverageFragment({
          directory: browserPageCoverage.outputDirectory,
          contextId: item.contextId,
          pid: process.pid,
          threadId,
          repoPath: browserPageCoverage.repoPath,
          artifact: item.artifact,
          sourcePopulation: browserPageCoverage.sourcePopulation,
        });

        const relativeFragmentPath = relative(browserPageCoverage.outputDirectory, fragmentPath);

        if (
          isAbsolute(relativeFragmentPath) ||
          relativeFragmentPath === ".." ||
          relativeFragmentPath.startsWith(".." + sep)
        ) {
          throw new Error("Browser page coverage fragment escaped its run directory");
        }

        const fragmentBytes = await readFile(fragmentPath);

        fragmentReferences.push({
          captureId: item.captureId,
          contextId: item.contextId,
          path: relativeFragmentPath.split(sep).join("/"),
          sha256: createHash("sha256").update(fragmentBytes).digest("hex"),
        });
      }

      await writeFile(
        join(
          browserPageCoverage.buildDirectory,
          "routing-public-flows.browser-capture-evidence.json",
        ),
        JSON.stringify({
          format: "hesperia-browser-page-capture-evidence",
          version: 1,
          runId: browserPageCoverage.runId,
          ownerId: browserPageCoverage.ownerId,
          platform: process.platform,
          populationFingerprint: browserPageCoverage.populationFingerprint,
          workerSeedTemplate: "worker-seed-template.json",
          workerOutputMap: "worker-output-map.json",
          builds: capturedBuilds,
          captures,
          fragments: fragmentReferences,
        }),
      );
    }
  } finally {
    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
