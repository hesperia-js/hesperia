import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { coverageSourceFiles } from "./coverage-inventory.ts";
import { coverageSourceHasExecutableStatements } from "./coverage-source-classifier.ts";

export interface CoverageSummary {
  readonly lineFound: number;
  readonly lineHit: number;
  readonly functionFound: number;
  readonly functionHit: number;
  readonly branchRecordsPresent: boolean;
  readonly unmeasuredSources: readonly string[];
  readonly nonExecutableSources: readonly string[];
}

export interface CoverageResult extends CoverageSummary {
  readonly linePercent: number;
  readonly functionPercent: number;
  readonly threshold: number;
  readonly passed: boolean;
}

interface SourceCoverage {
  readonly filename: string;
  readonly summaryFields: Set<"LF" | "LH" | "FNF" | "FNH">;
  lineFound: number;
  lineHit: number;
  functionFound: number;
  functionHit: number;
  branchRecordsPresent: boolean;
}

interface CoverageMeasurement {
  readonly lineFound: number;
  readonly lineHit: number;
  readonly functionFound: number;
  readonly functionHit: number;
  readonly branchRecordsPresent: boolean;
  readonly measuredSources: ReadonlySet<string>;
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 0 : (hit / found) * 100;
}

function parseLcovCount(value: string, field: string, filename: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`LCOV has invalid ${field} count for ${filename}: ${value}`);
  }

  const count = Number(value);

  if (!Number.isSafeInteger(count)) {
    throw new Error(`LCOV has invalid ${field} count for ${filename}: ${value}`);
  }

  return count;
}

function summaryCount(
  record: SourceCoverage,
  field: "LF" | "LH" | "FNF" | "FNH",
  value: string,
): number {
  if (record.summaryFields.has(field)) {
    throw new Error(`LCOV has duplicate ${field} count for ${record.filename}`);
  }

  record.summaryFields.add(field);

  return parseLcovCount(value, field, record.filename);
}

function addLcovCount(total: number, count: number, label: string): number {
  const result = total + count;

  if (!Number.isSafeInteger(result)) {
    throw new Error(`LCOV ${label} exceeds the safe integer range`);
  }

  return result;
}

function sourceKey(path: string, repoPath: string): string | undefined {
  const nativePath = path.replace(/[\\/]/gu, sep);
  const absolutePath = resolve(repoPath, nativePath);
  const relativePath = relative(repoPath, absolutePath);

  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return undefined;
  }

  const normalized = relativePath.split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasExecutableStatements(filename: string, repoPath: string): boolean {
  const source = readFileSync(join(repoPath, filename), "utf8");
  return coverageSourceHasExecutableStatements(filename, source);
}

