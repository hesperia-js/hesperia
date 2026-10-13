import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { plugin } from "bun";
import { coverageSourceFiles } from "./coverage-inventory.ts";

const require = createRequire(import.meta.url);
const { createInstrumenter } = require("istanbul-lib-instrument") as {
  createInstrumenter(options: Record<string, unknown>): Instrumenter;
};
const { createCoverageMap } = require("istanbul-lib-coverage") as {
  createCoverageMap(data?: Record<string, CoverageFile>): CoverageMap;
};
const { createContext } = require("istanbul-lib-report") as {
  createContext(options: {
    coverageMap: CoverageMap;
    dir: string;
    defaultSummarizer: "flat";
  }): object;
};
const { create: createReporter } = require("istanbul-reports") as {
  create(
    name: "lcovonly",
    options: { file: string; projectRoot?: string },
  ): {
    execute(context: object): void;
  };
};

export const coverageVariable = "__hesperiaCoverage__";

export interface SourceMapData {
  readonly version: number;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly sourceRoot?: string;
  readonly names?: readonly string[];
  readonly mappings: string;
  readonly [key: string]: unknown;
}

export interface CoveragePopulationFile {
  readonly source: string;
  readonly sourceSha256: string;
  readonly canonicalUnitsSha256: string;
}

export interface CoveragePopulation {
  readonly schema: 1;
  readonly fingerprint: string;
  readonly files: readonly CoveragePopulationFile[];
}

export interface CoverageOwnerFile {
  readonly sources: readonly string[];
  readonly sourceMapSha256: string;
  readonly instrumentedSourceSha256: string;
  readonly unitLayoutSha256: string;
}

export interface CoverageArtifact {
  readonly format: "hesperia-coverage";
  readonly version: 2;
  readonly kind: "seed" | "hits";
  readonly runId: string;
  readonly ownerId: string;
  readonly platform: string;
  readonly populationFingerprint: string;
  readonly population?: CoveragePopulation;
  readonly ownerFiles: readonly CoverageOwnerFile[];
  readonly coverage: Record<string, CoverageFile>;
}

export interface CoverageRunArtifacts {
  readonly family:
    | "bun-tests-ordinary"
    | "project-worker-owner"
    | "browser-css"
    | "native-editor"
    | "final-aggregate";
  readonly runId: string;
  readonly platform: string;
  readonly seeds: readonly CoverageArtifact[];
  readonly fragments: readonly CoverageArtifact[];
}

export type CoveragePlatform = "win32" | "linux";

export type CoverageFamilyId = Exclude<CoverageRunArtifacts["family"], "final-aggregate">;

export interface PlatformCoverageFamilyRun {
  readonly family: CoverageFamilyId;
  readonly runId: string;
  readonly platform: CoveragePlatform;
  readonly workerEvidence?: {
    readonly invocations: number;
    readonly path: string;
    readonly sha256: string;
  };
  readonly nativeEvidence?: {
    readonly summaryPath: string;
    readonly summarySha256: string;
    readonly observationPath: string;
    readonly observationSha256: string;
    readonly summary: Record<string, unknown>;
  };
}

export interface PlatformCoverageCapture {
  readonly format: "hesperia-platform-coverage-capture";
  readonly version: 1;
  readonly status: "completed";
  readonly acceptance: "deferred-combined";
  readonly platform: CoveragePlatform;
  readonly runId: string;
  readonly population: CoveragePopulation;
  readonly runs: readonly PlatformCoverageFamilyRun[];
  readonly coverage: Record<string, CoverageFile>;
}

export interface MergedCoverageRuns {
  readonly coverage: CoverageMap;
  readonly population: CoveragePopulation;
  readonly platform: string;
}

export interface CoverageLocation {
  readonly start: { readonly line: number; readonly column: number };
  readonly end?: { readonly line: number; readonly column: number } | null;
}

export interface CoverageFile {
  path: string;
  statementMap: Record<string, CoverageLocation>;
  fnMap: Record<
    string,
    { name: string; decl: CoverageLocation; loc: CoverageLocation; [key: string]: unknown }
  >;
  branchMap: Record<
    string,
    {
      type: string;
      loc: CoverageLocation;
      locations: CoverageLocation[];
      [key: string]: unknown;
    }
  >;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  inputSourceMap?: SourceMapData;
  hash?: string;
  __hesperiaInstrumentedSourceSha256?: string;
  [key: string]: unknown;
}

export interface PreparedCoverageSource {
  readonly path: string;
  readonly relativePath: string;
  readonly instrumentedCode: string;
  readonly loader: "ts" | "tsx";
  readonly bootstrapHash?: string;
  readonly seed: CoverageFile;
  readonly sourceMap: SourceMapData;
  readonly ownerFile: CoverageOwnerFile;
}

export interface CoverageInstrumentation {
  readonly prepared: ReadonlyMap<string, PreparedCoverageSource>;
  readonly seeds: ReadonlyMap<string, CoverageFile>;
}

export interface SeededCoverageSources {
  readonly prepared: readonly PreparedCoverageSource[];
  readonly coverage: Record<string, CoverageFile>;
  readonly ownerFiles: readonly CoverageOwnerFile[];
  readonly population: CoveragePopulation;
}

export interface CoverageMap {
  files(): string[];

  fileCoverageFor(path: string): { toJSON(): CoverageFile };

  toJSON(): Record<string, CoverageFile>;

  merge(data: Record<string, CoverageFile>): void;
}

interface Instrumenter {
  instrumentSync(code: string, filename: string): string;

  lastFileCoverage(): CoverageFile;

  lastSourceMap(): SourceMapData | null;
}

