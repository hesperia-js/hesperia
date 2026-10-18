import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createCoverageArtifact,
  inventoryCoverageSources,
  mergeCoverageArtifacts,
  seedCoverageSources,
} from "../coverage-collector.ts";

const repoPath = resolve(import.meta.dir, "../../..");

test("a collector-valid artifact from another run is rejected", async () => {
  const outputDirectory = process.env.HESPERIA_COVERAGE_OUTPUT_DIR;
  const runId = process.env.HESPERIA_COVERAGE_RUN_ID;

  expect(outputDirectory).toBeDefined();

  expect(runId).toBeDefined();

  const sources = inventoryCoverageSources(repoPath);
  const seeded = await seedCoverageSources(sources, repoPath);
  const currentSeed = createCoverageArtifact({
    repoPath,
    kind: "seed",
    runId: runId!,
    ownerId: "bun-tests",
    populationFingerprint: seeded.population.fingerprint,
    population: seeded.population,
    coverage: seeded.coverage,
  });
  const currentHits = createCoverageArtifact({
    repoPath,
    kind: "hits",
    runId: runId!,
    ownerId: "bun-tests",
    populationFingerprint: seeded.population.fingerprint,
    sourcePopulation: seeded.population,
    coverage: {},
  });
  const validMerge = await mergeCoverageArtifacts({
    repoPath,
    expectedSources: sources,
    seeds: [currentSeed],
    fragments: [currentHits],
  });

  expect(validMerge.files()).toHaveLength(sources.length);

  writeFileSync(
    join(outputDirectory!, `${runId}-stale.json`),
    JSON.stringify({ ...currentSeed, runId: "previous-run" }),
  );
});
