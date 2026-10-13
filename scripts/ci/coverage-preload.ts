import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { threadId } from "node:worker_threads";
import { afterAll } from "bun:test";
import {
  coverageVariable,
  createCoverageArtifact,
  inventoryCoverageSources,
  installCoverageInstrumentation,
  seedCoverageSources,
  writeCoverageFragment,
  type CoverageFile,
  type CoveragePopulation,
} from "./coverage-collector.ts";

const repoPath = resolve(import.meta.dir, "../..");
const runId = process.env.HESPERIA_COVERAGE_RUN_ID ?? randomUUID();
const contextId = process.env.HESPERIA_COVERAGE_CONTEXT ?? "bun-test";
const ownerId = process.env.HESPERIA_COVERAGE_OWNER_ID ?? "bun-tests";
const outputDirectory = resolve(
  process.env.HESPERIA_COVERAGE_OUTPUT_DIR ?? resolve(repoPath, ".hesperia/coverage/runs", runId),
);
const eligibleSources = inventoryCoverageSources(repoPath);
const seededCoverage = await seedCoverageSources(eligibleSources, repoPath);
const workerTemplatePath = process.env.HESPERIA_COVERAGE_WORKER_TEMPLATE;

if (workerTemplatePath) {
  const template = JSON.parse(readFileSync(workerTemplatePath, "utf8")) as {
    readonly sourcePopulation?: CoveragePopulation;
  };

  if (
    !template.sourcePopulation ||
    JSON.stringify(template.sourcePopulation) !== JSON.stringify(seededCoverage.population)
  ) {
    throw new Error("Coverage worker graph population does not match the direct Bun owner");
  }
}

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

if (browserPageConfiguration.some((value) => value !== undefined)) {
  if (browserPageConfiguration.some((value) => value === undefined)) {
    throw new Error("Browser page coverage configuration is incomplete");
  }

  const template = JSON.parse(readFileSync(browserPageTemplatePath!, "utf8")) as {
    readonly sourcePopulation?: CoveragePopulation;
  };

  if (
    !template.sourcePopulation ||
    JSON.stringify(template.sourcePopulation) !== JSON.stringify(seededCoverage.population) ||
    browserPagePopulationFingerprint !== seededCoverage.population.fingerprint
  ) {
    throw new Error("Browser page worker graph does not match the direct Bun owner population");
  }
}

installCoverageInstrumentation({
  repoPath,
  eligibleSources,
  preparedSources: seededCoverage.prepared,
});

const seedArtifact = createCoverageArtifact({
  repoPath,
  kind: "seed",
  runId,
  ownerId,
  populationFingerprint: seededCoverage.population.fingerprint,
  population: seededCoverage.population,
  coverage: seededCoverage.coverage,
});

afterAll(() => {
  const pid = process.pid;
  const fragment =
    (Reflect.get(globalThis, coverageVariable) as Record<string, CoverageFile> | undefined) ?? {};

  try {
    const hitArtifact = createCoverageArtifact({
      repoPath,
      kind: "hits",
      runId,
      ownerId,
      populationFingerprint: seededCoverage.population.fingerprint,
      sourcePopulation: seededCoverage.population,
      coverage: fragment,
    });
    const seedPath = writeCoverageFragment({
      directory: outputDirectory,
      contextId: `${contextId}-seed`,
      pid,
      threadId,
      repoPath,
      artifact: seedArtifact,
      sourcePopulation: seededCoverage.population,
    });
    const fragmentPath = writeCoverageFragment({
      directory: outputDirectory,
      contextId: `${contextId}-hits`,
      pid,
      threadId,
      repoPath,
      artifact: hitArtifact,
      sourcePopulation: seededCoverage.population,
    });

    console.error(`Hesperia coverage seed: ${seedPath}`);

    console.error(`Hesperia coverage fragment: ${fragmentPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    process.exitCode = 1;
  }
});