function canonicalKey(path: string, repoPath: string): string | undefined {
  const nativePath = path.replace(/[\\/]/gu, sep);
  const absolutePath = resolve(repoPath, nativePath);
  const relativePath = relative(repoPath, absolutePath);

  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`))
    return undefined;

  const normalized = relativePath.split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStrings(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
}

function sha256(value: string | Uint8Array): string {
  const hash = createHash("sha256");

  if (typeof value === "string") hash.update(value, "utf8");
  else hash.update(value);

  return hash.digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function coverageUnitLayout(coverage: CoverageFile): unknown {
  return {
    statements: coverage.statementMap,
    functions: coverage.fnMap,
    branches: coverage.branchMap,
  };
}

function unitLayoutSha256(coverage: CoverageFile): string {
  return sha256(stableJson(coverageUnitLayout(coverage)));
}

function sourceMapSha256(sourceMap: SourceMapData, sources: readonly string[]): string {
  return sha256(
    stableJson({
      version: sourceMap.version,
      sources,
      names: sourceMap.names ?? [],
      mappings: sourceMap.mappings,
      sourceRoot: "",
    }),
  );
}

function populationSha256(files: readonly CoveragePopulationFile[]): string {
  return sha256(stableJson({ schema: 1, files }));
}

function coverageSourceKey(coverage: CoverageFile, repoPath: string): string {
  const root = resolve(repoPath);

  if (typeof coverage.path !== "string" || coverage.path.length === 0) {
    throw new Error("Coverage record has no raw output path");
  }

  const outputPath = resolve(root, coverage.path);

  if (canonicalKey(outputPath, root) === undefined) {
    throw new Error(`Coverage record is outside the repository: ${coverage.path}`);
  }

  const sourceMap = coverage.inputSourceMap;

  if (!sourceMap || !Array.isArray(sourceMap.sources) || sourceMap.sources.length !== 1) {
    throw new Error(`Coverage record must map to exactly one TypeScript source: ${coverage.path}`);
  }

  if (
    sourceMap.version !== 3 ||
    typeof sourceMap.sources[0] !== "string" ||
    typeof sourceMap.mappings !== "string" ||
    (sourceMap.sourceRoot !== undefined && typeof sourceMap.sourceRoot !== "string") ||
    (sourceMap.names !== undefined &&
      (!Array.isArray(sourceMap.names) || sourceMap.names.some((name) => typeof name !== "string")))
  ) {
    throw new Error(`Coverage record has a malformed source map: ${coverage.path}`);
  }

  const mappedPath = absoluteSourcePath(
    sourceMap.sources[0],
    dirname(outputPath),
    typeof sourceMap.sourceRoot === "string" ? sourceMap.sourceRoot : "",
  );
  const key = canonicalKey(mappedPath, root);

  if (key === undefined) {
    throw new Error(`Coverage source map points outside the repository: ${coverage.path}`);
  }

  return key;
}

function validateCoverageCounters(coverage: CoverageFile, label: string): void {
  const counterMap = (value: unknown, name: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} has malformed ${name} coverage counters`);
    }

    return value as Record<string, unknown>;
  };

  const validateKeys = (
    actual: Record<string, unknown>,
    expected: readonly string[],
    name: string,
  ) => {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = [...expected].sort();

    if (stableJson(actualKeys) !== stableJson(expectedKeys)) {
      throw new Error(`${label} has mismatched ${name} coverage counters`);
    }
  };

  const validateCount = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} has invalid ${name} coverage counter`);
    }
  };

  if (
    coverage.statementMap === null ||
    typeof coverage.statementMap !== "object" ||
    Array.isArray(coverage.statementMap) ||
    coverage.fnMap === null ||
    typeof coverage.fnMap !== "object" ||
    Array.isArray(coverage.fnMap) ||
    coverage.branchMap === null ||
    typeof coverage.branchMap !== "object" ||
    Array.isArray(coverage.branchMap)
  ) {
    throw new Error(`${label} has malformed coverage maps`);
  }

  const statements = counterMap(coverage.s, "statement");
  const functions = counterMap(coverage.f, "function");
  const branches = counterMap(coverage.b, "branch");

  validateKeys(statements, Object.keys(coverage.statementMap), "statement");

  validateKeys(functions, Object.keys(coverage.fnMap), "function");

  validateKeys(branches, Object.keys(coverage.branchMap), "branch");

  for (const [key, value] of Object.entries(statements)) validateCount(value, `statement ${key}`);

  for (const [key, value] of Object.entries(functions)) validateCount(value, `function ${key}`);

  for (const [key, value] of Object.entries(branches)) {
    const locations = coverage.branchMap[key]?.locations;

    if (!Array.isArray(value) || !Array.isArray(locations) || value.length !== locations.length) {
      throw new Error(`${label} has mismatched branch arms for ${key}`);
    }

    for (const [index, count] of value.entries()) validateCount(count, `branch ${key}/${index}`);
  }
}

function validateEmbeddedSource(
  coverage: CoverageFile,
  authoredSource: string,
  label: string,
): void {
  const sourceMap = coverage.inputSourceMap;

  if (!sourceMap) throw new Error(`${label} has no source map`);

  if (
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sourcesContent.length !== 1 ||
    typeof sourceMap.sourcesContent[0] !== "string"
  ) {
    throw new Error(`${label} has malformed source contents`);
  }

  const embedded = sourceMap.sourcesContent[0];

  if (embedded !== authoredSource) {
    throw new Error(`${label} source contents do not match the authored source`);
  }
}

function ownerFileFromCoverage(coverage: CoverageFile, repoPath: string): CoverageOwnerFile {
  validateCoverageCounters(coverage, coverage.path);

  const source = coverageSourceKey(coverage, repoPath);
  const sourceMap = coverage.inputSourceMap!;
  const instrumentedSourceSha256 = coverage.__hesperiaInstrumentedSourceSha256;

  if (
    typeof instrumentedSourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(instrumentedSourceSha256)
  ) {
    throw new Error(`Coverage record has no instrumented-source identity: ${coverage.path}`);
  }

  return {
    sources: [source],
    sourceMapSha256: sourceMapSha256(sourceMap, [source]),
    instrumentedSourceSha256,
    unitLayoutSha256: unitLayoutSha256(coverage),
  };
}

function preparedSourceFilter(paths: readonly string[]): RegExp {
  const escaped = paths.map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`^(?:${escaped.join("|")})$`, process.platform === "win32" ? "iu" : "u");
}

function absoluteSourcePath(source: string, repoPath: string, sourceRoot = ""): string {
  return resolve(repoPath, sourceRoot, source);
}

function hasUnits(coverage: CoverageFile): boolean {
  return (
    Object.keys(coverage.statementMap).length > 0 ||
    Object.keys(coverage.fnMap).length > 0 ||
    Object.keys(coverage.branchMap).length > 0
  );
}

function typecheckCoverageBootstrap(
  source: string,
  relativePath: string,
  expectedPath: string,
): { readonly source: string; readonly bootstrapHash: string } {
  const prefix = /^(?:#![^\r\n]*\r?\n)?/u.exec(source)?.[0] ?? "";
  const declaration = /^function (cov_[\w$]+)\(\)\{/u.exec(source.slice(prefix.length));

  if (!declaration) {
    throw new Error(`Istanbul emitted no recognizable coverage bootstrap for ${relativePath}`);
  }

  const coverageFunction = declaration[1]!;
  const functionDeclaration = `function ${coverageFunction}(){`;
  const actualCoverageBlock = "var actualCoverage=coverage[path];{";
  const blockIndex = source.indexOf(actualCoverageBlock, prefix.length);
  const blockStart = blockIndex + actualCoverageBlock.length;
  const suppressionStart = source.indexOf("// @ts-ignore", blockStart);
  const assignment = `${coverageFunction}=function(){return actualCoverage;};`;
  const assignmentStart = source.indexOf(assignment, suppressionStart + "// @ts-ignore".length);
  const bootstrapTail = `return actualCoverage;}${coverageFunction}();`;
  const tailStart = source.indexOf(bootstrapTail, assignmentStart + assignment.length);
  const bootstrapEnd = tailStart + bootstrapTail.length;
  const extraBlock = source.indexOf(actualCoverageBlock, blockIndex + actualCoverageBlock.length);
  const extraSuppression = source.indexOf(
    "// @ts-ignore",
    suppressionStart + "// @ts-ignore".length,
  );
  const extraAssignment = source.indexOf(assignment, assignmentStart + assignment.length);
  const extraTail = source.indexOf(bootstrapTail, tailStart + bootstrapTail.length);
  const beforeSuppression = source.slice(blockStart, suppressionStart);
  const afterSuppression = source.slice(suppressionStart + "// @ts-ignore".length, assignmentStart);

  if (
    blockIndex < prefix.length ||
    suppressionStart < blockStart ||
    assignmentStart < suppressionStart ||
    tailStart < assignmentStart ||
    !/^\s*$/u.test(beforeSuppression) ||
    !/^\r?\n/u.test(afterSuppression) ||
    (extraBlock >= 0 && extraBlock < bootstrapEnd) ||
    (extraSuppression >= 0 && extraSuppression < bootstrapEnd) ||
    (extraAssignment >= 0 && extraAssignment < bootstrapEnd) ||
    (extraTail >= 0 && extraTail < bootstrapEnd)
  ) {
    throw new Error(`Istanbul emitted an unexpected bootstrap suppression for ${relativePath}`);
  }

  const bootstrapHeader = source.slice(prefix.length, blockIndex);
  const pathDeclarations = [
    ...bootstrapHeader.matchAll(/\bvar\s+path\s*=\s*("(?:\\.|[^"\\])*")\s*;/gu),
  ];
  const hashDeclarations = [...bootstrapHeader.matchAll(/\bvar\s+hash\s*=\s*("[^"\\]*")\s*;/gu)];
  const hashRetentionBranches = [
    ...bootstrapHeader.matchAll(
      /if\s*\(\s*!\s*coverage\s*\[\s*path\s*\]\s*\|\|\s*coverage\s*\[\s*path\s*\]\s*\.\s*hash\s*!==\s*hash\s*\)\s*\{\s*coverage\s*\[\s*path\s*\]\s*=\s*coverageData\s*;\s*\}/gu,
    ),
  ];

  if (
    pathDeclarations.length !== 1 ||
    hashDeclarations.length !== 1 ||
    hashRetentionBranches.length !== 1
  ) {
    throw new Error(
      `Istanbul emitted an ambiguous coverage identity bootstrap for ${relativePath}`,
    );
  }

  let bootstrapPath: unknown;
  let bootstrapHash: unknown;

  try {
    bootstrapPath = JSON.parse(pathDeclarations[0]![1]!);
    bootstrapHash = JSON.parse(hashDeclarations[0]![1]!);
  } catch {
    throw new Error(`Istanbul emitted malformed coverage identity literals for ${relativePath}`);
  }

  if (
    bootstrapPath !== expectedPath ||
    typeof bootstrapHash !== "string" ||
    !/^[a-f0-9]{40}$/u.test(bootstrapHash)
  ) {
    throw new Error(`Istanbul changed the coverage identity for ${relativePath}`);
  }

  if (!source.startsWith(`${prefix}${functionDeclaration}`)) {
    throw new Error(`Istanbul coverage bootstrap changed unexpectedly for ${relativePath}`);
  }

  const typedDeclaration = `var ${coverageFunction}=  ()=>{`;
  const typedTail = `return actualCoverage};${coverageFunction}();`;

  if (
    typedDeclaration.length !== functionDeclaration.length ||
    typedTail.length !== bootstrapTail.length
  ) {
    throw new Error(`Istanbul typed bootstrap changed generated positions for ${relativePath}`);
  }

  const result =
    source.slice(0, prefix.length) +
    typedDeclaration +
    source.slice(prefix.length + functionDeclaration.length, suppressionStart) +
    " ".repeat("// @ts-ignore".length) +
    source.slice(suppressionStart + "// @ts-ignore".length, tailStart) +
    typedTail +
    source.slice(bootstrapEnd);
  return { source: result, bootstrapHash };
}

function normalizeInstrumentedSourceMap(
  sourceMap: SourceMapData,
  sourcePath: string,
  repoPath: string,
  authoredSource: string,
): SourceMapData {
  if (sourceMap.version !== 3 || sourceMap.sources.length !== 1) {
    throw new Error(`Istanbul map for ${sourcePath} does not identify exactly one source`);
  }

  const mappedPath = absoluteSourcePath(
    sourceMap.sources[0]!,
    dirname(sourcePath),
    sourceMap.sourceRoot ?? "",
  );
  const mappedKey = canonicalKey(mappedPath, repoPath);
  const expectedKey = canonicalKey(sourcePath, repoPath);

  if (mappedKey === undefined || mappedKey !== expectedKey) {
    throw new Error(
      `Istanbul map for ${sourcePath} does not preserve its authored source identity: ${sourceMap.sources[0]}`,
    );
  }

  const relativeSource = relative(dirname(sourcePath), sourcePath).split(sep).join("/");
  const contents = sourceMap.sourcesContent;

  if (
    !Array.isArray(contents) ||
    contents.length !== 1 ||
    typeof contents[0] !== "string" ||
    contents[0] !== authoredSource
  ) {
    throw new Error(`Istanbul map for ${sourcePath} does not contain the authored source`);
  }

  return {
    ...sourceMap,
    sources: [relativeSource],
    sourcesContent: [authoredSource],
    sourceRoot: "",
  };
}

export async function prepareCoverageSource(
  source: string,
  repoPath: string,
): Promise<PreparedCoverageSource> {
  const root = resolve(repoPath);
  const sourcePath = resolve(root, source);
  const relativePath = relative(root, sourcePath).split(sep).join("/");

  if (canonicalKey(sourcePath, root) === undefined)
    throw new Error(`Coverage source is outside the repository: ${source}`);

  const authoredSource = readFileSync(sourcePath, "utf8");
  const sourceKeyValue = canonicalKey(sourcePath, root);

  if (sourceKeyValue === undefined)
    throw new Error(`Coverage source is outside the repository: ${sourcePath}`);

  const isTsx = sourcePath.toLowerCase().endsWith(".tsx");
  const instrumenter = createInstrumenter({
    coverageVariable,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    preserveComments: true,
    produceSourceMap: true,
    parserPlugins: isTsx ? ["typescript", "jsx"] : ["typescript"],
  });
  let instrumentedSource = instrumenter.instrumentSync(authoredSource, sourcePath);
  const seed = instrumenter.lastFileCoverage();
  const rawSourceMap = instrumenter.lastSourceMap();
  const hasExecutableUnits = hasUnits(seed);

  if (Object.hasOwn(seed, "hash")) {
    throw new Error(`Istanbul returned its runtime hash in the canonical seed for ${relativePath}`);
  }

  let bootstrapHash: string | undefined;
  let sourceMap: SourceMapData;

  if (!hasExecutableUnits) {
    instrumentedSource = authoredSource;
    sourceMap = {
      version: 3,
      sources: [relative(dirname(sourcePath), sourcePath).split(sep).join("/")],
      sourcesContent: [authoredSource],
      sourceRoot: "",
      names: [],
      mappings: "",
    };
  } else {
    if (!rawSourceMap) throw new Error(`Istanbul emitted no source map for ${relativePath}`);

    sourceMap = normalizeInstrumentedSourceMap(rawSourceMap, sourcePath, root, authoredSource);
    const bootstrap = typecheckCoverageBootstrap(instrumentedSource, relativePath, sourcePath);
    instrumentedSource = bootstrap.source;
    bootstrapHash = bootstrap.bootstrapHash;
    const typedBootstrap = instrumentedSource.replace(
      "var global=globalThis;",
      "var global=globalThis as any;",
    );

    if (typedBootstrap === instrumentedSource) {
      throw new Error(`Istanbul generated no typed coverage bootstrap for ${relativePath}`);
    }

    instrumentedSource = typedBootstrap;
  }

  const instrumentedSourceIdentity = sha256(instrumentedSource);
  const instrumentedCode = hasExecutableUnits
    ? `${instrumentedSource}\n;(globalThis as any)[${JSON.stringify(coverageVariable)}][${JSON.stringify(sourcePath)}].inputSourceMap=${JSON.stringify(sourceMap)};` +
      `(globalThis as any)[${JSON.stringify(coverageVariable)}][${JSON.stringify(sourcePath)}].__hesperiaInstrumentedSourceSha256=${JSON.stringify(instrumentedSourceIdentity)};\n`
    : instrumentedSource;
  seed.inputSourceMap = sourceMap;
  seed.__hesperiaInstrumentedSourceSha256 = instrumentedSourceIdentity;

  if (resolve(seed.path) !== sourcePath) {
    throw new Error(`Istanbul changed the coverage path for ${relativePath}: ${seed.path}`);
  }

  const ownerFile: CoverageOwnerFile = {
    sources: [sourceKeyValue],
    sourceMapSha256: sourceMapSha256(sourceMap, [sourceKeyValue]),
    instrumentedSourceSha256: instrumentedSourceIdentity,
    unitLayoutSha256: unitLayoutSha256(seed),
  };
  return {
    path: sourcePath,
    relativePath,
    instrumentedCode,
    loader: isTsx ? "tsx" : "ts",
    ...(bootstrapHash === undefined ? {} : { bootstrapHash }),
    seed,
    sourceMap,
    ownerFile,
  };
}

function canonicalCoverageFile(coverage: CoverageFile, repoPath: string): CoverageFile {
  const root = resolve(repoPath);

  validateCoverageCounters(coverage, coverage.path);

  const sourceKey = coverageSourceKey(coverage, root);
  const expectedPath = resolve(root, sourceKey.replaceAll("/", sep));
  const authoredSource = readFileSync(expectedPath, "utf8");

  validateEmbeddedSource(coverage, authoredSource, sourceKey);

  return { ...coverage, path: expectedPath };
}

function hasHits(coverage: CoverageFile): boolean {
  return (
    Object.values(coverage.s).some((count) => count > 0) ||
    Object.values(coverage.f).some((count) => count > 0) ||
    Object.values(coverage.b).some((counts) => counts.some((count) => count > 0))
  );
}

function seedIdentity(coverage: CoverageFile): string {
  return stableJson({
    path: coverage.path,
    statementMap: coverage.statementMap,
    fnMap: coverage.fnMap,
    branchMap: coverage.branchMap,
    s: coverage.s,
    f: coverage.f,
    b: coverage.b,
  });
}

function addCoverageCounter(current: number, added: number, name: string, path: string): number {
  const total = current + added;

  if (!Number.isSafeInteger(total)) {
    throw new Error(`Merged ${name} coverage counter exceeds the safe integer range for ${path}`);
  }

  return total;
}

/** Merge a fragment only when its authored TypeScript unit maps exactly match the seed. */
function mergeCoverageFragment(
  seed: CoverageFile,
  fragment: CoverageFile,
  path: string,
): CoverageFile {
  validateCoverageCounters(seed, path);

  validateCoverageCounters(fragment, path);

  if (
    stableJson(seed.statementMap) !== stableJson(fragment.statementMap) ||
    stableJson(seed.fnMap) !== stableJson(fragment.fnMap) ||
    stableJson(seed.branchMap) !== stableJson(fragment.branchMap)
  ) {
    throw new Error(`Coverage fragment unit maps do not match canonical seed for ${path}`);
  }

  const merged: CoverageFile = {
    ...seed,
    path,
    statementMap: { ...seed.statementMap },
    fnMap: { ...seed.fnMap },
    branchMap: Object.fromEntries(
      Object.entries(seed.branchMap).map(([key, value]) => [
        key,
        { ...value, locations: [...value.locations] },
      ]),
    ),
    s: { ...seed.s },
    f: { ...seed.f },
    b: Object.fromEntries(Object.entries(seed.b).map(([key, hits]) => [key, [...hits]])),
  };

  for (const key of Object.keys(seed.s)) {
    merged.s[key] = addCoverageCounter(seed.s[key]!, fragment.s[key]!, "statement", path);
  }

  for (const key of Object.keys(seed.f)) {
    merged.f[key] = addCoverageCounter(seed.f[key]!, fragment.f[key]!, "function", path);
  }

  for (const [key, seedHits] of Object.entries(seed.b)) {
    merged.b[key] = seedHits.map((count, index) =>
      addCoverageCounter(count, fragment.b[key]![index]!, `branch ${key}/${index}`, path),
    );
  }

  return merged;
}

export async function seedCoverageSources(
  sources: readonly string[],
  repoPath: string,
): Promise<SeededCoverageSources> {
  const prepared: PreparedCoverageSource[] = [];
  const errors: unknown[] = [];
  let nextIndex = 0;

  const prepareNext = async () => {
    while (true) {
      const index = nextIndex++;

      if (index >= sources.length) return;

      try {
        prepared[index] = await prepareCoverageSource(sources[index]!, repoPath);
      } catch (error) {
        errors[index] = error;
      }
    }
  };

  const workerCount = Math.min(4, sources.length);

  await Promise.all(Array.from({ length: workerCount }, () => prepareNext()));

  const firstError = errors.find((error) => error !== undefined);

  if (firstError !== undefined) throw firstError;

  const coverage: Record<string, CoverageFile> = {};
  const populationFiles: CoveragePopulationFile[] = [];

  for (const item of prepared) {
    if (coverage[item.path])
      throw new Error(`Duplicate coverage seed source: ${item.relativePath}`);

    coverage[item.path] = item.seed;
    const source = item.ownerFile.sources[0]!;
    const authored = readFileSync(item.path, "utf8");

    validateEmbeddedSource(item.seed, authored, item.path);

    populationFiles.push({
      source,
      sourceSha256: sha256(authored),
      canonicalUnitsSha256: unitLayoutSha256(item.seed),
    });
  }

  populationFiles.sort((left, right) => compareStrings(left.source, right.source));

  const population: CoveragePopulation = {
    schema: 1,
    fingerprint: populationSha256(populationFiles),
    files: populationFiles,
  };
  return { prepared, coverage, ownerFiles: prepared.map((item) => item.ownerFile), population };
}

export function installCoverageInstrumentation(options: {
  readonly repoPath: string;
  readonly eligibleSources: readonly string[];
  readonly preparedSources: readonly PreparedCoverageSource[];
}): CoverageInstrumentation {
  const root = resolve(options.repoPath);
  const eligible = new Map<string, string>();

  for (const source of options.eligibleSources) {
    const key = canonicalKey(source, root);

    if (key === undefined) throw new Error(`Coverage source is outside the repository: ${source}`);

    if (eligible.has(key)) throw new Error(`Duplicate coverage instrumentation source: ${source}`);

    eligible.set(key, source);
  }

  const prepared = new Map<string, PreparedCoverageSource>();
  const seeds = new Map<string, CoverageFile>();

  for (const item of options.preparedSources) {
    const key = canonicalKey(item.path, root);

    if (key === undefined || !eligible.has(key))
      throw new Error(`Coverage preparation contains an unexpected source: ${item.path}`);

    if (prepared.has(key))
      throw new Error(`Duplicate prepared coverage source: ${item.relativePath}`);

    prepared.set(key, item);

    seeds.set(item.path, item.seed);
  }

  const missingPrepared = [...eligible.keys()].filter((key) => !prepared.has(key));

  if (missingPrepared.length > 0) {
    throw new Error(`Coverage preparation omitted expected sources: ${missingPrepared.join(", ")}`);
  }

  if (prepared.size > 0) {
    const filter = preparedSourceFilter([...prepared.values()].map((item) => item.path));

    plugin({
      name: "hesperia-istanbul-direct-typescript",

      setup(build) {
        build.onLoad({ filter }, ({ path }) => {
          const key = canonicalKey(path, root);

          if (key === undefined || !eligible.has(key)) {
            throw new Error(
              `Coverage loader matched a path outside the eligible inventory: ${path}`,
            );
          }

          const item = prepared.get(key);

          if (!item) throw new Error(`Coverage source was not prepared before loading: ${path}`);

          return { contents: item.instrumentedCode, loader: item.loader };
        });
      },
    });
  }

  return { prepared, seeds };
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is not a SHA-256 identity`);
  }
}