function coveredSources(
  text: string,
  repoPath: string,
  inventory: ReadonlyMap<string, string>,
): CoverageMeasurement {
  let lineFound = 0;
  let lineHit = 0;
  let functionFound = 0;
  let functionHit = 0;
  let branchRecordsPresent = false;
  const measuredSources = new Set<string>();
  const recordedSources = new Set<string>();
  let current: SourceCoverage | undefined;

  const finishRecord = () => {
    const record = current;
    current = undefined;

    if (!record) return;

    if (record.lineHit > record.lineFound) {
      throw new Error(`LCOV line hits exceed found count for ${record.filename}`);
    }

    if (record.functionHit > record.functionFound) {
      throw new Error(`LCOV function hits exceed found count for ${record.filename}`);
    }

    const key = sourceKey(record.filename, repoPath);
    const filename = key === undefined ? undefined : inventory.get(key);

    if (key !== undefined && filename !== undefined) {
      if (recordedSources.has(key)) {
        throw new Error(`LCOV contains duplicate production source records for ${filename}`);
      }

      recordedSources.add(key);

      if (record.lineFound === 0 && record.functionFound === 0) return;

      measuredSources.add(key);

      lineFound = addLcovCount(lineFound, record.lineFound, "aggregate LF count");
      lineHit = addLcovCount(lineHit, record.lineHit, "aggregate LH count");
      functionFound = addLcovCount(functionFound, record.functionFound, "aggregate FNF count");
      functionHit = addLcovCount(functionHit, record.functionHit, "aggregate FNH count");
      branchRecordsPresent ||= record.branchRecordsPresent;
    }
  };

  for (const line of text.split(/\r?\n/u)) {
    if (line === "end_of_record") {
      finishRecord();

      continue;
    }

    if (line.startsWith("SF:")) {
      finishRecord();

      current = {
        filename: line.slice(3),
        summaryFields: new Set(),
        lineFound: 0,
        lineHit: 0,
        functionFound: 0,
        functionHit: 0,
        branchRecordsPresent: false,
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("LF:")) {
      current.lineFound = summaryCount(current, "LF", line.slice(3));
    } else if (line.startsWith("LH:")) {
      current.lineHit = summaryCount(current, "LH", line.slice(3));
    } else if (line.startsWith("FNF:")) {
      current.functionFound = summaryCount(current, "FNF", line.slice(4));
    } else if (line.startsWith("FNH:")) {
      current.functionHit = summaryCount(current, "FNH", line.slice(4));
    } else if (line.startsWith("BRF:") || line.startsWith("BRH:") || line.startsWith("BRDA:")) {
      current.branchRecordsPresent = true;
    }
  }

  finishRecord();

  return {
    lineFound,
    lineHit,
    functionFound,
    functionHit,
    branchRecordsPresent,
    measuredSources,
  };
}

export function checkCoverage(options: {
  readonly lcovPath: string;
  readonly repoPath?: string;
  readonly threshold?: number;
}): CoverageResult {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const threshold = options.threshold ?? 90;

  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("coverage threshold must be between 0 and 100");
  }

  const inventoryPaths = coverageSourceFiles(repoPath);
  const executableSources: string[] = [];
  const nonExecutableSources: string[] = [];

  for (const path of inventoryPaths) {
    if (hasExecutableStatements(path, repoPath)) executableSources.push(path);
    else nonExecutableSources.push(path);
  }

  const inventory = new Map(
    inventoryPaths.flatMap((path) => {
      const key = sourceKey(path, repoPath);
      return key === undefined ? [] : [[key, path] as const];
    }),
  );
  const measurement = coveredSources(
    readFileSync(resolve(repoPath, options.lcovPath), "utf8"),
    repoPath,
    inventory,
  );

  if (measurement.lineFound === 0 || measurement.functionFound === 0) {
    throw new Error("LCOV report has no measurable line or function records");
  }

  const unmeasuredSources = executableSources.filter((path) => {
    const key = sourceKey(path, repoPath);
    return key !== undefined && !measurement.measuredSources.has(key);
  });
  const linePercent = percentage(measurement.lineHit, measurement.lineFound);
  const functionPercent = percentage(measurement.functionHit, measurement.functionFound);
  return {
    lineFound: measurement.lineFound,
    lineHit: measurement.lineHit,
    functionFound: measurement.functionFound,
    functionHit: measurement.functionHit,
    branchRecordsPresent: measurement.branchRecordsPresent,
    unmeasuredSources,
    nonExecutableSources,
    linePercent,
    functionPercent,
    threshold,
    passed:
      linePercent >= threshold && functionPercent >= threshold && unmeasuredSources.length === 0,
  };
}

function parseArguments(args: readonly string[]): { lcovPath: string; threshold: number } {
  let lcovPath = ".hesperia/coverage/lcov.info";
  let threshold = 90;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: bun run scripts/ci/check-coverage.ts [--path <lcov-file>] [--threshold <percent>]",
      );

      process.exit(0);
    }

    if (argument !== "--path" && argument !== "--threshold") {
      throw new Error(`unknown option: ${argument ?? ""}`);
    }

    const value = args[index + 1];

    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);

    if (argument === "--path") lcovPath = value;
    else threshold = Number(value);

    index += 1;
  }

  return { lcovPath, threshold };
}

if (import.meta.main) {
  try {
    const result = checkCoverage({ ...parseArguments(Bun.argv.slice(2)) });

    console.log(
      `Line coverage: ${result.lineHit}/${result.lineFound} (${result.linePercent.toFixed(2)}%)`,
    );

    console.log(
      `Function coverage: ${result.functionHit}/${result.functionFound} (${result.functionPercent.toFixed(2)}%)`,
    );

    console.log(
      result.branchRecordsPresent
        ? "Branch coverage records are present but are not part of the enforced floor."
        : "Branch coverage is unmeasured: this LCOV report contains no branch records.",
    );

    if (result.unmeasuredSources.length > 0) {
      console.log(`Unmeasured production sources (${result.unmeasuredSources.length}):`);

      for (const path of result.unmeasuredSources) console.log(`  ${path}`);
    }

    if (result.nonExecutableSources.length > 0) {
      console.log(
        `Production sources with no executable statements (${result.nonExecutableSources.length}):`,
      );

      for (const path of result.nonExecutableSources) console.log(`  ${path}`);
    }

    if (!result.passed) {
      if (result.unmeasuredSources.length > 0) {
        throw new Error(
          `LCOV is missing executable coverage records for ${result.unmeasuredSources.length} production sources`,
        );
      }

      throw new Error(`line and function coverage must each meet the ${result.threshold}% floor`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    process.exitCode = 1;
  }
}
