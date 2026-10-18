import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generatedPositionFor, originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import {
  coverageVariable,
  createCoverageArtifact,
  installCoverageInstrumentation,
  mergeCoverageArtifacts,
  mergeCoverageRuns,
  seedCoverageSources,
  writeCoverageFragment,
  type CoverageArtifact,
  type CoverageFile,
  type CoverageRunArtifacts,
} from "../../scripts/ci/coverage-collector.ts";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("direct TS collection preserves behavior and merges canonical hits with offline zero-hit seeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-coverage-collector-"));

  roots.push(root);

  expect(resolve(root)).not.toBe(resolve(process.cwd()));

  const sourcePaths = [
    "packages/sample/src/resolve.ts",
    "packages/sample/src/status-label.ts",
    "packages/sample/src/untouched.ts",
    "packages/sample/src/empty.ts",
    "packages/sample/src/import-only.ts",
  ];

  for (const source of sourcePaths) await mkdir(join(root, source, ".."), { recursive: true });

  const [usedPath, helperPath, untouchedPath, emptyPath, importOnlyPath] = sourcePaths.map(
    (source) => resolve(root, source),
  );

  await writeFile(
    usedPath!,
    [
      'import { statusLabel } from "./status-label.ts";',
      'function hiddenForCoverage() { return statusLabel("not called"); }',
      "export function resolveStatus(status: string) {",
      '  if (status === "ready") return { status, label: statusLabel(status), next: 4 };',
      "  return { status, label: statusLabel(status), next: 0 };",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(emptyPath!, "export {};\n");

  await writeFile(importOnlyPath!, 'import "./status-label.ts";\n');

  await writeFile(
    helperPath!,
    [
      "export function statusLabel(status: string) {",
      '  if (status === "ready") return "Ready to publish";',
      '  return "Waiting";',
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    untouchedPath!,
    [
      "export function untouched(value: string) {",
      "  if (value.length > 0) return value.trim();",
      '  return "empty";',
      "}",
      "",
    ].join("\n"),
  );

  const originalResolveSource = await readFile(usedPath!, "utf8");

  const malformedSource = "packages/sample/src/malformed.ts";
  const malformedPath = resolve(root, malformedSource);

  await writeFile(malformedPath, "export const malformed: = 1;\n");

  let preparationError: unknown;

  try {
    await seedCoverageSources([sourcePaths[0]!, malformedSource], root);
  } catch (error) {
    preparationError = error;
  }

  expect(String(preparationError).replaceAll("\\", "/")).toContain(malformedSource);

  const seeded = await seedCoverageSources(sourcePaths, root);

  for (const item of seeded.prepared) {
    expect(item.sourceMap.sources).toHaveLength(1);

    expect(resolve(dirname(item.path), item.sourceMap.sources[0]!)).toBe(resolve(item.path));
  }

  const emptyPrepared = seeded.prepared.find((item) => item.path === emptyPath)!;
  const importOnlyPrepared = seeded.prepared.find((item) => item.path === importOnlyPath)!;

  expect(emptyPrepared.sourceMap.mappings).toBe("");

  expect(Object.keys(emptyPrepared.seed.statementMap)).toHaveLength(0);

  expect(Object.keys(emptyPrepared.seed.fnMap)).toHaveLength(0);

  expect(Object.keys(emptyPrepared.seed.branchMap)).toHaveLength(0);

  expect(emptyPrepared.seed.inputSourceMap?.sources).toStrictEqual(emptyPrepared.sourceMap.sources);

  expect(Object.keys(importOnlyPrepared.seed.statementMap)).toHaveLength(0);

  expect(Object.keys(importOnlyPrepared.seed.fnMap)).toHaveLength(0);

  expect(Object.keys(importOnlyPrepared.seed.branchMap)).toHaveLength(0);

  expect(importOnlyPrepared.seed.inputSourceMap?.sourcesContent?.[0]).toBe(
    'import "./status-label.ts";\n',
  );

  expect(importOnlyPrepared.sourceMap.mappings).toBe("");

  expect(importOnlyPrepared.instrumentedCode).toBe('import "./status-label.ts";\n');

  const usedPrepared = seeded.prepared.find((item) => item.path === usedPath)!;
  const sourceCodeEnd = usedPrepared.instrumentedCode.lastIndexOf(".inputSourceMap=");

  expect(sourceCodeEnd).toBeGreaterThan(0);

  expect(usedPrepared.instrumentedCode.slice(0, sourceCodeEnd)).toMatch(
    /export function resolveStatus\(status:\s*string\)/u,
  );

  const generatedSource = usedPrepared.instrumentedCode.slice(0, sourceCodeEnd);
  const generatedImport = /import\s*\{\s*statusLabel\s*\}/u.exec(generatedSource);

  expect(generatedImport).toBeDefined();

  const traceMap = new TraceMap({
    version: 3,
    names: [...(usedPrepared.sourceMap.names ?? [])],
    sources: [...usedPrepared.sourceMap.sources],
    sourcesContent: [...(usedPrepared.sourceMap.sourcesContent ?? [])],
    sourceRoot: usedPrepared.sourceMap.sourceRoot,
    mappings: usedPrepared.sourceMap.mappings,
  });
  const importPrefix = generatedSource.slice(0, generatedImport!.index);
  const importLine = importPrefix.split("\n").length;
  const importColumn = importPrefix.length - importPrefix.lastIndexOf("\n") - 1;

  expect(
    generatedPositionFor(traceMap, {
      source: "resolve.ts",
      line: 1,
      column: 0,
    }),
  ).toMatchObject({ line: importLine, column: importColumn });

  expect(originalPositionFor(traceMap, { line: importLine, column: importColumn })).toMatchObject({
    source: "resolve.ts",
    line: 1,
    column: 0,
  });

  const mappedToken = "statusLabel(status)";
  const authoredTokenOffset = originalResolveSource.indexOf(mappedToken);
  const generatedTokenOffset = usedPrepared.instrumentedCode.indexOf(mappedToken);

  expect(authoredTokenOffset).toBeGreaterThanOrEqual(0);

  expect(generatedTokenOffset).toBeGreaterThanOrEqual(0);

  expect(generatedTokenOffset).toBeLessThan(sourceCodeEnd);

  const authoredPrefix = originalResolveSource.slice(0, authoredTokenOffset);
  const generatedPrefix = usedPrepared.instrumentedCode.slice(0, generatedTokenOffset);
  const authoredLine = authoredPrefix.split("\n").length;
  const generatedLine = generatedPrefix.split("\n").length;
  const authoredColumn = authoredPrefix.length - authoredPrefix.lastIndexOf("\n") - 1;
  const generatedColumn = generatedPrefix.length - generatedPrefix.lastIndexOf("\n") - 1;

  expect(
    generatedPositionFor(traceMap, {
      source: "resolve.ts",
      line: authoredLine,
      column: authoredColumn,
    }),
  ).toMatchObject({ line: generatedLine, column: generatedColumn });

  expect(
    originalPositionFor(traceMap, { line: generatedLine, column: generatedColumn }),
  ).toMatchObject({ source: "resolve.ts", line: authoredLine, column: authoredColumn });

  const usedSeed = seeded.coverage[usedPath!]!;
  const hiddenFunction = Object.entries(usedSeed.fnMap).find(
    ([, value]) => value.name === "hiddenForCoverage",
  );

  expect(hiddenFunction).toBeDefined();

  expect(usedSeed.f[hiddenFunction![0]]).toBe(0);

  let missingPreparationError: unknown;

  try {
    installCoverageInstrumentation({
      repoPath: root,
      eligibleSources: sourcePaths,
      preparedSources: seeded.prepared.slice(0, 1),
    });
  } catch (error) {
    missingPreparationError = error;
  }

  expect(String(missingPreparationError)).toContain(
    "Coverage preparation omitted expected sources",
  );

  const collectorPath = resolve(import.meta.dir, "../../scripts/ci/coverage-collector.ts");
  const childScript = join(root, "coverage-owner-probe.ts");

  await writeFile(
    childScript,
    [
      'import { pathToFileURL } from "node:url";',
      `const collector = await import(pathToFileURL(${JSON.stringify(collectorPath)}).href);`,
      `const root = ${JSON.stringify(root)};`,
      `const sourcePaths = ${JSON.stringify(sourcePaths)};`,
      `const usedPath = ${JSON.stringify(usedPath)};`,
      `const helperPath = ${JSON.stringify(helperPath)};`,
      "const seeded = await collector.seedCoverageSources(sourcePaths, root);",
      "const instrumentation = collector.installCoverageInstrumentation({ repoPath: root, eligibleSources: sourcePaths, preparedSources: seeded.prepared });",
      "if (!instrumentation.prepared.has(sourcePaths[0])) throw new Error('source was not prepared before the Bun loader hook');",
      "const imported = await import(pathToFileURL(usedPath).href);",
      "const output = imported.resolveStatus('ready');",
      "if (JSON.stringify(output) !== JSON.stringify({ status: 'ready', label: 'Ready to publish', next: 4 })) throw new Error('direct TypeScript import changed behavior');",
      `const processCoverage = Reflect.get(globalThis, ${JSON.stringify(coverageVariable)});`,
      "const coverage = processCoverage?.[usedPath];",
      "if (!coverage) throw new Error('instrumented TypeScript import emitted no coverage record');",
      "const helperCoverage = processCoverage?.[helperPath];",
      "if (!helperCoverage) throw new Error('relative TypeScript import emitted no coverage record');",
      "process.stdout.write(JSON.stringify({ output, coverage, helperCoverage, ownerFiles: seeded.ownerFiles }));",
    ].join("\n"),
  );

  const child = Bun.spawn([process.execPath, childScript], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(status, stdout + stderr).toBe(0);

  const childResult = JSON.parse(stdout) as {
    output: { status: string; label: string; next: number };
    coverage: CoverageFile;
    helperCoverage: CoverageFile;
    ownerFiles: { sources: string[]; instrumentedSourceSha256: string }[];
  };

  expect(childResult.output).toStrictEqual({
    status: "ready",
    label: "Ready to publish",
    next: 4,
  });

  expect(childResult.coverage).toBeDefined();

  expect(childResult.helperCoverage).toBeDefined();

  expect(childResult.coverage.path).toBe(usedSeed.path);

  expect(JSON.parse(JSON.stringify(childResult.coverage.statementMap))).toStrictEqual(
    JSON.parse(JSON.stringify(usedSeed.statementMap)),
  );

  expect(JSON.parse(JSON.stringify(childResult.coverage.fnMap))).toStrictEqual(
    JSON.parse(JSON.stringify(usedSeed.fnMap)),
  );

  expect(JSON.parse(JSON.stringify(childResult.coverage.branchMap))).toStrictEqual(
    JSON.parse(JSON.stringify(usedSeed.branchMap)),
  );

  expect(JSON.parse(JSON.stringify(childResult.helperCoverage.statementMap))).toStrictEqual(
    JSON.parse(JSON.stringify(seeded.coverage[helperPath!]!.statementMap)),
  );

  expect(JSON.parse(JSON.stringify(childResult.helperCoverage.fnMap))).toStrictEqual(
    JSON.parse(JSON.stringify(seeded.coverage[helperPath!]!.fnMap)),
  );

  expect(JSON.parse(JSON.stringify(childResult.helperCoverage.branchMap))).toStrictEqual(
    JSON.parse(JSON.stringify(seeded.coverage[helperPath!]!.branchMap)),
  );

  expect(
    childResult.ownerFiles.map((item) => [item.sources[0], item.instrumentedSourceSha256]),
  ).toStrictEqual(
    seeded.ownerFiles.map((item) => [item.sources[0], item.instrumentedSourceSha256]),
  );

  expect(() =>
    createCoverageArtifact({
      repoPath: root,
      kind: "seed",
      runId: "run-1",
      ownerId: "bun-tests",
      populationFingerprint: seeded.population.fingerprint,
      coverage: seeded.coverage,
    }),
  ).toThrow("requires a population manifest");

  const seedArtifact = createCoverageArtifact({
    repoPath: root,
    kind: "seed",
    runId: "run-1",
    ownerId: "bun-tests",
    populationFingerprint: seeded.population.fingerprint,
    population: seeded.population,
    coverage: seeded.coverage,
  });
  let legacyArtifactError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seeded.coverage as unknown as CoverageArtifact],
      fragments: [],
    });
  } catch (error) {
    legacyArtifactError = error;
  }

  expect(String(legacyArtifactError)).toContain("non-seed artifact");

  const hitArtifact = createCoverageArtifact({
    repoPath: root,
    kind: "hits",
    runId: "run-1",
    ownerId: "bun-tests",
    populationFingerprint: seeded.population.fingerprint,
    sourcePopulation: seeded.population,
    coverage: {
      [usedPath!]: childResult.coverage,
      [helperPath!]: childResult.helperCoverage,
    },
  });

  const merged = await mergeCoverageArtifacts({
    repoPath: root,
    expectedSources: sourcePaths,
    seeds: [seedArtifact],
    fragments: [hitArtifact],
  });

  const used = merged.fileCoverageFor(usedPath!).toJSON();
  const helper = merged.fileCoverageFor(helperPath!).toJSON();
  const untouched = merged.fileCoverageFor(untouchedPath!).toJSON();

  expect(Object.values(used.s).some((count) => count > 0)).toBe(true);

  expect(Object.values(used.f).some((count) => count > 0)).toBe(true);

  expect(used.f[hiddenFunction![0]]).toBe(0);

  expect(Object.values(helper.s).some((count) => count > 0)).toBe(true);

  expect(Object.values(helper.f).some((count) => count > 0)).toBe(true);

  expect(Object.values(untouched.s).every((count) => count === 0)).toBe(true);

  expect(Object.values(untouched.f).every((count) => count === 0)).toBe(true);

  expect(merged.files().map((path) => path.replaceAll("\\", "/"))).toContain(
    usedPath!.replaceAll("\\", "/"),
  );

  expect(merged.files().map((path) => path.replaceAll("\\", "/"))).toContain(
    helperPath!.replaceAll("\\", "/"),
  );

  expect(merged.files().map((path) => path.replaceAll("\\", "/"))).toContain(
    emptyPath!.replaceAll("\\", "/"),
  );

  const stableFixtureJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableFixtureJson).join(",")}]`;

    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableFixtureJson(entry)}`).join(",")}}`;
    }

    return JSON.stringify(value) ?? "undefined";
  };

  const fixtureSha256 = (value: unknown): string =>
    createHash("sha256").update(stableFixtureJson(value)).digest("hex");

  const aggregateStatement = Object.keys(usedSeed.s)[0]!;
  const aggregateFunction = Object.keys(usedSeed.f)[0]!;
  const aggregateBranch = Object.keys(usedSeed.b)[0]!;
  const aggregateFamilies = [
    "bun-tests-ordinary",
    "project-worker-owner",
    "browser-css",
    "native-editor",
  ] as const;

  const runWithContribution = (
    family: CoverageRunArtifacts["family"],
    sequence: number,
    contribution: number,
    coverageSeed: Record<string, CoverageFile> = seeded.coverage,
    population = seeded.population,
  ): CoverageRunArtifacts => {
    const suffix = sequence.toString().padStart(12, "0");
    const runId = `00000000-0000-4000-8000-${suffix}`;
    const ownerId = `aggregate-owner-${sequence}`;
    const seed = createCoverageArtifact({
      repoPath: root,
      kind: "seed",
      runId,
      ownerId,
      populationFingerprint: population.fingerprint,
      population,
      coverage: coverageSeed,
    });
    const hitCoverage = structuredClone(coverageSeed);
    const hit = hitCoverage[usedPath!]!;
    hit.s[aggregateStatement] = contribution;
    hit.f[aggregateFunction] = contribution;
    hit.b[aggregateBranch] = hit.b[aggregateBranch]!.map(() => contribution);
    const fragment = createCoverageArtifact({
      repoPath: root,
      kind: "hits",
      runId,
      ownerId,
      populationFingerprint: population.fingerprint,
      sourcePopulation: population,
      coverage: { [usedPath!]: hit },
    });
    return {
      family,
      runId,
      platform: process.platform,
      seeds: [seed],
      fragments: [fragment],
    };
  };

  const originalRuns = aggregateFamilies.map((family, index) =>
    runWithContribution(family, index + 1, [2, 3, 5, 7][index]!),
  );
  let aggregateCaptureCount = 0;
  const finalAggregate = await mergeCoverageRuns({
    repoPath: root,
    expectedSources: sourcePaths,
    runs: originalRuns,
    capture: async ({ population, coverage }) => {
      aggregateCaptureCount += 1;

      expect(population.fingerprint).toBe(seeded.population.fingerprint);

      const admitted = coverage.fileCoverageFor(usedPath!).toJSON();

      expect(admitted.s[aggregateStatement]).toBe(17);

      expect(admitted.f[aggregateFunction]).toBe(17);

      expect(admitted.b[aggregateBranch]).toEqual(usedSeed.b[aggregateBranch]!.map(() => 17));

      return runWithContribution("final-aggregate", 5, 11);
    },
  });

  expect(aggregateCaptureCount).toBe(1);

  const aggregateUsed = finalAggregate.coverage.fileCoverageFor(usedPath!).toJSON();

  expect(aggregateUsed.s[aggregateStatement]).toBe(28);

  expect(aggregateUsed.f[aggregateFunction]).toBe(28);

  expect(aggregateUsed.b[aggregateBranch]).toEqual(usedSeed.b[aggregateBranch]!.map(() => 28));

  for (const key of ["statementMap", "fnMap", "branchMap"] as const) {
    expect(JSON.parse(JSON.stringify(aggregateUsed[key]))).toStrictEqual(
      JSON.parse(JSON.stringify(usedSeed[key])),
    );
  }

  const aggregateUntouched = finalAggregate.coverage.fileCoverageFor(untouchedPath!).toJSON();
  const untouchedSeed = seeded.coverage[untouchedPath!]!;

  for (const key of ["statementMap", "fnMap", "branchMap", "s", "f", "b"] as const) {
    expect(JSON.parse(JSON.stringify(aggregateUntouched[key]))).toStrictEqual(
      JSON.parse(JSON.stringify(untouchedSeed[key])),
    );
  }

  expect(
    finalAggregate.coverage
      .files()
      .map((path) => resolve(path))
      .sort(),
  ).toStrictEqual(sourcePaths.map((source) => resolve(root, source)).sort());

  let invalidCaptureCalls = 0;

  const invalidCapture = async (): Promise<CoverageRunArtifacts> => {
    invalidCaptureCalls += 1;
    throw new Error("Invalid source runs reached aggregate capture");
  };

  let duplicateAggregateIdError: unknown;
  const duplicateAggregateIdRuns = [...originalRuns];
  duplicateAggregateIdRuns[1] = {
    ...duplicateAggregateIdRuns[1]!,
    runId: duplicateAggregateIdRuns[0]!.runId,
  };

  try {
    await mergeCoverageRuns({
      repoPath: root,
      expectedSources: sourcePaths,
      runs: duplicateAggregateIdRuns,
      capture: invalidCapture,
    });
  } catch (error) {
    duplicateAggregateIdError = error;
  }

  expect(String(duplicateAggregateIdError)).toContain("duplicate original run");

  let duplicateAggregateFamilyError: unknown;
  const duplicateAggregateFamilyRuns = [...originalRuns];
  duplicateAggregateFamilyRuns[1] = {
    ...duplicateAggregateFamilyRuns[1]!,
    family: duplicateAggregateFamilyRuns[0]!.family,
  };

  try {
    await mergeCoverageRuns({
      repoPath: root,
      expectedSources: sourcePaths,
      runs: duplicateAggregateFamilyRuns,
      capture: invalidCapture,
    });
  } catch (error) {
    duplicateAggregateFamilyError = error;
  }

  expect(String(duplicateAggregateFamilyError)).toContain(
    "one original run from each required test owner",
  );

  const incompatibleCoverage = structuredClone(seeded.coverage);
  const incompatibleFile = incompatibleCoverage[usedPath!]!;
  const extraUnit = "aggregate-test-foreign-unit";
  incompatibleFile.statementMap[extraUnit] = structuredClone(
    incompatibleFile.statementMap[aggregateStatement]!,
  );
  incompatibleFile.s[extraUnit] = 0;
  const usedSource = seeded.population.files.find((file) => file.source.endsWith("/resolve.ts"))!;
  const incompatibleUnitsSha256 = fixtureSha256({
    statements: incompatibleFile.statementMap,
    functions: incompatibleFile.fnMap,
    branches: incompatibleFile.branchMap,
  });
  const incompatiblePopulationFiles = seeded.population.files.map((file) =>
    file.source === usedSource.source
      ? { ...file, canonicalUnitsSha256: incompatibleUnitsSha256 }
      : file,
  );
  const incompatiblePopulation = {
    schema: 1 as const,
    fingerprint: fixtureSha256({ schema: 1, files: incompatiblePopulationFiles }),
    files: incompatiblePopulationFiles,
  };
  const incompatibleRuns = [...originalRuns];
  incompatibleRuns[2] = runWithContribution(
    "browser-css",
    3,
    5,
    incompatibleCoverage,
    incompatiblePopulation,
  );
  let incompatiblePopulationError: unknown;

  try {
    await mergeCoverageRuns({
      repoPath: root,
      expectedSources: sourcePaths,
      runs: incompatibleRuns,
      capture: invalidCapture,
    });
  } catch (error) {
    incompatiblePopulationError = error;
  }

  expect(String(incompatiblePopulationError)).toContain(
    "source populations differ at original run",
  );

  expect(invalidCaptureCalls).toBe(0);

  const changedFunctionEndArtifact = structuredClone(hitArtifact);
  const changedFunctionKey = Object.keys(changedFunctionEndArtifact.coverage[usedPath!]!.fnMap)[0]!;
  const functionLocation =
    changedFunctionEndArtifact.coverage[usedPath!]!.fnMap[changedFunctionKey]!.loc;
  changedFunctionEndArtifact.coverage[usedPath!]!.fnMap[changedFunctionKey]!.loc = {
    ...functionLocation,
    end: {
      ...functionLocation.end!,
      column: functionLocation.end!.column + 1,
    },
  };
  let changedFunctionEndError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seedArtifact],
      fragments: [changedFunctionEndArtifact],
    });
  } catch (error) {
    changedFunctionEndError = error;
  }

  expect(String(changedFunctionEndError)).toContain(
    "Coverage owner transform identity does not match",
  );

  let missingSeedError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: [...sourcePaths, "packages/sample/src/missing.ts"],
      seeds: [seedArtifact],
      fragments: [],
    });
  } catch (error) {
    missingSeedError = error;
  }

  expect(String(missingSeedError)).toContain(
    "Coverage population does not match the expected source inventory",
  );

  const duplicateSeedMerge = await mergeCoverageArtifacts({
    repoPath: root,
    expectedSources: sourcePaths,
    seeds: [seedArtifact, seedArtifact],
    fragments: [],
  });
  const duplicateSeedUsed = duplicateSeedMerge.fileCoverageFor(usedPath!).toJSON();

  expect(Object.keys(duplicateSeedUsed.s)).toHaveLength(
    Object.keys(seeded.coverage[usedPath!]!.s).length,
  );

  expect(Object.values(duplicateSeedUsed.s).every((count) => count === 0)).toBe(true);

  const conflictingSeedCoverage = structuredClone(seeded.coverage);
  const conflictingFile = conflictingSeedCoverage[usedPath!]!;
  const changedFunction = Object.keys(conflictingFile.fnMap)[0]!;
  conflictingFile.fnMap[changedFunction]!.name += "_different";
  const conflictingSeed = createCoverageArtifact({
    repoPath: root,
    kind: "seed",
    runId: "run-1",
    ownerId: "bun-tests",
    populationFingerprint: seeded.population.fingerprint,
    sourcePopulation: seeded.population,
    coverage: conflictingSeedCoverage,
  });
  let duplicateSeedError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seedArtifact, conflictingSeed],
      fragments: [],
    });
  } catch (error) {
    duplicateSeedError = error;
  }

  expect(String(duplicateSeedError)).toContain("Conflicting duplicate coverage seeds");

  const fragmentOne = writeCoverageFragment({
    directory: join(root, "fragments"),
    contextId: "suite-a",
    pid: 101,
    threadId: 0,
    repoPath: root,
    artifact: hitArtifact,
    sourcePopulation: seeded.population,
  });
  const fragmentTwo = writeCoverageFragment({
    directory: join(root, "fragments"),
    contextId: "suite-a",
    pid: 102,
    threadId: 3,
    repoPath: root,
    artifact: hitArtifact,
    sourcePopulation: seeded.population,
  });
  const fragmentSameProcess = writeCoverageFragment({
    directory: join(root, "fragments"),
    contextId: "suite-a",
    pid: 101,
    threadId: 0,
    repoPath: root,
    artifact: hitArtifact,
    sourcePopulation: seeded.population,
  });

  expect(new Set([fragmentOne, fragmentTwo, fragmentSameProcess]).size).toBe(3);

  expect(Object.keys(JSON.parse(await readFile(fragmentOne, "utf8")).coverage)).toContain(
    usedPath!,
  );

  expect(Object.keys(JSON.parse(await readFile(fragmentSameProcess, "utf8")).coverage)).toContain(
    usedPath!,
  );

  expect(Object.keys(JSON.parse(await readFile(fragmentTwo, "utf8")).coverage)).toContain(
    usedPath!,
  );

  const staleMap = structuredClone(hitArtifact);
  staleMap.coverage[usedPath!]!.inputSourceMap = {
    ...staleMap.coverage[usedPath!]!.inputSourceMap!,
    mappings: `${staleMap.coverage[usedPath!]!.inputSourceMap!.mappings}A`,
  };
  let staleMapError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seedArtifact],
      fragments: [staleMap],
    });
  } catch (error) {
    staleMapError = error;
  }

  expect(String(staleMapError)).toContain("Coverage owner transform identity does not match");

  const invalidSourceContents = [
    { contents: undefined, error: "malformed source contents" },
    { contents: [null], error: "malformed source contents" },
    { contents: [`${originalResolveSource}stale`], error: "source contents do not match" },
  ] as const;

  for (const invalid of invalidSourceContents) {
    const staleContents = structuredClone(hitArtifact);
    staleContents.coverage[usedPath!]!.inputSourceMap = {
      ...staleContents.coverage[usedPath!]!.inputSourceMap!,
      sourcesContent: invalid.contents,
    };
    let sourceContentsError: unknown;

    try {
      await mergeCoverageArtifacts({
        repoPath: root,
        expectedSources: sourcePaths,
        seeds: [seedArtifact],
        fragments: [staleContents],
      });
    } catch (error) {
      sourceContentsError = error;
    }

    expect(String(sourceContentsError)).toContain(invalid.error);
  }

  let staleSourceError: unknown;

  await writeFile(usedPath!, `${await readFile(usedPath!, "utf8")}\n// changed after capture\n`);

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seedArtifact],
      fragments: [hitArtifact],
    });
  } catch (error) {
    staleSourceError = error;
  }

  expect(String(staleSourceError)).toContain("source contents do not match the authored source");

  await writeFile(usedPath!, originalResolveSource);

  const differentRun = { ...hitArtifact, runId: "run-2" };
  let differentRunError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seedArtifact],
      fragments: [differentRun],
    });
  } catch (error) {
    differentRunError = error;
  }

  expect(String(differentRunError)).toContain("different runs");

  const differentPlatform = {
    ...hitArtifact,
    platform: process.platform === "win32" ? "linux" : "win32",
  };
  let differentPlatformError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seedArtifact],
      fragments: [differentPlatform],
    });
  } catch (error) {
    differentPlatformError = error;
  }

  expect(String(differentPlatformError)).toContain("platform mismatch");

  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
  ] as const) {
    const malformedCounter = structuredClone(hitArtifact);
    malformedCounter.coverage[usedPath!]!.s[Object.keys(used.s)[0]!] = value as number;
    let malformedCounterError: unknown;

    try {
      await mergeCoverageArtifacts({
        repoPath: root,
        expectedSources: sourcePaths,
        seeds: [seedArtifact],
        fragments: [malformedCounter],
      });
    } catch (error) {
      malformedCounterError = error;
    }

    expect(String(malformedCounterError)).toContain("invalid statement");
  }

  const hitStatement = Object.keys(used.s).find((key) => used.s[key]! > 0)!;

  expect(hitArtifact.coverage[usedPath!]!.s[hitStatement]).toBeGreaterThan(0);

  const oversizedHitArtifact = structuredClone(hitArtifact);
  oversizedHitArtifact.coverage[usedPath!]!.s[hitStatement] = Number.MAX_SAFE_INTEGER;
  let mergedCounterError: unknown;

  try {
    await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: sourcePaths,
      seeds: [seedArtifact],
      fragments: [oversizedHitArtifact, hitArtifact],
    });
  } catch (error) {
    mergedCounterError = error;
  }

  expect(String(mergedCounterError)).toContain(
    "Merged statement coverage counter exceeds the safe integer range",
  );
});