function validatePopulation(population: CoveragePopulation): void {
  if (population.schema !== 1 || !Array.isArray(population.files)) {
    throw new Error("Coverage population has an unsupported schema");
  }

  const seen = new Set<string>();
  let previous = "";

  for (const file of population.files) {
    if (typeof file.source !== "string" || file.source.length === 0 || file.source.includes("\\")) {
      throw new Error("Coverage population has an invalid source path");
    }

    if (seen.has(file.source)) throw new Error(`Coverage population repeats ${file.source}`);

    if (previous && compareStrings(previous, file.source) > 0) {
      throw new Error("Coverage population sources are not in canonical order");
    }

    previous = file.source;

    seen.add(file.source);

    assertSha256(file.sourceSha256, `Coverage source hash for ${file.source}`);

    assertSha256(file.canonicalUnitsSha256, `Coverage unit layout for ${file.source}`);
  }

  assertSha256(population.fingerprint, "Coverage population fingerprint");

  if (populationSha256(population.files) !== population.fingerprint) {
    throw new Error("Coverage population fingerprint does not match its source records");
  }
}

function validateArtifactRecords(
  artifact: CoverageArtifact,
  repoPath: string,
): Map<string, CoverageFile> {
  if (
    artifact.format !== "hesperia-coverage" ||
    artifact.version !== 2 ||
    (artifact.kind !== "seed" && artifact.kind !== "hits")
  ) {
    throw new Error("Coverage artifact has an unsupported format or version");
  }

  if (typeof artifact.runId !== "string" || artifact.runId.length === 0) {
    throw new Error("Coverage artifact has no run identity");
  }

  if (typeof artifact.ownerId !== "string" || artifact.ownerId.length === 0) {
    throw new Error("Coverage artifact has no owner identity");
  }

  if (artifact.platform !== process.platform) {
    throw new Error(`Coverage artifact platform mismatch: ${artifact.platform}`);
  }

  assertSha256(artifact.populationFingerprint, "Coverage population fingerprint");

  if (artifact.kind === "hits" && artifact.population !== undefined) {
    throw new Error("Coverage hit artifact must reference, not repeat, the population");
  }

  if (artifact.population !== undefined) validatePopulation(artifact.population);

  if (
    artifact.coverage === null ||
    typeof artifact.coverage !== "object" ||
    Array.isArray(artifact.coverage) ||
    !Array.isArray(artifact.ownerFiles)
  ) {
    throw new Error("Coverage artifact payload is malformed");
  }

  const ownerFiles = new Map<string, CoverageOwnerFile>();

  for (const ownerFile of artifact.ownerFiles) {
    if (!Array.isArray(ownerFile.sources) || ownerFile.sources.length !== 1) {
      throw new Error(`Coverage owner ${artifact.ownerId} must identify one source per record`);
    }

    const source = ownerFile.sources[0];

    if (typeof source !== "string" || source.length === 0 || source.includes("\\")) {
      throw new Error(`Coverage owner ${artifact.ownerId} has an invalid source path`);
    }

    assertSha256(ownerFile.sourceMapSha256, `Coverage source map for ${source}`);

    assertSha256(ownerFile.instrumentedSourceSha256, `Coverage instrumented source for ${source}`);

    assertSha256(ownerFile.unitLayoutSha256, `Coverage owner unit layout for ${source}`);

    if (ownerFiles.has(source)) {
      throw new Error(`Coverage owner ${artifact.ownerId} repeats ${source}`);
    }

    ownerFiles.set(source, ownerFile);
  }

  const root = resolve(repoPath);
  const records = new Map<string, CoverageFile>();

  for (const [recordPath, coverage] of Object.entries(artifact.coverage)) {
    if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) {
      throw new Error(`Coverage artifact has a malformed record: ${recordPath}`);
    }

    if (recordPath !== coverage.path) {
      throw new Error(`Coverage artifact record key does not match its raw path: ${recordPath}`);
    }

    const source = coverageSourceKey(coverage, root);

    if (records.has(source)) {
      throw new Error(`Coverage artifact repeats authored source ${source}`);
    }

    const ownerFile = ownerFiles.get(source);

    if (!ownerFile) {
      throw new Error(`Coverage artifact has no owner transform metadata for ${source}`);
    }

    const currentOwnerFile = ownerFileFromCoverage(coverage, root);

    if (stableJson(currentOwnerFile) !== stableJson(ownerFile)) {
      throw new Error(`Coverage owner transform identity does not match ${source}`);
    }

    const authoredPath = resolve(root, source.replaceAll("/", sep));
    const authoredSource = readFileSync(authoredPath, "utf8");

    validateEmbeddedSource(coverage, authoredSource, source);

    if (artifact.kind === "seed" && hasHits(coverage)) {
      throw new Error(`Coverage seed contains executed hits for ${source}`);
    }

    records.set(source, coverage);
  }

  if (records.size !== ownerFiles.size) {
    throw new Error(`Coverage artifact ${artifact.ownerId} has unused owner transform metadata`);
  }

  if (artifact.kind === "seed" && records.size === 0) {
    throw new Error(`Coverage seed artifact ${artifact.ownerId} is empty`);
  }

  return records;
}

function validateArtifactPopulation(
  artifact: CoverageArtifact,
  records: ReadonlyMap<string, CoverageFile>,
  population: CoveragePopulation,
  expected: ReadonlyMap<string, string>,
): void {
  if (artifact.populationFingerprint !== population.fingerprint) {
    throw new Error(`Coverage artifact ${artifact.ownerId} refers to a different population`);
  }

  const populationBySource = new Map(population.files.map((file) => [file.source, file]));

  for (const [source, coverage] of records) {
    if (!expected.has(source)) throw new Error(`Unexpected coverage source: ${source}`);

    const populationFile = populationBySource.get(source);

    if (!populationFile) throw new Error(`Coverage population omitted ${source}`);

    const authoredPath = expected.get(source)!;
    const authoredSource = readFileSync(authoredPath, "utf8");

    if (sha256(authoredSource) !== populationFile.sourceSha256) {
      throw new Error(`Coverage source changed after capture: ${source}`);
    }

    validateEmbeddedSource(coverage, authoredSource, source);
  }

  if (artifact.population !== undefined) {
    if (stableJson(artifact.population) !== stableJson(population)) {
      throw new Error(`Coverage seed artifact ${artifact.ownerId} has a mismatched population`);
    }

    if (artifact.kind !== "seed" || records.size !== expected.size) {
      throw new Error(
        `Canonical coverage seed ${artifact.ownerId} does not cover the full inventory`,
      );
    }
  }
}