test("Bun test host instruments eligible imports without instrumenting the test module", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-coverage-test-host-"));

  roots.push(root);

  const source = "packages/sample/src/subject.ts";
  const sourcePath = resolve(root, source);
  const preloadPath = join(root, "coverage-preload.ts");
  const testPath = join(root, "tests", "uninstrumented.fixture.test.ts");

  await mkdir(dirname(sourcePath), { recursive: true });

  await mkdir(dirname(testPath), { recursive: true });

  await writeFile(sourcePath, "export function answer() { return 42; }\n");

  const collectorPath = resolve(import.meta.dir, "../../scripts/ci/coverage-collector.ts");

  await writeFile(
    preloadPath,
    [
      'import { pathToFileURL } from "node:url";',
      `const collector = await import(pathToFileURL(${JSON.stringify(collectorPath)}).href);`,
      `const root = ${JSON.stringify(root)};`,
      `const sources = ${JSON.stringify([source])};`,
      "const seeded = await collector.seedCoverageSources(sources, root);",
      "collector.installCoverageInstrumentation({ repoPath: root, eligibleSources: sources, preparedSources: seeded.prepared });",
    ].join("\n"),
  );

  await writeFile(
    testPath,
    [
      'import { expect, test } from "bun:test";',
      'import { pathToFileURL } from "node:url";',
      `const subjectPath = ${JSON.stringify(sourcePath)};`,
      `const testPath = ${JSON.stringify(testPath)};`,
      "test('the eligible import executes with its original behavior and records hits', async () => {",
      "  const subject = await import(pathToFileURL(subjectPath).href);",
      "  expect(subject.answer()).toBe(42);",
      `  const processCoverage = Reflect.get(globalThis, ${JSON.stringify(coverageVariable)});`,
      "  const coverage = processCoverage?.[subjectPath];",
      "  expect(processCoverage?.[testPath]).toBeUndefined();",
      "  expect(coverage).toBeDefined();",
      "  expect(Object.values(coverage.s).some((count) => count > 0)).toBe(true);",
      "  process.stdout.write('coverage test host ok\\n');",
      "});",
      "",
    ].join("\n"),
  );

  const child = Bun.spawn(
    [process.execPath, "test", "--preload", preloadPath, "--timeout=15000", testPath],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = stdout + stderr;

  expect(status, output).toBe(0);

  expect(output).toContain("1 pass");

  expect(output).toContain("coverage test host ok");
});