export function createCoverageArtifact(options: {
  readonly repoPath: string;
  readonly kind: "seed" | "hits";
  readonly runId: string;
  readonly ownerId: string;
  readonly populationFingerprint: string;
  readonly population?: CoveragePopulation;
  readonly sourcePopulation?: CoveragePopulation;
  readonly coverage: Record<string, CoverageFile>;
}): CoverageArtifact {
  if (options.population === undefined && options.sourcePopulation === undefined) {
    throw new Error("Coverage artifact creation requires a population manifest");
  }

  const root = resolve(options.repoPath);
  const ownerFiles = Object.values(options.coverage).map((coverage) =>
    ownerFileFromCoverage(coverage, root),
  );
  const artifact: CoverageArtifact = {
    format: "hesperia-coverage",
    version: 2,
    kind: options.kind,
    runId: options.runId,
    ownerId: options.ownerId,
    platform: process.platform,
    populationFingerprint: options.populationFingerprint,
    ...(options.population === undefined ? {} : { population: options.population }),
    ownerFiles,
    coverage: options.coverage,
  };
  const records = validateArtifactRecords(artifact, root);
  const population = options.population ?? options.sourcePopulation;

  if (population) {
    validatePopulation(population);

    const expected = new Map(
      population.files.map((file) => [
        file.source,
        resolve(root, file.source.replaceAll("/", sep)),
      ]),
    );

    validateArtifactPopulation(artifact, records, population, expected);
  }

  return artifact;
}

interface OwnerSeedRecord {
  readonly coverage: CoverageFile;
  readonly ownerFile: CoverageOwnerFile;
  readonly identity: string;
}

function ownerSeedIdentity(coverage: CoverageFile, ownerFile: CoverageOwnerFile): string {
  return stableJson({ ownerFile, unitLayoutSha256: unitLayoutSha256(coverage) });
}

export async function mergeCoverageArtifacts(options: {
  readonly repoPath: string;
  readonly expectedSources: readonly string[];
  readonly seeds: readonly CoverageArtifact[];
  readonly fragments: readonly CoverageArtifact[];
}): Promise<CoverageMap> {
  const root = resolve(options.repoPath);
  const expected = new Map<string, string>();

  for (const source of options.expectedSources) {
    const key = canonicalKey(source, root);

    if (key === undefined) {
      throw new Error(`Expected coverage source is outside the repository: ${source}`);
    }

    if (expected.has(key)) throw new Error(`Duplicate expected coverage source: ${source}`);

    expected.set(key, resolve(root, key.replaceAll("/", sep)));
  }

  const artifacts = [...options.seeds, ...options.fragments];

  if (artifacts.length === 0) throw new Error("Coverage merge has no artifacts");

  if (options.seeds.some((artifact) => artifact.kind !== "seed")) {
    throw new Error("Coverage seed input contains a non-seed artifact");
  }

  if (options.fragments.some((artifact) => artifact.kind !== "hits")) {
    throw new Error("Coverage fragment input contains a non-hit artifact");
  }

  const runId = artifacts[0]!.runId;
  const populationFingerprint = artifacts[0]!.populationFingerprint;
  const checked = new Map<CoverageArtifact, Map<string, CoverageFile>>();
  let canonicalPopulation: CoveragePopulation | undefined;

  for (const artifact of artifacts) {
    if (artifact.runId !== runId) throw new Error("Coverage artifacts come from different runs");

    if (artifact.populationFingerprint !== populationFingerprint) {
      throw new Error("Coverage artifacts refer to different populations");
    }

    const records = validateArtifactRecords(artifact, root);

    checked.set(artifact, records);

    if (artifact.population !== undefined) {
      if (
        canonicalPopulation &&
        stableJson(canonicalPopulation) !== stableJson(artifact.population)
      ) {
        throw new Error("Coverage seed artifacts contain conflicting populations");
      }

      canonicalPopulation = artifact.population;
    }
  }

  if (!canonicalPopulation) throw new Error("Coverage merge has no canonical population seed");

  if (canonicalPopulation.fingerprint !== populationFingerprint) {
    throw new Error("Coverage seed population does not match the artifact fingerprint");
  }

  const populationSources = new Set(canonicalPopulation.files.map((file) => file.source));

  if (
    populationSources.size !== expected.size ||
    [...expected.keys()].some((key) => !populationSources.has(key))
  ) {
    throw new Error("Coverage population does not match the expected source inventory");
  }

  const populationBySource = new Map(canonicalPopulation.files.map((file) => [file.source, file]));

  for (const [source, path] of expected) {
    const record = populationBySource.get(source);

    if (!record) throw new Error(`Coverage population omitted ${source}`);

    const authored = readFileSync(path, "utf8");

    if (sha256(authored) !== record.sourceSha256) {
      throw new Error(`Coverage source changed after capture: ${source}`);
    }
  }

  for (const artifact of artifacts) {
    validateArtifactPopulation(artifact, checked.get(artifact)!, canonicalPopulation, expected);
  }

  const ownerSeeds = new Map<string, Map<string, OwnerSeedRecord>>();
  const canonicalSeeds = new Map<string, CoverageFile>();

  for (const artifact of options.seeds) {
    const records = checked.get(artifact)!;
    const ownerFileBySource = new Map(
      artifact.ownerFiles.map((ownerFile) => [ownerFile.sources[0]!, ownerFile]),
    );
    const byOwner = ownerSeeds.get(artifact.ownerId) ?? new Map<string, OwnerSeedRecord>();

    for (const [source, coverage] of records) {
      if (!expected.has(source)) throw new Error(`Unexpected seeded coverage source: ${source}`);

      const ownerFile = ownerFileBySource.get(source)!;
      const identity = ownerSeedIdentity(coverage, ownerFile);
      const previous = byOwner.get(source);

      if (previous && previous.identity !== identity) {
        throw new Error(`Conflicting duplicate coverage seeds for ${source} (${artifact.ownerId})`);
      }

      if (!previous) byOwner.set(source, { coverage, ownerFile, identity });

      if (artifact.population !== undefined) {
        const canonical = canonicalCoverageFile(coverage, root);
        const populationRecord = populationBySource.get(source)!;

        if (unitLayoutSha256(canonical) !== populationRecord.canonicalUnitsSha256) {
          throw new Error(`Canonical seed layout does not match population for ${source}`);
        }

        const priorCanonical = canonicalSeeds.get(source);

        if (priorCanonical && seedIdentity(priorCanonical) !== seedIdentity(canonical)) {
          throw new Error(`Conflicting canonical coverage seeds for ${source}`);
        }

        if (!priorCanonical) canonicalSeeds.set(source, canonical);
      }
    }

    ownerSeeds.set(artifact.ownerId, byOwner);
  }

  const missingCanonicalSeeds = [...expected.keys()].filter(
    (source) => !canonicalSeeds.has(source),
  );

  if (missingCanonicalSeeds.length > 0) {
    throw new Error(
      `Canonical coverage seed is missing sources: ${missingCanonicalSeeds.join(", ")}`,
    );
  }

  const merged: Record<string, CoverageFile> = {};

  for (const [source, path] of expected) {
    const seed = canonicalSeeds.get(source);

    if (!seed) throw new Error(`Coverage output omitted expected source: ${source}`);

    merged[path] = { ...seed, path };
  }

  for (const artifact of options.fragments) {
    const records = checked.get(artifact)!;
    const ownerSeed = ownerSeeds.get(artifact.ownerId);

    if (!ownerSeed) throw new Error(`Coverage hit artifact has no seed owner: ${artifact.ownerId}`);

    const ownerFileBySource = new Map(
      artifact.ownerFiles.map((ownerFile) => [ownerFile.sources[0]!, ownerFile]),
    );

    for (const [source, coverage] of records) {
      const seedRecord = ownerSeed.get(source);

      if (!seedRecord) {
        throw new Error(
          `Coverage hit artifact has no matching owner seed for ${source} (${artifact.ownerId})`,
        );
      }

      const hitOwnerFile = ownerFileBySource.get(source)!;

      if (stableJson(hitOwnerFile) !== stableJson(seedRecord.ownerFile)) {
        throw new Error(`Coverage hit source map does not match its owner seed for ${source}`);
      }

      if (ownerSeedIdentity(coverage, hitOwnerFile) !== seedRecord.identity) {
        throw new Error(`Coverage hit transform does not match its owner seed for ${source}`);
      }

      const mapped = canonicalCoverageFile(coverage, root);
      const current = merged[expected.get(source)!];

      if (!current) throw new Error(`Coverage output omitted expected source: ${source}`);

      merged[expected.get(source)!] = mergeCoverageFragment(current, mapped, expected.get(source)!);
    }
  }

  return createCoverageMap(merged);
}

export async function mergeCoverageRuns(options: {
  readonly repoPath: string;
  readonly expectedSources: readonly string[];
  readonly runs: readonly CoverageRunArtifacts[];
  readonly capture: (input: {
    readonly population: CoveragePopulation;
    readonly coverage: CoverageMap;
  }) => Promise<CoverageRunArtifacts>;
}): Promise<MergedCoverageRuns> {
  const sourceFamilies = options.runs.map((run) => run.family).sort();

  if (
    options.runs.length !== 4 ||
    JSON.stringify(sourceFamilies) !==
      JSON.stringify(["browser-css", "bun-tests-ordinary", "native-editor", "project-worker-owner"])
  ) {
    throw new Error("Final coverage requires one original run from each required test owner");
  }

  const root = resolve(options.repoPath);
  const expected = options.expectedSources.map((source) => canonicalKey(source, root));

  if (expected.some((source) => source === undefined)) {
    throw new Error("Coverage aggregate source inventory contains an outside path");
  }

  const expectedSources = new Set(expected as string[]);

  if (expectedSources.size !== options.expectedSources.length) {
    throw new Error("Coverage aggregate source inventory contains duplicates");
  }

  const runIds = new Set<string>();
  const admitted: {
    readonly input: CoverageRunArtifacts;
    readonly coverage: CoverageMap;
    readonly population: CoveragePopulation;
  }[] = [];
  let canonicalPopulation: CoveragePopulation | undefined;
  let platform: string | undefined;

  const admit = async (input: CoverageRunArtifacts): Promise<void> => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.runId)) {
      throw new Error("Coverage aggregate contains an invalid original run identity");
    }

    if (runIds.has(input.runId)) {
      throw new Error(`Coverage aggregate contains a duplicate original run: ${input.runId}`);
    }

    if (
      admitted.some((entry) => entry.input.family === input.family) ||
      (input.family === "final-aggregate") !== admitted.length >= 4
    ) {
      throw new Error(
        `Coverage aggregate contains a duplicate or unexpected family: ${input.family}`,
      );
    }

    if (typeof input.platform !== "string" || input.platform !== process.platform) {
      throw new Error(`Coverage aggregate run platform mismatch: ${input.runId}`);
    }

    const artifacts = [...input.seeds, ...input.fragments];

    if (artifacts.length === 0) {
      throw new Error(`Coverage aggregate run has no artifacts: ${input.runId}`);
    }

    for (const artifact of artifacts) {
      if (artifact.runId !== input.runId) {
        throw new Error(
          `Coverage artifact does not retain its original run identity: ${input.runId}`,
        );
      }

      if (artifact.platform !== input.platform) {
        throw new Error(`Coverage artifact platform mismatch in original run ${input.runId}`);
      }
    }

    const coverage = await mergeCoverageArtifacts({
      repoPath: root,
      expectedSources: options.expectedSources,
      seeds: input.seeds,
      fragments: input.fragments,
    });
    const populationArtifacts = artifacts.filter((artifact) => artifact.population !== undefined);
    const population = populationArtifacts[0]?.population;

    if (!population)
      throw new Error(`Coverage aggregate run has no full population: ${input.runId}`);

    if (
      populationArtifacts.some(
        (artifact) => stableJson(artifact.population) !== stableJson(population),
      )
    ) {
      throw new Error(`Coverage aggregate run has conflicting source populations: ${input.runId}`);
    }

    if (canonicalPopulation && stableJson(population) !== stableJson(canonicalPopulation)) {
      throw new Error(
        `Coverage aggregate source populations differ at original run ${input.runId}`,
      );
    }

    if (platform !== undefined && platform !== input.platform) {
      throw new Error("Coverage aggregate cannot combine runs from different platforms");
    }

    const files = coverage.files().map((path) => canonicalKey(path, root));

    if (
      files.some((source) => source === undefined) ||
      files.length !== expectedSources.size ||
      new Set(files as string[]).size !== files.length ||
      [...expectedSources].some((source) => !files.includes(source))
    ) {
      throw new Error(
        `Coverage aggregate run does not contain the complete source inventory: ${input.runId}`,
      );
    }

    for (const path of coverage.files()) {
      const record = coverage.fileCoverageFor(path).toJSON();
      const populationFile = population.files.find(
        (file) => file.source === canonicalKey(path, root),
      );

      if (!populationFile || unitLayoutSha256(record) !== populationFile.canonicalUnitsSha256) {
        throw new Error(`Coverage aggregate source-unit map differs from its population: ${path}`);
      }
    }

    canonicalPopulation ??= population;
    platform ??= input.platform;

    runIds.add(input.runId);

    admitted.push({ input, coverage, population });
  };

  for (const run of options.runs) await admit(run);

  const first = admitted[0];

  if (!first) throw new Error("Coverage aggregate admitted no source runs");

  const preSupportRecords = first.coverage.toJSON();

  for (const item of admitted.slice(1)) {
    for (const [path, fragment] of Object.entries(item.coverage.toJSON())) {
      const seed = preSupportRecords[path];

      if (!seed) throw new Error(`Coverage aggregate omitted source ${path}`);

      preSupportRecords[path] = mergeCoverageFragment(seed, fragment, path);
    }
  }

  const preSupportCoverage = createCoverageMap(preSupportRecords);
  const capturedRun = await options.capture({
    population: canonicalPopulation!,
    coverage: preSupportCoverage,
  });

  if (capturedRun.family !== "final-aggregate") {
    throw new Error("Final coverage capture did not retain its aggregate owner identity");
  }

  await admit(capturedRun);

  const mergedRecords = preSupportCoverage.toJSON();

  for (const [path, fragment] of Object.entries(admitted[admitted.length - 1]!.coverage.toJSON())) {
    const seed = mergedRecords[path];

    if (!seed) throw new Error(`Final coverage omitted aggregate source ${path}`);

    mergedRecords[path] = mergeCoverageFragment(seed, fragment, path);
  }

  const merged = createCoverageMap(mergedRecords);
  const coveragePaths = merged.files();

  if (coveragePaths.length !== expectedSources.size) {
    throw new Error("Final coverage numeric join changed the complete source inventory");
  }

  for (const path of coveragePaths) {
    if (!expectedSources.has(canonicalKey(path, root)!)) {
      throw new Error(`Final coverage numeric join introduced an unexpected source: ${path}`);
    }
  }

  return {
    coverage: merged,
    population: canonicalPopulation!,
    platform: platform!,
  };
}

const coverageRunIdentity = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const requiredCoverageFamilies: readonly CoverageFamilyId[] = [
  "bun-tests-ordinary",
  "project-worker-owner",
  "browser-css",
  "native-editor",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function coverageProvenancePath(path: string, repoPath: string): string {
  const root = resolve(repoPath);
  const relativePath = relative(root, resolve(path)).split(sep).join("/");

  if (!relativePath.startsWith(".hesperia/") || relativePath.includes("\\")) {
    throw new Error(`Coverage provenance path is outside .hesperia: ${path}`);
  }

  return relativePath;
}

function validatePortableFamilyRuns(
  runs: readonly PlatformCoverageFamilyRun[],
  platform: CoveragePlatform,
  aggregateRunId: string,
): void {
  if (runs.length !== requiredCoverageFamilies.length) {
    throw new Error("Platform coverage capture omitted a required family run");
  }

  const seenFamilies = new Set<string>();
  const seenRunIds = new Set([aggregateRunId]);

  for (const run of runs) {
    if (
      !isRecord(run) ||
      !requiredCoverageFamilies.includes(run.family) ||
      run.platform !== platform ||
      !coverageRunIdentity.test(run.runId) ||
      seenFamilies.has(run.family) ||
      seenRunIds.has(run.runId)
    ) {
      throw new Error("Platform coverage capture has duplicate or invalid family provenance");
    }

    seenFamilies.add(run.family);

    seenRunIds.add(run.runId);

    if (run.family === "project-worker-owner") {
      if (
        !isRecord(run.workerEvidence) ||
        !Number.isSafeInteger(run.workerEvidence.invocations) ||
        Number(run.workerEvidence.invocations) <= 0 ||
        typeof run.workerEvidence.path !== "string" ||
        run.workerEvidence.path !==
          `.hesperia/coverage/runs/${run.runId}/worker-invocations.json` ||
        typeof run.workerEvidence.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(run.workerEvidence.sha256) ||
        run.nativeEvidence !== undefined
      ) {
        throw new Error("Platform coverage capture omitted project-worker provenance");
      }
    } else if (run.family === "native-editor") {
      if (
        !isRecord(run.nativeEvidence) ||
        run.nativeEvidence.summaryPath !==
          `.hesperia/ec/${run.runId}/editor-capture-summary.json` ||
        run.nativeEvidence.observationPath !==
          `.hesperia/ec/${run.runId}/native-process-observation.json` ||
        typeof run.nativeEvidence.summarySha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(run.nativeEvidence.summarySha256) ||
        typeof run.nativeEvidence.observationSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(run.nativeEvidence.observationSha256) ||
        !isRecord(run.nativeEvidence.summary) ||
        run.nativeEvidence.summary.format !== "hesperia-editor-capture-summary" ||
        run.nativeEvidence.summary.version !== 1 ||
        run.nativeEvidence.summary.runId !== run.runId ||
        (run.nativeEvidence.summary.sourceCount !== undefined &&
          !Number.isSafeInteger(run.nativeEvidence.summary.sourceCount)) ||
        run.workerEvidence !== undefined
      ) {
        throw new Error("Platform coverage capture omitted native-editor provenance");
      }
    } else if (run.workerEvidence !== undefined || run.nativeEvidence !== undefined) {
      throw new Error(`Unexpected evidence was attached to ${run.family}`);
    }
  }

  if (requiredCoverageFamilies.some((family) => !seenFamilies.has(family))) {
    throw new Error("Platform coverage capture omitted a required family run");
  }
}

export function createPlatformCoverageCapture(options: {
  readonly repoPath: string;
  readonly platform: CoveragePlatform;
  readonly runId: string;
  readonly population: CoveragePopulation;
  readonly runs: readonly PlatformCoverageFamilyRun[];
  readonly coverage: CoverageMap;
}): PlatformCoverageCapture {
  const root = resolve(options.repoPath);

  if (!coverageRunIdentity.test(options.runId)) {
    throw new Error("Platform coverage capture has an invalid aggregate run identity");
  }

  validatePopulation(options.population);

  validatePortableFamilyRuns(options.runs, options.platform, options.runId);

  const expectedSources = inventoryCoverageSources(root)
    .map((source) => canonicalKey(source, root))
    .filter((source): source is string => source !== undefined)
    .sort(compareStrings);
  const populationSources = options.population.files.map((file) => file.source);

  if (stableJson(expectedSources) !== stableJson(populationSources)) {
    throw new Error("Platform coverage capture does not match the current source inventory");
  }

  const recordsBySource = new Map<string, CoverageFile>();

  for (const path of options.coverage.files()) {
    const source = canonicalKey(path, root);

    if (source === undefined || recordsBySource.has(source)) {
      throw new Error(`Platform coverage contains an invalid or duplicate source: ${path}`);
    }

    recordsBySource.set(source, options.coverage.fileCoverageFor(path).toJSON());
  }

  if (
    recordsBySource.size !== expectedSources.length ||
    expectedSources.some((source) => !recordsBySource.has(source))
  ) {
    throw new Error("Platform coverage capture does not contain the complete source inventory");
  }

  const populationBySource = new Map(
    options.population.files.map((file) => [file.source, file] as const),
  );
  const coverage: Record<string, CoverageFile> = {};

  for (const source of expectedSources) {
    const path = resolve(root, source.replaceAll("/", sep));
    const authored = readFileSync(path);
    const populationFile = populationBySource.get(source)!;

    if (sha256(authored) !== populationFile.sourceSha256) {
      throw new Error(`Platform coverage source changed after capture: ${source}`);
    }

    const record = recordsBySource.get(source)!;

    validateCoverageCounters(record, source);

    if (unitLayoutSha256(record) !== populationFile.canonicalUnitsSha256) {
      throw new Error(`Platform coverage unit map differs from its population: ${source}`);
    }

    coverage[source] = {
      path: source,
      statementMap: record.statementMap,
      fnMap: record.fnMap,
      branchMap: record.branchMap,
      s: record.s,
      f: record.f,
      b: record.b,
    };
  }

  return {
    format: "hesperia-platform-coverage-capture",
    version: 1,
    status: "completed",
    acceptance: "deferred-combined",
    platform: options.platform,
    runId: options.runId,
    population: options.population,
    runs: options.runs,
    coverage,
  };
}

function portableEvidencePath(root: string, relativePath: string): string {
  if (!relativePath.startsWith(".hesperia/") || relativePath.includes("\\")) {
    throw new Error(`Coverage provenance has a non-portable path: ${relativePath}`);
  }

  const artifactRelativePath = relativePath.slice(".hesperia/".length);
  const artifactPath = resolve(root, artifactRelativePath.replaceAll("/", sep));
  const relativeArtifactPath = relative(root, artifactPath);

  if (
    isAbsolute(relativeArtifactPath) ||
    relativeArtifactPath === ".." ||
    relativeArtifactPath.startsWith(`..${sep}`)
  ) {
    throw new Error(`Coverage provenance path escaped its artifact root: ${relativePath}`);
  }

  return artifactPath;
}

function requireEvidenceSha(path: string, expected: string, label: string): void {
  if (sha256(readFileSync(path)) !== expected) {
    throw new Error(`${label} does not match its captured SHA-256 identity`);
  }
}

function validatePortableFamilyEvidence(
  capture: PlatformCoverageCapture,
  artifactRoot: string,
): void {
  for (const run of capture.runs) {
    if (run.family === "project-worker-owner") {
      const evidence = run.workerEvidence!;
      const path = portableEvidencePath(artifactRoot, evidence.path);

      requireEvidenceSha(path, evidence.sha256, "Project-worker invocation receipt");
    } else if (run.family === "native-editor") {
      const evidence = run.nativeEvidence!;
      const summaryPath = portableEvidencePath(artifactRoot, evidence.summaryPath);
      const observationPath = portableEvidencePath(artifactRoot, evidence.observationPath);

      requireEvidenceSha(summaryPath, evidence.summarySha256, "Native-editor run summary");

      requireEvidenceSha(observationPath, evidence.observationSha256, "Native process proof");

      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as unknown;
      const observation = JSON.parse(readFileSync(observationPath, "utf8")) as unknown;

      if (
        !isRecord(summary) ||
        summary.format !== "hesperia-editor-capture-summary" ||
        summary.version !== 1 ||
        summary.runId !== run.runId ||
        summary.sourceCount !== capture.population.files.length ||
        !isRecord(observation) ||
        observation.runId !== run.runId ||
        (capture.platform === "linux" &&
          (observation.platform !== "linux" ||
            observation.populationFingerprint !== capture.population.fingerprint))
      ) {
        throw new Error("Native-editor evidence does not match its admitted family run");
      }
    }
  }
}

function validatePlatformCapture(
  value: unknown,
  repoPath: string,
  artifactRoot: string,
  expectedPlatform: CoveragePlatform,
): PlatformCoverageCapture {
  if (
    !isRecord(value) ||
    value.format !== "hesperia-platform-coverage-capture" ||
    value.version !== 1 ||
    value.status !== "completed" ||
    value.acceptance !== "deferred-combined" ||
    value.platform !== expectedPlatform ||
    typeof value.runId !== "string" ||
    !coverageRunIdentity.test(value.runId) ||
    !isRecord(value.coverage) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error(`The ${expectedPlatform} platform capture is incomplete or unsupported`);
  }

  const capture = value as unknown as PlatformCoverageCapture;

  validatePopulation(capture.population);

  validatePortableFamilyRuns(capture.runs, expectedPlatform, capture.runId);

  validatePortableFamilyEvidence(capture, artifactRoot);

  const root = resolve(repoPath);
  const expectedSources = inventoryCoverageSources(root)
    .map((source) => canonicalKey(source, root))
    .filter((source): source is string => source !== undefined)
    .sort(compareStrings);
  const populationSources = capture.population.files.map((file) => file.source);

  if (stableJson(expectedSources) !== stableJson(populationSources)) {
    throw new Error(`${expectedPlatform} source population differs from the current inventory`);
  }

  if (
    Object.keys(capture.coverage).sort(compareStrings).join("\0") !== populationSources.join("\0")
  ) {
    throw new Error(`${expectedPlatform} coverage files differ from their source population`);
  }

  const populationBySource = new Map(
    capture.population.files.map((file) => [file.source, file] as const),
  );
  const absoluteRecords: Record<string, CoverageFile> = {};

  for (const source of populationSources) {
    if (
      source.startsWith("/") ||
      source.includes("\\") ||
      source.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`${expectedPlatform} capture has a non-canonical source path: ${source}`);
    }

    const record = capture.coverage[source];

    if (
      !isRecord(record) ||
      record.path !== source ||
      Object.keys(record).sort(compareStrings).join("\0") !==
        ["b", "branchMap", "f", "fnMap", "path", "s", "statementMap"]
          .sort(compareStrings)
          .join("\0")
    ) {
      throw new Error(`${expectedPlatform} capture has a malformed coverage record: ${source}`);
    }

    const absolutePath = resolve(root, source.replaceAll("/", sep));
    const populationFile = populationBySource.get(source)!;

    if (sha256(readFileSync(absolutePath)) !== populationFile.sourceSha256) {
      throw new Error(
        `${expectedPlatform} source bytes differ from the admitted population: ${source}`,
      );
    }

    const absoluteRecord = { ...record, path: absolutePath } as unknown as CoverageFile;

    validateCoverageCounters(absoluteRecord, source);

    if (unitLayoutSha256(absoluteRecord) !== populationFile.canonicalUnitsSha256) {
      throw new Error(
        `${expectedPlatform} source-unit map differs from the admitted population: ${source}`,
      );
    }

    absoluteRecords[absolutePath] = absoluteRecord;
  }

  return { ...capture, coverage: absoluteRecords };
}

export function mergePlatformCoverageCaptures(options: {
  readonly repoPath: string;
  readonly captures: readonly unknown[];
  readonly artifactRoots: Readonly<Record<CoveragePlatform, string>>;
}): {
  readonly coverage: CoverageMap;
  readonly population: CoveragePopulation;
  readonly captures: readonly PlatformCoverageCapture[];
} {
  if (options.captures.length !== 2) {
    throw new Error("Combined coverage requires one completed Windows and Linux capture");
  }

  const byPlatform = new Map<CoveragePlatform, PlatformCoverageCapture>();
  const usedRunIds = new Set<string>();

  for (const value of options.captures) {
    if (!isRecord(value) || (value.platform !== "win32" && value.platform !== "linux")) {
      throw new Error("Combined coverage received an unsupported platform capture");
    }

    const platform = value.platform;

    if (byPlatform.has(platform)) {
      throw new Error(`Combined coverage received duplicate ${platform} captures`);
    }

    const capture = validatePlatformCapture(
      value,
      options.repoPath,
      options.artifactRoots[platform],
      platform,
    );

    for (const runId of [capture.runId, ...capture.runs.map((run) => run.runId)]) {
      if (usedRunIds.has(runId)) {
        throw new Error(`Combined coverage received duplicate original run identity: ${runId}`);
      }

      usedRunIds.add(runId);
    }

    byPlatform.set(platform, capture);
  }

  const windows = byPlatform.get("win32");
  const linux = byPlatform.get("linux");

  if (!windows || !linux) {
    throw new Error("Combined coverage requires one completed Windows and Linux capture");
  }

  if (stableJson(windows.population) !== stableJson(linux.population)) {
    throw new Error("Windows and Linux captures have different source populations");
  }

  const merged = windows.population.files.reduce<Record<string, CoverageFile>>(
    (records, populationFile) => {
      const windowsRecord =
        windows.coverage[resolve(options.repoPath, populationFile.source.replaceAll("/", sep))];
      const linuxRecord =
        linux.coverage[resolve(options.repoPath, populationFile.source.replaceAll("/", sep))];

      if (!windowsRecord || !linuxRecord) {
        throw new Error(`Combined coverage omitted source ${populationFile.source}`);
      }

      records[windowsRecord.path] = mergeCoverageFragment(
        windowsRecord,
        linuxRecord,
        windowsRecord.path,
      );
      return records;
    },
    {},
  );
  return {
    coverage: createCoverageMap(merged),
    population: windows.population,
    captures: [windows, linux],
  };
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/gu, "_");

  if (!safe || safe === "." || safe === "..")
    throw new Error("Coverage fragment identity is invalid");

  return safe;
}

export function writeCoverageFragment(options: {
  readonly directory: string;
  readonly contextId: string;
  readonly pid: number;
  readonly threadId: number;
  readonly repoPath: string;
  readonly artifact: CoverageArtifact;
  readonly sourcePopulation: CoveragePopulation;
}): string {
  const { closeSync, mkdirSync, openSync, renameSync, writeFileSync } =
    require("node:fs") as typeof import("node:fs");
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");

  if (!Number.isSafeInteger(options.pid) || options.pid < 0) {
    throw new Error("Coverage fragment process identity is invalid");
  }

  if (!Number.isSafeInteger(options.threadId) || options.threadId < 0) {
    throw new Error("Coverage fragment thread identity is invalid");
  }

  validatePopulation(options.sourcePopulation);

  const root = resolve(options.repoPath);
  const records = validateArtifactRecords(options.artifact, root);
  const expected = new Map(
    options.sourcePopulation.files.map((file) => [
      file.source,
      resolve(root, file.source.replaceAll("/", sep)),
    ]),
  );

  validateArtifactPopulation(options.artifact, records, options.sourcePopulation, expected);

  const directory = resolve(options.directory);

  mkdirSync(directory, { recursive: true });

  const filename = `${safeSegment(options.artifact.runId)}-${safeSegment(options.artifact.ownerId)}-${safeSegment(options.contextId)}-${options.pid}-${options.threadId}-${randomUUID()}.json`;
  const destination = resolve(directory, filename);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx");

  try {
    writeFileSync(descriptor, JSON.stringify(options.artifact));

    closeSync(descriptor);

    renameSync(temporary, destination);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {}

    throw error;
  }

  return destination;
}

export function writeLcovReport(
  coverage: CoverageMap,
  outputPath: string,
  projectRoot = process.cwd(),
): void {
  const output = resolve(outputPath);
  const context = createContext({
    coverageMap: coverage,
    dir: dirname(output),
    defaultSummarizer: "flat",
  });

  createReporter("lcovonly", { file: basename(output), projectRoot }).execute(context);
}

export function inventoryCoverageSources(repoPath: string): readonly string[] {
  return coverageSourceFiles(resolve(repoPath));
}
